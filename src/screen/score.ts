/**
 * Composite scoring for the screening brief.
 *
 * Weights are fixed by the brief: insider or major-investor buying 20%,
 * earnings surprise strength 25%, free cash flow yield 25%, analyst sentiment
 * 20%, PEG ratio 10%. The ownership weight funds the PEG slice because PEG is
 * the one factor that prices growth against what is being paid for it, and the
 * ownership signal is the noisiest of the five.
 *
 * The important design decision is what an unavailable factor does. Scoring it
 * zero would be an estimate — it asserts "no insider buying" when the truth is
 * "we could not check" — and it would rank a company with missing data below
 * one with genuinely bad data. Instead the composite is computed over the
 * factors that *are* available and rescaled to 0-100, with the coverage
 * percentage reported beside it. A score of 70 on 55% coverage is a different
 * claim from 70 on full coverage, and the report must not conflate them.
 */

import { isVerified, type Sourced } from "../lib/provenance.js";

export const WEIGHTS = {
  insider: 0.2,
  surprise: 0.25,
  fcfYield: 0.25,
  peg: 0.1,
  sentiment: 0.2,
} as const;

export type FactorName = keyof typeof WEIGHTS;

export const FACTOR_LABELS: Record<FactorName, string> = {
  insider: "Net insider / fund accumulation",
  surprise: "Earnings surprise strength",
  fcfYield: "Free cash flow yield",
  peg: "PEG ratio",
  sentiment: "Analyst sentiment",
};

export interface Factor {
  /** Normalised 0-100 within the factor, or unverified. */
  score: Sourced<number>;
  /** Human-readable basis, shown in the report. */
  detail: string;
}

export type Factors = Record<FactorName, Factor>;

export interface CompositeScore {
  /** 0-100 over available factors, or undefined if none were available. */
  value: number | undefined;
  /** Share of total weight that could be evaluated, 0-1. */
  coverage: number;
  /** Factors that could not be evaluated, with reasons. */
  missing: { factor: FactorName; reason: string }[];
  contributions: {
    factor: FactorName;
    weight: number;
    score: number;
    weighted: number;
  }[];
}

export function composite(factors: Factors): CompositeScore {
  let weightedTotal = 0;
  let availableWeight = 0;
  const missing: CompositeScore["missing"] = [];
  const contributions: CompositeScore["contributions"] = [];

  for (const name of Object.keys(WEIGHTS) as FactorName[]) {
    const factor = factors[name];
    const weight = WEIGHTS[name];

    if (!isVerified(factor.score)) {
      missing.push({ factor: name, reason: factor.score.reason });
      continue;
    }

    const clamped = Math.max(0, Math.min(100, factor.score.value));
    weightedTotal += clamped * weight;
    availableWeight += weight;
    contributions.push({
      factor: name,
      weight,
      score: clamped,
      weighted: clamped * weight,
    });
  }

  return {
    // Rescaling by available weight keeps the number on a 0-100 scale rather
    // than penalising absent data as if it were bad data.
    value: availableWeight > 0 ? weightedTotal / availableWeight : undefined,
    coverage: availableWeight,
    missing,
    contributions,
  };
}

// ---------------------------------------------------------------------------
// Factor normalisation
// ---------------------------------------------------------------------------

/**
 * Thousands-separated USD, pinned to en-US.
 *
 * Bare `toLocaleString()` follows the host locale, which produced Indian lakh
 * grouping ("2,50,000") on the development machine. Dollar figures must render
 * the same way wherever the screen runs.
 */
export function formatUsd(n: number): string {
  return n.toLocaleString("en-US");
}

/** Maps a value onto 0-100 by linear interpolation, clamped at both ends. */
export function scale(value: number, min: number, max: number): number {
  if (max === min) return 50;
  return Math.max(0, Math.min(100, ((value - min) / (max - min)) * 100));
}

/**
 * Component split inside the 20% ownership factor.
 *
 * Congressional disclosure was funded out of the two largest components rather
 * than by widening the factor: the brief fixes the ownership weight at 20% and
 * this is a fourth reading of the same question, not a sixth factor. Breadth
 * keeps its 15% because it is already the smallest slice and the least noisy
 * of the three.
 */
