import assert from "node:assert/strict";
import { test, describe } from "node:test";

import {
  isMajorHolderForm,
  parseForm4,
  summariseInsiderActivity,
  type InsiderActivity,
} from "./insider.js";

const META = {
  filedAt: "2026-07-06",
  accession: "0001197647-26-000005",
  url: "https://www.sec.gov/example",
};

function form4(rows: string, relationship = "<isDirector>1</isDirector>"): string {
  return `<?xml version="1.0"?>
<ownershipDocument>
  <documentType>4</documentType>
  <issuer><issuerTradingSymbol>TEST</issuerTradingSymbol></issuer>
  <reportingOwner>
    <reportingOwnerId><rptOwnerName>DOE JANE</rptOwnerName></reportingOwnerId>
    <reportingOwnerRelationship>${relationship}</reportingOwnerRelationship>
  </reportingOwner>
  <nonDerivativeTable>${rows}</nonDerivativeTable>
</ownershipDocument>`;
}

function txn(code: string, shares: number, price: number, ad: string): string {
  return `<nonDerivativeTransaction>
    <securityTitle><value>Common</value></securityTitle>
    <transactionDate><value>2026-07-01</value></transactionDate>
    <transactionCoding><transactionCode>${code}</transactionCode></transactionCoding>
    <transactionAmounts>
      <transactionShares><value>${shares}</value></transactionShares>
      <transactionPricePerShare><value>${price}</value><footnoteId id="F2"/></transactionPricePerShare>
      <transactionAcquiredDisposedCode><value>${ad}</value></transactionAcquiredDisposedCode>
    </transactionAmounts>
  </nonDerivativeTransaction>`;
}

describe("Form 4 parsing", () => {
  test("extracts a single open-market purchase", () => {
    const result = parseForm4(form4(txn("P", 1000, 50, "A")), META);

    assert.equal(result.length, 1);
    const t = result[0];
    assert.equal(t?.code, "P");
    assert.equal(t?.shares, 1000);
    assert.equal(t?.pricePerShare, 50);
    assert.equal(t?.value, 50_000);
    assert.equal(t?.ownerName, "DOE JANE");
    assert.equal(t?.isDirector, true);
  });

  test("reads price correctly when a footnote sits beside the value", () => {
    // The naive regex failure mode: grabbing the footnote id instead of 0.
    const result = parseForm4(form4(txn("G", 500_000, 0, "D")), META);

    assert.equal(result[0]?.pricePerShare, 0);
    assert.equal(result[0]?.value, 0);
  });

  test("handles multiple transactions in one filing", () => {
    const result = parseForm4(
      form4(txn("P", 100, 10, "A") + txn("S", 50, 12, "D")),
      META,
    );

    assert.equal(result.length, 2);
    assert.deepEqual(
      result.map((t) => t.code),
      ["P", "S"],
    );
  });

  test("returns empty for a filing with no non-derivative table", () => {
    const xml = `<?xml version="1.0"?><ownershipDocument>
      <documentType>4</documentType>
      <reportingOwner><reportingOwnerId><rptOwnerName>X</rptOwnerName></reportingOwnerId></reportingOwner>
    </ownershipDocument>`;

    assert.deepEqual(parseForm4(xml, META), []);
  });

  test("throws on a document that is not a Form 4", () => {
    assert.throws(() => parseForm4("<html><body>not xml</body></html>", META));
  });

  test("captures officer title and ten percent owner flags", () => {
    const result = parseForm4(
      form4(
        txn("P", 1, 1, "A"),
        "<isDirector>0</isDirector><isOfficer>1</isOfficer>" +
          "<officerTitle>Chief Executive Officer</officerTitle>" +
          "<isTenPercentOwner>1</isTenPercentOwner>",
      ),
      META,
    );

    assert.equal(result[0]?.isOfficer, true);
    assert.equal(result[0]?.officerTitle, "Chief Executive Officer");
    assert.equal(result[0]?.isTenPercentOwner, true);
  });
});

