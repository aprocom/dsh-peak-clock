# Peak Clock

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin that answers one
question with one glance: **is DeepSeek charging full price right now, and for how much longer?**

DeepSeek publishes two prices for the same model. Peak hours are **01:00–04:00 and 06:00–10:00
UTC, Monday to Friday, excluding Chinese public holidays**; every other hour — nights, weekends,
holidays — costs **half**. Those hours are written in UTC on a Beijing calendar, which is exact and
unreadable at the same time. Peak Clock renders the current window, the countdown, the schedule in
your own timezone, the published price table, your Platform balance and the spend of the session
you are looking at.

Community plugin, not an official DeepSeek product.

## What you get

A badge in the composer tool row, just left of the model selector:

- a state dot (amber for peak, green for off-peak), the state name and the time left;
- a click opens the detail panel.

The detail panel is a card portalled to the page body, so it is never clipped by the composer:

- **countdown** to the exact moment the price changes, with the rate chip (`full price` / `half price`);
- **local-day timeline**: your own day from 00:00 to 24:00, every peak stretch in amber, a marker for now;
- **next change**: `Peak starts today at 04:00` — with `tomorrow` or a date when it is not today;
- **peak hours in your timezone**, your zone with its UTC offset, the policy day in Beijing (weekday,
  weekend, or the holiday name), and the time in Beijing;
- **price table**: cache-hit input, cache-miss input and output for `deepseek-flash` and
  `deepseek-v4-pro`, peak and off-peak, in USD per 1M tokens, with the date it was checked;
- **money**: the Platform balance (recharge and bonus wallets, shown for any provider because it is
  account-wide) and, for a DeepSeek route, this session's spend in USD, priced message by message at
  the window each request settled in and marked `≈` when the total is partial;
- honest warnings: a degraded holiday calendar, an unreadable balance, messages without token
  usage, unpriced model ids — each with the Refresh button that retries both the payload and the
  calendar;

## Requirements

- DeepSeek Harness **0.2.x** (developed and verified against `0.2.2-rc.3`, Desktop and Web).
- No build step, no runtime dependencies, no configuration.
- The clock works without any account. The balance and the spend need the DeepSeek account
  service (`deepseekAccount`) and a signed-in account; without them the panel says so and the
  clock keeps working.

## Install

From GitHub (once published to a repository):

```sh
dsh plugin --profile desktop add github:<owner>/dsh-peak-clock
```

From a checkout:

```sh
git clone <repository> dsh-peak-clock
dsh plugin --profile desktop add /absolute/path/to/dsh-peak-clock
```

Or open **Plugins** in the sidebar, choose **Add plugin**, and install the package directory. Then
reload the window (`Cmd+R` / `Ctrl+R`): the browser half is loaded lazily.

Remove it with `dsh plugin --profile desktop remove dsh-peak-clock`.

## How it decides

The policy is evaluated where it is written — in UTC, on the Beijing calendar:

```
peak  = weekday(Beijing date) ∈ Mon..Fri
        AND Beijing date is not a Chinese public holiday
        AND minute-of-day(UTC) ∈ [01:00, 04:00) ∪ [06:00, 10:00)
```

Beijing is UTC+8 with no daylight saving time, so a UTC window keeps its minute-of-day in Beijing;
nothing has to guess. Rendering is yours: the timeline, the clock strings and the next-change line
are formatted in your timezone with `Intl`, so a 23- or 25-hour day still draws and counts
correctly.

Three honesty rules the panel follows:

1. **A week is not four windows.** A window boundary only counts when the price actually changes
   across it, so Friday 10:00 UTC is the next change for a whole weekend, and a holiday that falls
   on a Tuesday produces no transition at all.
2. **A model that is not DeepSeek's own invoice gets no DeepSeek claim.** Prices and money are
   shown for the direct routes (`deepseek-account`, `deepseek-official`). With another provider
   selected, the panel says the schedule does not apply; with an unknown provider it shows the
   published table but attributes no spend.
