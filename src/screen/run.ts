/**
 * The screening pipeline: gather every input for one company, apply the
 * brief's filters, and score it.
 *
 * Nothing here invents a figure. The thesis and risk lines are assembled from
 * the computed factors rather than written freehand, so every clause traces
 * back to a sourced number. Intrinsic value is represented by the published
 * analyst consensus target rather than a discounted cash flow of my own,
 * because a DCF would require growth and discount-rate assumptions that the
 * brief forbids estimating.
 */

import type { UniverseEntry } from "../config/universe.js";
import { fetchCompanyFacts } from "../edgar/companyfacts.js";
import {
  fetchInsiderActivity,
  summariseInsiderActivity,
  type InsiderSummary,
} from "../edgar/insider.js";
import type { NormalizedCompany } from "../edgar/normalize.js";
import type { Company } from "../edgar/tickers.js";
import {
  derive,
  isVerified,
  sourced,
  today,
  unverified,
  valueOf,
  type Sourced,
} from "../lib/provenance.js";
import { attempt } from "../lib/web.js";
import { ttmFreeCashFlow, type FlowBasis } from "../metrics/fundamentals.js";
import { strengthProfile, type StrengthProfile } from "../metrics/strength.js";
import {
  fetchEarningsSurprises,
  fetchQuote,
  fetchRatings,
  type EarningsSurprise,
  type NasdaqRatings,
} from "../providers/nasdaq.js";
import { fetchTipRanks } from "../providers/tipranks.js";
import {
  composite,
  fcfYieldScore,
  insiderScore,
  sentimentScore,
  surpriseScore,
  type CompositeScore,
  type Factors,
} from "./score.js";

export const INSIDER_WINDOW_DAYS = 14;
export const MIN_MARKET_CAP = 1_000_000_000;

export interface FilterResult {
  name: string;
  /** undefined when the filter could not be evaluated. */
  passed: boolean | undefined;
  detail: string;
}

export interface ScreenedCompany {
  ticker: string;
  name: string;
  entry: UniverseEntry;
  currency: string;

  price: Sourced<number>;
  marketCap: Sourced<number>;
  sector: Sourced<string>;
  priceTarget: Sourced<number>;
  ttmEps: Sourced<number>;
  peRatio: Sourced<number>;
  fcf: Sourced<number>;
  fcfBasis: FlowBasis;
  fcfYield: Sourced<number>;

  insider: InsiderSummary | undefined;
  surprises: Sourced<EarningsSurprise[]>;
  strength: StrengthProfile;

  factors: Factors;
  score: CompositeScore;
  filters: FilterResult[];
  /** True only when every filter that could be evaluated passed. */
  qualifies: boolean;

  thesis: string;
  topRisk: string;
  upsideToTarget: Sourced<number>;
}

function derivedSource(label: string) {
  return {
    name: `Derived (${label})`,
    url: "https://www.sec.gov/edgar",
    retrievedAt: today(),
  };
}

/** Sum of the last four reported quarterly EPS figures. */
function ttmEpsFrom(surprises: Sourced<EarningsSurprise[]>): Sourced<number> {
  if (!isVerified(surprises)) return unverified(surprises.reason);

  const recent = surprises.value.slice(0, 4);
  if (recent.length < 4) {
    return unverified(`only ${recent.length} of 4 quarters of EPS reported`);
  }

  const total = recent.reduce((sum, q) => sum + q.actualEps, 0);
  const newest = recent[0];

  return sourced(total, {
    name: "Derived from Nasdaq earnings surprise (4 quarters)",
    url: surprises.source.url,
    asOf: newest?.reportedOn ?? surprises.source.asOf,
    retrievedAt: today(),
  });
}

