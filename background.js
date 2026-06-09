// background.js — minimal service worker.
// Storage is the source of truth and content scripts read/write it directly,
// so the worker mostly exists for lifecycle logging and future message relay.

chrome.runtime.onInstalled.addListener(() => {
  console.debug("[EasyBooking] installed/updated");
});
