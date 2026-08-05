// background.js — MV3 service worker.
// Storage is the source of truth; content scripts read/write it directly. The
// worker's job here is the toolbar badge: a green check when a fresh prospect
// is captured, cleared when it goes stale (older than MAX_AGE_MS) or absent.
// It also wires the toolbar icon to open the side panel (there is no
// action.default_popup — a manifest popup would defeat openPanelOnActionClick).

const STORAGE_KEY = "eb:currentProspect";
const MAX_AGE_MS = 30 * 60 * 1000; // keep in sync with content-scheduler.js
const STALE_ALARM = "eb:stale";
const GREEN = "#22c55e";

function isFresh(p) {
  return !!(p && p.email && p.capturedAt && Date.now() - p.capturedAt < MAX_AGE_MS);
}

async function refreshBadge() {
  const res = await chrome.storage.local.get(STORAGE_KEY);
  const p = res && res[STORAGE_KEY];
  if (isFresh(p)) {
    chrome.action.setBadgeText({ text: "✓" });
    chrome.action.setBadgeBackgroundColor({ color: GREEN });
    chrome.action.setTitle({ title: `Easy Booking — ${p.email} captured` });
    // Re-evaluate (and clear) the moment this capture goes stale.
    chrome.alarms.create(STALE_ALARM, { when: p.capturedAt + MAX_AGE_MS + 1000 });
  } else {
    chrome.action.setBadgeText({ text: "" });
    chrome.action.setTitle({ title: "Easy Booking" });
  }
}

// Clicking the toolbar icon toggles the side panel. Set on both install and
// startup: the setting is not guaranteed to survive a browser restart, and the
// worker has no other reliable "first run of this session" hook.
async function enableSidePanelOnActionClick() {
  try {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.debug("[EasyBooking] could not set side panel behavior:", e && e.message);
  }
}

async function init() {
  await enableSidePanelOnActionClick();
  await refreshBadge();
}

chrome.runtime.onInstalled.addListener(init);
chrome.runtime.onStartup.addListener(init);

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes[STORAGE_KEY]) refreshBadge();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === STALE_ALARM) refreshBadge();
});