describe("major holder form matching", () => {
  test("matches both spellings EDGAR uses, including amendments", () => {
    // Both appear in the same company feed; the SCHEDULE form is the one
    // used by the more recent filings.
    for (const form of [
      "SC 13D",
      "SC 13G",
      "SC 13G/A",
      "SCHEDULE 13G",
      "SCHEDULE 13G/A",
      "SCHEDULE 13D",
    ]) {
      assert.equal(isMajorHolderForm(form), true, `should match ${form}`);
    }
  });

  test("excludes 13F, which is quarterly with a 45-day lag", () => {
    assert.equal(isMajorHolderForm("13F-HR"), false);
    assert.equal(isMajorHolderForm("13F-HR/A"), false);
  });

  test("does not match unrelated forms", () => {
    for (const form of ["4", "10-K", "8-K", "S-1"]) {
      assert.equal(isMajorHolderForm(form), false, `should not match ${form}`);
    }
  });
});

const NO_HOLDERS = {
  netPercentChange: 0,
  increases: [],
  decreases: [],
  indeterminate: [],
  filedByCompanyCount: 0,
  consideredCount: 0,
};

describe("conviction filtering", () => {
  function activity(codes: [string, number, number, string][]): InsiderActivity {
    return {
      cik: "0000000001",
      windowDays: 90,
      since: "2026-05-09",
      transactions: codes.flatMap(([code, shares, price, ad]) =>
        parseForm4(form4(txn(code, shares, price, ad)), META),
      ),
      majorHolders: NO_HOLDERS,
      parseFailures: [],
    };
  }

  test("counts open-market purchases and ignores grants and withholdings", () => {
    const summary = summariseInsiderActivity(
      activity([
        ["P", 1000, 50, "A"], // real purchase
        ["A", 5000, 0, "A"], // equity grant — compensation
        ["M", 2000, 10, "A"], // option exercise
        ["F", 800, 50, "D"], // tax withholding
      ]),
    );

    assert.equal(summary.buyCount, 1);
    assert.equal(summary.buyValue, 50_000);
    assert.equal(summary.excludedCount, 3);
    assert.equal(summary.netAccumulation, true);
  });

  test("a grant-only filing produces no signal", () => {
    const summary = summariseInsiderActivity(activity([["A", 100_000, 0, "A"]]));

    assert.equal(summary.buyCount, 0);
    assert.equal(summary.buyValue, 0);
    assert.equal(summary.netAccumulation, false);
  });

  test("net selling is not accumulation", () => {
    const summary = summariseInsiderActivity(
      activity([
        ["P", 100, 50, "A"],
        ["S", 1000, 50, "D"],
      ]),
    );

    assert.ok(summary.netValue < 0);
    assert.equal(summary.netAccumulation, false);
  });

  test("nets sales against purchases", () => {
    const summary = summariseInsiderActivity(
      activity([
        ["P", 1000, 50, "A"],
        ["S", 400, 50, "D"],
      ]),
    );

    assert.equal(summary.buyValue, 50_000);
    assert.equal(summary.sellValue, 20_000);
    assert.equal(summary.netValue, 30_000);
  });

  test("a gift disposal is not counted as a sale", () => {
    const summary = summariseInsiderActivity(activity([["G", 500_000, 0, "D"]]));

    assert.equal(summary.sellCount, 0);
    assert.equal(summary.excludedCount, 1);
  });

  test("a rising 5%+ holder stake alone constitutes accumulation", () => {
    const summary = summariseInsiderActivity({
      ...activity([]),
      majorHolders: {
        ...NO_HOLDERS,
        netPercentChange: 2.4,
        increases: [
          {
            reportingPerson: "BIG FUND",
            deltaPercent: 2.4,
            from: 0,
            to: 2.4,
            basis: "new-position",
            latestFiledAt: "2026-08-01",
          },
        ],
        consideredCount: 1,
      },
    });

    assert.equal(summary.netAccumulation, true);
    assert.equal(summary.netHolderPercentChange, 2.4);
    assert.equal(summary.holdersIncreasing, 1);
  });

  test("a fund exiting is not accumulation", () => {
    const summary = summariseInsiderActivity({
      ...activity([]),
      majorHolders: {
        ...NO_HOLDERS,
        netPercentChange: -6.1,
        decreases: [
          {
            reportingPerson: "BIG FUND",
            deltaPercent: -6.1,
            from: 6.1,
            to: 0,
            basis: "exit",
            latestFiledAt: "2026-08-01",
          },
        ],
        consideredCount: 1,
      },
    });

    assert.equal(summary.netAccumulation, false);
    assert.equal(summary.holdersDecreasing, 1);
  });
});
