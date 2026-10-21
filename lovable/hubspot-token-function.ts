// Easy Booking — HubSpot token-exchange edge function (deploy on Lovable Cloud).
//
// Purpose: the Chrome extension must never hold the OAuth client secret
// (SOC 2 secrets-management). This function performs the only two OAuth
// operations that need it, plus a server-side identity lookup:
//
//   POST { action: "exchange", code }            -> tokens + SDR identity
//   POST { action: "refresh",  refresh_token }   -> fresh access token
//
// Secrets (set in Lovable Cloud's secret store, NEVER in code):
//   HUBSPOT_CLIENT_ID
//   HUBSPOT_CLIENT_SECRET
//
// All CRM traffic still flows extension -> api.hubapi.com directly; this
// function only mints tokens. It is locked to the extension's origins.
//
// Two extension IDs, both allowlisted (ALLOWED_EXTENSION_IDS):
//   - dhmhnhegpigpedbfpplkodihmljhkcff: the Chrome Web Store install (the
//     store zip strips manifest.json's "key", so the store assigns this ID);
//   - ihajiebioinbhaljdmaihgonjglhalpa: the unpacked/dev install (pinned by
//     the "key" in manifest.json).
// The request's Origin must be chrome-extension://<one of them>; CORS echoes
// that exact origin back (never a wildcard). The redirect_uri sent to HubSpot
// on exchange is DERIVED from the validated origin's ID, never taken from the
// request body: a body redirect_uri is only checked against the derived one
// (400 redirect_mismatch if they differ). Each ID's
// https://<id>.chromiumapp.org/hubspot must also be registered on the HubSpot
// app's Auth tab (hubspot-app/src/app/app-hsmeta.json) and listed in the
// extension's KNOWN_EXTENSION_IDS (hubspot-config.js). All three must agree.
//
// Hardening notes (all fail-open / best-effort — see each section below):
//   - Introspection now sends the field HubSpot's endpoint actually requires
//     (`token`, not `token_type_hint`/`access_token`) and every introspect
//     failure is logged with its status + a body snippet instead of being
//     swallowed. user_email/user_id in the exchange response are real values
//     again, though the extension no longer depends on them for attribution
//     (it self-resolves identity client-side — see hubspot-auth.js).
//   - Hub allowlist: a successful introspection that reports a hub_id other
//     than Wiza's portal (40063500) gets a 403. An introspection FAILURE
//     allows the request through (logged) — an introspect outage must never
//     lock every rep out mid-call.
//   - A small in-memory rate limiter damps a single runaway caller. It is
//     explicitly NOT a real defense; see its comment block for why.
//
// ## Deploying updates
// Lovable Cloud has no CLI/git path from this repo — deploys happen by
// pasting source into Lovable's chat. To ship a change made here:
//   1. Open the wiza-hs-connect Lovable project.
//   2. Paste the FULL, current contents of this file into the chat with the
//      instruction: "replace the hubspot-token function with exactly this
//      source".
//   3. Verify with the curl in this file's PR/commit description (or ask
//      whoever changed it — it POSTs a garbage refresh_token and expects a
//      clean 4xx JSON error back), then check Lovable's function logs for
//      the matching `[hubspot-token]` line.

const ALLOWED_EXTENSION_IDS = [
  "dhmhnhegpigpedbfpplkodihmljhkcff", // Chrome Web Store install
  "ihajiebioinbhaljdmaihgonjglhalpa", // unpacked/dev install (manifest "key")
];
const TOKEN_URL = "https://api.hubapi.com/oauth/v3/token";
const INTROSPECT_URL = "https://api.hubapi.com/oauth/v3/token/introspect";

// Wiza's HubSpot portal (see PRODUCT.md § Operating Context). Any token that
// introspects to a different hub is rejected — see checkHubAllowlist below.
const WIZA_HUB_ID = 40063500;

// The extension ID behind an allowlisted Origin, or null for anything else
// (a web page, curl, an unknown extension).
function allowedExtensionId(origin: string): string | null {
  const m = /^chrome-extension:\/\/([a-p]{32})$/.exec(origin);
  return m && ALLOWED_EXTENSION_IDS.includes(m[1]) ? m[1] : null;
}