3. **An estimate says it is an estimate.** Spend is priced per `assistant/message` at
   `event.time`; messages without usage are counted and the total is labelled partial.

## Holidays

The Chinese public-holiday calendar is bundled for **2026 and 2027**, transcribed from the State
Council notices into stable keys (`spring-festival`, `national-day`, …) and shipped in
[`lib/holidays.json`](lib/holidays.json). A year outside the bundle is fetched by the Host half from
`holiday-cn` mirrors (with `timor.tech` as a third source), cached for 12 hours, and labelled in the
panel. When every source fails, the plugin falls back to the weekday rule and **says so** — it never
presents a guess as the calendar.

Adjusted make-up workdays (调休) that fall on a Saturday or Sunday are kept in the file for display,
but they stay off-peak: the published rule is Monday to Friday, and a Saturday is not one.

## Privacy and security

- The browser half computes the clock locally. It sends no session content, no model text and no
  credentials anywhere.
- Two same-origin Host routes exist, both `GET`/`HEAD` only, both `cache-control: no-store`:
  - `/api/peak-clock/holidays?year=YYYY` — the calendar of one year;
  - `/api/peak-clock/finance?sessionId=…` — the price table revision, the balance and the spend.
- They refuse cross-site requests (`Sec-Fetch-Site`, and an `Origin` that disagrees with `Host`).
  They carry no authentication of their own: they are meant for a Harness bound to loopback, like
  the rest of the Web UI. Do not expose the Harness to a network you do not trust.
- The balance is read through `ctx.deepseekAccount.getBalance`; the credential never leaves the
  Host. Nothing is written to disk and nothing is logged.
- The only third-party requests are the holiday mirrors, and only for a year the bundle does not
  cover.

## Configuration

None. The price table, the peak windows and the holiday file live in the package so an install
cannot half-apply a policy. When DeepSeek changes its prices, edit
[`lib/rules.js`](lib/rules.js), bump `PRICING_UPDATED`, run `node scripts/sync-client.mjs` and
reload the window; the panel shows the new check date.

## Development

```sh
node --test            # the whole suite, no dependencies
node scripts/sync-client.mjs   # regenerate the engine, rules and calendar copies inside client.js
```

Layout:

| Path | Role |
|---|---|
| `index.js` | Host half: the two routes, the calendar cache, the spend fold, the balance read |
| `lib/engine.js` | Canonical clock: UTC windows, Beijing calendar, transitions, local-day timeline |
| `lib/rules.js` | Canonical price table, model matching, cost of one request |
| `lib/holidays.json` | Bundled 2026–2027 notices |
| `client.js` | Browser half: badge, panel, dictionaries, styles |
| `scripts/sync-client.mjs` | Copies engine, rules and calendar into `client.js` |

`client.js` cannot import the Host modules: the loader serves only the package's `./client`
export. The copies are therefore generated, and `test/engine-sync.test.mjs` fails when a copy and
its source disagree — a change to the policy has to reach the browser half.

## Known limitations

- The spend is an estimate for the current session only; a request that starts before a boundary
  and settles after it is priced entirely in the window it settled in.
- The day reason follows the Beijing calendar, which is what the price rule is written on, while the
  next change is expressed in your local days; the panel labels the row `Day (Beijing)` so a Moscow
  evening and a Beijing morning cannot be confused.
- The timeline samples the local day every five minutes, and its quarter labels assume a 24-hour
  day; on a daylight-saving day the marker and the countdown stay exact, but the labels can sit an
  hour off.
- The holiday mirrors are third-party services. A year they cannot answer stays on the weekday
  rule, with a warning.
- The bundled calendar ends at 2027. A later year is fetched; if that fails, the panel says so.

## License

MIT. Not affiliated with, endorsed by, or supported by DeepSeek.
