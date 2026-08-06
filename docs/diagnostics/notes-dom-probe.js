// notes-dom-probe.js — paste into the DevTools console of the NOOKS DIALER TAB
// (app.nooks.in) DURING a call, with the notes editor visible / just after
// saving a note. Dumps the structure the extension's notes capture needs to
// anchor on — data-testids, editor placement, save buttons — and copies the
// JSON to the clipboard. No note text or prospect data is included beyond the
// first 40 chars of placeholders/labels.
(() => {
  const out = { url: location.pathname, view: null, editors: [], noteish: [], saveButtons: [], dialogs: 0 };
  const ids = [...new Set([...document.querySelectorAll("[data-testid]")].map((n) => n.getAttribute("data-testid")))];
  out.testidCount = ids.length;
  out.noteish = ids.filter((id) => /note|dialog|editor|call/i.test(id));
  out.view = ids.find((id) => /expanded-view|in-call|active-call|dialing/i.test(id)) || null;
  out.dialogs = document.querySelectorAll('[role="dialog"]').length;
  document.querySelectorAll('textarea, [contenteditable="true"]').forEach((n) => {
    const chain = [];
    for (let p = n.parentElement, i = 0; p && i < 8; p = p.parentElement, i++) {
      const t = p.getAttribute && p.getAttribute("data-testid");
      if (t) chain.push(t);
    }
    out.editors.push({
      tag: n.tagName,
      placeholder: (n.placeholder || "").slice(0, 40) || null,
      testid: n.getAttribute("data-testid"),
      inDialog: !!n.closest('[role="dialog"]'),
      visible: n.offsetParent !== null,
      ancestorTestids: chain,
    });
  });
  document.querySelectorAll("button").forEach((b) => {
    const t = (b.textContent || "").trim();
    if (/^(save|add note|add a note|done)$/i.test(t)) {
      out.saveButtons.push({ text: t, testid: b.getAttribute("data-testid"), inDialog: !!b.closest('[role="dialog"]') });
    }
  });
  try { copy(JSON.stringify(out, null, 1)); } catch (e) { /* copy() only exists in DevTools */ }
  console.log(JSON.stringify(out, null, 1));
  return "Probe done — JSON copied to clipboard (and printed above). Paste it back to Claude.";
})();
