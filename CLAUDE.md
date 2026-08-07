# StockResearch

Stock research platform for **US equities**, intended to work from real-time data.

## Repo isolation

This project is completely separate from the `cleartax` repo (an Indian
income-tax filing app that lives at `C:\cleartax` → `arnab2026-ux/cleartax`).
Never move code between the two. Nothing here goes there, and nothing there
comes here.

## Stack

Node 24, TypeScript 7 (ESM, `strict` + `noUncheckedIndexedAccess`), run via
`tsx`. No framework or UI chosen yet.

| Package | Purpose |
| --- | --- |
| `firecrawl` 4.32 | Hosted scraping / extraction API |
| `playwright` 1.62 | Browser automation (Chromium only) |
| `dotenv` | Env loading |

## Setup on a fresh machine

```bash
npm install
npx playwright install chromium
```

The Chromium binary lives in the OS-level Playwright cache, **not** in this
repo — `npm install` alone will not fetch it, and Playwright will fail at
launch until the second command runs. This matters for cloud sessions and CI.

Secrets go in `.env` (gitignored); `.env.example` lists the keys. Only the user
adds real key values.

## Verifying the toolchain

```bash
npm run smoke
```

Launches Chromium and loads the Firecrawl SDK. The live Firecrawl call is
skipped when `FIRECRAWL_API_KEY` is unset, so a pass without a key only proves
Playwright works.

## Firecrawl SDK — do not write this from memory

The package was renamed; most examples online and in training data are stale.

- Package is `firecrawl`, **not** `@mendable/firecrawl-js` (legacy alias).
- Default export is the `Firecrawl` class: `new Firecrawl({ apiKey })`.
- `scrape(url, options)` returns a `Document`; ask for output via
  `{ formats: ["markdown"] }`.

Check `node_modules/firecrawl/dist/index.d.ts` before using any other method.

## Data sources (decided)

Real-time data is **not** required — the goal is a multi-month to one-year
hold horizon, not trading. EDGAR is the spine: free, official, keyless, and
no terms-of-service risk.

| Input | Source | Status |
| --- | --- | --- |
| Financials, financial strength | SEC EDGAR XBRL `companyfacts` | Built |
| Insider buying (30% of score) | SEC EDGAR Form 4 | Built |
| Major holder activity | SEC EDGAR Schedule 13D/G | Built |
| Price, market cap, P/E | Market data API | **Needs a key** |
| Earnings surprise | Market data API | **Needs a key** |
| Analyst upgrades/downgrades | Market data API, free tier only | **Needs a key** |
| Guidance changes | EDGAR 8-K EX-99.1 + Firecrawl | Not started |

Firecrawl and Playwright are for qualitative text — filings, transcripts,
news — never for quotes.

## The screening brief

`npm run screen` (planned) implements a fixed framework the user specified.
Weights: insider/major-investor buying 30%, earnings surprise 25%, FCF yield
25%, analyst sentiment 20%. Filters: activity in last 14 days, positive TTM
FCF or guidance turning positive, market cap > $1000M, P/E below sector
average, positive surprise in last two quarters.

Two rules are absolute:

- **Never estimate a figure.** If it cannot be pulled live, it is written
  `UNVERIFIED`. This is enforced by the type system — see below.
- **Never recommend an action.** Research output only.

## Provenance is structural, not conventional

Every figure is a `Sourced<T>` (`src/lib/provenance.ts`) carrying its source,
URL, and `asOf` date. `Unverified` is a variant of the type, not a sentinel,
so a missing input cannot be mistaken for zero and cannot reach a report
without a citation. `derive()` propagates unverified-ness: a ratio built from
a missing input is itself unverified, naming which input failed.

## XBRL normalization — four traps

These are handled in `src/edgar/normalize.ts` and each has regression tests.
Do not "simplify" them away:

1. **Facts repeat.** Every 10-K restates two prior years. Latest `filed` wins.
2. **`fy`/`fp` describe the filing, not the fact.** Classify periods by their
   own `start`/`end` span instead.
3. **Companies switch tags mid-history.** NVDA's revenue tag changed in FY2022;
   first-match-wins truncated the series four years early. Tag chains merge.
4. **Instants need anchoring.** Balance-sheet facts carry no period length, so
   annual ones must be matched to fiscal year ends or the series silently
   fills with quarterly dates and year-over-year comparisons break.

Non-USD and IFRS filers exist in the universe (ASML reports US-GAAP in EUR;
GFS files IFRS). Currency and taxonomy are detected per company.

## Form 4 — only code P is a buy

A Form 4 reports every change in an insider's position. Grants (`A`), option
exercises (`M`), tax withholding (`F`), and gifts (`G`) are compensation
mechanics, not conviction. Only **`P`** (open-market purchase) signals an
insider paying market price with their own money. ABSI in testing: 2 real
buys against 8 excluded events — counting all of them would have inflated the
signal fivefold.

## Conventions

- Never commit `.env` or any API key.
- Keep `npm run typecheck` clean.