export const OWNERSHIP_COMPONENTS = {
  /** Insider dollar flow: open-market purchases less sales, in dollars. */
  flow: 0.4,
  /** Net percentage points of the class added by 5%+ holders. */
  stake: 0.35,
  /** Distinct insider buyers net of distinct sellers. */
  breadth: 0.15,
  /** Net count of congressional purchases less sales over the window. */
  congress: 0.1,
} as const;

/**
 * Net accumulation score, 0-100.
 *
 * Measures whether insiders, 5%+ holders and disclosing members of Congress
 * were net buyers over the window, not merely whether they were active.
 * Selling insiders and exiting funds push the score below the neutral midpoint,
 * which a presence-of-activity measure cannot express: a fund cutting its stake
 * and a fund building one both look like "a 13D/G filing" until the direction
 * is read.
 *
 * 50 is neutral — no net movement either way. Four components, weighted by
 * `OWNERSHIP_COMPONENTS`: insider dollar flow 40%, institutional stake change
 * 35%, breadth 15%, congressional net direction 10%. Percentage points are the
 * natural unit for the stake component, since a 2-point move means the same
 * thing regardless of company size.
 *
 * **The congressional component is counts, never dollars.** House disclosures
 * report a bracket ("$1,001 - $15,000"), not a value; turning that into a
 * dollar figure would be estimating, so only the direction and the number of
 * trades are used.
 *
 * `congress` being undefined means the House feed was not checked, and the
 * three EDGAR components are renormalised over their own weight — the same
 * treatment `composite()` gives an unavailable factor. Present-but-empty is a
 * different claim: it means the window was checked and quiet, which is
 * genuinely neutral.
 */
export function netAccumulationScore(input: {
  netInsiderValue: number;
  distinctBuyers: number;
  distinctSellers: number;
  netHolderPercentChange: number;
  holdersIncreasing: number;
  holdersDecreasing: number;
  windowDays: number;
  congress?: {
    /** Purchases less sales, as a count. */
    net: number;
    purchases: number;
    sales: number;
    distinctFilers: number;
  };
}): { score: number; detail: string } {
  const NEUTRAL = 50;
  const w = OWNERSHIP_COMPONENTS;

  const flow = scale(input.netInsiderValue, -2_000_000, 2_000_000);
  const stake = scale(input.netHolderPercentChange, -4, 4);
  const breadth = scale(input.distinctBuyers - input.distinctSellers, -3, 3);

  let weighted = flow * w.flow + stake * w.stake + breadth * w.breadth;
  let usedWeight = w.flow + w.stake + w.breadth;

  if (input.congress) {
    // Three net trades saturates. Congressional activity in any one name is
    // rare enough that a wider band would leave the component permanently
    // pinned near neutral even when a member did disclose a purchase.
    weighted += scale(input.congress.net, -3, 3) * w.congress;
    usedWeight += w.congress;
  }

  const score = weighted / usedWeight;

  const noEvidence =
    input.netInsiderValue === 0 &&
    input.netHolderPercentChange === 0 &&
    input.distinctBuyers === 0 &&
    input.distinctSellers === 0 &&
    (input.congress === undefined ||
      (input.congress.purchases === 0 && input.congress.sales === 0));

  const dollars = (n: number): string =>
    `${n < 0 ? "-" : "+"}$${formatUsd(Math.abs(Math.round(n)))}`;

  const congressDetail = input.congress
    ? input.congress.purchases + input.congress.sales === 0
      ? "no congressional disclosures"
      : `Congress net ${input.congress.net >= 0 ? "+" : ""}${input.congress.net} ` +
        `(${input.congress.purchases} buy / ${input.congress.sales} sell, ` +
        `${input.congress.distinctFilers} filer(s))`
    : undefined;

  const detail = noEvidence
    ? `no insider trades, 5%+ holder changes${
        input.congress ? " or congressional disclosures" : ""
      } in ${input.windowDays}d`
    : [
        `insider net ${dollars(input.netInsiderValue)}`,
        `${input.distinctBuyers} buyer(s) / ${input.distinctSellers} seller(s)`,
        `5%+ holders net ${input.netHolderPercentChange >= 0 ? "+" : ""}${input.netHolderPercentChange.toFixed(2)}pp ` +
          `(${input.holdersIncreasing} up, ${input.holdersDecreasing} down)`,
        ...(congressDetail ? [congressDetail] : []),
      ].join(", ");

  // With nothing on any side the honest reading is neutral, not zero: an
  // absence of trading is not evidence of distribution.
  return { score: noEvidence ? NEUTRAL : score, detail };
}

