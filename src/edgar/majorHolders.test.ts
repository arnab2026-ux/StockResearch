import assert from "node:assert/strict";
import { test, describe } from "node:test";

import { parseSchedule13, summariseMajorHolders, type MajorHolderFiling } from "./majorHolders.js";

const META = {
  filedAt: "2026-04-28",
  form: "SCHEDULE 13G",
  accession: "0002100119-26-000017",
  url: "https://www.sec.gov/example",
};

function schedule13(opts: {
  issuerCik: string;
  issuerName: string;
  person: string;
  percent: string;
  shares?: string;
}): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<sch:edgarSubmission xmlns:sch="http://www.sec.gov/edgar/schedule13g" xmlns:com="http://www.sec.gov/edgar/common">
  <sch:formData>
    <sch:coverPageHeader>
      <sch:issuerInfo>
        <sch:issuerCik>${opts.issuerCik}</sch:issuerCik>
        <sch:issuerName>${opts.issuerName}</sch:issuerName>
      </sch:issuerInfo>
    </sch:coverPageHeader>
    <sch:coverPageHeaderReportingPersonDetails>
      <sch:reportingPersonName>${opts.person}</sch:reportingPersonName>
      <sch:reportingPersonBeneficiallyOwnedAggregateNumberOfShares>${opts.shares ?? "1000"}</sch:reportingPersonBeneficiallyOwnedAggregateNumberOfShares>
      <sch:classPercent>${opts.percent}</sch:classPercent>
    </sch:coverPageHeaderReportingPersonDetails>
  </sch:formData>
