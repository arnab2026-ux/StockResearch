/**
 * TipRanks — analyst consensus, price targets, and per-analyst track records.
 *
 * The screening brief scores "analyst sentiment (upgrades vs downgrades)" at
 * 20%. Two design choices matter here:
 *
 * - Sentiment *change* is computed from `consensusOverTime`, a dated series of
 *   buy/hold/sell counts. The per-rating `actionId` field would seem more
 *   direct, but its enum is undocumented — the observed distribution
 *   (8 appearing 232 times against 2 each for 3 and 4) implies 8 is
 *   "maintain" and the rare codes are upgrades and downgrades, but that is
 *   inference. Aggregate counts carry the same information and require no
 *   guess about an undocumented encoding.
 *
 * - Analyst quality weighting uses `stockSuccessRate`, the share of an
 *   analyst's past calls on this stock that were profitable. A unanimous
 *   "buy" from analysts who are usually wrong is weaker evidence than a
 *   split verdict among analysts who are usually right.
 */

import { fetchJson, webSource } from "../lib/web.js";
import { sourced, unverified, type Sourced } from "../lib/provenance.js";

const BASE = "https://www.tipranks.com/api/stocks/getData/";

/** Payloads run to roughly 600 KB per ticker, so cache generously. */
const TTL_HOURS = 24;

/**
 * Rating levels as they appear in `ratings[].ratingId`.
 *
 * Inferred from the observed distribution against the published consensus:
 * for a strong-buy stock, level 1 dominates (199 occurrences) while 3 is
 * middling (54) and 2 is rare (23). Only used for accuracy weighting; the
 * headline distribution comes from the explicit nB/nH/nS counts.
 */
const RATING_BUY = 1;
const RATING_SELL = 2;
const RATING_HOLD = 3;

interface TipRanksRating {
  ratingId: number;
  actionId: number;
  date: string;
  priceTarget: number | null;
}

interface TipRanksExpert {
  name: string | null;
  firm: string | null;
  ratings: TipRanksRating[] | null;
  /** Share of this analyst's past calls on this stock that made money, 0-1. */
  stockSuccessRate: number | null;
  stockAverageReturn: number | null;
  stockTotalRecommendations: number | null;
  includedInConsensus: boolean;
}

interface TipRanksConsensus {
  rating: number;
  nB: number;
  nH: number;
  nS: number;
  isLatest: number;
  d: string;
}

interface ConsensusPoint {
  buy: number;
  hold: number;
  sell: number;
  date: string;
  consensus: number;
  priceTarget: number | null;
}

interface PriceTargetConsensus {
  priceTarget: number | null;
  high: number | null;
  low: number | null;
}

interface TipRanksPayload {
  ticker: string;
  companyName: string | null;
  marketCap: number | null;
  consensuses: TipRanksConsensus[] | null;
  consensusOverTime: ConsensusPoint[] | null;
  ptConsensus: PriceTargetConsensus[] | null;
  experts: TipRanksExpert[] | null;
}

export interface ConsensusDistribution {
  buy: number;
  hold: number;
  sell: number;
  total: number;
}

export interface SentimentChange {
  /** Distribution at the start of the comparison window. */
  from: ConsensusDistribution;
  to: ConsensusDistribution;
  fromDate: string;
  toDate: string;
  /** Net movement toward buy: rise in buys less rise in sells. */
  netShift: number;
}

export interface TipRanksData {
  distribution: Sourced<ConsensusDistribution>;
  /** Change over the requested lookback, when history reaches back that far. */
  change: Sourced<SentimentChange>;
  priceTarget: Sourced<number>;
  /**
   * Consensus weighted by each analyst's hit rate on this stock, in [-1, 1].
   * Positive leans buy.
   */
  accuracyWeightedScore: Sourced<number>;
  /** Mean success rate of the analysts in the consensus, for transparency. */
  meanAnalystAccuracy: Sourced<number>;
}

function distributionOf(c: {
  nB: number;
  nH: number;
  nS: number;
}): ConsensusDistribution {
  return { buy: c.nB, hold: c.nH, sell: c.nS, total: c.nB + c.nH + c.nS };
}

