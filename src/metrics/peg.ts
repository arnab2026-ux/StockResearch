/**
 * PEG ratio: trailing P/E divided by the forward earnings growth rate.
 *
 * The point of the ratio is to say what a multiple costs per point of growth,
 * which only means anything when both halves are positive. Almost every way of
 * getting PEG wrong produces a plausible-looking number rather than an error:
 *
 * - A loss-making company has a negative P/E, so its PEG comes out negative and
 *   sorts *better* than every profitable company on a lower-is-better scale.
 * - A growth rate off a negative base is arithmetic without meaning. TEM is
 *   forecast to go -1.38 to -0.05, which is a real improvement, but
 *   (-0.05 / -1.38) ^ (1/2) - 1 is a positive-looking "growth rate" describing
 *   a shrinking loss. Nothing about that number belongs in a valuation ratio.
 * - Falling earnings give a negative growth rate and therefore a negative PEG,
 *   which again sorts as though it were cheap.
 *
 * So each of those cases is UNVERIFIED with a reason, never a number. The
 * growth rate and the ratio are computed separately because a verified growth
 * rate is still worth reporting when it disqualifies the PEG.
 */

import {
  derive,
  isVerified,
  sourced,
  today,
  unverified,
  type Sourced,
} from "../lib/provenance.js";
import type { EpsForecast } from "../providers/nasdaq.js";

export interface EpsGrowth {
  /** Compound annual growth rate over the span, as a percent, e.g. 35.3. */
  percentPerYear: number;
  /** Fiscal years the CAGR is compounded over — the calendar span, not a row count. */
  years: number;
  fromFiscalEnd: string;
  fromEps: number;
  toFiscalEnd: string;
  toEps: number;
  /**
   * The lowest year inside the span that sits below the starting year, when
   * there is one. A CAGR reports only its endpoints, so a forecast that dips
   * before recovering is indistinguishable from one that climbs steadily. The
   * dip is not an error and does not change the rate — but it must be visible
   * in anything the rate is printed in.
   */
  trough?: { fiscalEnd: string; eps: number };
}

/** "35.3%/yr, Jan 2027 → Jan 2029" — the growth rate with the span it covers. */
export function describeGrowth(g: EpsGrowth): string {
  const dip = g.trough
    ? `, dipping to ${g.trough.eps.toFixed(2)} in ${g.trough.fiscalEnd}`
    : "";
  return (
    `${g.percentPerYear >= 0 ? "+" : ""}${g.percentPerYear.toFixed(1)}%/yr consensus EPS ` +
    `growth, ${g.fromFiscalEnd} ${g.fromEps.toFixed(2)} → ${g.toFiscalEnd} ${g.toEps.toFixed(2)}${dip}`
  );
}

/**
 * Consensus EPS compound annual growth rate across the published forecast span.
 *
 * The longest available span is preferred over the next year alone: a single
 * year-ahead step is dominated by where the current fiscal year happens to sit,
 * and the brief's horizon is multi-month to a year rather than a quarter.
 *
 * Leading loss-making years are dropped, not included, because the compounding
 * base has to be positive. That deliberately leaves companies forecast to lose
 * money throughout — TEM, ABSI — with no growth rate at all rather than a
 * number computed off a negative base.
 *
 * A span that dips before recovering still gets a rate, and the rate is still
 * the endpoints'. Refusing one would be worse than reporting it: UNVERIFIED
 * means "could not be checked", and a forecast that was checked and found ugly
 * would then be *excluded* from the composite and rescaled away, which lifts
 * the company's score instead of lowering it. SWKS earns a real PEG of ~7.3
 * and a real 0/100 for it; that penalty is the point. What the dip does change
 * is the description — see `trough`.
 */
