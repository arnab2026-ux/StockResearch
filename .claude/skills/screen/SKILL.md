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
| `npm run screen -- --no-vault` | Skip writing to the Obsidian vault |

A full run takes several minutes: it makes roughly 250 rate-limited requests
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
| Net insider / fund accumulation | 20% |
| Earnings surprise strength | 25% |
| Free cash flow yield | 25% |
| Analyst sentiment | 20% |
| PEG ratio | 10% |

The ownership factor measures **direction, not activity**. Insiders selling
and funds cutting stakes push it below the neutral midpoint of 50. A quiet
window with no trades on either side scores 50, because an absence of trading
is not evidence of distribution.

The PEG factor is **inverted** — it is the only one where lower is better. It
is trailing P/E divided by the forward consensus EPS growth rate, so it asks
what the multiple costs per point of growth. It is UNVERIFIED rather than
scored whenever that question has no meaning: a negative P/E, a loss anywhere
in the growth span, or growth that is not positive.

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

- **Free cash flow basis is labelled `TTM` or `FY` per company.** TTM is
  reconstructed as prior fiscal year plus current year-to-date less the
  year-ago year-to-date. `FY` means no year-to-date data was available to roll
  it forward — mostly foreign filers — and that figure can be stale by up to
  three quarters.
- **A single outsized earnings surprise can dominate the surprise factor**,
  since magnitude is scored on a four-quarter mean. GOOGL currently shows a
  +216% quarter, which is almost certainly a one-off item rather than
  operational. Read the per-quarter detail before relying on that factor.
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
- **PEG is UNVERIFIED for 13 of 51 companies**, almost all loss-making and so
  carrying a negative trailing P/E. Those companies rescale to 90% coverage.
- **17 of the 38 verified PEGs sit on the floor at exactly 0**, because the
  scoring band runs 0.75–3.0. For nearly half the covered universe the factor
  therefore contributes a constant: GOOGL at 5.34, MCHP at 5.28, DDOG at 6.10
  and SWKS at 7.35 are indistinguishable in score.
- **The growth base and the P/E base are disconnected.** Growth compounds from
  the first forecast year; the P/E is trailing. A forecast earnings collapse
  could in principle produce a flatteringly low PEG. Not currently live — the
  lowest forecast-year-1 to trailing-EPS ratio in the universe is ACLS at 0.82
  — but NTRA, at +5900%/yr growth off a 0.03 base, is held out only by its
  negative trailing P/E today.
- **GOOGL's consensus hides a 28% EPS drop for Dec 2027** (20.51 → 14.74 →
  17.73 → 22.58), rendered by the endpoints as +3.3%/yr. The trough is now
  named in the report, but that figure has not been checked against a second
  source.

## The Obsidian vault

When `OBSIDIAN_VAULT_PATH` is set, results are written as plain markdown —
directly to disk, no plugin and no running Obsidian required.

- `10-Companies/{TICKER}.md` — one note per company
- `20-Screens/{date}-screen.md` — one note per run, wikilinked to the companies

Each company note has three zones with **different owners**:

| Zone | Owner | Behaviour |
| --- | --- | --- |
| Frontmatter | machine | Rewritten every run (except `status`, which is preserved) |
| `## Event log` | machine | Append-only, deduplicated; entries are never rewritten |
| `## Latest screen` | machine | Replaced wholesale each run |
| `## Thesis` and anything else | **the user** | Never touched |

Never write into `## Thesis` or add machine content outside the zones above.
The separation is what lets the screen accumulate state alongside the user's
own analysis, and it is covered by tests in `src/vault/markdown.test.ts`.

The vault is also what makes change detection work: score movement and
ownership shifts are differences against the previous run's frontmatter, so
there is no week-over-week signal without it.

## After running

Summarise the ranked list, then for the top names give thesis, top risk, and
price versus consensus target. Carry the UNVERIFIED markers through — a gap
the user cannot see is worse than one they can.
