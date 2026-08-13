import assert from "node:assert/strict";
import { test, describe } from "node:test";

import { isVerified, sourced, unverified, type Sourced } from "../lib/provenance.js";
import type { EpsForecast } from "../providers/nasdaq.js";
import { pegScore } from "../screen/score.js";
import { consensusEpsGrowth, describeGrowth, pegRatio } from "./peg.js";

const SRC = {
  name: "Nasdaq EPS consensus forecast",
  url: "https://api.nasdaq.com/api/analyst/NVDA/earnings-forecast",
  asOf: "2026-08-13",
  retrievedAt: "2026-08-13",
};

/** Rows as Nasdaq publishes them: month-and-year label, consensus EPS. */
function rows(...pairs: [string, number][]): Sourced<EpsForecast[]> {
  return sourced(
    pairs.map(([fiscalEnd, consensusEps]) => ({
      fiscalEnd,
      year: Number(/(\d{4})/.exec(fiscalEnd)?.[1]),
      consensusEps,
    })),
    SRC,
  );
}

// Real Nasdaq yearly forecasts, August 2026.
const NVDA = rows(["Jan 2027", 8.79], ["Jan 2028", 12.13], ["Jan 2029", 16.1]);
const CRUS = rows(["Mar 2027", 7.86], ["Mar 2028", 8.32], ["Mar 2029", 8.58]);
const ASML = rows(
  ["Dec 2026", 44.85],
  ["Dec 2027", 59.18],
  ["Dec 2028", 80.04],
  ["Dec 2029", 89.2],
);
const SWKS = rows(["Sep 2026", 3.64], ["Sep 2027", 3.52], ["Sep 2028", 3.81]);
const TEM = rows(["Dec 2026", -1.38], ["Dec 2027", -1.0], ["Dec 2028", -0.05]);
const ABSI = rows(["Dec 2026", -0.71], ["Dec 2027", -0.62], ["Dec 2028", -0.6]);

function growthOf(forecasts: Sourced<EpsForecast[]>): number {
  const g = consensusEpsGrowth(forecasts);
  assert.ok(isVerified(g), `expected a growth rate, got ${!g.ok ? g.reason : ""}`);
  return g.value.percentPerYear;
}

