# Changelog

## 0.1.1 — 2026-11-16

Polish pass on the badge and the panel.

- The badge counts seconds inside the last hour (`18:05`), keeps `h:mm` above it and days beyond
  one, and the tooltip keeps the same resolution instead of rounding to minutes.
- The timeline's now marker carries the local time it stands for, hugging the edge of the band at
  the very start and end of a day.
- The price table folds into a `<details>` block, collapsed by default, so the balance and the
  session spend stay above the fold.
- The model row stacks the provider under the model instead of joining them with a separator that
  wrapped mid-token in the composer.
- Ready for publication: one-image detail documents in English, Russian and Chinese over a
  text-free preview, `docs` in the packaged files, `engines.dsh` narrowed to `^0.2.1-rc.1`, and a
  release section in the README.

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
- Dictionaries in English, Russian and Chinese; `Intl` formatting follows the active UI language,
  including durations above a day and the localized price-check date.
- The balance is account-wide and shown for every provider; the spend and the price table appear
  only for DeepSeek's direct routes, and the policy day is labelled as Beijing's.
- Keyboard opening moves focus into the panel, closing restores the previous focus, and Refresh
  retries the finance payload and a failed holiday calendar together.
- Tests: engine boundaries, weekend and holiday carry, timeline, price table, Host routes and
  guards, client bundle wiring, generated-block parity, packaging.