export async function gather(
  company: Company,
  entry: UniverseEntry,
  opts: { refresh?: boolean; insiderWindowDays?: number } = {},
): Promise<ScreenedCompany> {
  const windowDays = opts.insiderWindowDays ?? INSIDER_WINDOW_DAYS;

  const { company: facts } = await fetchCompanyFacts(company.cik, {
    ...(opts.refresh !== undefined ? { refresh: opts.refresh } : {}),
  });

  const [insiderActivity, quote, surprises, ratings, tipranks] = await Promise.all([
    fetchInsiderActivity(company.cik, { windowDays }).catch(() => undefined),
    attempt("Nasdaq quote", async () => sourced(await fetchQuote(company.ticker), {
      name: "Nasdaq",
      url: `https://api.nasdaq.com/api/quote/${company.ticker}/info`,
      asOf: today(),
      retrievedAt: today(),
    })),
    attempt("Nasdaq earnings surprise", () => fetchEarningsSurprises(company.ticker)),
    attempt("Nasdaq analyst ratings", async () =>
      sourced(await fetchRatings(company.ticker), {
        name: "Nasdaq analyst ratings",
        url: `https://api.nasdaq.com/api/analyst/${company.ticker}/ratings`,
        asOf: today(),
        retrievedAt: today(),
      }),
    ),
    attempt("TipRanks", async () =>
      sourced(await fetchTipRanks(company.ticker), {
        name: "TipRanks",
        url: `https://www.tipranks.com/stocks/${company.ticker.toLowerCase()}`,
        asOf: today(),
        retrievedAt: today(),
      }),
    ),
  ]);

  const insider = insiderActivity ? summariseInsiderActivity(insiderActivity) : undefined;

  const q = isVerified(quote) ? quote.value : undefined;
  const tr = isVerified(tipranks) ? tipranks.value : undefined;

  const price = q?.price ?? unverified("no quote provider available");
  const marketCap = q?.marketCap ?? unverified("no quote provider available");
  const sector = q?.sector ?? unverified("no quote provider available");

  // Prefer TipRanks' consensus target; fall back to Nasdaq's one-year target.
  const priceTarget =
    tr && isVerified(tr.priceTarget)
      ? tr.priceTarget
      : (q?.oneYearTarget ?? unverified("no consensus price target published"));

  const ttmEps = ttmEpsFrom(surprises);

  const peRatio = derive(
    { price, eps: ttmEps },
    (v) => v.price / v.eps,
    derivedSource("price over trailing twelve month EPS"),
  );

  const fcfFlow = ttmFreeCashFlow(facts);
  const fcfYield = derive(
    { fcf: fcfFlow.amount, cap: marketCap },
    (v) => v.fcf / v.cap,
    derivedSource("free cash flow over market capitalisation"),
  );

  const upsideToTarget = derive(
    { target: priceTarget, price },
    (v) => v.target / v.price - 1,
    derivedSource("consensus target over current price"),
  );

  const strength = strengthProfile(facts);

  // --- factors ------------------------------------------------------------
  const factors: Factors = {
    insider: buildInsiderFactor(insider, windowDays),
    surprise: buildSurpriseFactor(surprises),
    fcfYield: buildFcfYieldFactor(fcfYield),
    sentiment: buildSentimentFactor(tr, isVerified(ratings) ? ratings.value : undefined),
  };

  const score = composite(factors);

  return {
    ticker: company.ticker,
    name: q?.companyName ?? company.name,
    entry,
    currency: facts.currency,
    price,
    marketCap,
    sector,
    priceTarget,
    ttmEps,
    peRatio,
    fcf: fcfFlow.amount,
    fcfBasis: fcfFlow.basis,
    fcfYield,
    insider,
    surprises,
    strength,
    factors,
    score,
    filters: [],
    qualifies: false,
    thesis: "",
    topRisk: "",
    upsideToTarget,
  };
}

function buildInsiderFactor(
  insider: InsiderSummary | undefined,
  windowDays: number,
): Factors["insider"] {
  if (!insider) {
    return {
      score: unverified("EDGAR insider feed unavailable"),
      detail: "not checked",
    };
  }

  const { score, detail } = insiderScore({
    buyCount: insider.buyCount,
    distinctBuyers: insider.distinctBuyers,
    buyValue: insider.buyValue,
    sellValue: insider.sellValue,
    majorHolderFilings: insider.majorHolderFilingCount,
  });

  return {
    score: sourced(score, {
      name: `SEC EDGAR Form 4 and Schedule 13D/G (${windowDays}-day window)`,
      url: "https://www.sec.gov/edgar",
      asOf: today(),
      retrievedAt: today(),
    }),
    detail,
  };
}

function buildSurpriseFactor(
  surprises: Sourced<EarningsSurprise[]>,
): Factors["surprise"] {
  if (!isVerified(surprises)) {
    return { score: unverified(surprises.reason), detail: "no surprise data" };
  }

  const { score, detail } = surpriseScore(surprises.value);
  return { score: sourced(score, surprises.source), detail };
}

function buildFcfYieldFactor(fcfYield: Sourced<number>): Factors["fcfYield"] {
  if (!isVerified(fcfYield)) {
    return { score: unverified(fcfYield.reason), detail: "FCF yield unavailable" };
  }

  const { score, detail } = fcfYieldScore(fcfYield.value);
  return { score: sourced(score, fcfYield.source), detail };
}

/**
 * Nasdaq publishes a consensus label rather than a buy/hold/sell breakdown, so
 * the label is mapped onto the same -1..1 axis the distribution produces.
 */
