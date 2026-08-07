import assert from "node:assert/strict";
import { test, describe } from "node:test";

import { normalize } from "./normalize.js";
import type { CompanyFacts, XbrlFact } from "./types.js";

function fact(partial: Partial<XbrlFact> & Pick<XbrlFact, "end" | "val">): XbrlFact {
  return {
    accn: "0000000000-00-000000",
    fy: 2025,
    fp: "FY",
    form: "10-K",
    filed: "2025-02-01",
    ...partial,
  };
}

function facts(
  concepts: Record<string, XbrlFact[]>,
  taxonomy = "us-gaap",
  unit = "USD",
): CompanyFacts {
  const bucket: Record<string, { units: Record<string, XbrlFact[]> }> = {};
  for (const [tag, series] of Object.entries(concepts)) {
    bucket[tag] = { units: { [unit]: series } };
  }
  return {
    cik: 1,
    entityName: "Test Co",
    facts: { [taxonomy]: bucket },
  };
}

describe("period classification", () => {
  test("keeps annual spans and rejects quarterly ones", () => {
    const result = normalize(
      facts({
        Revenues: [
          fact({ start: "2024-01-01", end: "2024-12-31", val: 1000 }),
          fact({ start: "2024-10-01", end: "2024-12-31", val: 300 }),
        ],
      }),
      "0000000001",
    );

    assert.equal(result.annual.revenue?.length, 1);
    assert.equal(result.annual.revenue?.[0]?.value, 1000);
    assert.equal(result.quarterly.revenue?.length, 1);
    assert.equal(result.quarterly.revenue?.[0]?.value, 300);
  });

  test("accepts 52/53-week fiscal years that drift off 365 days", () => {
    const result = normalize(
      facts({
        Revenues: [fact({ start: "2024-01-29", end: "2025-01-26", val: 500 })],
      }),
      "0000000001",
    );

    assert.equal(result.annual.revenue?.length, 1);
  });

  test("ignores fy and fp, which describe the filing not the fact", () => {
    // A FY2022 figure reported as a comparative inside the FY2024 10-K.
    const result = normalize(
      facts({
        Revenues: [
          fact({ start: "2022-01-01", end: "2022-12-31", val: 100, fy: 2024, fp: "FY" }),
        ],
      }),
      "0000000001",
    );

    assert.equal(result.annual.revenue?.[0]?.end, "2022-12-31");
    assert.equal(result.annual.revenue?.[0]?.value, 100);
  });
});

describe("restatement handling", () => {
  test("prefers the most recently filed value for a repeated period", () => {
    const result = normalize(
      facts({
        Revenues: [
          fact({ start: "2024-01-01", end: "2024-12-31", val: 1000, filed: "2025-02-01" }),
          fact({ start: "2024-01-01", end: "2024-12-31", val: 1050, filed: "2026-02-01" }),
        ],
      }),
      "0000000001",
    );

    assert.equal(result.annual.revenue?.length, 1);
    assert.equal(result.annual.revenue?.[0]?.value, 1050);
  });

  test("prefers the audited 10-K when two filings land the same day", () => {
    const result = normalize(
      facts({
        Revenues: [
          fact({
            start: "2024-01-01",
            end: "2024-12-31",
            val: 900,
            form: "10-Q",
            filed: "2025-02-01",
          }),
          fact({
            start: "2024-01-01",
            end: "2024-12-31",
            val: 1000,
            form: "10-K",
            filed: "2025-02-01",
          }),
        ],
      }),
      "0000000001",
    );

    assert.equal(result.annual.revenue?.[0]?.value, 1000);
  });
});

describe("tag chain merging", () => {
  test("merges tags so a mid-history switch does not truncate the series", () => {
    // The NVDA case: the preferred tag covers only the middle years.
    const result = normalize(
      facts({
        RevenueFromContractWithCustomerExcludingAssessedTax: [
          fact({ start: "2021-01-01", end: "2021-12-31", val: 200 }),
        ],
        Revenues: [
          fact({ start: "2020-01-01", end: "2020-12-31", val: 100 }),
          fact({ start: "2021-01-01", end: "2021-12-31", val: 999 }),
          fact({ start: "2022-01-01", end: "2022-12-31", val: 300 }),
        ],
      }),
      "0000000001",
    );

    assert.equal(result.annual.revenue?.length, 3);
    assert.deepEqual(
      result.annual.revenue?.map((v) => v.value),
      [100, 200, 300],
      "earlier tag in the chain should win the overlapping period",
    );
  });

  test("records every tag that contributed", () => {
    const result = normalize(
      facts({
        RevenueFromContractWithCustomerExcludingAssessedTax: [
          fact({ start: "2021-01-01", end: "2021-12-31", val: 200 }),
        ],
        Revenues: [fact({ start: "2020-01-01", end: "2020-12-31", val: 100 })],
      }),
      "0000000001",
    );

    assert.deepEqual(result.tagsUsed.revenue, [
      "RevenueFromContractWithCustomerExcludingAssessedTax",
      "Revenues",
    ]);
  });
});

describe("currency and taxonomy detection", () => {
  test("detects a non-USD reporting currency", () => {
    const result = normalize(
      facts(
        { Revenues: [fact({ start: "2024-01-01", end: "2024-12-31", val: 100 })] },
        "us-gaap",
        "EUR",
      ),
      "0000000001",
    );

    assert.equal(result.currency, "EUR");
    assert.equal(result.annual.revenue?.[0]?.value, 100);
  });

  test("reads IFRS filers via the ifrs-full taxonomy", () => {
    const result = normalize(
      facts(
        {
          Revenue: [fact({ start: "2024-01-01", end: "2024-12-31", val: 700 })],
          ProfitLoss: [fact({ start: "2024-01-01", end: "2024-12-31", val: 70 })],
          Assets: [fact({ end: "2024-12-31", val: 5000 })],
        },
        "ifrs-full",
      ),
      "0000000001",
    );

    assert.equal(result.taxonomy, "ifrs-full");
    assert.equal(result.annual.revenue?.[0]?.value, 700);
    assert.equal(result.annual.netIncome?.[0]?.value, 70);
  });
});

describe("instants", () => {
  test("treats balance sheet items as instants and excludes duration facts", () => {
    const result = normalize(
      facts({
        Assets: [
          fact({ end: "2024-12-31", val: 5000 }),
          fact({ start: "2024-01-01", end: "2024-12-31", val: 9999 }),
        ],
      }),
      "0000000001",
    );

    assert.equal(result.annual.assets?.length, 1);
    assert.equal(result.annual.assets?.[0]?.value, 5000);
  });
});
