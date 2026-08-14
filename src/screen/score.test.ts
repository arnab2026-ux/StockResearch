import assert from "node:assert/strict";
import { test, describe } from "node:test";

import { sourced, unverified, type Sourced } from "../lib/provenance.js";
import {
  composite,
  fcfYieldScore,
  netAccumulationScore,
  OWNERSHIP_COMPONENTS,
  pegScore,
  scale,
  sentimentScore,
  surpriseScore,
  WEIGHTS,
  type Factors,
} from "./score.js";

const SRC = {
  name: "test",
  url: "https://example.com",
  asOf: "2026-08-07",
  retrievedAt: "2026-08-07",
};

function factor(score: Sourced<number>, detail = ""): Factors[keyof Factors] {
  return { score, detail };
}

function factors(over: Partial<Record<keyof typeof WEIGHTS, Sourced<number>>>): Factors {
  return {
    insider: factor(over.insider ?? sourced(50, SRC)),
    surprise: factor(over.surprise ?? sourced(50, SRC)),
    fcfYield: factor(over.fcfYield ?? sourced(50, SRC)),
    peg: factor(over.peg ?? sourced(50, SRC)),
    sentiment: factor(over.sentiment ?? sourced(50, SRC)),
  };
}

describe("weights", () => {
  test("sum to 1 as the brief specifies", () => {
    const total = Object.values(WEIGHTS).reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(total - 1) < 1e-9, `weights sum to ${total}`);
  });
});

describe("composite", () => {
  test("weights factors as specified", () => {
    const result = composite(
      factors({
        insider: sourced(100, SRC),
        surprise: sourced(0, SRC),
        fcfYield: sourced(0, SRC),
        peg: sourced(0, SRC),
        sentiment: sourced(0, SRC),
      }),
    );

    assert.equal(result.value, 20);
    assert.equal(result.coverage, 1);
  });

  test("full marks across all factors is 100", () => {
    const result = composite(
      factors({
        insider: sourced(100, SRC),
        surprise: sourced(100, SRC),
        fcfYield: sourced(100, SRC),
        peg: sourced(100, SRC),
        sentiment: sourced(100, SRC),
      }),
    );

    assert.equal(result.value, 100);
  });

  test("an unavailable factor is excluded, not scored zero", () => {
    // Insider is 20% of the weight. Were it scored zero the composite would
    // be 40; rescaling over available weight keeps it at 50.
    const result = composite({
      insider: factor(unverified("no data source")),
      surprise: factor(sourced(50, SRC)),
      fcfYield: factor(sourced(50, SRC)),
      peg: factor(sourced(50, SRC)),
      sentiment: factor(sourced(50, SRC)),
    });

    assert.equal(result.value, 50);
    assert.ok(Math.abs(result.coverage - 0.8) < 1e-9);
    assert.equal(result.missing[0]?.factor, "insider");
  });

  test("reports the reason a factor was missing", () => {
    const result = composite({
      ...factors({}),
      sentiment: factor(unverified("TipRanks returned no consensus")),
    });

    assert.equal(result.missing.length, 1);
    assert.match(result.missing[0]?.reason ?? "", /TipRanks/);
  });

  test("no available factors yields undefined rather than zero", () => {
    const result = composite({
      insider: factor(unverified("x")),
      surprise: factor(unverified("x")),
      fcfYield: factor(unverified("x")),
      peg: factor(unverified("x")),
      sentiment: factor(unverified("x")),
    });

    assert.equal(result.value, undefined);
    assert.equal(result.coverage, 0);
  });

  test("clamps out-of-range factor scores", () => {
    const result = composite(
      factors({
        insider: sourced(500, SRC),
        surprise: sourced(-100, SRC),
        fcfYield: sourced(0, SRC),
        peg: sourced(0, SRC),
        sentiment: sourced(0, SRC),
      }),
    );

    // Insider clamps to 100, surprise to 0.
    assert.equal(result.value, 20);
  });

  test("a company with no PEG is not penalised for it", () => {
    // The common case for loss-making names: everything else is measurable and
    // the composite must reflect those factors alone.
    const withPeg = composite(factors({ peg: sourced(0, SRC) }));
    const withoutPeg = composite(factors({ peg: unverified("negative P/E") }));

    assert.ok(Math.abs((withoutPeg.value ?? 0) - 50) < 1e-9);
    assert.ok(withPeg.value !== undefined && withPeg.value < 50);
    assert.ok(Math.abs(withoutPeg.coverage - 0.9) < 1e-9);
  });
});

