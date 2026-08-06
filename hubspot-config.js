// hubspot-config.js — OAuth configuration for the "Easy Booking CRM" HubSpot
// app (portal 40063500).
//
// There is NO client secret in this file, or anywhere else in the extension.
// Per SOC 2 secrets management, the secret lives only in Lovable Cloud's secret
// store, and the two OAuth operations that need it (authorization-code exchange
// and refresh) happen inside the hosted edge function at TOKEN_PROXY_URL — see
// lovable/hubspot-token-function.ts. Everything else (all CRM reads and writes)
// still goes from the extension straight to api.hubapi.com.
//
// The client ID stays here because it is not a secret: it is a public
// identifier, and the browser-side authorize URL cannot be built without it.
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
    // Public identifier for the "Easy Booking CRM" app (developer account →
    // Apps → Easy Booking CRM → Auth → "Client ID"). Not a secret. The client
    // *secret* from that same tab is never stored here — it lives only in
    // Lovable Cloud's secret store as HUBSPOT_CLIENT_SECRET.
    CLIENT_ID: "8d295d37-31c3-4075-8b97-1565ed99025f",

    // The deployed token-exchange function. It holds the client secret and is
    // origin-locked to this extension; see lovable/hubspot-token-function.ts.
    TOKEN_PROXY_URL: "https://wiza-hs-connect.lovable.app/api/public/hubspot-token",

    // Must match a redirect URL registered on the app's Auth tab exactly, and
    // also the REDIRECT_URL constant inside the edge function — the function
    // sends its own redirect_uri to HubSpot, and the two must agree or the
    // exchange fails. chrome.identity.launchWebAuthFlow only intercepts this
    // host, and the extension ID is pinned by the "key" field in manifest.json;
    // if that key is ever removed the ID changes and this URL stops matching
    // (hubspot-auth logs loudly when that happens).
    REDIRECT_URL: "https://ihajiebioinbhaljdmaihgonjglhalpa.chromiumapp.org/hubspot",

    // Every scope checked as *required* in the app's Auth settings must appear
    // in the authorize URL's `scope` parameter, or HubSpot refuses the install
    // ("the provided scopes are missing/insufficient"). `oauth` is required on
    // the app, so it is listed here explicitly — HubSpot does not add it for us.
    // Keep this list in sync with the app's Auth tab. Engagement scopes
    // (crm.objects.notes.*, …) get added in Phase 4 only if a MISSING_SCOPES
    // error actually names them.
    //
    // crm.objects.custom.read (Phase 12): reads the Wiza User / Wiza Account /
    // Trial custom objects for the richer Wiza usage section. It is on the
    // app's Auth tab as of build #10, but a rep's TOKEN only carries a scope
    // it was actually issued with — this array is what asks HubSpot for it on
    // the next connect. Until a rep reconnects, hubspot-data.js's
    // fetchCustomObject sees 403 MISSING_SCOPES on every custom-object read
    // and degrades silently to the rollup properties, exactly as it did
    // before this scope existed — see the Wiza custom objects note in the
    // README.
    SCOPES: [
      "oauth",
      "crm.objects.contacts.read",
      "crm.objects.contacts.write",
      "crm.objects.companies.read",
      "crm.objects.deals.read",
      "crm.objects.owners.read",
      "crm.objects.custom.read",
    ],

    // Browser-side authorize step — no secret involved.
    AUTHORIZE_URL: "https://app.hubspot.com/oauth/authorize",
    // Base for CRM calls made directly from the panel. api.hubapi.com (not
    // api.hubspot.com) because that is what manifest.json grants host
    // permission for. HubSpot's token endpoints are deliberately absent here:
    // the extension never calls them.
    API_BASE: "https://api.hubapi.com",

    // The portal these SDRs work in — used for record deep links in Phase 3.
    PORTAL_ID: "40063500",
  };

  // Both values are populated, so this passes today. It stays as a guard: if
  // either is ever blanked or reverted to a FILL_ME placeholder, the panel shows
  // a visible "Setup needed" state instead of failing mid-OAuth.
  EB.hubspotConfig.isConfigured = function isConfigured() {
    const c = EB.hubspotConfig;
    return !!(
      c.CLIENT_ID &&
      c.TOKEN_PROXY_URL &&
      !c.CLIENT_ID.startsWith("FILL_ME") &&
      !c.TOKEN_PROXY_URL.startsWith("FILL_ME")
    );
  };
})();
