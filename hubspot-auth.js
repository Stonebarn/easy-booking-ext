// hubspot-auth.js — per-SDR HubSpot OAuth for the side panel.
//
// The extension holds no client secret. The two OAuth operations that require
// it run in a hosted Lovable Cloud edge function
// (lovable/hubspot-token-function.ts):
//
//   POST { action: "exchange", code }          -> { access_token, refresh_token,
//                                                  expires_in, hub_id,
//                                                  user_email, user_id }
//   POST { action: "refresh", refresh_token }  -> { access_token, expires_in }
//
// The exchange also *offers* identity (the function introspects server-side),
// but it is never relied on: see ensureIdentity() below, which resolves the
// signed-in SDR from the access token itself on whatever path needs it.
// Everything else — the authorize redirect and every CRM call — stays
// client-side.
//
// No host_permissions entry is needed for the function's domain: it answers the
// preflight with Access-Control-Allow-Origin set to this extension's origin, so
// ordinary CORS lets the panel through. host_permissions exists to *bypass*
// CORS, which is why api.hubapi.com is listed and this host is not.
//
// Token lifetimes shape the rest: access tokens last 30 min, refresh tokens
// never expire and are not rotated. So the refresh token is the durable
// credential (chrome.storage.local, survives restarts) and the access token is
// disposable (chrome.storage.session, cleared when the browser closes).
// Refreshing happens on demand, right before a call needs a token — no alarms,
// nothing to re-arm, and nothing breaks when the service worker dies.
//
// Every request here runs from the *side panel document*, never the service
// worker: the panel is long-lived while open, whereas the MV3 worker can be
// killed mid-flight.
//
// Plain IIFE + globals, not an ES module: CI runs `node --check` on .js files,
// which parses them as CommonJS. Load hubspot-config.js before this file.