function pointDistribution(p: ConsensusPoint): ConsensusDistribution {
  return { buy: p.buy, hold: p.hold, sell: p.sell, total: p.buy + p.hold + p.sell };
}

export async function fetchTipRanks(
  ticker: string,
  opts: { lookbackDays?: number; refresh?: boolean } = {},
): Promise<TipRanksData> {
  const { lookbackDays = 30, refresh } = opts;
  const url = `${BASE}?name=${encodeURIComponent(ticker)}`;

  const data = await fetchJson<TipRanksPayload>(url, {
    ttlHours: TTL_HOURS,
    cacheKey: `tipranks_${ticker}`,
    headers: { Referer: `https://www.tipranks.com/stocks/${ticker.toLowerCase()}` },
    ...(refresh !== undefined ? { refresh } : {}),
  });

  // --- headline distribution ---------------------------------------------
  const latest =
    data.consensuses?.find((c) => c.isLatest === 1) ?? data.consensuses?.[0];

  const distribution = latest
    ? sourced(distributionOf(latest), webSource("TipRanks consensus", url))
    : unverified("TipRanks published no analyst consensus");

  // --- change over the lookback ------------------------------------------
  const history = (data.consensusOverTime ?? [])
    .slice()
    .sort((a, b) => a.date.localeCompare(b.date));

  let change: Sourced<SentimentChange>;
  const newest = history.at(-1);

  if (!newest || history.length < 2) {
    change = unverified("TipRanks published no consensus history");
  } else {
    const cutoff = new Date(Date.parse(newest.date) - lookbackDays * 86_400_000);
    // The oldest point still inside the window, else the earliest we have.
    const baseline =
      history.find((p) => Date.parse(p.date) >= cutoff.getTime()) ?? history[0];

    if (!baseline || baseline.date === newest.date) {
      change = unverified(`no consensus history older than ${lookbackDays} days`);
    } else {
      const from = pointDistribution(baseline);
      const to = pointDistribution(newest);
      change = sourced(
        {
          from,
          to,
          fromDate: baseline.date.slice(0, 10),
          toDate: newest.date.slice(0, 10),
          netShift: to.buy - from.buy - (to.sell - from.sell),
        },
        webSource("TipRanks consensus history", url, newest.date.slice(0, 10)),
      );
    }
  }

  // --- price target -------------------------------------------------------
  const pt = data.ptConsensus?.find((p) => typeof p.priceTarget === "number");
  const priceTarget =
    pt?.priceTarget != null
      ? sourced(pt.priceTarget, webSource("TipRanks price target", url))
      : unverified("TipRanks published no consensus price target");

  // --- accuracy weighting -------------------------------------------------
  const contributors = (data.experts ?? []).filter(
    (e) =>
      e.includedInConsensus &&
      typeof e.stockSuccessRate === "number" &&
      (e.ratings?.length ?? 0) > 0,
  );

  let weightedSum = 0;
  let weightTotal = 0;
  let accuracySum = 0;

  for (const expert of contributors) {
    const newestRating = expert.ratings
      ?.slice()
      .sort((a, b) => b.date.localeCompare(a.date))[0];
    if (!newestRating) continue;

    const direction =
      newestRating.ratingId === RATING_BUY
        ? 1
        : newestRating.ratingId === RATING_SELL
          ? -1
          : newestRating.ratingId === RATING_HOLD
            ? 0
            : undefined;
    if (direction === undefined) continue;

    const accuracy = expert.stockSuccessRate ?? 0;
    weightedSum += direction * accuracy;
    weightTotal += accuracy;
    accuracySum += accuracy;
  }

  const accuracyWeightedScore =
    weightTotal > 0
      ? sourced(weightedSum / weightTotal, webSource("TipRanks analyst records", url))
      : unverified("no ranked analyst records available for this stock");

  const meanAnalystAccuracy =
    contributors.length > 0
      ? sourced(
          accuracySum / contributors.length,
          webSource("TipRanks analyst records", url),
        )
      : unverified("no ranked analyst records available for this stock");

  return {
    distribution,
    change,
    priceTarget,
    accuracyWeightedScore,
    meanAnalystAccuracy,
  };
}
