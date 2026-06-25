// popup.js — shows the currently captured prospect (email + timezone) and lets
// the rep trigger a manual fill on the active scheduler tab.

const STORAGE_KEY = "eb:currentProspect";
const MAX_AGE_MS = 30 * 60 * 1000;

const headerEl = document.getElementById("header");
const capturedEl = document.getElementById("captured");
const emptyEl = document.getElementById("empty");
const emailEl = document.getElementById("email");
const tzFieldEl = document.getElementById("tz-field");
const tzEl = document.getElementById("tz");
const tzSubEl = document.getElementById("tz-sub");
const metaEl = document.getElementById("meta");
const fillBtn = document.getElementById("fill");

function fmtOffset(min) {
  if (min == null) return "";
  const sign = min < 0 ? "-" : "+";
  const a = Math.abs(min);
  const h = Math.floor(a / 60);
  const m = a % 60;
  return `UTC${sign}${h}${m ? ":" + String(m).padStart(2, "0") : ""}`;
}

function render(payload) {
  const hasProspect = payload && payload.email;
  capturedEl.style.display = hasProspect ? "" : "none";
  emptyEl.style.display = hasProspect ? "none" : "";
  fillBtn.disabled = !hasProspect;
  headerEl.classList.toggle("live", !!hasProspect);
  if (!hasProspect) return;

  emailEl.textContent = payload.email;

  // Timezone: prefer a clear abbreviation + offset; show the prospect's local
  // clock as a secondary line. The scheduler resolves this to Default's zone.
  const hasTz = payload.tzAbbr || payload.timezone || payload.tzOffsetMin != null;
  tzFieldEl.style.display = hasTz ? "" : "none";
  if (hasTz) {
    const off = fmtOffset(payload.tzOffsetMin);
    const main = [payload.tzAbbr || payload.timezone, off].filter(Boolean).join(" · ");
    tzEl.textContent = main || "—";
    const localTime = payload.timezoneRaw && (payload.timezoneRaw.match(/\(([^)]+)\)/) || [])[1];
    tzSubEl.textContent = localTime ? `${localTime} their time` : "";
    tzSubEl.style.display = localTime ? "" : "none";
  }

  const ageMin = payload.capturedAt ? Math.round((Date.now() - payload.capturedAt) / 60000) : null;
  const stale = payload.capturedAt && Date.now() - payload.capturedAt > MAX_AGE_MS;
  metaEl.classList.toggle("stale", !!stale);
  if (ageMin === null) metaEl.textContent = "captured from Nooks";
  else if (stale) metaEl.textContent = `captured ${ageMin}m ago — may be stale`;
  else metaEl.textContent = ageMin <= 0 ? "captured just now" : `captured ${ageMin}m ago`;
}

chrome.storage.local.get(STORAGE_KEY, (res) => render(res && res[STORAGE_KEY]));

fillBtn.addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !/^https:\/\/scheduler\.default\.com\//.test(tab.url || "")) {
    metaEl.textContent = "Open the booking tab first, then click again.";
    return;
  }
  // Re-trigger the scheduler content script by nudging storage (its onChanged
  // listener will re-attempt the fill).
  const res = await chrome.storage.local.get(STORAGE_KEY);
  const payload = res[STORAGE_KEY];
  if (payload) {
    await chrome.storage.local.set({
      [STORAGE_KEY]: { ...payload, capturedAt: Date.now() },
    });
    metaEl.textContent = "Fill triggered.";
  }
});
