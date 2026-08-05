// hubspot-auth.js — per-SDR HubSpot OAuth for the side panel.
//
// There is no backend. The extension talks to HubSpot directly, using the
// client secret embedded in hubspot-config.js (see the decision block there).
// Every request in this file runs from the *side panel document*, never from
// the service worker: the panel is long-lived while open, whereas the MV3
// worker can be killed mid-flight, and `https://api.hubapi.com/*` in
// host_permissions means the panel's fetches skip CORS entirely.
//
// Token lifetimes shape the design: access tokens last 30 min, refresh tokens
// never expire and are not rotated. So the refresh token is the durable
// credential (chrome.storage.local, survives restarts) and the access token is
// disposable (chrome.storage.session, cleared when the browser closes).
// Refreshing happens on demand, right before a call needs a token — no alarms,
// nothing to re-arm, and nothing breaks when the worker dies.
//
// Plain IIFE + globals, not an ES module: CI runs `node --check` on .js files,
// which parses them as CommonJS. Load hubspot-config.js before this file.

(() => {
  "use strict";

  const EB = (self.EB = self.EB || {});
  const CFG = EB.hubspotConfig;

  // Separate keys, never nested inside "eb:currentProspect" — the scheduler
  // content script resets its fill state on *any* write to that key.
  const AUTH_KEY = "eb:hs:auth"; // local:   { refreshToken, userEmail, hubId, ownerId, connectedAt }
  const TOKEN_KEY = "eb:hs:accessToken"; // session: { accessToken, expiresAt }

  // Refresh this far before actual expiry so a call never races the boundary.
  const REFRESH_SKEW_MS = 5 * 60 * 1000;

  const log = (...args) => console.debug("[EasyBooking]", ...args);

  // --- Errors --------------------------------------------------------------
  // Typed so the UI can distinguish "you were never connected" from "HubSpot
  // rejected us" and show the right affordance.
  //   CONFIG_MISSING  — client id/secret placeholders never filled in
  //   NOT_CONNECTED   — no refresh token (signed out), or the refresh token died
  //   CANCELLED       — SDR closed the consent window
  //   DENIED          — HubSpot returned an error on the redirect
  //   STATE_MISMATCH  — CSRF check failed
  //   EXCHANGE_FAILED / REFRESH_FAILED / API_ERROR
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
        "HubSpot client ID/secret not set — fill them in hubspot-config.js."
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

  async function writeToken(tok) {
    // HubSpot returns expires_in in seconds (1800).
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

  // Merge into the stored record so best-effort enrichment (email, owner id)
  // can land after the connection itself is already safely persisted.
  async function patchAuth(patch) {
    const current = (await readAuth()) || {};
    return writeAuth({ ...current, ...patch });
  }

  // --- HTTP ----------------------------------------------------------------
  function formBody(fields) {
    const body = new URLSearchParams();
    for (const [k, v] of Object.entries(fields)) {
      if (v !== undefined && v !== null) body.append(k, String(v));
    }
    return body.toString();
  }

  // HubSpot error bodies are JSON-ish but not guaranteed; never let a parse
  // failure mask the real status.
  async function readError(res) {
    let detail = "";
    try {
      const text = await res.text();
      try {
        const j = JSON.parse(text);
        detail = j.message || j.error_description || j.error || text;
      } catch (_) {
        detail = text;
      }
    } catch (_) {
      /* body already consumed or unreadable */
    }
    return `HTTP ${res.status}${detail ? ` — ${String(detail).slice(0, 300)}` : ""}`;
  }

  async function postForm(url, fields, errCode) {
    let res;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded;charset=utf-8" },
        body: formBody(fields),
      });
    } catch (e) {
      throw new HubSpotAuthError(errCode, `Could not reach HubSpot: ${e && e.message}`, e);
    }
    if (!res.ok) throw new HubSpotAuthError(errCode, await readError(res), res.status);
    return res.json();
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
  // HubSpot has on file) but it is derived from the extension ID, which is only
  // stable because of manifest.json's "key". Catch a drift here rather than in
  // an opaque HubSpot error page.
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

  async function introspect(accessToken) {
    return postForm(
      CFG.INTROSPECT_URL,
      {
        client_id: CFG.CLIENT_ID,
        client_secret: CFG.CLIENT_SECRET,
        token_type_hint: "access_token",
        access_token: accessToken,
      },
      "API_ERROR"
    );
  }

  // Owner ID ≠ user ID, and note attribution needs the owner ID.
  async function lookupOwnerId(email) {
    const url = `${CFG.API_BASE}/crm/v3/owners/?email=${encodeURIComponent(email)}`;
    const res = await apiFetch(url);
    if (!res.ok) throw new HubSpotAuthError("API_ERROR", await readError(res), res.status);
    const body = await res.json();
    const owner = body && Array.isArray(body.results) ? body.results[0] : null;
    return owner ? String(owner.id) : null;
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
      throw new HubSpotAuthError(
        "DENIED",
        params.get("error_description") || oauthError
      );
    }
    if (params.get("state") !== state) {
      throw new HubSpotAuthError("STATE_MISMATCH", "HubSpot returned an unexpected state value.");
    }
    const code = params.get("code");
    if (!code) {
      throw new HubSpotAuthError("DENIED", "HubSpot did not return an authorization code.");
    }

    const tok = await postForm(
      CFG.TOKEN_URL,
      {
        grant_type: "authorization_code",
        client_id: CFG.CLIENT_ID,
        client_secret: CFG.CLIENT_SECRET,
        redirect_uri: CFG.REDIRECT_URL,
        code,
      },
      "EXCHANGE_FAILED"
    );
    if (!tok.refresh_token) {
      throw new HubSpotAuthError("EXCHANGE_FAILED", "HubSpot did not return a refresh token.");
    }

    // Persist the durable credential FIRST. Everything below is enrichment; if
    // introspection or the owner lookup fails we must not throw away a refresh
    // token we already hold, or the SDR ends up connected in HubSpot but signed
    // out here with no way back except revoking the install.
    await writeToken(tok);
    await writeAuth({
      refreshToken: tok.refresh_token,
      userEmail: null,
      hubId: tok.hub_id != null ? String(tok.hub_id) : null,
      ownerId: null,
      connectedAt: Date.now(),
    });
    log("HubSpot connected; resolving identity");

    try {
      const info = await introspect(tok.access_token);
      await patchAuth({
        userEmail: info.user || null,
        hubId: info.hub_id != null ? String(info.hub_id) : null,
      });
      if (info.user) {
        try {
          const ownerId = await lookupOwnerId(info.user);
          await patchAuth({ ownerId });
          log("HubSpot owner id for", info.user, "->", ownerId);
        } catch (e) {
          log("owner lookup failed (note attribution will need it later):", e && e.message);
        }
      }
    } catch (e) {
      log("token introspection failed; connected without identity details:", e && e.message);
    }

    return getAuthState();
  }

  // --- Access token / refresh ---------------------------------------------
  // Single-flight: the panel can fire several HubSpot calls at once on a
  // prospect change, and each refresh burns a request against a portal-wide
  // rate limit. Concurrent callers share one in-flight refresh.
  let inFlightRefresh = null;

  async function refreshAccessToken() {
    assertConfigured();
    const auth = await readAuth();
    if (!auth || !auth.refreshToken) {
      throw new HubSpotAuthError("NOT_CONNECTED", "Not connected to HubSpot.");
    }
    let tok;
    try {
      tok = await postForm(
        CFG.TOKEN_URL,
        {
          grant_type: "refresh_token",
          client_id: CFG.CLIENT_ID,
          client_secret: CFG.CLIENT_SECRET,
          refresh_token: auth.refreshToken,
        },
        "REFRESH_FAILED"
      );
    } catch (e) {
      // A rejected refresh token is dead for good (revoked install, rotated
      // secret). Drop it so the UI falls back to a clean "Connect" state
      // instead of retrying a credential that can never work.
      if (e instanceof HubSpotAuthError && e.cause === 400) {
        log("refresh token rejected; clearing stored HubSpot auth");
        await logout();
        throw new HubSpotAuthError("NOT_CONNECTED", "HubSpot connection expired — reconnect.", e);
      }
      throw e;
    }
    // Refresh tokens are not rotated, but honor one if HubSpot ever sends it.
    if (tok.refresh_token && tok.refresh_token !== auth.refreshToken) {
      await patchAuth({ refreshToken: tok.refresh_token });
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

  // Bearer-authenticated fetch with one refresh-and-retry on 401 — covers the
  // case where a token is revoked or invalidated before its stated expiry.
  // Returns the raw Response so callers own status handling.
  async function apiFetch(url, options = {}) {
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
      ownerId: (auth && auth.ownerId) || null,
      connectedAt: (auth && auth.connectedAt) || null,
    };
  }

  EB.hubspotAuth = {
    login,
    logout,
    getAuthState,
    getAccessToken,
    apiFetch,
    HubSpotAuthError,
    AUTH_KEY,
    TOKEN_KEY,
  };
})();