(() => {
  "use strict";

  const EB = (self.EB = self.EB || {});
  const CFG = EB.hubspotConfig;

  // Separate keys, never nested inside "eb:currentProspect" — the scheduler
  // content script resets its fill state on *any* write to that key.
  const AUTH_KEY = "eb:hs:auth"; // local:   { refreshToken, userEmail, hubId, userId, ownerId, connectedAt }
  const TOKEN_KEY = "eb:hs:accessToken"; // session: { accessToken, expiresAt }

  // Refresh this far before actual expiry so a call never races the boundary.
  const REFRESH_SKEW_MS = 5 * 60 * 1000;

  const log = (...args) => console.debug("[EasyBooking]", ...args);

  // --- Errors --------------------------------------------------------------
  // Typed so the UI can distinguish "you were never connected" from "the token
  // service is misconfigured" from "HubSpot is having a moment".
  //   CONFIG_MISSING  — client id / proxy URL placeholders never filled in
  //   NOT_CONNECTED   — no refresh token (signed out), or the refresh token died
  //   CANCELLED       — SDR closed the consent window
  //   DENIED          — HubSpot returned an error on the redirect
  //   STATE_MISMATCH  — CSRF check failed
  //   EXCHANGE_FAILED — HubSpot rejected the authorization code
  //   REFRESH_FAILED  — transient: network, or the endpoint/HubSpot 5xx'd
  //   PROXY_ERROR     — the token service itself refused the request (origin
  //                     lock, bad shape) — never evidence the SDR's token is bad
  //   API_ERROR       — a CRM call failed
  class HubSpotAuthError extends Error {
    constructor(code, message, cause) {
      super(message);
      this.name = "HubSpotAuthError";
      this.code = code;
      if (cause !== undefined) this.cause = cause;
    }
  }

  function assertConfigured() {
    if (!CFG || !CFG.isConfigured()) {
      throw new HubSpotAuthError(
        "CONFIG_MISSING",
        "HubSpot CLIENT_ID / TOKEN_PROXY_URL not set — fill them in hubspot-config.js."
      );
    }
  }

  // --- Storage -------------------------------------------------------------
  // storage.session is available to extension pages with the "storage"
  // permission, but keep an in-memory fallback so a missing/failing session
  // area degrades to "re-auth per panel load" instead of breaking outright.
  const hasSession = !!(chrome.storage && chrome.storage.session);
  let memToken = null;

  async function readToken() {
    if (!hasSession) return memToken;
    try {
      const res = await chrome.storage.session.get(TOKEN_KEY);
      return (res && res[TOKEN_KEY]) || null;
    } catch (e) {
      log("session storage unreadable, using memory:", e && e.message);
      return memToken;
    }
  }

  // Both proxy actions return { access_token, expires_in } (exchange returns
  // more, which its caller handles), so one writer covers both.
  async function writeToken(tok) {
    const record = {
      accessToken: tok.access_token,
      expiresAt: Date.now() + Number(tok.expires_in || 0) * 1000,
    };
    memToken = record;
    if (hasSession) {
      try {
        await chrome.storage.session.set({ [TOKEN_KEY]: record });
      } catch (e) {
        log("could not persist access token to session storage:", e && e.message);
      }
    }
    return record;
  }

  async function clearToken() {
    memToken = null;
    if (hasSession) {
      try {
        await chrome.storage.session.remove(TOKEN_KEY);
      } catch (e) {
        log("could not clear session token:", e && e.message);
      }
    }
  }

  async function readAuth() {
    const res = await chrome.storage.local.get(AUTH_KEY);
    return (res && res[AUTH_KEY]) || null;
  }

  async function writeAuth(record) {
    await chrome.storage.local.set({ [AUTH_KEY]: record });
    return record;
  }

  // Merge into the stored record so best-effort enrichment (the owner lookup)
  // can land after the connection itself is already safely persisted.
  async function patchAuth(patch) {
    const current = (await readAuth()) || {};
    return writeAuth({ ...current, ...patch });
  }

  // --- The token service ---------------------------------------------------
  function describeDetail(detail) {
    if (!detail) return "";
    if (typeof detail === "string") return detail;
    // HubSpot error bodies carry { message, category, correlationId, … }.
    return detail.message || detail.error_description || detail.error || JSON.stringify(detail);
  }

  // POSTs one of the two actions and returns the parsed body. Throws a typed
  // HubSpotAuthError carrying the HTTP status on `.status` and the endpoint's
  // `error` slug on `.proxyError` — which is what the refresh path needs to tell
  // a dead token from a broken deployment.
  async function callProxy(action, payload, failCode) {
    let res;
    try {
      res = await fetch(CFG.TOKEN_PROXY_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, ...payload }),
      });
    } catch (e) {
      // Offline, DNS, TLS, or a CORS rejection — all transient as far as our
      // stored credentials are concerned.
      throw new HubSpotAuthError(
        failCode,
        `Could not reach the HubSpot token service: ${e && e.message}`,
        e
      );
    }

    let body = null;
    try {
      body = await res.json();
    } catch (_) {
      /* non-JSON (service down, HTML error page) — handled below */
    }

    if (res.ok) return body || {};

    const slug = (body && body.error) || "";
    const detail = describeDetail(body && body.detail);
    const message = detail
      ? `${slug || "HTTP " + res.status}: ${String(detail).slice(0, 300)}`
      : slug || `HTTP ${res.status}`;

    // "exchange_failed"/"refresh_failed" mean HubSpot itself rejected us and the
    // function passed HubSpot's status through. Any other slug is the function
    // refusing the request (forbidden_origin, missing_refresh_token,
    // unknown_action, invalid_json, method_not_allowed) — our bug or a
    // deployment problem, never evidence that the SDR's token is bad.
    const fromHubSpot = slug === "exchange_failed" || slug === "refresh_failed";
    const err = new HubSpotAuthError(fromHubSpot ? failCode : "PROXY_ERROR", message, res.status);
    err.proxyError = slug;
    err.status = res.status;
    throw err;
  }

  // --- Authorize round trip ------------------------------------------------
  function randomState() {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  }

  function buildAuthorizeUrl(state) {
    // Built by hand rather than with URLSearchParams: that encodes spaces as
    // "+", and HubSpot's scope parameter wants %20-separated values.
    const query = [
      `client_id=${encodeURIComponent(CFG.CLIENT_ID)}`,
      `redirect_uri=${encodeURIComponent(CFG.REDIRECT_URL)}`,
      `scope=${encodeURIComponent(CFG.SCOPES.join(" "))}`,
      `state=${encodeURIComponent(state)}`,
    ].join("&");
    return `${CFG.AUTHORIZE_URL}?${query}`;
  }

  // The registered redirect URL is hard-coded in config (it has to match what
  // HubSpot *and* the edge function both have on file) but it derives from the
  // extension ID, which is only stable because of manifest.json's "key". Catch
  // a drift here rather than in an opaque HubSpot error page.
  function warnOnRedirectDrift() {
    try {
      const expected = chrome.identity.getRedirectURL("hubspot");
      if (expected !== CFG.REDIRECT_URL) {
        log(
          "redirect URL mismatch — this browser expects",
          expected,
          "but hubspot-config.js registers",
          CFG.REDIRECT_URL,
          "(is manifest.json's 'key' still present?)"
        );
      }
    } catch (_) {
      /* identity API unavailable; login() will fail with a clearer error */
    }
  }

  // --- Signed-in identity --------------------------------------------------
  // Who a note gets attributed to. hs_created_by ("Activity created by") wants
  // the SDR's HubSpot *user* id, and every note this extension wrote came out as
  // "No user" because that id was never actually known.
  //
  // Why: the exchange in login() was the ONE code path that ever captured it,
  // straight from the token service's response — and that response carries
  // user_id: null. The hosted function asks HubSpot's introspect endpoint for
  // identity but posts the token as `access_token`, while the endpoint requires a
  // form field named `token`; it 400s, the function swallows the failure
  // (`if (intro.ok) who = intro.data;`) and returns nulls. Nothing looked again:
  // a restored session reads the same null back out of storage, and a token
  // refresh never touches identity at all. One silent failure at one moment,
  // cached in chrome.storage.local for the life of the connection.
  //
  // So identity is resolved from the token instead, here, on demand:
  // GET /oauth/v1/access-tokens/{token} is public token metadata — no client
  // secret, the bearer token is the path segment — and answers { user (email),
  // user_id, hub_id } for whoever the token belongs to. That answer is available
  // on EVERY path (fresh login, session restored from storage, token just
  // refreshed), which is the whole point: there is no longer a path that can
  // leave a connection anonymous.
  //
  // Contract, because attribution must never cost a rep their note: single
  // flight, persisted once resolved, and a failure returns null WITHOUT caching
  // anything — the next sync simply asks again.
  let inFlightIdentity = null;

  async function fetchTokenIdentity() {
    const token = await getAccessToken();
    // The token rides in the path (HubSpot's own design for this endpoint);
    // apiFetch additionally sends it as the bearer, which this endpoint ignores.
    // Never logged, on either side.
    const res = await apiFetch(`/oauth/v1/access-tokens/${encodeURIComponent(token)}`);
    if (!res.ok) {
      throw new HubSpotAuthError("API_ERROR", `HTTP ${res.status}`, res.status);
    }
    const body = (await res.json()) || {};
    return {
      userEmail: body.user ? String(body.user) : null,
      userId: body.user_id != null ? String(body.user_id) : null,
      hubId: body.hub_id != null ? String(body.hub_id) : null,
    };
  }

  // Returns { userEmail, userId, hubId } — any field may still be null — or null
  // when there is no connection at all. Callers carry on unattributed rather than
  // lose the write.
  async function ensureIdentity() {
    const auth = await readAuth();
    if (!auth || !auth.refreshToken) {
      log("identity requested while not connected");
      return null;
    }
    const have = {
      userEmail: auth.userEmail || null,
      userId: auth.userId || null,
      hubId: auth.hubId || null,
    };
    // The user id is the field attribution actually needs; the email is what the
    // owner lookup searches by. Either one missing is worth one round trip.
    if (have.userEmail && have.userId) return have;
    // Same single-flight shape as the owner lookup and the token refresh: the
    // check and the assignment below have no await between them, so a second
    // caller either sees no flight or sees this one.
    if (inFlightIdentity) return inFlightIdentity;
    const p = (async () => {
      try {
        const who = await fetchTokenIdentity();
        const patch = {};
        if (who.userId && who.userId !== have.userId) patch.userId = who.userId;
        if (who.userEmail && who.userEmail !== have.userEmail) patch.userEmail = who.userEmail;
        if (who.hubId && !have.hubId) patch.hubId = who.hubId;
        if (Object.keys(patch).length) {
          await patchAuth(patch);
          log(
            "backfilled the signed-in HubSpot identity from the access token:",
            who.userEmail || "(no email)",
            "user id",
            who.userId || "(none)"
          );
        }
        return {
          userEmail: who.userEmail || have.userEmail,
          userId: who.userId || have.userId,
          hubId: who.hubId || have.hubId,
        };
      } catch (e) {
        // Deliberately caches nothing: the flight is cleared in the finally
        // below, so the next sync retries instead of inheriting this failure.
        log("could not read the signed-in HubSpot identity:", (e && e.message) || e);
        return have.userEmail || have.userId ? have : null;
      }
    })();
    inFlightIdentity = p;
    try {
      return await p;
    } finally {
      if (inFlightIdentity === p) inFlightIdentity = null;
    }
  }

  // --- Owner identity ------------------------------------------------------
  // Owner ID ≠ user ID. Note attribution needs both, for different fields:
  // hubspot_owner_id wants the *owner* ID (this lookup), hs_created_by wants the
  // *user* ID (ensureIdentity above). Still done client-side: it is an ordinary
  // CRM read, no secret involved.
  async function lookupOwnerId(email) {
    const res = await apiFetch(`/crm/v3/owners/?email=${encodeURIComponent(email)}`);
    if (!res.ok) {
      throw new HubSpotAuthError("API_ERROR", `HTTP ${res.status}`, res.status);
    }
    const body = await res.json();
    const owner = body && Array.isArray(body.results) ? body.results[0] : null;
    return owner ? String(owner.id) : null;
  }

  // Lazy, self-healing owner resolution.
  //
  // The lookup used to run exactly once, at login, as best-effort enrichment —
  // so a single failure there (offline for a second, a 429, owners scope not yet
  // granted) left `ownerId` null in eb:hs:auth *forever*, and every note that
  // connection ever created came out unattributed. That is what happened live.
  // Resolving on demand instead means an already-broken connection fixes itself
  // the next time it needs an owner, with no reconnect and nothing for the rep
  // to do.
  //
  // Returns the owner ID, or null when it genuinely can't be resolved — callers
  // are expected to carry on unattributed rather than lose the write.
  let inFlightOwnerLookup = null;

  async function ensureOwnerId() {
    const auth = await readAuth();
    if (!auth || !auth.refreshToken) {
      log("owner id requested while not connected");
      return null;
    }
    if (auth.ownerId) return String(auth.ownerId);
    // The lookup searches by email, and the email can be missing for exactly the
    // reason the user id was (see ensureIdentity) — so resolve identity first
    // rather than giving up. This is what made the live failure total: no email
    // meant no owner either, so BOTH attribution fields went unset.
    let email = auth.userEmail || null;
    if (!email) {
      const who = await ensureIdentity();
      email = (who && who.userEmail) || null;
    }
    if (!email) {
      log("no HubSpot email for this connection — cannot resolve an owner id");
      return null;
    }
    // Single-flight, same reason as the token refresh: a prospect change can ask
    // for this from several places at once, and one CRM round trip is enough.
    // The assignment is synchronous with the check above, so no second caller
    // can slip past it.
    if (inFlightOwnerLookup) return inFlightOwnerLookup;
    const p = (async () => {
      try {
        const ownerId = await lookupOwnerId(email);
        if (!ownerId) {
          log("HubSpot has no owner record for", email, "— notes will be unattributed");
          return null;
        }
        await patchAuth({ ownerId });
        log("resolved HubSpot owner id for", email, "->", ownerId);
        return ownerId;
      } catch (e) {
        log("owner lookup failed; notes will be unattributed this time:", (e && e.message) || e);
        return null;
      }
    })();
    inFlightOwnerLookup = p;
    try {
      return await p;
    } finally {
      if (inFlightOwnerLookup === p) inFlightOwnerLookup = null;
    }
  }

  async function login() {
    assertConfigured();
    warnOnRedirectDrift();

    const state = randomState();
    let redirect;
    try {
      redirect = await chrome.identity.launchWebAuthFlow({
        url: buildAuthorizeUrl(state),
        interactive: true,
      });
    } catch (e) {
      // Chrome rejects with "The user did not approve access." when the consent
      // window is closed — that is a cancellation, not a failure.
      const msg = (e && e.message) || "";
      if (/did not approve|canceled|cancelled|closed/i.test(msg)) {
        throw new HubSpotAuthError("CANCELLED", "HubSpot connection cancelled.", e);
      }
      throw new HubSpotAuthError("DENIED", msg || "HubSpot authorization failed.", e);
    }
    if (!redirect) throw new HubSpotAuthError("CANCELLED", "HubSpot connection cancelled.");

    const params = new URL(redirect).searchParams;
    const oauthError = params.get("error");
    if (oauthError) {
      throw new HubSpotAuthError("DENIED", params.get("error_description") || oauthError);
    }
    if (params.get("state") !== state) {
      throw new HubSpotAuthError("STATE_MISMATCH", "HubSpot returned an unexpected state value.");
    }
    const code = params.get("code");
    if (!code) {
      throw new HubSpotAuthError("DENIED", "HubSpot did not return an authorization code.");
    }

    // The only place the authorization code goes is the token service, which
    // holds the secret and returns tokens plus the SDR's identity.
    const tok = await callProxy("exchange", { code }, "EXCHANGE_FAILED");
    if (!tok.refresh_token) {
      throw new HubSpotAuthError(
        "EXCHANGE_FAILED",
        "No refresh token returned by the token service."
      );
    }

    // Persist the durable credential FIRST. The owner lookup below is
    // enrichment; if it fails we must not throw away a refresh token we already
    // hold, or the SDR ends up connected in HubSpot but signed out here with no
    // way back except revoking the install.
    await writeToken(tok);
    await writeAuth({
      refreshToken: tok.refresh_token,
      userEmail: tok.user_email || null,
      hubId: tok.hub_id != null ? String(tok.hub_id) : null,
      userId: tok.user_id != null ? String(tok.user_id) : null,
      ownerId: null,
      connectedAt: Date.now(),
    });
    log("HubSpot connected as", tok.user_email || "(email unknown)");

    // Whatever the token service did or didn't tell us about identity, confirm it
    // from the token itself — the exchange's user_email/user_id are null in
    // practice (see ensureIdentity), and a connection that starts anonymous
    // writes anonymous notes. Then the owner ID, so the first note of the session
    // doesn't pay for either lookup. Both swallow their own failures and retry
    // when a note needs them, so neither can cost us the refresh token above.
    await ensureIdentity();
    await ensureOwnerId();

    return getAuthState();
  }

  // --- Access token / refresh ---------------------------------------------
  // Single-flight: the panel can fire several HubSpot calls at once on a
  // prospect change, and each refresh is a round trip through the token service.
  // Concurrent callers share one in-flight refresh.
  let inFlightRefresh = null;

  async function refreshAccessToken() {
    assertConfigured();
    const auth = await readAuth();
    if (!auth || !auth.refreshToken) {
      throw new HubSpotAuthError("NOT_CONNECTED", "Not connected to HubSpot.");
    }
    let tok;
    try {
      tok = await callProxy("refresh", { refresh_token: auth.refreshToken }, "REFRESH_FAILED");
    } catch (e) {
      // Only a 4xx that HubSpot itself produced means the refresh token is dead
      // for good (revoked install, rotated secret) — drop it so the UI falls
      // back to a clean "Connect" state. A 5xx, a network failure, or the
      // service refusing the request (PROXY_ERROR) is transient or our own bug:
      // keep the credentials, because signing an SDR out over a blip would make
      // them re-consent for nothing.
      const status = e && e.status;
      const deadToken =
        e instanceof HubSpotAuthError &&
        e.code === "REFRESH_FAILED" &&
        typeof status === "number" &&
        status >= 400 &&
        status < 500;
      if (deadToken) {
        log("refresh token rejected by HubSpot; clearing stored auth");
        await logout();
        throw new HubSpotAuthError("NOT_CONNECTED", "HubSpot connection expired — reconnect.", e);
      }
      log("refresh failed but credentials kept (transient):", e && e.message);
      throw e;
    }
    if (!tok.access_token) {
      throw new HubSpotAuthError("REFRESH_FAILED", "No access token returned by the token service.");
    }
    const record = await writeToken(tok);
    log("HubSpot access token refreshed");
    return record.accessToken;
  }

  async function getAccessToken() {
    const cached = await readToken();
    if (cached && cached.accessToken && cached.expiresAt - Date.now() > REFRESH_SKEW_MS) {
      return cached.accessToken;
    }
    if (inFlightRefresh) return inFlightRefresh;
    const p = refreshAccessToken();
    inFlightRefresh = p;
    try {
      return await p;
    } finally {
      if (inFlightRefresh === p) inFlightRefresh = null;
    }
  }

  // Bearer-authenticated CRM fetch (extension → api.hubapi.com directly) with
  // one refresh-and-retry on 401 — covers a token revoked before its stated
  // expiry. Returns the raw Response so callers own status handling.
  //
  // A bare path is resolved against API_BASE. Callers used to have to prefix it
  // themselves, and one didn't: a relative URL from the panel document resolves
  // against chrome-extension://, so the request never reached HubSpot. Doing it
  // here means no caller can get it wrong. The origin assertion then guarantees
  // the bearer token can only ever be attached to a HubSpot request, whatever a
  // future caller passes in.
  async function apiFetch(path, options = {}) {
    const url = /^https?:/i.test(path) ? path : `${CFG.API_BASE}${path}`;
    let origin;
    try {
      origin = new URL(url).origin;
    } catch (e) {
      throw new HubSpotAuthError("CONFIG_MISSING", `Invalid request URL: ${path}`);
    }
    if (origin !== new URL(CFG.API_BASE).origin) {
      throw new HubSpotAuthError(
        "CONFIG_MISSING",
        `Refusing to send credentials to ${origin}`
      );
    }

    const send = async (token) =>
      fetch(url, {
        ...options,
        headers: {
          ...(options.headers || {}),
          Authorization: `Bearer ${token}`,
        },
      });

    let res = await send(await getAccessToken());
    if (res.status === 401) {
      log("HubSpot returned 401; refreshing once and retrying");
      await clearToken();
      res = await send(await getAccessToken());
    }
    return res;
  }

  async function logout() {
    await clearToken();
    try {
      await chrome.storage.local.remove(AUTH_KEY);
    } catch (e) {
      log("could not clear stored HubSpot auth:", e && e.message);
    }
    log("HubSpot disconnected");
  }

  async function getAuthState() {
    const auth = await readAuth();
    return {
      connected: !!(auth && auth.refreshToken),
      configured: !!(CFG && CFG.isConfigured()),
      userEmail: (auth && auth.userEmail) || null,
      hubId: (auth && auth.hubId) || null,
      // Two different IDs, deliberately both exposed: ownerId attributes a note
      // ("Activity assigned to"), userId is what hs_created_by wants
      // ("Activity created by"). Either may legitimately be null here — this is a
      // pure read of what's stored, called on every render. Call ensureIdentity()
      // / ensureOwnerId() when you actually need them; those heal the record.
      ownerId: (auth && auth.ownerId) || null,
      userId: (auth && auth.userId) || null,
      connectedAt: (auth && auth.connectedAt) || null,
    };
  }

  EB.hubspotAuth = {
    login,
    logout,
    getAuthState,
    getAccessToken,
    ensureIdentity,
    ensureOwnerId,
    apiFetch,
    HubSpotAuthError,
    AUTH_KEY,
    TOKEN_KEY,
  };
})();
