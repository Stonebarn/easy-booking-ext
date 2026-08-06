// booked-signal-probe.js — paste into the DevTools console to capture what the
// "meeting booked" celebration needs to anchor on. Run it TWICE, in two places:
//
//   1. THE DIALER TAB (app.nooks.in), on a call you have just dispositioned —
//      ideally as "Meeting Booked". This is the trigger we cannot ship yet: the
//      disposition control appears only during/after a live call, so it is
//      absent from every DOM capture taken so far (docs/nooks-dom-recon.md
//      lists it as an open item). What comes back here is what turns the
//      dialer-side trigger on.
//
//   2. THE BOOKING TAB (scheduler.default.com), on the confirmation screen right
//      after a real booking goes through. Today's shipped detection watches for
//      a confirmation URL, a NEW confirmation phrase, or the form closing (see
//      the BOOKING config in content-scheduler.js). This capture is what
//      replaces those broad guesses with the page's actual markup.
//
// Both dumps are copied to the clipboard and printed. Deliberately no prospect
// data: labels and option text are truncated, and nothing that looks like an
// email, phone number, or note body is collected.
(() => {
  const MAX = 60;
  const trim = (s) => String(s == null ? "" : s).replace(/\s+/g, " ").trim().slice(0, MAX);
  // Belt and braces: never let a prospect's details ride along in a paste.
  const scrub = (s) =>
    trim(s)
      .replace(/[\w.+-]+@[\w.-]+\.\w+/g, "<email>")
      .replace(/\+?\d[\d\s().-]{7,}\d/g, "<phone>");

  const visible = (el) => {
    if (!el || !el.getBoundingClientRect) return false;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== "hidden" && cs.display !== "none";
  };

  const testidChain = (n) => {
    const chain = [];
    for (let p = n && n.parentElement, i = 0; p && i < 8; p = p.parentElement, i++) {
      const t = p.getAttribute && p.getAttribute("data-testid");
      if (t) chain.push(t);
    }
    return chain;
  };

  const host = location.hostname;
  const onDialer = /nooks\./i.test(host);
  const out = { probe: "booked-signal", where: onDialer ? "dialer" : "booking", url: location.pathname + location.search };

  if (onDialer) {
    // ---- 1. The disposition control ------------------------------------
    // Anything a rep could set an outcome with: a <select>, a combobox, a
    // listbox, a radio group, or a plain button row. We record the CONTROL's
    // anchors and its option labels, which is all the extension needs to read
    // "Meeting Booked" back out later.
    const OUTCOME_WORDS =
      /meeting booked|booked|not interested|no answer|voicemail|left message|wrong number|bad number|callback|call back|gatekeeper|do not call|dnc|connected|hung up|no show/i;
    const LABEL_WORDS = /disposition|outcome|call result|result|status|log call/i;

    const ids = [...new Set([...document.querySelectorAll("[data-testid]")].map((n) => n.getAttribute("data-testid")))];
    out.testidCount = ids.length;
    out.dispositionishTestids = ids.filter((id) => /disposition|outcome|result|log|wrap|end-?call/i.test(id));

    out.selects = [...document.querySelectorAll("select")].filter(visible).map((s) => ({
      testid: s.getAttribute("data-testid"),
      name: trim(s.getAttribute("name")),
      ariaLabel: trim(s.getAttribute("aria-label")),
      value: trim(s.value),
      options: [...s.options].slice(0, 20).map((o) => trim(o.textContent)),
      ancestorTestids: testidChain(s),
    }));

    out.comboboxes = [...document.querySelectorAll('[role="combobox"], [role="listbox"], [aria-haspopup="listbox"]')]
      .filter(visible)
      .map((c) => ({
        role: c.getAttribute("role"),
        testid: c.getAttribute("data-testid"),
        ariaLabel: trim(c.getAttribute("aria-label")),
        text: scrub(c.textContent),
        expanded: c.getAttribute("aria-expanded"),
        ancestorTestids: testidChain(c),
      }));

    // Any leaf whose text is a known call outcome — this is what finds a button
    // row or a set of chips that no aria role or testid gives away.
    out.outcomeLeaves = [...document.querySelectorAll("button, [role='option'], [role='menuitem'], [role='radio'], li, span, div")]
      .filter((n) => !n.children.length && visible(n) && OUTCOME_WORDS.test(trim(n.textContent)))
      .slice(0, 30)
      .map((n) => ({
        tag: n.tagName,
        role: n.getAttribute("role"),
        text: trim(n.textContent),
        testid: n.getAttribute("data-testid"),
        ariaSelected: n.getAttribute("aria-selected"),
        ariaChecked: n.getAttribute("aria-checked"),
        className: trim(n.className),
        ancestorTestids: testidChain(n),
      }));

    // Labelled rows ("Disposition: Meeting Booked") — the label→value shape the
    // rest of the scraper already uses.
    out.labelledRows = [...document.querySelectorAll("p, span, div, label")]
      .filter((n) => !n.children.length && visible(n) && LABEL_WORDS.test(trim(n.textContent)))
      .slice(0, 20)
      .map((n) => {
        const row = n.parentElement;
        return {
          label: trim(n.textContent),
          rowText: scrub(row && row.textContent),
          testid: n.getAttribute("data-testid"),
          ancestorTestids: testidChain(n),
        };
      });
    out.note = "Looking for: which control holds the outcome, and the exact text of its 'Meeting Booked' option.";
  } else {
    // ---- 2. The booking confirmation ------------------------------------
    out.urlHasConfirmHint = /confirm|booked|success|thank/i.test(location.href);
    out.title = trim(document.title);
    // Every short visible line on screen, in order: the confirmation headline is
    // certain to be among them, and this is what the phrase list should match.
    out.visibleLines = [...document.querySelectorAll("h1, h2, h3, h4, p, span, div, strong, li")]
      .filter((n) => !n.children.length && visible(n))
      .map((n) => scrub(n.textContent))
      .filter((t) => t && t.length <= MAX)
      .slice(0, 60);
    out.headings = [...document.querySelectorAll("h1, h2, h3, h4")]
      .filter(visible)
      .map((n) => scrub(n.textContent));
    out.buttons = [...document.querySelectorAll("button, a[role='button'], [role='button']")]
      .filter(visible)
      .map((b) => ({ text: trim(b.textContent), ariaLabel: trim(b.getAttribute("aria-label")) }))
      .filter((b) => b.text || b.ariaLabel)
      .slice(0, 25);
    out.emailInputStillPresent = !!document.querySelector(
      'input[type="email"], input[placeholder*="@"], input[placeholder*="email" i]'
    );
    out.note =
      "Looking for: the confirmation headline's exact wording, and whether the URL changes on success.";
  }

  const json = JSON.stringify(out, null, 2);
  console.log(json);
  try {
    (navigator.clipboard && navigator.clipboard.writeText(json)) || copy(json);
    console.log("%c[probe] copied to the clipboard — paste it to Jack/Claude", "color:#7e43ff");
  } catch (e) {
    console.log("[probe] copy failed; select the JSON above and copy it by hand");
  }
  return out;
})();