const CONSENSUS_LEVELS: Record<string, number> = {
  "strong buy": 1,
  buy: 0.6,
  "moderate buy": 0.4,
  overweight: 0.5,
  hold: 0,
  neutral: 0,
  "moderate sell": -0.4,
  underweight: -0.5,
  sell: -0.6,
  "strong sell": -1,
};

function buildSentimentFactor(
  tr: Awaited<ReturnType<typeof fetchTipRanks>> | undefined,
  nasdaq: NasdaqRatings | undefined,
): Factors["sentiment"] {
  if (!tr || !isVerified(tr.distribution)) {
    // TipRanks fingerprints non-browser clients and returns 403, so the
    // Nasdaq consensus label is the working free fallback. It carries the
    // level but not the buy/hold/sell split or per-analyst track records.
    if (nasdaq && isVerified(nasdaq.consensus)) {
      const label = nasdaq.consensus.value.trim().toLowerCase();
      const level = CONSENSUS_LEVELS[label];
      const count = valueOf(nasdaq.analystCount);

      if (level !== undefined) {
        return {
          score: sourced((level + 1) * 50, nasdaq.consensus.source),
          detail:
            `consensus "${nasdaq.consensus.value}"` +
            (count !== undefined ? ` from ${count} analysts` : "") +
            " (Nasdaq; no buy/hold/sell split or accuracy weighting available)",
        };
      }

      return {
        score: unverified(`unrecognised consensus label "${nasdaq.consensus.value}"`),
        detail: "consensus label not mappable",
      };
    }

    return {
      score: unverified(
        tr && !isVerified(tr.distribution)
          ? tr.distribution.reason
          : "no analyst sentiment source available",
      ),
      detail: "no analyst consensus",
    };
  }

  const d = tr.distribution.value;
  const { score, detail } = sentimentScore({
    buy: d.buy,
    hold: d.hold,
    sell: d.sell,
    netShift: isVerified(tr.change) ? tr.change.value.netShift : undefined,
    accuracyWeighted: valueOf(tr.accuracyWeightedScore),
  });

  return { score: sourced(score, tr.distribution.source), detail };
}

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

/**
 * Applies the brief's five filters.
 *
 * `sectorMedianPe` is computed across the screened set rather than taken from
 * a vendor, so it is transparent but reflects only this universe. With an
 * AI/semis/biotech universe that is a demanding comparison — these are
 * high-multiple sectors, so the median is high and the filter is doing real
 * work rather than passing everything.
 */
export function applyFilters(
  c: ScreenedCompany,
  sectorMedianPe: Map<string, number>,
): FilterResult[] {
  const results: FilterResult[] = [];

  // 1. Insider or major-investor activity in the window.
  results.push(
    c.insider
      ? {
          name: `Insider/major-investor activity (${INSIDER_WINDOW_DAYS}d)`,
          passed: c.insider.hasSignal,
          detail: `${c.insider.buyCount} open-market buy(s), ${c.insider.majorHolderFilingCount} 13D/G`,
        }
      : {
          name: `Insider/major-investor activity (${INSIDER_WINDOW_DAYS}d)`,
          passed: undefined,
          detail: "UNVERIFIED — EDGAR feed unavailable",
        },
  );

  // 2. Positive trailing free cash flow.
  const fcf = valueOf(c.fcf);
  results.push({
    name: "Positive FCF (TTM)",
    passed: fcf === undefined ? undefined : fcf > 0,
    detail:
      fcf === undefined
        ? "UNVERIFIED"
        : `${(fcf / 1e6).toFixed(0)}M ${c.currency} on ${c.fcfBasis.toUpperCase()} basis` +
          (c.fcfBasis === "fy" ? " (guidance check not implemented)" : ""),
  });

  // 3. Market cap above $1000M.
  const cap = valueOf(c.marketCap);
  results.push({
    name: "Market cap > $1000M",
    passed: cap === undefined ? undefined : cap > MIN_MARKET_CAP,
    detail:
      cap === undefined
        ? "UNVERIFIED"
        : cap >= 1e12
          ? `$${(cap / 1e12).toFixed(2)}T`
          : `$${(cap / 1e9).toFixed(2)}B`,
  });

  // 4. P/E below the sector median.
  const pe = valueOf(c.peRatio);
  const sector = valueOf(c.sector) ?? c.entry.category;
  const median = sectorMedianPe.get(sector);
  results.push({
    name: "P/E below sector median",
    passed:
      pe === undefined || median === undefined ? undefined : pe > 0 && pe < median,
    detail:
      pe === undefined
        ? "UNVERIFIED — no P/E"
        : median === undefined
          ? `UNVERIFIED — fewer than ${MIN_SECTOR_SAMPLE} comparable ${sector} companies in this run`
          : `${pe.toFixed(1)} vs ${median.toFixed(1)} (${sector})`,
  });

  // 5. Positive surprise in each of the last two quarters.
  if (!isVerified(c.surprises)) {
    results.push({
      name: "Positive surprise, last 2 quarters",
      passed: undefined,
      detail: "UNVERIFIED",
    });
  } else {
    const lastTwo = c.surprises.value.slice(0, 2);
    results.push({
      name: "Positive surprise, last 2 quarters",
      passed:
        lastTwo.length < 2
          ? undefined
          : lastTwo.every((s) => s.surprisePercent > 0),
      detail: lastTwo
        .map((s) => `${s.fiscalQuarterEnd} ${s.surprisePercent >= 0 ? "+" : ""}${s.surprisePercent.toFixed(1)}%`)
        .join(", "),
    });
  }

  return results;
}

