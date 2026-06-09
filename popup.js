// popup.js — shows the currently captured prospect email and lets the rep
// trigger a manual fill on the active scheduler tab.

const STORAGE_KEY = "eb:currentProspect";
const emailEl = document.getElementById("email");
const metaEl = document.getElementById("meta");
const fillBtn = document.getElementById("fill");

function render(payload) {
  if (payload && payload.email) {
    emailEl.textContent = payload.email;
    emailEl.classList.remove("empty");
    const ageMin = payload.capturedAt
      ? Math.round((Date.now() - payload.capturedAt) / 60000)
      : null;
    metaEl.textContent =
      ageMin === null ? "captured from Nooks" : `captured ${ageMin} min ago`;
    fillBtn.disabled = false;
  } else {
    emailEl.textContent = "No prospect email captured yet";
    emailEl.classList.add("empty");
    metaEl.textContent = "Open the Nooks dialer with a prospect loaded.";
    fillBtn.disabled = true;
  }
}

chrome.storage.local.get(STORAGE_KEY, (res) => render(res && res[STORAGE_KEY]));

fillBtn.addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !/^https:\/\/scheduler\.default\.com\//.test(tab.url || "")) {
    metaEl.textContent = "Open the booking tab first, then click again.";
    return;
  }
  // Re-trigger the scheduler content script by nudging storage (its
  // onChanged listener will attempt a fill).
  const res = await chrome.storage.local.get(STORAGE_KEY);
  const payload = res[STORAGE_KEY];
  if (payload) {
    await chrome.storage.local.set({
      [STORAGE_KEY]: { ...payload, capturedAt: Date.now() },
    });
    metaEl.textContent = "Fill triggered.";
  }
});
