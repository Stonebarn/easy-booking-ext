// hubspot-config.js — OAuth configuration for the "Easy Booking CRM" HubSpot
// app (portal 40063500).
//
// ─────────────────────────────────────────────────────────────────────────────
// THE CLIENT SECRET IS EMBEDDED IN THE EXTENSION BY EXPLICIT DECISION
// (2026-08-05). HubSpot does not support PKCE, so the token exchange needs the
// secret somewhere; for an internal tool used by ~8 SDRs on an unpacked install
// with a private-distribution app, a whole token-exchange backend was judged
// not worth its keep. There is no server: the extension talks to HubSpot
// directly.
//
// This is only acceptable while ALL of the following hold:
//   • this repository stays PRIVATE;
//   • the HubSpot app stays private-distribution (not Web-Store published,
//     not marketplace-listed);
//   • the extension is distributed internally.
//
// ROTATE THE SECRET IMMEDIATELY if any of that changes — the repo goes public
// or is forked outside Wiza, the extension ships to the Chrome Web Store, or a
// leak is suspected. Rotate in HubSpot: developer account → Easy Booking CRM →
// Auth → client secret → rotate, then update CLIENT_SECRET below. At that point
// also revisit the decision: the fallback is a ~100-line Cloudflare Worker
// exposing /token + /refresh, origin-locked to this extension's ID.
// ─────────────────────────────────────────────────────────────────────────────
//
// Plain IIFE + a global namespace, not an ES module: the repo has no build step
// and CI runs `node --check` on every .js file, which parses them as CommonJS
// (so `import`/`export` here would fail the build). Load order in
// sidepanel.html supplies the dependency: this file, then hubspot-auth.js,
// then sidepanel.js. `self` rather than `window` so the same file could also be
// imported by the service worker.

(() => {
  "use strict";

  const EB = (self.EB = self.EB || {});

  EB.hubspotConfig = {
    // ---- Paste these two from the HubSpot app's Auth tab -------------------
    // developers.hubspot.com → your developer account → Apps → "Easy Booking
    // CRM" → Auth. Copy "Client ID" and "Client secret" verbatim.
    CLIENT_ID: "FILL_ME_CLIENT_ID",
    CLIENT_SECRET: "FILL_ME_CLIENT_SECRET",
    // -----------------------------------------------------------------------

    // Must match a redirect URL registered on that same Auth tab, exactly.
    // chrome.identity.launchWebAuthFlow only intercepts this host, and the
    // extension ID is pinned by the "key" field in manifest.json — if that key
    // is ever removed the ID changes and this URL stops matching (hubspot-auth
    // logs loudly when that happens).
    REDIRECT_URL: "https://ihajiebioinbhaljdmaihgonjglhalpa.chromiumapp.org/hubspot",

    // Every scope checked as *required* in the app's Auth settings must appear
    // in the authorize URL's `scope` parameter, or HubSpot refuses the install
    // ("the provided scopes are missing/insufficient"). `oauth` is required on
    // the app, so it is listed here explicitly — HubSpot does not add it for us.
    // Keep this list in sync with the app's Auth tab. Engagement scopes
    // (crm.objects.notes.*, …) get added in Phase 4 only if a MISSING_SCOPES
    // error actually names them.
    SCOPES: [
      "oauth",
      "crm.objects.contacts.read",
      "crm.objects.contacts.write",
      "crm.objects.companies.read",
      "crm.objects.companies.write",
      "crm.objects.deals.read",
      "crm.objects.owners.read",
    ],

    AUTHORIZE_URL: "https://app.hubspot.com/oauth/authorize",
    // v3 (v1 is deprecated). Both token endpoints take form-URL-encoded bodies
    // so the client secret never lands in a query string or a server log.
    TOKEN_URL: "https://api.hubapi.com/oauth/v3/token",
    INTROSPECT_URL: "https://api.hubapi.com/oauth/v3/token/introspect",
    // Base for CRM calls. api.hubapi.com (not api.hubspot.com) because that is
    // what manifest.json grants host permission for.
    API_BASE: "https://api.hubapi.com",

    // The portal these SDRs work in — used for record deep links in Phase 3.
    PORTAL_ID: "40063500",
  };

  // Guard against shipping/booting with the placeholders still in place; the
  // panel turns this into a visible "setup needed" state rather than a failed
  // OAuth round trip.
  EB.hubspotConfig.isConfigured = function isConfigured() {
    const c = EB.hubspotConfig;
    return !!(
      c.CLIENT_ID &&
      c.CLIENT_SECRET &&
      !c.CLIENT_ID.startsWith("FILL_ME") &&
      !c.CLIENT_SECRET.startsWith("FILL_ME")
    );
  };
})();