// CORS echoes the caller's exact origin when it is allowlisted, and omits
// Allow-Origin entirely otherwise (so the browser blocks the read). Vary:
// Origin keeps any cache in front of us from serving one origin's headers to
// another.
function corsHeaders(extensionId: string | null): Record<string, string> {
  const headers: Record<string, string> = {
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Vary": "Origin",
  };
  if (extensionId) headers["Access-Control-Allow-Origin"] = `chrome-extension://${extensionId}`;
  return headers;
}

function redirectUrlFor(extensionId: string): string {
  return `https://${extensionId}.chromiumapp.org/hubspot`;
}

function json(body: unknown, status: number, cors: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...cors },
  });
}

async function hubspotForm(url: string, params: Record<string, string>) {
  const body = new URLSearchParams({
    client_id: Deno.env.get("HUBSPOT_CLIENT_ID") ?? "",
    client_secret: Deno.env.get("HUBSPOT_CLIENT_SECRET") ?? "",
    ...params,
  });
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  return { ok: res.ok, status: res.status, data: await res.json() };
}

// Introspects an access token. The endpoint's own required-fields error
// (verified live) is "client_id, client_secret, token" — the field is named
// `token`, not `token_type_hint`/`access_token` as this function sent for a
// long time, which is why identity has always come back null (see intro
// failure logging in checkHubAllowlist below, and hubspot-auth.js's
// ensureIdentity() for why the extension no longer relies on this).
async function introspectToken(accessToken: string) {
  const intro = await hubspotForm(INTROSPECT_URL, { token: accessToken });
  return {
    ok: intro.ok,
    status: intro.status,
    data: intro.data,
    hubId: intro.ok && intro.data && typeof intro.data.hub_id === "number" ? intro.data.hub_id : null,
  };
}

// Fail-open by design: an introspect outage (a blip on HubSpot's side, a
// transient 5xx) must never lock every rep out of the tool they're using
// mid-call. Only a SUCCESSFUL introspection that names a foreign hub is
// treated as evidence worth rejecting on.
function checkHubAllowlist(
  action: string,
  intro: { ok: boolean; status: number; data: unknown; hubId: number | null },
): { allowed: boolean; hubId: number | null } {
  if (!intro.ok) {
    const snippet = JSON.stringify(intro.data ?? null).slice(0, 300);
    console.error(`[hubspot-token] introspect failed during ${action}: status=${intro.status} body=${snippet}`);
    return { allowed: true, hubId: null };
  }
  if (intro.hubId != null && intro.hubId !== WIZA_HUB_ID) {
    console.error(`[hubspot-token] rejected ${action}: hub_id ${intro.hubId} is not the allowed portal (${WIZA_HUB_ID})`);
    return { allowed: false, hubId: intro.hubId };
  }
  return { allowed: true, hubId: intro.hubId };
}

// --- Basic abuse damping ----------------------------------------------------
// A small, best-effort speed bump — explicitly NOT a security control.
// Lovable Cloud can run (and cold-start) multiple isolates behind this one
// function, each getting its own copy of this Map, so this counter is
// per-isolate and resets on every cold start: a caller spread across
// isolates, or one who just waits one out, sails straight past it. What it
// DOES catch, cheaply and without any external state: a single runaway loop
// (an extension bug, a stuck retry) hammering one warm isolate. Keyed on the
// caller's IP when Lovable forwards one via X-Forwarded-For; falls back to a
// single shared bucket when it doesn't, which still damps a same-isolate
// flood even without per-caller separation. If real abuse protection is ever
// needed, it belongs in front of this function (e.g. a KV-backed limiter),
// not faked here.
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 30; // generous: normal traffic is one login + a refresh roughly every 25min per SDR
const rateLimitHits = new Map<string, number[]>();

function isRateLimited(key: string): boolean {
  const now = Date.now();
  const hits = (rateLimitHits.get(key) ?? []).filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
  hits.push(now);
  rateLimitHits.set(key, hits);
  return hits.length > RATE_LIMIT_MAX;
}

