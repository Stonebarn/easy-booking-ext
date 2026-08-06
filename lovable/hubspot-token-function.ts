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
// function only mints tokens. It is locked to the extension's origin.
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

const EXTENSION_ID = "ihajiebioinbhaljdmaihgonjglhalpa";
const ALLOWED_ORIGIN = `chrome-extension://${EXTENSION_ID}`;
const REDIRECT_URL = `https://${EXTENSION_ID}.chromiumapp.org/hubspot`;
const TOKEN_URL = "https://api.hubapi.com/oauth/v3/token";
const INTROSPECT_URL = "https://api.hubapi.com/oauth/v3/token/introspect";

// Wiza's HubSpot portal (see PRODUCT.md § Operating Context). Any token that
// introspects to a different hub is rejected — see checkHubAllowlist below.
const WIZA_HUB_ID = 40063500;

const CORS = {
  "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Vary": "Origin",
};

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
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
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS });
  }
  if (req.method !== "POST") {
    return json({ error: "method_not_allowed" }, 405);
  }

  // Only the pinned extension may mint tokens here.
  if ((req.headers.get("Origin") ?? "") !== ALLOWED_ORIGIN) {
    return json({ error: "forbidden_origin" }, 403);
  }

  const clientKey = (req.headers.get("X-Forwarded-For") ?? "").split(",")[0].trim() || "no-ip";
  if (isRateLimited(clientKey)) {
    console.error(`[hubspot-token] rate limit hit for ${clientKey}`);
    return json({ error: "rate_limited" }, 429);
  }

  let payload: { action?: string; code?: string; refresh_token?: string };
  try {
    payload = await req.json();
  } catch {
    return json({ error: "invalid_json" }, 400);
  }

  if (payload.action === "exchange") {
    if (!payload.code) return json({ error: "missing_code" }, 400);
    const result = await hubspotForm(TOKEN_URL, {
      grant_type: "authorization_code",
      redirect_uri: REDIRECT_URL,
      code: payload.code,
    });
    if (!result.ok) {
      return json({ error: "exchange_failed", detail: result.data }, result.status);
    }
    // Server-side identity lookup (introspect also requires the secret).
    const intro = await introspectToken(result.data.access_token);
    const { allowed, hubId } = checkHubAllowlist("exchange", intro);
    if (!allowed) {
      return json({ error: "forbidden_hub" }, 403);
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
    );
  }

  if (payload.action === "refresh") {
    if (!payload.refresh_token) return json({ error: "missing_refresh_token" }, 400);
    const result = await hubspotForm(TOKEN_URL, {
      grant_type: "refresh_token",
      refresh_token: payload.refresh_token,
    });
    if (!result.ok) {
      return json({ error: "refresh_failed", detail: result.data }, result.status);
    }
    const intro = await introspectToken(result.data.access_token);
    const { allowed, hubId } = checkHubAllowlist("refresh", intro);
    if (!allowed) {
      return json({ error: "forbidden_hub" }, 403);
    }
    // Visibility only — timestamp and hub_id, NEVER the token itself — so an
    // unexpected caller (wrong hub, unexpected volume) is at least visible in
    // Lovable's function logs.
    console.log(`[hubspot-token] refresh at ${new Date().toISOString()} hub_id=${hubId ?? "unknown"}`);
    return json(
      { access_token: result.data.access_token, expires_in: result.data.expires_in },
      200,
    );
  }

  return json({ error: "unknown_action" }, 400);
});