describe("consensus EPS growth", () => {
  test("compounds across the full published span", () => {
    // (16.10 / 8.79) ^ (1/2) - 1
    assert.ok(Math.abs(growthOf(NVDA) - 35.3376) < 0.01, `${growthOf(NVDA)}`);
    // Three intervals, not four rows: 44.85 to 89.20 over Dec 2026 → Dec 2029.
    assert.ok(Math.abs(growthOf(ASML) - 25.7585) < 0.01, `${growthOf(ASML)}`);
    assert.ok(Math.abs(growthOf(CRUS) - 4.4798) < 0.01, `${growthOf(CRUS)}`);
  });

  test("reports the span it measured", () => {
    const g = consensusEpsGrowth(NVDA);
    assert.ok(isVerified(g));
    assert.equal(g.value.years, 2);
    assert.equal(g.value.fromFiscalEnd, "Jan 2027");
    assert.equal(g.value.toFiscalEnd, "Jan 2029");
  });

  test("a near-term dip does not decide the rate on its own", () => {
    // SWKS falls 3.64 → 3.52 next year before recovering to 3.81. Measured
    // over the whole span it still grows, slowly; the one-year step alone
    // would have called it a decline.
    const g = growthOf(SWKS);
    assert.ok(g > 0 && g < 5, `SWKS growth ${g}`);
  });

  test("ordering comes from the fiscal year, not the feed", () => {
    // A reversed feed would otherwise invert the rate without failing.
    const reversed = rows(["Jan 2029", 16.1], ["Jan 2028", 12.13], ["Jan 2027", 8.79]);
    assert.ok(Math.abs(growthOf(reversed) - growthOf(NVDA)) < 1e-9);
  });

  test("all-negative forecasts have no growth rate at all", () => {
    // TEM improves from -1.38 to -0.05, which a naive CAGR renders as a
    // confident-looking positive number. There is no growth rate here.
    for (const [name, forecasts] of [["TEM", TEM], ["ABSI", ABSI]] as const) {
      const g = consensusEpsGrowth(forecasts);
      assert.equal(g.ok, false, `${name} should have no growth rate`);
      assert.match(!g.ok ? g.reason : "", /non-positive base|not positive/);
    }
  });

  test("a loss year before the forecast turns positive is dropped", () => {
    const g = consensusEpsGrowth(rows(["Dec 2026", -0.5], ["Dec 2027", 0.4], ["Dec 2028", 0.9]));
    assert.ok(isVerified(g));
    assert.equal(g.value.fromFiscalEnd, "Dec 2027");
    assert.equal(g.value.years, 1);
    assert.ok(Math.abs(g.value.percentPerYear - 125) < 1e-9);
  });

  test("a loss year in the middle disqualifies the span", () => {
    // Compounding across it would price a round trip through a loss as growth.
    const g = consensusEpsGrowth(rows(["Dec 2026", 1], ["Dec 2027", -0.2], ["Dec 2028", 2]));
    assert.equal(g.ok, false);
  });

  test("a zero forecast is treated as non-positive, not as a base", () => {
    const g = consensusEpsGrowth(rows(["Dec 2026", 0], ["Dec 2027", 1.2]));
    assert.equal(g.ok, false);
  });

  test("one year of forecast is not a growth rate", () => {
    const g = consensusEpsGrowth(rows(["Jan 2027", 8.79]));
    assert.equal(g.ok, false);
    assert.match(!g.ok ? g.reason : "", /needs two/);
  });

  test("an unavailable forecast propagates its reason", () => {
    const g = consensusEpsGrowth(unverified("Nasdaq returned HTTP 403"));
    assert.equal(g.ok, false);
    assert.match(!g.ok ? g.reason : "", /403/);
  });

  test("an empty forecast is not a growth rate", () => {
    const g = consensusEpsGrowth(sourced([] as EpsForecast[], SRC));
    assert.equal(g.ok, false);
    assert.match(!g.ok ? g.reason : "", /needs two/);
  });

  test("compounds over the calendar span, not the row count", () => {
    // Nasdaq drops a year it has no consensus for (nasdaq.ts declines to
    // interpolate one), so the surviving rows can straddle a gap. Counting
    // rows would compound 1.00 → 2.00 over one interval and call it 100%/yr
    // while labelling the span Dec 2026 → Dec 2029.
    const gapped = consensusEpsGrowth(rows(["Dec 2026", 1.0], ["Dec 2029", 2.0]));
    assert.ok(isVerified(gapped));
    assert.equal(gapped.value.years, 3);
    // (2 / 1) ^ (1/3) - 1
    assert.ok(Math.abs(gapped.value.percentPerYear - 25.9921) < 0.01, `${gapped.value.percentPerYear}`);

    // The gapped span must land on the same rate as the same endpoints filled in.
    const filled = consensusEpsGrowth(
      rows(["Dec 2026", 1.0], ["Dec 2027", 1.2599], ["Dec 2028", 1.5874], ["Dec 2029", 2.0]),
    );
    assert.ok(isVerified(filled));
    assert.ok(
      Math.abs(filled.value.percentPerYear - gapped.value.percentPerYear) < 0.01,
      `gapped ${gapped.value.percentPerYear} vs filled ${filled.value.percentPerYear}`,
    );
  });

  test("the reported span and the compounding denominator always agree", () => {
    for (const f of [NVDA, ASML, CRUS, SWKS]) {
      const g = consensusEpsGrowth(f);
      assert.ok(isVerified(g));
      const from = Number(/(\d{4})/.exec(g.value.fromFiscalEnd)?.[1]);
      const to = Number(/(\d{4})/.exec(g.value.toFiscalEnd)?.[1]);
      assert.equal(g.value.years, to - from);
      // Re-deriving the rate from the printed endpoints must reproduce it.
      const recomputed =
        ((g.value.toEps / g.value.fromEps) ** (1 / g.value.years) - 1) * 100;
      assert.ok(Math.abs(recomputed - g.value.percentPerYear) < 1e-9);
    }
  });

  test("two forecast rows inside one calendar year have no annual rate", () => {
    // A fiscal year-end change publishes two rows for the same year. A
    // zero-year denominator would otherwise compound to Infinity or to a
    // silently invented one-year rate.
    const g = consensusEpsGrowth(rows(["Jan 2027", 1.0], ["Dec 2027", 2.0]));
    assert.equal(g.ok, false);
    assert.match(!g.ok ? g.reason : "", /full fiscal year|no denominator/);
  });
});