export function consensusEpsGrowth(
  forecasts: Sourced<EpsForecast[]>,
): Sourced<EpsGrowth> {
  if (!isVerified(forecasts)) return unverified(forecasts.reason);

  const rows = [...forecasts.value].sort((a, b) => a.year - b.year);

  if (rows.length < 2) {
    return unverified(
      `only ${rows.length} year of consensus EPS forecast published; a growth rate needs two`,
    );
  }

  // Everything up to and including the last non-positive year is unusable, so
  // the retained span is contiguous and entirely positive.
  const usable = rows.slice(rows.findLastIndex((r) => r.consensusEps <= 0) + 1);

  if (usable.length < 2) {
    const losses = rows
      .filter((r) => r.consensusEps <= 0)
      .map((r) => `${r.fiscalEnd} ${r.consensusEps.toFixed(2)}`)
      .join(", ");
    return unverified(
      `consensus EPS is not positive across two consecutive forecast years (${losses}); ` +
        "a growth rate off a non-positive base has no meaning",
    );
  }

  const first = usable[0];
  const last = usable.at(-1);
  if (!first || !last) {
    return unverified("consensus EPS forecast span could not be read");
  }

  // Compounded over the calendar span, not over the number of rows. Nasdaq
  // drops a forecast year it has no consensus for, so the rows are not
  // guaranteed to be consecutive — and counting them would compress a
  // three-year span into one interval and treble the apparent growth rate.
  const years = last.year - first.year;

  if (years < 1) {
    return unverified(
      `consensus EPS forecast rows do not span a full fiscal year ` +
        `(${first.fiscalEnd} → ${last.fiscalEnd}); a compound annual rate has no denominator`,
    );
  }

  const percentPerYear = ((last.consensusEps / first.consensusEps) ** (1 / years) - 1) * 100;

  if (!Number.isFinite(percentPerYear)) {
    return unverified("consensus EPS growth rate is not a finite number");
  }

  // Named, not corrected: the dip is a fact about the forecast, and hiding it
  // behind two endpoints is what would be wrong.
  const below = usable
    .slice(1, -1)
    .filter((r) => r.consensusEps < first.consensusEps)
    .sort((a, b) => a.consensusEps - b.consensusEps)[0];

  return sourced(
    {
      percentPerYear,
      years,
      fromFiscalEnd: first.fiscalEnd,
      fromEps: first.consensusEps,
      toFiscalEnd: last.fiscalEnd,
      toEps: last.consensusEps,
      ...(below ? { trough: { fiscalEnd: below.fiscalEnd, eps: below.consensusEps } } : {}),
    },
    {
      name: `Derived from ${forecasts.source.name} (${years}-year consensus EPS CAGR)`,
      url: forecasts.source.url,
      asOf: forecasts.source.asOf,
      retrievedAt: today(),
    },
  );
}

/**
 * PEG from a trailing P/E and a forward growth rate in percent.
 *
 * Both guards below produce UNVERIFIED rather than a number, because in each
 * case the arithmetic still succeeds and yields a value that would rank as
 * *cheap* on a lower-is-better scale.
 */
export function pegRatio(
  peRatio: Sourced<number>,
  growth: Sourced<EpsGrowth>,
): Sourced<number> {
  if (isVerified(peRatio) && peRatio.value <= 0) {
    return unverified(
      `trailing P/E is ${peRatio.value.toFixed(1)} — negative or zero trailing earnings ` +
        "leave no multiple to price against growth",
    );
  }

  if (isVerified(growth) && growth.value.percentPerYear <= 0) {
    return unverified(
      `consensus EPS is not forecast to grow (${describeGrowth(growth.value)})`,
    );
  }

  const growthPercent: Sourced<number> = isVerified(growth)
    ? sourced(growth.value.percentPerYear, growth.source)
    : growth;

  return derive(
    { pe: peRatio, growthPercent },
    (v) => v.pe / v.growthPercent,
    {
      name: "Derived (trailing P/E over forward consensus EPS growth)",
      url: "https://www.nasdaq.com/",
      retrievedAt: today(),
    },
  );
}
