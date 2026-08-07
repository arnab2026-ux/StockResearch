import assert from "node:assert/strict";
import { test, describe } from "node:test";

import { normalize } from "../edgar/normalize.js";
import type { CompanyFacts, XbrlFact } from "../edgar/types.js";
import { isVerified, valueOf } from "../lib/provenance.js";
import {
  computeRatios,
  readAt,
  snapshotAt,
  trailingTwelveMonths,
  ttmFreeCashFlow,
} from "./fundamentals.js";
import { altmanZ, piotroskiFScore } from "./strength.js";

interface Line {
  tag: string;
  instant?: boolean;
  /** Share counts live under `units.shares`, not the reporting currency. */
  unit?: string;
  values: { end: string; val: number; start?: string }[];
}

function build(lines: Line[]): ReturnType<typeof normalize> {
  const bucket: Record<string, { units: Record<string, XbrlFact[]> }> = {};

  for (const line of lines) {
    bucket[line.tag] = {
      units: {
        [line.unit ?? "USD"]: line.values.map((v) => ({
          ...(line.instant ? {} : { start: v.start ?? yearStart(v.end) }),
          end: v.end,
          val: v.val,
          accn: "0000000000-00-000000",
          fy: 2025,
          fp: "FY",
          form: "10-K",
          filed: "2026-02-01",
        })),
      },
    };
  }

  const facts: CompanyFacts = {
    cik: 1,
    entityName: "Test Co",
    facts: { "us-gaap": bucket },
  };

  return normalize(facts, "0000000001");
}