describe("PEG ratio", () => {
  const growth = consensusEpsGrowth(NVDA);

  test("is the trailing multiple over the growth rate in percent", () => {
    const peg = pegRatio(sourced(45, SRC), growth);
    assert.ok(isVerified(peg));
    // 45 / 35.3376
    assert.ok(Math.abs(peg.value - 1.2734) < 0.001, `${peg.value}`);
  });

  test("a loss-making company has no PEG, not a negative one", () => {
    // A negative PEG sorts as the cheapest thing in the universe.
    const peg = pegRatio(sourced(-18.4, SRC), growth);
    assert.equal(peg.ok, false);
    assert.match(!peg.ok ? peg.reason : "", /negative or zero trailing earnings/);
  });

  test("a zero P/E is refused for the same reason", () => {
    const peg = pegRatio(sourced(0, SRC), growth);
    assert.equal(peg.ok, false);
  });

  test("shrinking earnings have no PEG", () => {
    const declining = consensusEpsGrowth(rows(["Dec 2026", 5], ["Dec 2027", 4]));
    assert.ok(isVerified(declining));
    assert.ok(declining.value.percentPerYear < 0);

    const peg = pegRatio(sourced(20, SRC), declining);
    assert.equal(peg.ok, false);
    assert.match(!peg.ok ? peg.reason : "", /not forecast to grow/);
  });

  test("a missing input is named rather than dropped", () => {
    const noPe = pegRatio(unverified("no quote provider available"), growth);
    assert.equal(noPe.ok, false);
    assert.match(!noPe.ok ? noPe.reason : "", /pe unavailable/);

    const noGrowth = pegRatio(sourced(45, SRC), consensusEpsGrowth(TEM));
    assert.equal(noGrowth.ok, false);
    assert.match(!noGrowth.ok ? noGrowth.reason : "", /growthPercent unavailable/);
  });

  test("a mid-span dip is named, never averaged out of sight", () => {
    // The CAGR is an endpoints-only statistic, so 3.64 → 3.81 reads identically
    // whether the path climbed or fell through 3.52 first. The rate stays the
    // rate; the description has to carry the dip.
    const g = consensusEpsGrowth(SWKS);
    assert.ok(isVerified(g));
    assert.deepEqual(g.value.trough, { fiscalEnd: "Sep 2027", eps: 3.52 });
    assert.match(describeGrowth(g.value), /dipping to 3\.52 in Sep 2027/);

    const steady = consensusEpsGrowth(CRUS);
    assert.ok(isVerified(steady));
    assert.equal(steady.value.trough, undefined);
    assert.doesNotMatch(describeGrowth(steady.value), /dipping/);
  });

  test("a down year ahead scores at the floor rather than being excluded", () => {
    // SWKS's next fiscal year is down, but the two-year span still grows, so
    // the not-forecast-to-grow guard does not fire and the PEG is real: ~7.3
    // against a band that bottoms out at 3.0.
    //
    // That is the intended outcome and the harsher one. UNVERIFIED would mean
    // "could not be checked", and composite() excludes an unverified factor
    // and rescales — so refusing this PEG would delete a 0/100 from SWKS's
    // average and *raise* its composite. A finding must not be laundered into
    // an absence.
    const peg = pegRatio(sourced(16.95, SRC), consensusEpsGrowth(SWKS));
    assert.ok(isVerified(peg), "SWKS must get a real PEG, not an excused one");
    assert.ok(Math.abs(peg.value - 7.342) < 0.01, `${peg.value}`);
    assert.equal(pegScore(peg.value).score, 0);
  });

  test("a v-shaped recovery is scored on the recovery, with the trough visible", () => {
    // The known cost of the longest-span rule: a collapse followed by a
    // rebound compounds to a high rate and a top PEG score. The rate is not
    // wrong — consensus really does end far higher — but the report must not
    // present it as smooth growth.
    const g = consensusEpsGrowth(rows(["Dec 2026", 5], ["Dec 2027", 3], ["Dec 2028", 12]));
    assert.ok(isVerified(g));
    assert.ok(Math.abs(g.value.percentPerYear - 54.919) < 0.01, `${g.value.percentPerYear}`);

    const peg = pegRatio(sourced(30, SRC), g);
    assert.ok(isVerified(peg));
    assert.equal(pegScore(peg.value).score, 100);
    assert.match(describeGrowth(g.value), /dipping to 3\.00 in Dec 2027/);
  });

  test("KNOWN GAP: a near-zero forecast base produces an unbounded growth rate", () => {
    // Characterisation, not endorsement. 0.05 → 2.00 is arithmetically a
    // 3900%/yr rate, and dividing a 500x trailing multiple by it yields a PEG
    // of 0.13 and a perfect score — a company at 500x earnings ranking as the
    // cheapest growth in the universe. No threshold is invented here because
    // any cut-off would be a figure nobody published; what stops it in
    // practice is that a company forecast to earn 0.05 is almost always
    // loss-making today, and a non-positive trailing P/E is already refused.
    //
    // If a live run ever produces a PEG under ~0.3 on a triple-digit P/E, this
    // is the path it came down.
    const g = consensusEpsGrowth(rows(["Dec 2026", 0.05], ["Dec 2027", 2.0]));
    assert.ok(isVerified(g));
    assert.ok(Math.abs(g.value.percentPerYear - 3900) < 0.01, `${g.value.percentPerYear}`);

    const peg = pegRatio(sourced(500, SRC), g);
    assert.ok(isVerified(peg));
    assert.ok(peg.value < 0.15, `${peg.value}`);
    assert.equal(pegScore(peg.value).score, 100);

    // The guard that does hold: the same company one year earlier, still
    // loss-making, gets no PEG at all.
    assert.equal(pegRatio(sourced(-40, SRC), g).ok, false);
  });

  test("a positive span that turns negative is refused", () => {
    // The mirror of the leading-loss case. Slicing past the last non-positive
    // year must leave nothing here, not silently compound 1 → 2 and ignore the
    // loss that follows.
    const g = consensusEpsGrowth(rows(["Dec 2026", 1], ["Dec 2027", 2], ["Dec 2028", -0.5]));
    assert.equal(g.ok, false);
    assert.match(!g.ok ? g.reason : "", /non-positive base|not positive/);
    assert.equal(pegRatio(sourced(30, SRC), g).ok, false);
  });

  test("a verified PEG is always positive and finite", () => {
    // The two guards exist to stop a sign inversion, so nothing that survives
    // them may sort as cheaper than a genuinely cheap company.
    const cases: [number, Sourced<EpsForecast[]>][] = [
      [45, NVDA], [30, ASML], [30, CRUS], [16.95, SWKS],
      [-18, NVDA], [0, NVDA], [45, TEM], [45, ABSI],
      [45, rows(["Dec 2026", 5], ["Dec 2027", 4])],
      [45, rows(["Dec 2026", 5], ["Dec 2027", 5])],
      [45, rows(["Dec 2026", 1e-12], ["Dec 2027", 1e12])],
    ];

    for (const [pe, forecasts] of cases) {
      const peg = pegRatio(sourced(pe, SRC), consensusEpsGrowth(forecasts));
      if (!isVerified(peg)) continue;
      assert.ok(peg.value > 0 && Number.isFinite(peg.value), `PEG ${peg.value} from P/E ${pe}`);
      const s = pegScore(peg.value).score;
      assert.ok(s >= 0 && s <= 100, `score ${s}`);
    }
  });

  test("cheap growth ranks below expensive growth on the raw ratio", () => {
    const asml = pegRatio(sourced(30, SRC), consensusEpsGrowth(ASML));
    const crus = pegRatio(sourced(30, SRC), consensusEpsGrowth(CRUS));
    assert.ok(isVerified(asml) && isVerified(crus));
    // Same multiple, six times the growth: ASML's PEG must be far lower.
    assert.ok(asml.value < crus.value);
  });
});
