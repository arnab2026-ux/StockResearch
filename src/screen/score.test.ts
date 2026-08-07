import assert from "node:assert/strict";
import { test, describe } from "node:test";

import { sourced, unverified, type Sourced } from "../lib/provenance.js";
import {
  composite,
  fcfYieldScore,
  insiderScore,
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

describe("insider score", () => {
  test("no activity scores zero", () => {
    const r = insiderScore({
      buyCount: 0,
      distinctBuyers: 0,
      buyValue: 0,
      sellValue: 0,
      majorHolderFilings: 0,
    });

    assert.equal(r.score, 0);
  });

  test("breadth outweighs a single large purchase", () => {
    const broad = insiderScore({
      buyCount: 4,
      distinctBuyers: 4,
      buyValue: 400_000,
      sellValue: 0,
      majorHolderFilings: 0,
    });
    const concentrated = insiderScore({
      buyCount: 1,
      distinctBuyers: 1,
      buyValue: 2_000_000,
      sellValue: 0,
      majorHolderFilings: 0,
    });

    assert.ok(
      broad.score > concentrated.score,
      `broad ${broad.score} should beat concentrated ${concentrated.score}`,
    );
  });

  test("heavy net selling tempers the score", () => {
    const base = {
      buyCount: 2,
      distinctBuyers: 2,
      buyValue: 500_000,
      majorHolderFilings: 0,
    };
    const clean = insiderScore({ ...base, sellValue: 0 });
    const offset = insiderScore({ ...base, sellValue: 5_000_000 });

    assert.ok(offset.score < clean.score);
  });

  test("13D/G filings alone produce a signal", () => {
    const r = insiderScore({
      buyCount: 0,
      distinctBuyers: 0,
      buyValue: 0,
      sellValue: 0,
      majorHolderFilings: 2,
    });

    assert.ok(r.score > 0);
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
