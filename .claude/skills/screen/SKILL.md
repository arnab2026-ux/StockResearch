---
name: screen
description: Run the stock screening framework over the AI, semiconductor, and AI-driven biotech universe and produce a scored research watchlist. Use whenever the user says "run a screen", "run the screen", "screen for undervalued stocks", asks for the weekly watchlist, or asks to re-screen specific tickers.
---

# Stock screen

Produce a scored watchlist of potentially undervalued companies from the
configured universe. **Research output only — never recommend an action.**

## How to run it

```bash
npm run screen
```

Useful variants:

| Command | Purpose |
| --- | --- |
| `npm run screen -- NVDA AMD` | Specific tickers, full detail each |
| `npm run screen -- --all` | Detail for every company, not just qualifiers |
| `npm run screen -- --window=120` | Widen the ownership lookback from 90 days |
| `npm run screen -- --refresh` | Bypass all caches and refetch |

A full run takes several minutes: it makes roughly 200 rate-limited requests
and is deliberately throttled. Do not parallelise it or remove the throttles.

## The framework

Screening filters:

1. **Net** accumulation by insiders or 5%+ holders over a 90-day window
2. Positive trailing-twelve-month free cash flow, or guidance turning positive
3. Market cap above $1000M
4. Price-to-earnings below the sector average
5. Positive earnings surprise in each of the last two quarters

Scoring weights, fixed:

| Factor | Weight |
| --- | --- |
| Net insider / fund accumulation | 30% |
| Earnings surprise strength | 25% |
| Free cash flow yield | 25% |
| Analyst sentiment | 20% |

The ownership factor measures **direction, not activity**. Insiders selling
and funds cutting stakes push it below the neutral midpoint of 50. A quiet
window with no trades on either side scores 50, because an absence of trading
is not evidence of distribution.

Per company the report gives: name and ticker, composite score 0–100,
one-line thesis, top risk, and current price against estimated intrinsic
value.

## Absolute rules

- **Never estimate a figure.** Anything not retrievable live is printed
  `UNVERIFIED` with the reason. Do not fill such a gap from memory, from a
  prior run, or by inference — the type system enforces this via
  `Sourced<T>` in `src/lib/provenance.ts`, so do not work around it.
- **Cite the source and date for every number.** The report already does
  this; preserve the citations when summarising.
- **Never recommend an action.** Describe, rank, and explain. Do not say what
  to buy, sell, or hold. If asked directly for a recommendation, explain that
  this is research output and you are not a licensed adviser.

## Reading the output

- **Scoring coverage** matters as much as the score. 70 at 60% coverage is a
  weaker claim than 70 at 100% — say so when summarising.
- An **unavailable factor is excluded and the composite rescaled**, not
  scored zero. A company is never penalised for a data gap as though it had
  bad data.
- **Filter counts** read `passed/evaluable`. A filter that could not be
  evaluated is neither a pass nor a fail.
- **Sector median P/E** is computed across the companies in that run, not
  taken from a vendor, and needs at least 3 comparable companies. Running a
  small subset will leave that filter UNVERIFIED.

## Known limitations — state these when they affect a conclusion

- **TTM free cash flow usually falls back to the latest fiscal year**, because
  most filers never tag Q4 discretely. The basis column shows `FY` when that
  happens, and an FY figure can be up to three quarters stale.
- **Analyst sentiment comes from Nasdaq's consensus label**, not a
  buy/hold/sell distribution. TipRanks would give per-analyst track records
  and a true distribution, but it fingerprints non-browser clients and returns
  403; that is bot detection and must not be worked around.
- **Guidance-based FCF turnaround is not implemented.** Filter 2 tests
  reported FCF only.
- **13F institutional holdings are not ingested.** They are indexed by the
  filing fund, not by the stock, so finding who added a given ticker means
  parsing every fund's 13F or the SEC's bulk quarterly dataset. The 5%+ holder
  signal comes from Schedule 13D/G, which is issuer-indexed.
- **Only Form 4 transaction code `P` counts as insider buying.** Grants,
  option exercises, tax withholding, and gifts are compensation mechanics.
- **A lone 13D/G amendment is indeterminate.** Its prior level lies outside
  the window, so no delta is claimed; the count appears in the filter detail.
  Widening `--window` converts some of these into real deltas.

## After running

Summarise the ranked list, then for the top names give thesis, top risk, and
price versus consensus target. Carry the UNVERIFIED markers through — a gap
the user cannot see is worse than one they can.