function yearStart(end: string): string {
  const d = new Date(end);
  d.setUTCFullYear(d.getUTCFullYear() - 1);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

describe("nil-when-absent rule", () => {
  test("treats absent short-term debt as zero when the balance sheet is present", () => {
    const c = build([
      { tag: "Assets", instant: true, values: [{ end: "2025-12-31", val: 1000 }] },
    ]);

    const std = readAt(c, "shortTermDebt", "2025-12-31");
    assert.equal(isVerified(std), true);
    assert.equal(valueOf(std), 0);
    assert.match(
      isVerified(std) ? std.source.name : "",
      /treated as nil/,
      "the inference must be visible in the citation",
    );
  });

  test("leaves debt unverified when the balance sheet itself is missing", () => {
    const c = build([
      { tag: "Revenues", values: [{ end: "2025-12-31", val: 100 }] },
    ]);

    assert.equal(isVerified(readAt(c, "shortTermDebt", "2025-12-31")), false);
  });

  test("does not apply the rule to revenue", () => {
    const c = build([
      { tag: "Assets", instant: true, values: [{ end: "2025-12-31", val: 1000 }] },
    ]);

    assert.equal(isVerified(readAt(c, "revenue", "2025-12-31")), false);
  });
});

describe("ratios", () => {
  const company = build([
    { tag: "Revenues", values: [{ end: "2025-12-31", val: 1000 }] },
    { tag: "GrossProfit", values: [{ end: "2025-12-31", val: 600 }] },
    { tag: "OperatingIncomeLoss", values: [{ end: "2025-12-31", val: 200 }] },
    { tag: "NetIncomeLoss", values: [{ end: "2025-12-31", val: 150 }] },
    {
      tag: "NetCashProvidedByUsedInOperatingActivities",
      values: [{ end: "2025-12-31", val: 250 }],
    },
    {
      tag: "PaymentsToAcquirePropertyPlantAndEquipment",
      values: [{ end: "2025-12-31", val: 50 }],
    },
    {
      tag: "DepreciationDepletionAndAmortization",
      values: [{ end: "2025-12-31", val: 40 }],
    },
    { tag: "Assets", instant: true, values: [{ end: "2025-12-31", val: 2000 }] },
    { tag: "AssetsCurrent", instant: true, values: [{ end: "2025-12-31", val: 800 }] },
    {
      tag: "LiabilitiesCurrent",
      instant: true,
      values: [{ end: "2025-12-31", val: 400 }],
    },
    {
      tag: "CashAndCashEquivalentsAtCarryingValue",
      instant: true,
      values: [{ end: "2025-12-31", val: 300 }],
    },
    {
      tag: "LongTermDebtNoncurrent",
      instant: true,
      values: [{ end: "2025-12-31", val: 500 }],
    },
    { tag: "StockholdersEquity", instant: true, values: [{ end: "2025-12-31", val: 900 }] },
  ]);

  const r = computeRatios(snapshotAt(company, "2025-12-31"));

  test("free cash flow is operating cash flow less capex", () => {
    assert.equal(valueOf(r.freeCashFlow), 200);
  });

  test("EBITDA adds back depreciation and amortisation", () => {
    assert.equal(valueOf(r.ebitda), 240);
  });

  test("net debt subtracts cash and short-term investments", () => {
    // 500 long-term debt, no short-term debt or investments, less 300 cash.
    assert.equal(valueOf(r.netDebt), 200);
  });

  test("margins compute off revenue", () => {
    assert.equal(valueOf(r.grossMargin), 0.6);
    assert.equal(valueOf(r.operatingMargin), 0.2);
    assert.equal(valueOf(r.fcfMargin), 0.2);
  });

  test("current ratio", () => {
    assert.equal(valueOf(r.currentRatio), 2);
  });

  test("interest coverage is unverified when interest expense is absent", () => {
    assert.equal(isVerified(r.interestCoverage), false);
  });

  test("a derived figure names the input that was missing", () => {
    const missing = r.interestCoverage;
    assert.equal(missing.ok, false);
    if (!missing.ok) assert.match(missing.reason, /int unavailable/);
  });
});

describe("division guards", () => {
  test("zero revenue yields unverified, not Infinity", () => {
    const c = build([
      { tag: "Revenues", values: [{ end: "2025-12-31", val: 0 }] },
      { tag: "NetIncomeLoss", values: [{ end: "2025-12-31", val: -50 }] },
      { tag: "Assets", instant: true, values: [{ end: "2025-12-31", val: 100 }] },
    ]);

    const r = computeRatios(snapshotAt(c, "2025-12-31"));
    assert.equal(isVerified(r.netMargin), false);
  });
});

describe("trailing twelve months", () => {
  test("sums four discrete quarters", () => {
    const c = build([
      {
        tag: "NetCashProvidedByUsedInOperatingActivities",
        values: [
          { start: "2025-01-01", end: "2025-03-31", val: 10 },
          { start: "2025-04-01", end: "2025-06-30", val: 20 },
          { start: "2025-07-01", end: "2025-09-30", val: 30 },
          { start: "2025-10-01", end: "2025-12-31", val: 40 },
        ],
      },
    ]);

    const ttm = trailingTwelveMonths(c, "operatingCashFlow");
    assert.equal(ttm.basis, "ttm");
    assert.equal(valueOf(ttm.amount), 100);
  });

  test("falls back to the fiscal year and says so when nothing newer exists", () => {
    const c = build([
      {
        tag: "NetCashProvidedByUsedInOperatingActivities",
        values: [{ end: "2025-12-31", val: 95 }],
      },
    ]);

    const ttm = trailingTwelveMonths(c, "operatingCashFlow");
    assert.equal(ttm.basis, "fy");
    assert.equal(valueOf(ttm.amount), 95);
    assert.match(ttm.note, /no year-to-date data/);
  });

  test("rolls the fiscal year forward using year-to-date figures", () => {
    // The NVIDIA shape: FY plus a current-year quarter less the year-ago one.
    const c = build([
      {
        tag: "NetCashProvidedByUsedInOperatingActivities",
        values: [
          // Prior fiscal year, and the year-ago quarter inside it.
          { start: "2025-01-27", end: "2026-01-25", val: 102.72 },
          { start: "2025-01-27", end: "2025-04-27", val: 27.41 },
          // Current fiscal year to date.
          { start: "2026-01-26", end: "2026-04-26", val: 50.34 },
        ],
      },
    ]);

    const ttm = trailingTwelveMonths(c, "operatingCashFlow");
    assert.equal(ttm.basis, "ttm");
    assert.ok(
      Math.abs((valueOf(ttm.amount) ?? 0) - 125.65) < 0.01,
      `expected 125.65, got ${valueOf(ttm.amount)}`,
    );
    assert.equal(ttm.asOf, "2026-04-26");
  });

  test("uses the longest year-to-date period available", () => {
    const c = build([
      {
        tag: "NetCashProvidedByUsedInOperatingActivities",
        values: [
          { start: "2025-01-27", end: "2026-01-25", val: 100 },
          { start: "2025-01-27", end: "2025-04-27", val: 20 },
          { start: "2025-01-27", end: "2025-10-26", val: 60 },
          { start: "2026-01-26", end: "2026-04-26", val: 30 },
          { start: "2026-01-26", end: "2026-10-25", val: 80 },
        ],
      },
    ]);

    // Should pair the 9-month periods, not the quarters: 100 + 80 - 60.
    const ttm = trailingTwelveMonths(c, "operatingCashFlow");
    assert.equal(valueOf(ttm.amount), 120);
    assert.equal(ttm.asOf, "2026-10-25");
  });

  test("does not subtract a mismatched span", () => {
    // Current YTD is 9 months but only a year-ago quarter exists. Pairing
    // them would understate the deduction and inflate TTM.
    const c = build([
      {
        tag: "NetCashProvidedByUsedInOperatingActivities",
        values: [
          { start: "2025-01-27", end: "2026-01-25", val: 100 },
          { start: "2025-01-27", end: "2025-04-27", val: 20 },
          { start: "2026-01-26", end: "2026-10-25", val: 80 },
        ],
      },
    ]);

    const ttm = trailingTwelveMonths(c, "operatingCashFlow");
    assert.equal(ttm.basis, "fy");
    assert.equal(valueOf(ttm.amount), 100);
  });

  test("free cash flow falls back to FY basis if either leg is annual-only", () => {
    const c = build([
      {
        tag: "NetCashProvidedByUsedInOperatingActivities",
        values: [
          { start: "2025-01-01", end: "2025-12-31", val: 100 },
          { start: "2025-01-01", end: "2025-03-31", val: 20 },
          { start: "2026-01-01", end: "2026-03-31", val: 30 },
        ],
      },
      {
        tag: "PaymentsToAcquirePropertyPlantAndEquipment",
        values: [{ start: "2025-01-01", end: "2025-12-31", val: 10 }],
      },
    ]);

    const fcf = ttmFreeCashFlow(c);
    assert.equal(fcf.basis, "fy", "mixing a TTM numerator with annual capex would be wrong");
  });
});

describe("Piotroski F-Score", () => {
  function twoYears(
    over: Record<string, [number, number]> = {},
    omit: string[] = [],
  ) {
    const base: Record<string, [number, number]> = {
      Revenues: [1000, 1200],
      GrossProfit: [500, 640],
      OperatingIncomeLoss: [100, 150],
      NetIncomeLoss: [80, 120],
      NetCashProvidedByUsedInOperatingActivities: [150, 200],
      PaymentsToAcquirePropertyPlantAndEquipment: [30, 30],
      WeightedAverageNumberOfDilutedSharesOutstanding: [100, 99],
      ...over,
    };
    for (const tag of omit) delete base[tag];
    const instants: Record<string, [number, number]> = {
      Assets: [2000, 2100],
      AssetsCurrent: [800, 1000],
      LiabilitiesCurrent: [400, 400],
      LongTermDebtNoncurrent: [500, 400],
      StockholdersEquity: [900, 1000],
      RetainedEarningsAccumulatedDeficit: [300, 420],
      Liabilities: [1100, 1100],
    };

    return build([
      ...Object.entries(base).map(([tag, [a, b]]) => ({
        tag,
        unit: tag.includes("Shares") ? "shares" : "USD",
        values: [
          { end: "2024-12-31", val: a },
          { end: "2025-12-31", val: b },
        ],
      })),
      ...Object.entries(instants).map(([tag, [a, b]]) => ({
        tag,
        instant: true,
        values: [
          { end: "2024-12-31", val: a },
          { end: "2025-12-31", val: b },
        ],
      })),
    ]);
  }

  test("a uniformly improving company scores 9 of 9", () => {
    const f = piotroskiFScore(twoYears({}));
    assert.equal(f.available, 9);
    assert.equal(f.score, 9, JSON.stringify(f.signals, null, 2));
  });

  test("share issuance fails the dilution signal", () => {
    const f = piotroskiFScore(
      twoYears({ WeightedAverageNumberOfDilutedSharesOutstanding: [100, 130] }),
    );

    const dilution = f.signals.find((s) => s.name === "No share dilution");
    assert.equal(dilution?.passed, false);
    assert.equal(f.score, 8);
  });

  test("negative net income fails the ROA signal", () => {
    const f = piotroskiFScore(twoYears({ NetIncomeLoss: [80, -50] }));
    assert.equal(f.signals.find((s) => s.name === "ROA positive")?.passed, false);
  });

  test("needs two fiscal years", () => {
    const c = build([{ tag: "Revenues", values: [{ end: "2025-12-31", val: 100 }] }]);
    const f = piotroskiFScore(c);

    assert.equal(f.available, 0);
    assert.equal(f.score, 0);
  });

  test("unavailable signals are reported separately from failed ones", () => {
    // No diluted share data at all.
    const f = piotroskiFScore(
      twoYears({}, ["WeightedAverageNumberOfDilutedSharesOutstanding"]),
    );

    const dilution = f.signals.find((s) => s.name === "No share dilution");
    assert.equal(dilution?.passed, undefined);
    assert.ok(f.available < 9);
  });
});

describe("Altman Z''", () => {
  const solid = build([
    { tag: "Assets", instant: true, values: [{ end: "2025-12-31", val: 1000 }] },
    { tag: "AssetsCurrent", instant: true, values: [{ end: "2025-12-31", val: 600 }] },
    {
      tag: "LiabilitiesCurrent",
      instant: true,
      values: [{ end: "2025-12-31", val: 200 }],
    },
    {
      tag: "RetainedEarningsAccumulatedDeficit",
      instant: true,
      values: [{ end: "2025-12-31", val: 400 }],
    },
    { tag: "Liabilities", instant: true, values: [{ end: "2025-12-31", val: 300 }] },
    { tag: "StockholdersEquity", instant: true, values: [{ end: "2025-12-31", val: 700 }] },
    { tag: "OperatingIncomeLoss", values: [{ end: "2025-12-31", val: 150 }] },
  ]);

  test("computes the four-factor score and places it in the safe zone", () => {
    const z = altmanZ(solid, "2025-12-31");

    // 6.56(0.4) + 3.26(0.4) + 6.72(0.15) + 1.05(2.333) = 7.39
    assert.equal(isVerified(z.score), true);
    assert.ok(Math.abs((valueOf(z.score) ?? 0) - 7.39) < 0.02);
    assert.equal(z.zone, "safe");
  });

  test("a deeply loss-making balance sheet lands in distress", () => {
    const weak = build([
      { tag: "Assets", instant: true, values: [{ end: "2025-12-31", val: 1000 }] },
      { tag: "AssetsCurrent", instant: true, values: [{ end: "2025-12-31", val: 100 }] },
      {
        tag: "LiabilitiesCurrent",
        instant: true,
        values: [{ end: "2025-12-31", val: 500 }],
      },
      {
        tag: "RetainedEarningsAccumulatedDeficit",
        instant: true,
        values: [{ end: "2025-12-31", val: -800 }],
      },
      { tag: "Liabilities", instant: true, values: [{ end: "2025-12-31", val: 900 }] },
      {
        tag: "StockholdersEquity",
        instant: true,
        values: [{ end: "2025-12-31", val: 100 }],
      },
      { tag: "OperatingIncomeLoss", values: [{ end: "2025-12-31", val: -300 }] },
    ]);

    const z = altmanZ(weak, "2025-12-31");
    assert.equal(z.zone, "distress");
  });

  test("missing inputs leave the score unverified rather than partial", () => {
    const partial = build([
      { tag: "Assets", instant: true, values: [{ end: "2025-12-31", val: 1000 }] },
    ]);

    const z = altmanZ(partial, "2025-12-31");
    assert.equal(isVerified(z.score), false);
    assert.equal(z.zone, undefined);
  });
});