Deno.serve(async (req: Request) => {
  // Only the allowlisted extensions may mint tokens here. Resolved once, up
  // front, so the preflight and every response carry the same CORS headers.
  const extensionId = allowedExtensionId(req.headers.get("Origin") ?? "");
  const cors = corsHeaders(extensionId);

  if (req.method === "OPTIONS") {
    return new Response(null, { status: extensionId ? 204 : 403, headers: cors });
  }
  if (req.method !== "POST") {
    return json({ error: "method_not_allowed" }, 405, cors);
  }

  if (!extensionId) {
    return json({ error: "forbidden_origin" }, 403, cors);
  }

  const clientKey = (req.headers.get("X-Forwarded-For") ?? "").split(",")[0].trim() || "no-ip";
  if (isRateLimited(clientKey)) {
    console.error(`[hubspot-token] rate limit hit for ${clientKey}`);
    return json({ error: "rate_limited" }, 429, cors);
  }

  let payload: { action?: string; code?: string; refresh_token?: string; redirect_uri?: string };
  try {
    payload = await req.json();
  } catch {
    return json({ error: "invalid_json" }, 400, cors);
  }

  if (payload.action === "exchange") {
    if (!payload.code) return json({ error: "missing_code" }, 400, cors);
    // Derived from the validated Origin, never from the body. The extension
    // sends its own redirect_uri; a mismatch means its config and this
    // allowlist disagree, so fail loudly here rather than as an opaque
    // HubSpot error.
    const redirectUri = redirectUrlFor(extensionId);
    if (payload.redirect_uri != null && payload.redirect_uri !== redirectUri) {
      console.error(`[hubspot-token] redirect_uri mismatch for ${extensionId}: body=${String(payload.redirect_uri).slice(0, 200)} derived=${redirectUri}`);
      return json({ error: "redirect_mismatch" }, 400, cors);
    }
    const result = await hubspotForm(TOKEN_URL, {
      grant_type: "authorization_code",
      redirect_uri: redirectUri,
      code: payload.code,
    });
    if (!result.ok) {
      return json({ error: "exchange_failed", detail: result.data }, result.status, cors);
    }
    // Server-side identity lookup (introspect also requires the secret).
    const intro = await introspectToken(result.data.access_token);
    const { allowed, hubId } = checkHubAllowlist("exchange", intro);
    if (!allowed) {
      return json({ error: "forbidden_hub" }, 403, cors);
    }
    const who: { user?: string; user_id?: number } | null = intro.ok ? intro.data : null;
    return json(
      {
        access_token: result.data.access_token,
        refresh_token: result.data.refresh_token,
        expires_in: result.data.expires_in,
        hub_id: result.data.hub_id ?? hubId ?? null,
        user_email: who?.user ?? null,
        user_id: who?.user_id ?? null,
      },
      200,
      cors,
    );
  }

  if (payload.action === "refresh") {
    if (!payload.refresh_token) return json({ error: "missing_refresh_token" }, 400, cors);
    const result = await hubspotForm(TOKEN_URL, {
      grant_type: "refresh_token",
      refresh_token: payload.refresh_token,
    });
    if (!result.ok) {
      return json({ error: "refresh_failed", detail: result.data }, result.status, cors);
    }
    const intro = await introspectToken(result.data.access_token);
    const { allowed, hubId } = checkHubAllowlist("refresh", intro);
    if (!allowed) {
      return json({ error: "forbidden_hub" }, 403, cors);
    }
    // Visibility only — timestamp and hub_id, NEVER the token itself — so an
    // unexpected caller (wrong hub, unexpected volume) is at least visible in
    // Lovable's function logs.
    console.log(`[hubspot-token] refresh at ${new Date().toISOString()} hub_id=${hubId ?? "unknown"}`);
    return json(
      { access_token: result.data.access_token, expires_in: result.data.expires_in },
      200,
      cors,
    );
  }

  return json({ error: "unknown_action" }, 400, cors);
});