</sch:edgarSubmission>`;
}

const NVDA = "0001045810";

describe("Schedule 13D/G parsing", () => {
  test("extracts issuer, reporting person and percentage through namespaces", () => {
    const parsed = parseSchedule13(
      schedule13({
        issuerCik: NVDA,
        issuerName: "NVIDIA Corp",
        person: "The Vanguard Group",
        percent: "9.32",
        shares: "22256412.00",
      }),
      META,
    );

    assert.equal(parsed?.issuerCik, NVDA);
    assert.equal(parsed?.reportingPerson, "The Vanguard Group");
    assert.equal(parsed?.classPercent, 9.32);
    assert.equal(parsed?.shares, 22256412);
  });

  test("flags amendments from the form type", () => {
    const parsed = parseSchedule13(
      schedule13({ issuerCik: NVDA, issuerName: "NVIDIA Corp", person: "X", percent: "5" }),
      { ...META, form: "SCHEDULE 13G/A" },
    );

    assert.equal(parsed?.isAmendment, true);
  });

  test("returns undefined for a document with no issuer", () => {
    assert.equal(parseSchedule13("<html>not a schedule</html>", META), undefined);
  });
});

describe("issuer filtering", () => {
  function filing(over: Partial<MajorHolderFiling>): MajorHolderFiling {
    return {
      filedAt: "2026-04-28",
      form: "SCHEDULE 13G",
      isAmendment: false,
      issuerCik: NVDA,
      issuerName: "NVIDIA Corp",
      reportingPerson: "Fund A",
      shares: 1000,
      classPercent: 6,
      accession: "x",
      url: "https://example.com",
      ...over,
    };
  }

  test("discards filings where the company is the filer, not the subject", () => {
    // NVIDIA's own feed carries its 13G disclosing a stake in CoreWeave.
    const summary = summariseMajorHolders(
      [
        filing({ reportingPerson: "Vanguard", classPercent: 7 }),
        filing({
          issuerCik: "0001769628",
          issuerName: "CoreWeave, Inc.",
          reportingPerson: "NVIDIA Corporation",
          classPercent: 11.5,
        }),
      ],
      NVDA,
    );

    assert.equal(summary.consideredCount, 1);
    assert.equal(summary.filedByCompanyCount, 1);
    assert.equal(summary.netPercentChange, 7);
  });

  test("tolerates unpadded CIKs on either side", () => {
    const summary = summariseMajorHolders([filing({ issuerCik: "1045810" })], "1045810");
    assert.equal(summary.consideredCount, 1);
  });
});

describe("net change", () => {
  function filing(over: Partial<MajorHolderFiling>): MajorHolderFiling {
    return {
      filedAt: "2026-04-28",
      form: "SCHEDULE 13G",
      isAmendment: false,
      issuerCik: NVDA,
      issuerName: "NVIDIA Corp",
      reportingPerson: "Fund A",
      shares: 1000,
      classPercent: 6,
      accession: "x",
      url: "https://example.com",
      ...over,
    };
  }

  test("a new position counts as an addition of its full size", () => {
    const s = summariseMajorHolders([filing({ classPercent: 6.5 })], NVDA);

    assert.equal(s.netPercentChange, 6.5);
    assert.equal(s.increases[0]?.basis, "new-position");
  });

  test("differences two filings from the same holder", () => {
    const s = summariseMajorHolders(
      [
        filing({ filedAt: "2026-02-01", classPercent: 5.5 }),
        filing({ filedAt: "2026-05-01", classPercent: 8.0, isAmendment: true, form: "SCHEDULE 13G/A" }),
      ],
      NVDA,
    );

    assert.ok(Math.abs(s.netPercentChange - 2.5) < 1e-9);
    assert.equal(s.increases[0]?.basis, "amended");
  });

  test("an amendment reporting zero is an exit, not an addition", () => {
    // The Vanguard case: classPercent 0 means the stake fell below 5%.
    const s = summariseMajorHolders(
      [filing({ classPercent: 0, isAmendment: true, form: "SCHEDULE 13G/A" })],
      NVDA,
    );

    assert.ok(s.netPercentChange < 0, `expected negative, got ${s.netPercentChange}`);
    assert.equal(s.decreases[0]?.basis, "exit");
    assert.equal(s.increases.length, 0);
  });

  test("a reduction across two filings is negative", () => {
    const s = summariseMajorHolders(
      [
        filing({ filedAt: "2026-02-01", classPercent: 9 }),
        filing({ filedAt: "2026-05-01", classPercent: 6, isAmendment: true, form: "SCHEDULE 13G/A" }),
      ],
      NVDA,
    );

    assert.ok(Math.abs(s.netPercentChange + 3) < 1e-9);
    assert.equal(s.decreases.length, 1);
  });

  test("a lone amendment with unknown prior level is indeterminate, not guessed", () => {
    const s = summariseMajorHolders(
      [filing({ classPercent: 7, isAmendment: true, form: "SCHEDULE 13G/A" })],
      NVDA,
    );

    assert.equal(s.indeterminate.length, 1);
    assert.equal(s.netPercentChange, 0);
    assert.equal(s.increases.length, 0);
  });

  test("nets increases against decreases across holders", () => {
    const s = summariseMajorHolders(
      [
        filing({ reportingPerson: "Fund A", classPercent: 8 }),
        filing({
          reportingPerson: "Fund B",
          classPercent: 0,
          isAmendment: true,
          form: "SCHEDULE 13G/A",
        }),
      ],
      NVDA,
    );

    // +8 from the new position, -5 for the exit at the reporting threshold.
    assert.ok(Math.abs(s.netPercentChange - 3) < 1e-9);
    assert.equal(s.increases.length, 1);
    assert.equal(s.decreases.length, 1);
  });

  test("groups holders case-insensitively", () => {
    const s = summariseMajorHolders(
      [
        filing({ reportingPerson: "the vanguard group", filedAt: "2026-02-01", classPercent: 5 }),
        filing({
          reportingPerson: "The Vanguard Group",
          filedAt: "2026-05-01",
          classPercent: 7,
          isAmendment: true,
          form: "SCHEDULE 13G/A",
        }),
      ],
      NVDA,
    );

    assert.equal(s.increases.length, 1);
    assert.ok(Math.abs(s.netPercentChange - 2) < 1e-9);
  });
});