describe("scale", () => {
  test("clamps at both ends", () => {
    assert.equal(scale(-5, 0, 10), 0);
    assert.equal(scale(15, 0, 10), 100);
    assert.equal(scale(5, 0, 10), 50);
  });

  test("degenerate range returns the midpoint", () => {
    assert.equal(scale(3, 5, 5), 50);
  });
});

describe("net accumulation score", () => {
  const QUIET = {
    netInsiderValue: 0,
    distinctBuyers: 0,
    distinctSellers: 0,
    netHolderPercentChange: 0,
    holdersIncreasing: 0,
    holdersDecreasing: 0,
    windowDays: 90,
  };

  test("no activity at all is neutral, not zero", () => {
    // An absence of trading is not evidence of distribution.
    const r = netAccumulationScore(QUIET);
    assert.equal(r.score, 50);
    assert.match(r.detail, /no insider trades/);
  });

  test("net buying scores above neutral, net selling below", () => {
    const buying = netAccumulationScore({
      ...QUIET,
      netInsiderValue: 1_500_000,
      distinctBuyers: 3,
    });
    const selling = netAccumulationScore({
      ...QUIET,
      netInsiderValue: -1_500_000,
      distinctSellers: 3,
    });

    assert.ok(buying.score > 50, `buying scored ${buying.score}`);
    assert.ok(selling.score < 50, `selling scored ${selling.score}`);
  });

  test("a fund exiting scores below a fund entering", () => {
    const entering = netAccumulationScore({
      ...QUIET,
      netHolderPercentChange: 3,
      holdersIncreasing: 1,
    });
    const exiting = netAccumulationScore({
      ...QUIET,
      netHolderPercentChange: -3,
      holdersDecreasing: 1,
    });

    assert.ok(
      exiting.score < entering.score,
      `exit ${exiting.score} should be below entry ${entering.score}`,
    );
  });

  test("insider buying is offset by a large fund exit", () => {
    const mixed = netAccumulationScore({
      ...QUIET,
      netInsiderValue: 500_000,
      distinctBuyers: 1,
      netHolderPercentChange: -4,
      holdersDecreasing: 2,
    });
    const clean = netAccumulationScore({
      ...QUIET,
      netInsiderValue: 500_000,
      distinctBuyers: 1,
    });

    assert.ok(mixed.score < clean.score);
  });

  test("breadth of buyers lifts the score at equal dollar value", () => {
    const broad = netAccumulationScore({
      ...QUIET,
      netInsiderValue: 400_000,
      distinctBuyers: 3,
    });
    const single = netAccumulationScore({
      ...QUIET,
      netInsiderValue: 400_000,
      distinctBuyers: 1,
    });

    assert.ok(broad.score > single.score);
  });

  test("detail names both measures when active", () => {
    const r = netAccumulationScore({
      ...QUIET,
      netInsiderValue: 250_000,
      distinctBuyers: 2,
      netHolderPercentChange: 1.5,
      holdersIncreasing: 1,
    });

    assert.match(r.detail, /insider net \+\$250,000/);
    assert.match(r.detail, /5%\+ holders net \+1\.50pp/);
  });
});

