import assert from "node:assert/strict";
import { test, describe } from "node:test";

import { sourced, unverified, type Sourced } from "../lib/provenance.js";
import {
  composite,
  fcfYieldScore,
  netAccumulationScore,
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
        sentiment: sourced(0, SRC),
      }),
    );

    assert.equal(result.value, 30);
    assert.equal(result.coverage, 1);
  });

  test("full marks across all factors is 100", () => {
    const result = composite(
      factors({
        insider: sourced(100, SRC),
        surprise: sourced(100, SRC),
        fcfYield: sourced(100, SRC),
        sentiment: sourced(100, SRC),
      }),
    );

    assert.equal(result.value, 100);
  });

  test("an unavailable factor is excluded, not scored zero", () => {
    // Insider is 30% of the weight. Were it scored zero the composite would
    // be 35; rescaling over available weight keeps it at 50.
    const result = composite({
      insider: factor(unverified("no data source")),
      surprise: factor(sourced(50, SRC)),
      fcfYield: factor(sourced(50, SRC)),
      sentiment: factor(sourced(50, SRC)),
    });

    assert.equal(result.value, 50);
    assert.ok(Math.abs(result.coverage - 0.7) < 1e-9);
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
        sentiment: sourced(0, SRC),
      }),
    );

    // Insider clamps to 100, surprise to 0.
    assert.equal(result.value, 30);
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