/**
 * Smallest sector sample that yields a usable median.
 *
 * Below this the "median" is dominated by the company being tested — with one
 * company it *is* that company, so the filter compares a value against itself
 * and always fails. Better to report the comparison as unavailable.
 */
export const MIN_SECTOR_SAMPLE = 3;

/** Median P/E per sector across the screened set. */
export function sectorMedians(companies: ScreenedCompany[]): Map<string, number> {
  const bySector = new Map<string, number[]>();

  for (const c of companies) {
    const pe = valueOf(c.peRatio);
    // Negative and absurd multiples would distort the median; loss-making
    // companies have no meaningful P/E to contribute.
    if (pe === undefined || pe <= 0 || pe > 500) continue;
    const sector = valueOf(c.sector) ?? c.entry.category;
    const list = bySector.get(sector) ?? [];
    list.push(pe);
    bySector.set(sector, list);
  }

  const medians = new Map<string, number>();
  for (const [sector, values] of bySector) {
    if (values.length < MIN_SECTOR_SAMPLE) continue;
    values.sort((a, b) => a - b);
    const mid = Math.floor(values.length / 2);
    const median =
      values.length % 2 === 0
        ? ((values[mid - 1] ?? 0) + (values[mid] ?? 0)) / 2
        : (values[mid] ?? 0);
    medians.set(sector, median);
  }

  return medians;
}

/**
 * Builds the thesis and risk lines from computed factors.
 *
 * Deliberately mechanical: each clause names a figure that appears elsewhere
 * in the report with its citation, so nothing is asserted that is not
 * separately sourced.
 */
export function describe(c: ScreenedCompany): { thesis: string; topRisk: string } {
  const strongest = [...c.score.contributions].sort((a, b) => b.score - a.score)[0];
  const weakest = [...c.score.contributions].sort((a, b) => a.score - b.score)[0];

  const bits: string[] = [];
  const fcfY = valueOf(c.fcfYield);
  if (fcfY !== undefined && fcfY > 0) bits.push(`${(fcfY * 100).toFixed(1)}% FCF yield`);

  if (isVerified(c.surprises)) {
    const beats = c.surprises.value.slice(0, 4).filter((s) => s.surprisePercent > 0).length;
    bits.push(`${beats}/4 quarters above consensus`);
  }

  if (c.insider?.hasSignal) {
    bits.push(`${c.insider.buyCount} insider buy(s), ${c.insider.majorHolderFilingCount} 13D/G`);
  }

  if (strongest) bits.push(`strongest factor ${strongest.factor}`);

  const thesis = bits.length ? bits.join("; ") : "insufficient verified data for a thesis";

  // Risk: prefer a concrete balance-sheet or model concern over a generic one.
  const risks: string[] = [];
  if (c.strength.altman.zone === "distress") risks.push("Altman Z'' in distress zone");
  if (fcfY !== undefined && fcfY <= 0) risks.push("negative free cash flow");
  const pe = valueOf(c.peRatio);
  if (pe !== undefined && pe > 60) risks.push(`P/E ${pe.toFixed(0)} leaves little margin`);
  if (weakest && weakest.score < 25) risks.push(`weak ${weakest.factor} (${weakest.score.toFixed(0)}/100)`);
  if (c.score.coverage < 0.75) {
    risks.push(`only ${(c.score.coverage * 100).toFixed(0)}% of scoring weight verified`);
  }
  if (c.strength.caveats.length) risks.push(c.strength.caveats[0] ?? "");

  return { thesis, topRisk: risks[0] ?? "no material risk flagged by available data" };
}