describe("ownership components", () => {
  const QUIET = {
    netInsiderValue: 0,
    distinctBuyers: 0,
    distinctSellers: 0,
    netHolderPercentChange: 0,
    holdersIncreasing: 0,
    holdersDecreasing: 0,
    windowDays: 90,
  };

  /** EDGAR side maxed out, so the renormalisation is visible in the number. */
  const EDGAR_MAX = { ...QUIET, netInsiderValue: 2_000_000 };

  const congress = (net: number, purchases = Math.max(net, 0), sales = Math.max(-net, 0)) => ({
    net,
    purchases,
    sales,
    distinctFilers: Math.max(1, purchases + sales),
  });

  test("the four components sum to one", () => {
    const total = Object.values(OWNERSHIP_COMPONENTS).reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(total - 1) < 1e-9, `components sum to ${total}`);
  });

  test("the split is the one the design fixes", () => {
    assert.deepEqual(OWNERSHIP_COMPONENTS, {
      flow: 0.4,
      stake: 0.35,
      breadth: 0.15,
      congress: 0.1,
    });
  });

  test("an unchecked House feed renormalises rather than scoring the slice zero", () => {
    // flow 100, stake 50, breadth 50 → 65 of 0.9 available weight.
    // Scoring the missing congress slice zero would give 65; rescaling gives
    // 72.2, which is the same treatment `composite()` gives a missing factor.
    const r = netAccumulationScore(EDGAR_MAX);
    assert.ok(Math.abs(r.score - 65 / 0.9) < 1e-9, `scored ${r.score}`);
    assert.ok(r.score > 65, "the missing component must not drag the score down");
  });

  test("present-but-empty is neutral evidence, not the same as unchecked", () => {
    const unchecked = netAccumulationScore(EDGAR_MAX);
    const checkedAndQuiet = netAccumulationScore({ ...EDGAR_MAX, congress: congress(0, 0, 0) });

    // A window that was read and had nothing in it genuinely pulls toward
    // neutral. A window that was never read cannot say anything at all.
    assert.ok(Math.abs(checkedAndQuiet.score - 70) < 1e-9, `scored ${checkedAndQuiet.score}`);
    assert.ok(checkedAndQuiet.score < unchecked.score);
    assert.match(checkedAndQuiet.detail, /no congressional disclosures/);
    assert.doesNotMatch(unchecked.detail, /congress/i);
  });

  test("a quiet window with no House pass is exactly neutral", () => {
    assert.equal(netAccumulationScore(QUIET).score, 50);
    assert.equal(netAccumulationScore({ ...QUIET, congress: congress(0, 0, 0) }).score, 50);
  });

  test("one congressional purchase in an otherwise quiet name moves the score a little", () => {
    const r = netAccumulationScore({ ...QUIET, congress: congress(1) });

    // 45 from the three neutral EDGAR components, plus scale(1,-3,3)·0.10.
    assert.ok(Math.abs(r.score - (45 + (100 * 2) / 3 / 10)) < 1e-9, `scored ${r.score}`);
    assert.ok(r.score > 50 && r.score < 52, `expected a nudge, got ${r.score}`);
  });

  test("the congressional component cannot move the ownership score by more than five points", () => {
    const most = netAccumulationScore({ ...QUIET, congress: congress(3) });
    const least = netAccumulationScore({ ...QUIET, congress: congress(-3) });

    assert.equal(most.score, 55);
    assert.equal(least.score, 45);
    for (const net of [-50, -10, -3, 3, 10, 50]) {
      const s = netAccumulationScore({ ...QUIET, congress: congress(net) }).score;
      assert.ok(s >= 45 && s <= 55, `net ${net} scored ${s}`);
    }
  });

  test("three net trades saturates — a fourth adds nothing", () => {
    const three = netAccumulationScore({ ...QUIET, congress: congress(3) }).score;
    const ten = netAccumulationScore({ ...QUIET, congress: congress(10) }).score;
    assert.equal(three, ten);
  });

  test("at 20% of the composite, congress alone cannot move the score by a point", () => {
    const quiet = netAccumulationScore({ ...QUIET, congress: congress(0, 0, 0) }).score;

    for (const net of [1, 3, 50, -1, -3, -50]) {
      const withCongress = netAccumulationScore({ ...QUIET, congress: congress(net) }).score;
      const before = composite(factors({ insider: sourced(quiet, SRC) })).value ?? 0;
      const after = composite(factors({ insider: sourced(withCongress, SRC) })).value ?? 0;
      assert.ok(
        Math.abs(after - before) <= 1 + 1e-9,
        `net ${net} moved the composite by ${(after - before).toFixed(3)}`,
      );
    }
  });

  test("congressional selling scores below congressional buying", () => {
    const buying = netAccumulationScore({ ...QUIET, congress: congress(2) });
    const selling = netAccumulationScore({ ...QUIET, congress: congress(-2) });
    assert.ok(selling.score < 50 && buying.score > 50);
    assert.match(buying.detail, /Congress net \+2 \(2 buy \/ 0 sell/);
    assert.match(selling.detail, /Congress net -2 \(0 buy \/ 2 sell/);
  });

  test("congressional activity that nets to zero is not read as an absence", () => {
    // One buy and one sell is evidence, and evidence that cancels. It must
    // not be reported with the "nothing happened" wording.
    const r = netAccumulationScore({ ...QUIET, congress: congress(0, 1, 1) });
    assert.equal(r.score, 50);
    assert.match(r.detail, /Congress net \+0 \(1 buy \/ 1 sell/);
    assert.doesNotMatch(r.detail, /no insider trades/);
  });

  test("congress never overturns a decisive EDGAR reading", () => {
    // Heavy insider selling plus the loudest possible congressional buying
    // still has to land below neutral.
    const r = netAccumulationScore({
      ...QUIET,
      netInsiderValue: -2_000_000,
      distinctSellers: 3,
      netHolderPercentChange: -4,
      holdersDecreasing: 2,
      congress: congress(3),
    });
    assert.ok(r.score < 50, `scored ${r.score}`);
  });
});

describe("surprise score", () => {
  test("two consistent beats beat one large beat after a miss", () => {
    const steady = surpriseScore([
      { surprisePercent: 4, reportedOn: "2026-07-30" },
      { surprisePercent: 5, reportedOn: "2026-04-30" },
    ]);
    const erratic = surpriseScore([
      { surprisePercent: 20, reportedOn: "2026-07-30" },
      { surprisePercent: -11, reportedOn: "2026-04-30" },
    ]);

    assert.ok(
      steady.score > erratic.score,
      `steady ${steady.score} should beat erratic ${erratic.score}`,
    );
  });

  test("empty history scores zero", () => {
    assert.equal(surpriseScore([]).score, 0);
  });

  test("consecutive misses score low", () => {
    const r = surpriseScore([
      { surprisePercent: -8, reportedOn: "2026-07-30" },
      { surprisePercent: -6, reportedOn: "2026-04-30" },
    ]);

    assert.ok(r.score < 20, `expected low score, got ${r.score}`);
  });
});

describe("FCF yield score", () => {
  test("negative yield scores zero", () => {
    assert.equal(fcfYieldScore(-0.03).score, 0);
  });

  test("saturates at 8%", () => {
    assert.equal(fcfYieldScore(0.08).score, 100);
    assert.equal(fcfYieldScore(0.2).score, 100);
  });

  test("is monotonic below saturation", () => {
    assert.ok(fcfYieldScore(0.04).score > fcfYieldScore(0.02).score);
  });
});

describe("PEG score", () => {
  test("is inverted — a lower PEG scores higher", () => {
    // The one factor in the system where less is better.
    assert.ok(pegScore(0.9).score > pegScore(1.8).score);
    assert.ok(pegScore(1.8).score > pegScore(2.6).score);
  });

  test("saturates at 0.75 and bottoms out at 3.0", () => {
    assert.equal(pegScore(0.75).score, 100);
    assert.equal(pegScore(0.2).score, 100);
    assert.equal(pegScore(3).score, 0);
    assert.equal(pegScore(12).score, 0);
  });

  test("PEG 1.0 sits near the top of the band", () => {
    const r = pegScore(1);
    assert.ok(r.score > 85 && r.score < 95, `PEG 1.0 scored ${r.score}`);
  });

  test("detail states the ratio", () => {
    assert.equal(pegScore(1.234).detail, "PEG 1.23");
  });
});

describe("sentiment score", () => {
  test("unanimous buys outrank a split verdict", () => {
    const strong = sentimentScore({
      buy: 20,
      hold: 0,
      sell: 0,
      netShift: undefined,
      accuracyWeighted: undefined,
    });
    const split = sentimentScore({
      buy: 10,
      hold: 5,
      sell: 5,
      netShift: undefined,
      accuracyWeighted: undefined,
    });

    assert.ok(strong.score > split.score);
  });

  test("no coverage scores zero", () => {
    const r = sentimentScore({
      buy: 0,
      hold: 0,
      sell: 0,
      netShift: undefined,
      accuracyWeighted: undefined,
    });

    assert.equal(r.score, 0);
  });

  test("a positive shift lifts the score above the same static level", () => {
    const base = { buy: 10, hold: 5, sell: 1, accuracyWeighted: undefined };
    const rising = sentimentScore({ ...base, netShift: 3 });
    const falling = sentimentScore({ ...base, netShift: -3 });

    assert.ok(rising.score > falling.score);
  });

  test("missing sub-inputs renormalise rather than drag the score down", () => {
    const full = sentimentScore({
      buy: 20,
      hold: 0,
      sell: 0,
      netShift: 3,
      accuracyWeighted: 1,
    });
    const partial = sentimentScore({
      buy: 20,
      hold: 0,
      sell: 0,
      netShift: undefined,
      accuracyWeighted: undefined,
    });

    // Both are maximal for what they can measure.
    assert.ok(Math.abs(full.score - partial.score) < 1e-9);
  });
});
