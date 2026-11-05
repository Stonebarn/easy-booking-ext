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

    // The OAuth redirect URL for THIS install, derived from the running
    // extension's ID. chrome.identity.launchWebAuthFlow only intercepts
    // https://<this-extension's-id>.chromiumapp.org/, so a URL built from any
    // other ID loads as a real page and dies on DNS_PROBE_POSSIBLE.
    //
    // There are two IDs, and both have to work:
    //   - the Chrome Web Store install: the store strips manifest.json's
    //     "key" (scripts/package-store.mjs) and assigns its own ID;
    //   - the unpacked/dev install: the "key" in manifest.json pins it.
    // Each one's redirect URL must be registered in TWO other places, or that
    // install cannot connect:
    //   1. the HubSpot app's Auth tab (hubspot-app/src/app/app-hsmeta.json
    //      redirectUrls, shipped with `hs project upload`);
    //   2. ALLOWED_EXTENSION_IDS in lovable/hubspot-token-function.ts, which
    //      origin-locks the function and derives the redirect_uri it sends
    //      HubSpot from the caller's ID (the two must agree or the exchange
    //      fails).
    // KNOWN_EXTENSION_IDS below is the extension's copy of that list;
    // hubspot-auth logs loudly when the running ID is not on it.
    REDIRECT_URL: (() => {
      try {
        if (typeof chrome !== "undefined" && chrome.identity && chrome.identity.getRedirectURL) {
          return chrome.identity.getRedirectURL("hubspot");
        }
      } catch (_) {
        /* fall through to the dev URL below */
      }
      // No identity API here (a context without the permission, or a test
      // harness). The dev URL is the least-wrong guess, and only works for the
      // unpacked install.
      console.error(
        "[EasyBooking] chrome.identity unavailable — falling back to the dev redirect URL; HubSpot sign-in from a store install will fail"
      );
      return "https://ihajiebioinbhaljdmaihgonjglhalpa.chromiumapp.org/hubspot";
    })(),

    // Every extension ID whose redirect URL is registered on the HubSpot app
    // and allowlisted in the edge function. Keep in lockstep with
    // ALLOWED_EXTENSION_IDS in lovable/hubspot-token-function.ts and
    // redirectUrls in hubspot-app/src/app/app-hsmeta.json;
    // scripts/validate.mjs fails on any chromiumapp.org/hubspot URL whose ID
    // is not on this list.
    KNOWN_EXTENSION_IDS: [
      "dhmhnhegpigpedbfpplkodihmljhkcff", // Chrome Web Store install
      "ihajiebioinbhaljdmaihgonjglhalpa", // unpacked/dev install (manifest "key")
    ],

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
      // sales-email-read (v0.9.1): lets the Activity section's Emails tab read
      // one-to-one email engagements. It is in the app's optionalScopes, not
      // requiredScopes, so the 0.9.0 store build (which never asks for it)
      // keeps connecting. Reps on 0.9.1 disconnect and reconnect once to grant it.
      "sales-email-read",
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
