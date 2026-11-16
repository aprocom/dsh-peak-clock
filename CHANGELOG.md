# Changelog

## 0.1.0 — 2026-11-16

First version.

- Composer badge for `conversation.input.right`: pricing window, countdown, and a state dot.
- Detail panel portalled to the page body: countdown, local-day timeline, next change, schedule in
  the viewer timezone, today's reason, Beijing time, price table, balance and session spend.
- Host half with two read-only same-origin routes: the holiday calendar and the finance payload.
- Holiday calendar bundled for 2026–2027 from the State Council notices, with a mirrored upstream
  chain for later years and an explicit degraded state.
- Per-message spend priced at the settlement time with the request's own model, plus an unreadable
  and partial-total contract (`skipped`, `unknownModels`, `exact`).
- Dictionaries in English, Russian and Chinese; `Intl` formatting follows the active UI language.
- Tests: engine boundaries, weekend and holiday carry, timeline, price table, Host routes and
  guards, client bundle wiring, generated-block parity, packaging.
