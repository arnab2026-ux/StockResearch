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
| Insider buying (20% of score) | SEC EDGAR Form 4 | Built |
| Major holder activity | SEC EDGAR Schedule 13D/G | Built |
| Price, market cap, P/E | Market data API | **Needs a key** |
| Earnings surprise | Market data API | **Needs a key** |
| Analyst upgrades/downgrades | Market data API, free tier only | **Needs a key** |
| Guidance changes | EDGAR 8-K EX-99.1 + Firecrawl | Not started |

Firecrawl and Playwright are for qualitative text — filings, transcripts,
news — never for quotes.

## The screening brief

`npm run screen` implements a fixed framework the user specified. Weights:
net insider/fund accumulation 20%, earnings surprise 25%, FCF yield 25%,
analyst sentiment 20%, PEG ratio 10%. Filters: net accumulation over 90 days,
positive TTM FCF or guidance turning positive, market cap > $1000M, P/E below
sector average, positive surprise in last two quarters.

The ownership factor measures **net direction over 90 days, not activity**.
A 14-day window found nothing across the entire universe; 90 days also lets
13D/G amendments land. Selling insiders and exiting funds score below the
neutral midpoint of 50; a quiet window scores exactly 50.

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

## Obsidian vault — three zones, different owners

`OBSIDIAN_VAULT_PATH` points at the vault root (the folder containing
`.obsidian`). Notes are written directly to disk: a vault is just markdown,
Obsidian picks up external edits, and a direct write needs no plugin, no API
key, and no running app — which matters for scheduled runs.

Frontmatter, `## Event log`, and `## Latest screen` are machine-owned.
`## Thesis` and anything else belong to the user and are never touched. The
merge logic is in `src/vault/markdown.ts` with tests; get it wrong once and it
eats someone's notes.

The vault is what makes change detection possible — score and ownership
movement are diffs against the previous run's frontmatter.

## TTM is reconstructed, not taken from the 10-K

Most filers never tag Q4 discretely, so summing four quarters fails. Real TTM
is `prior FY + current YTD − year-ago YTD`, using the 6- and 9-month spans in
10-Qs that the annual and quarterly buckets discard. This is not cosmetic:
NVDA's FY understated trailing FCF by 22%, and SWKS's *overstated* it by more
than 2x. `FlowValue.basis` says `ttm` or `fy` per company.

## PEG — the only inverted factor

Source is Nasdaq `analyst/{ticker}/earnings-forecast` (`yearlyForecast.rows`,
forward consensus EPS). No new key — it is the same host the price, surprise,
and sentiment factors already use.

PEG is trailing P/E ÷ forward consensus EPS CAGR in percent. Every other score
in the system reads higher-is-better; this one is lower-is-better, so
`pegScore` subtracts the scale from 100 instead of applying it. Anything that
inverts a sign here silently flips the factor rather than failing.

Three guards, each producing `UNVERIFIED` rather than a number, because in all
three cases the arithmetic succeeds and returns something that sorts as
*cheap*:

1. **P/E ≤ 0 is unverifiable.** Negative trailing earnings leave no multiple to
   price growth against.
2. **Any EPS ≤ 0 inside the growth span is unverifiable.** A CAGR off a
   negative base is arithmetically meaningless. TEM going -1.38 to -0.05 is a
   real improvement and produces a positive-looking rate describing a shrinking
   loss — a number that does not belong in a valuation ratio.
3. **Growth ≤ 0 is unverifiable.** A negative PEG would sort as the cheapest
   name in the universe.

**The CAGR compounds over calendar years, not row count.** Nasdaq drops a row
it has no consensus for rather than interpolating, so surviving rows are not
guaranteed consecutive. Counting rows would have compounded a 3-year span over
1 interval and reported 100%/yr where the truth was 26%/yr.

**A legitimate PEG scoring 0 must not be converted to `UNVERIFIED`.**
Unverified factors are excluded and the composite rescaled, so refusing a real
zero would *raise* the company's score — laundering a finding into an absence.
`UNVERIFIED` means "could not be checked", never "checked and ugly".

## Schedule 13D/G — two traps

1. **A company's submissions feed contains filings where it is the filer, not
   the subject.** NVIDIA's feed carries its own 13Gs on CoreWeave and Nebius —
   2 of 5 recent filings. Counting those as "an investor bought NVIDIA"
   inverts the signal. Always check `issuerCik` against the company.
2. **An amendment reporting `classPercent` 0 is an exit.** Vanguard's March
   2026 amendment on NVDA reports zero: the stake fell below the threshold.
   Treating any 13D/G as bullish counts a large holder leaving as arriving.

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
