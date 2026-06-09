# Contributing

Thanks for helping improve Easy Booking. This is an internal Wiza tool; keep
changes small, well-described, and easy to roll back.

## Getting set up

There's no build step. Load the extension unpacked:

1. `chrome://extensions` → enable **Developer mode**
2. **Load unpacked** → select this repo folder
3. After any change, click the extension's **reload** icon, then reload the
   affected tab(s).

## Before opening a PR

- [ ] Run the manifest validator: `node scripts/validate.mjs`
- [ ] Manually test the full flow: prospect loaded in the Nooks dialer →
      booking form auto-fills on `scheduler.default.com`.
- [ ] Confirm you did **not** hard-code Nooks' generated CSS classes
      (`css-…`). Anchor on stable signals (field labels, placeholders, roles).
- [ ] Verify the script does not overwrite a value the rep already typed.
- [ ] Update [CHANGELOG.md](./CHANGELOG.md) and bump `version` in
      `manifest.json` if behavior changed.

## Conventions

- **Manifest V3**, plain JS — no framework, no bundler.
- Keep selector logic resilient and ordered most-reliable-first, with
  heuristic fallbacks.
- Gate noisy logging behind `console.debug` and prefix messages with
  `[EasyBooking]`.
- Document any new config knob in the README's Configuration table.

## Reporting issues

Use the issue templates under **Issues → New issue**. For a fill failure,
include: the prospect's dialer state (a screenshot with the email redacted is
fine), the booking URL, and any `[EasyBooking]` console output.

## Versioning

This project follows [SemVer](https://semver.org/). Bump:

- **patch** — selector tweak / bug fix, no behavior change
- **minor** — new behavior or config option
- **major** — breaking change to how/where it runs