/**
 * Earnings surprise score, 0-100.
 *
 * The brief filters on positive surprises in the last two quarters, so both
 * consistency and magnitude matter. A single large beat after a miss is worth
 * less than two steady beats.
 */
export function surpriseScore(
  surprises: { surprisePercent: number; reportedOn: string }[],
): { score: number; detail: string } {
  const recent = surprises.slice(0, 4);
  if (recent.length === 0) {
    return { score: 0, detail: "no surprise history" };
  }

  const lastTwo = recent.slice(0, 2);
  const positiveCount = lastTwo.filter((s) => s.surprisePercent > 0).length;
  const meanSurprise =
    recent.reduce((sum, s) => sum + s.surprisePercent, 0) / recent.length;

  // Consistency over the qualifying window, then magnitude across four
  // quarters. A 10% average beat saturates the magnitude component.
  const consistency = (positiveCount / Math.max(1, lastTwo.length)) * 60;
  const magnitude = scale(meanSurprise, -5, 10) * 0.4;

  return {
    score: consistency + magnitude,
    detail:
      `${positiveCount}/${lastTwo.length} of last two quarters positive, ` +
      `${meanSurprise >= 0 ? "+" : ""}${meanSurprise.toFixed(1)}% mean over ${recent.length}q`,
  };
}

/**
 * Free cash flow yield score, 0-100.
 *
 * FCF yield is free cash flow over market capitalisation. Zero and below score
 * zero: a cash-burning company has no yield, and negative yields do not rank
 * meaningfully against each other for this purpose. 8% saturates.
 */
export function fcfYieldScore(fcfYield: number): { score: number; detail: string } {
  const score = fcfYield <= 0 ? 0 : scale(fcfYield, 0, 0.08);
  return {
    score,
    detail: `FCF yield ${(fcfYield * 100).toFixed(2)}%`,
  };
}

/**
 * PEG ratio score, 0-100.
 *
 * The only inverted factor in the system: every other score reads
 * higher-is-better, PEG reads lower-is-better, so the scale is subtracted from
 * 100 rather than applied directly.
 *
 * 1.0 is the textbook line between growth being paid for and being paid up
 * for, so the band is set around it rather than on it — 0.75 and below is
 * unambiguously cheap for the growth and saturates, 3.0 and above scores zero.
 * Reaching zero rather than staying above it matters: at 10% of the composite
 * a compressed band would make the factor decorative.
 *
 * Callers must have applied the guards in `metrics/peg.ts` first; a negative
 * PEG reaching here would score 100.
 */
export function pegScore(peg: number): { score: number; detail: string } {
  return {
    score: 100 - scale(peg, 0.75, 3.0),
    detail: `PEG ${peg.toFixed(2)}`,
  };
}

/**
 * Analyst sentiment score, 0-100.
 *
 * Combines the current buy share, the recent shift in the distribution (the
 * brief's "upgrades vs downgrades"), and an accuracy-weighted consensus that
 * discounts analysts with poor records on this particular stock.
 */
export function sentimentScore(input: {
  buy: number;
  hold: number;
  sell: number;
  netShift: number | undefined;
  accuracyWeighted: number | undefined;
}): { score: number; detail: string } {
  const total = input.buy + input.hold + input.sell;
  if (total === 0) {
    return { score: 0, detail: "no analyst coverage" };
  }

  const buyShare = (input.buy - input.sell) / total; // -1..1
  const level = scale(buyShare, -1, 1);

  const parts = [`${input.buy}B/${input.hold}H/${input.sell}S`];

  // Weight the current level most heavily; direction and analyst quality
  // adjust it rather than dominating.
  let score = level * 0.6;
  let usedWeight = 0.6;

  if (input.netShift !== undefined) {
    score += scale(input.netShift, -3, 3) * 0.2;
    usedWeight += 0.2;
    parts.push(`net shift ${input.netShift >= 0 ? "+" : ""}${input.netShift}`);
  }

  if (input.accuracyWeighted !== undefined) {
    score += scale(input.accuracyWeighted, -1, 1) * 0.2;
    usedWeight += 0.2;
    parts.push(`accuracy-weighted ${input.accuracyWeighted.toFixed(2)}`);
  }

  return { score: score / usedWeight, detail: parts.join(", ") };
}
