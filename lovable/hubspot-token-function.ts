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

const EXTENSION_ID = "ihajiebioinbhaljdmaihgonjglhalpa";
const ALLOWED_ORIGIN = `chrome-extension://${EXTENSION_ID}`;
const REDIRECT_URL = `https://${EXTENSION_ID}.chromiumapp.org/hubspot`;
const TOKEN_URL = "https://api.hubapi.com/oauth/v3/token";
const INTROSPECT_URL = "https://api.hubapi.com/oauth/v3/token/introspect";

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
    let who: { user?: string; user_id?: number; hub_id?: number } | null = null;
    const intro = await hubspotForm(INTROSPECT_URL, {
      token_type_hint: "access_token",
      access_token: result.data.access_token,
    });
    if (intro.ok) who = intro.data;
    return json(
      {
        access_token: result.data.access_token,
        refresh_token: result.data.refresh_token,
        expires_in: result.data.expires_in,
        hub_id: result.data.hub_id ?? who?.hub_id ?? null,
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
    return json(
      { access_token: result.data.access_token, expires_in: result.data.expires_in },
      200,
    );
  }

  return json({ error: "unknown_action" }, 400);
});
