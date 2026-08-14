/**
 * Regression tests for the US House Clerk PTR reader.
 *
 * Every fixture below is verbatim `pdftotext -layout` output from a real
 * filing, identified by its Clerk document id and reachable at
 * `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2026/{docId}.pdf`.
 * Column positions are load-bearing — the parser recovers the owner, type,
 * date and amount columns from whitespace alone — so the whitespace in these
 * strings must not be "tidied".
 *
 * Two fixtures are synthetic and marked as such. They cover shapes the live
 * corpus happens not to contain (the open-ended top bracket) and shapes that
 * must never be produced (a plausible ticker that is not in the universe).
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { UNIVERSE } from "../config/universe.js";
import {
  describeTrade,
  extractPdfText,
  parseDisclosureIndex,
  parsePtr,
  ptrUrl,
  summariseCongressTrades,
  toIsoDate,
  yearsCovering,
  type CongressTrade,
} from "./houseDisclosures.js";

const META = {
  docId: "20034836",
  url: ptrUrl(2026, "20034836"),
  filedOn: "2026-06-23",
  filer: "index filer",
  stateDistrict: "??",
};

function parse(text: string, over: Partial<typeof META> = {}) {
  return parsePtr(text, { ...META, ...over });
}

// ---------------------------------------------------------------------------
// Fixtures — real extractions
// ---------------------------------------------------------------------------

/**
 * Doc 20034836, Hon. Nancy Pelosi. Spouse, call options on INTC, and the two
 * hard shapes in one row: the top of the amount bracket wraps to the next
 * line, and the ticker wraps to the line after that.
 */
const PELOSI = `                  P                T                                                        Filing ID #20034836

                                                                 R

            Clerk of the House of Representatives • Legislative Resource Center • B81 Cannon Building • Washington, DC 20515

F        I

Name:          Hon. Nancy Pelosi

Status:        Member

State/District: CA11

T

ID       Owner Asset                           Transaction Date  Notification Amount                                     Cap.
                                               Type              Date                                                    Gains >
                                                                                                                         $200?

         SP    Intel Corporation - Common Stock P  05/29/2026 05/29/2026 $1,000,001 -
                                                                                           $5,000,000
               (INTC) [OP]

               F      S     : New

               D         : Purchased 200 call options with a strike price of $50 and an expiration date of 3/19/27.

         SP    Uber Technologies, Inc. Common  P   05/29/2026 05/29/2026 $500,001 -
                                                                                           $1,000,000
               Stock (UBER) [OP]

               F      S     : New

               D         : Purchased 200 call options with a strike price of $50 and an expiration date of 3/19/27.

* For the complete list of asset type abbreviations, please visit https://fd.house.gov/reference/asset-type-codes.aspx.

I           P         O

    Yes No

C                        S

     I CERTIFY that the statements I have made on the attached Periodic Transaction Report are true, complete, and correct to the best of
my knowledge and belief. Further, I CERTIFY that I have disclosed all transactions as required by the STOCK Act.

Digitally Signed: Hon. Nancy Pelosi , 06/23/2026
`;

/**
 * Doc 20033779, Hon. Carol Devine Miller. Signed 08/13/2026, reporting
 * transactions from 03/10/2025 — seventeen months earlier. The single most
 * important fixture in this file: window the filing date and every one of
 * these lands inside a 90-day lookback.
 */
const MILLER = `                  P                            T                                               Filing ID #20033779

                                                                    R

            Clerk of the House of Representatives • Legislative Resource Center • B81 Cannon Building • Washington, DC 20515

F        I

Name:          Hon. Carol Devine Miller

Status:        Member

State/District: WV01

T

ID          Owner Asset                           Transaction Date  Notification Amount                                  Cap.
                                                  Type              Date                                                 Gains >
                                                                                                                         $200?

2000134514 SP     Pfizer, Inc. Common Stock (PFE) S            03/10/2025 04/11/2025 $15,001 -
                  [ST]                                                                                 $50,000

                  F      S  : Amended

                  S         O : United Bank Brokerage Account

2000134517 SP     Quest Diagnostics Incorporated S             03/10/2025 04/11/2025 $15,001 -
                  Common Stock (DGX) [ST]                                                              $50,000

                  F      S  : Amended

                  S         O : United Bank Brokerage Account

2000134515 SP     Target Corporation Common Stock S            03/10/2025 04/11/2025 $15,001 -
                  (TGT) [ST]                                                                           $50,000

                  F      S  : Amended

                  S         O : United Bank Brokerage Account

2000134527 SP     U.S. Bancorp Common Stock (USB) S            03/10/2025 04/11/2025 $15,001 -
                  [ST]                                                                                 $50,000

                  F      S  : Amended

                  S         O : United Bank Brokerage Account

* For the complete list of asset type abbreviations, please visit https://fd.house.gov/reference/asset-type-codes.aspx.

I              V            D

    United Bank Brokerage Account (Owner: SP)

I           P        O

    Yes No
`;

/** Doc 20035183, Hon. Derek Tran. Crypto `[CT]`, no owner code, a year's lag. */
const TRAN = `                     P                 T                                                 Filing ID #20035183

                                                              R

            Clerk of the House of Representatives • Legislative Resource Center • B81 Cannon Building • Washington, DC 20515

F        I

Name:             Hon. Derek Tran

Status:           Member

State/District: CA45

T

ID       Owner Asset                      Transaction Date    Notification Amount                                        Cap.
                                          Type                Date                                                       Gains >
                                                                                                                         $200?

                  Litecoin (LTC) [CT]     S                   07/28/2025 07/21/2026 $1,001 - $15,000

                  F   S   : New

                  S       O : Coinbase cryptocurrency wallet

                  C       : Filer believes that the value of the coin was <$1,000 when filer initiated trade; when trade settled, value had

                  fluctuated to just over $1,000. Filer did not realize that sale was >$1,000 until preparing 2025 FD.

* For the complete list of asset type abbreviations, please visit https://fd.house.gov/reference/asset-type-codes.aspx.
`;

/**
 * Doc 9116292, Hon. James Mann. A scan of a paper filing: `pdftotext` returns
 * two form feeds and nothing else. Legible to a person, empty to the reader.
 */
const LEGACY_SCAN = "\f\f";

/**
 * Doc 20034688, Hon. Jonathan Jackson. `S (partial)`, joint account, and the
 * top of the bracket sharing a line with the wrapped asset name rather than
 * sitting alone on it — the shape that used to truncate the range.
 */
const JACKSON_PARTIAL = `Name:          Hon. Jonathan Jackson

Status:        Member

State/District: IL01

T

ID       Owner Asset                             Transaction Date  Notification Amount                                   Cap.
                                                 Type              Date                                                  Gains >
                                                                                                                         $200?

         JT    Microsoft Corporation - Common    S (partial)  05/12/2026 06/02/2026 $15,001 -

               Stock (MSFT) [ST]                                   $50,000

               F         S  : New

               S            O : Morgan Stanley Trust Account

* For the complete list of asset type abbreviations, please visit https://fd.house.gov/reference/asset-type-codes.aspx.
`;

/** Doc 20034963, Hon. Jared Moskowitz. Dependent-child account, wrapped ticker. */
const MOSKOWITZ_DC = `Name:        Hon. Jared Moskowitz

Status:      Member

State/District: FL23

T

ID       Owner Asset                        Transaction Date   Notification Amount                     Cap.
                                            Type               Date                                    Gains >
                                                                                                       $200?

         DC  Applied Materials, Inc. - Common P                06/18/2026 06/30/2026 $1,001 - $15,000

             Stock (AMAT) [ST]

             F        S  : New

             S           O : Morgan Stanley Active Assets (5)
`;

/** Doc 20034695, Hon. Kevin Hern. Transaction type `E` — a merger exchange. */
const HERN_EXCHANGE = `Name:        Hon. Kevin Hern

Status:      Member

State/District: OK01

T

ID       Owner Asset                                  Transaction Date  Notification Amount       Cap.
                                                      Type              Date                      Gains >
                                                                                                  $200?

         JT  Coterra Energy Inc. Common Stock E          05/08/2026 05/11/2026 $15,001 - $50,000

             (CTRA) [ST]

             F        S   : New

             S           O : Hern Family Foundation

             D           : merged with DVN Energy Corp.
`;

// --- synthetic, and only where the real corpus has no example --------------

/**
 * SYNTHETIC. The open-ended top bracket, which no filing in the sampled window
 * uses. Modelled on the Clerk's own form: "$50,000,001 +".
 */
const TOP_BRACKET = `Name:          Hon. Test Member

State/District: ZZ99

ID       Owner Asset                           Transaction Date  Notification Amount
         SP    NVIDIA Corporation - Common Stock P  05/29/2026 05/29/2026 $50,000,001 +
               (NVDA) [ST]
`;

/**
 * SYNTHETIC. Two symbols that look exactly like tickers and are not in the
 * universe, inside company names that themselves carry parentheses. Nothing
 * here may become a position.
 */
const NEAR_MISS = `Name:          Hon. Test Member

State/District: ZZ99

ID       Owner Asset                           Transaction Date  Notification Amount
         SP    Alphabet Inc. (Class C) Capital P  05/29/2026 05/29/2026 $1,001 - $15,000
               Stock (GOOG) [ST]

         SP    Vanguard Total (US) Stock Market P  05/29/2026 05/29/2026 $1,001 - $15,000
               Index Fund ETF (VTI) [ST]
`;

// ---------------------------------------------------------------------------

describe("toIsoDate", () => {
  test("accepts both M/D/YYYY and MM/DD/YYYY", () => {
    assert.equal(toIsoDate("6/23/2026"), "2026-06-23");
    assert.equal(toIsoDate("06/23/2026"), "2026-06-23");
    assert.equal(toIsoDate("12/1/2025"), "2025-12-01");
    assert.equal(toIsoDate("  3/10/2025  "), "2025-03-10");
  });

  test("refuses a two-digit year rather than guessing the century", () => {
    // "05/29/28" is an option expiry inside a description, not a transaction
    // date. Inferring 2028 — or 1928 — would be estimating.
    assert.equal(toIsoDate("5/29/28"), undefined);
    assert.equal(toIsoDate("05/29/28"), undefined);
  });

  test("refuses anything that is not a complete US date", () => {
    for (const bad of ["", "2026-06-23", "6/2026", "23/6/2026extra", "x/y/zzzz"]) {
      assert.equal(toIsoDate(bad), undefined, `accepted ${JSON.stringify(bad)}`);
    }
  });

  test("does not validate the calendar — only the shape", () => {
    // Documented limitation: the Clerk publishes real dates, and rejecting a
    // parseable one would lose a trade to a calendar check this cannot do
    // without a timezone assumption.
    assert.equal(toIsoDate("13/45/2026"), "2026-13-45");
  });
});

describe("yearsCovering", () => {
  test("a mid-year run needs only the current year", () => {
    assert.deepEqual(yearsCovering(90, new Date("2026-08-14T00:00:00Z")), [2026]);
  });

  test("a January run with a 90-day window reaches into the prior year", () => {
    // The Clerk indexes by filing year. A trade made in October is disclosed
    // in that year's index, so a January run that ignores it is blind to the
    // first two thirds of its own window.
    assert.deepEqual(yearsCovering(90, new Date("2027-01-15T00:00:00Z")), [2026, 2027]);
  });

  test("1 January needs both years", () => {
    assert.deepEqual(yearsCovering(90, new Date("2027-01-01T00:00:00Z")), [2026, 2027]);
  });

  test("31 December needs only the current year", () => {
    assert.deepEqual(yearsCovering(90, new Date("2026-12-31T00:00:00Z")), [2026]);
  });

  test("never asks for a year after the run — a filing cannot precede its trade", () => {
    for (const days of [1, 14, 90, 365, 800]) {
      const years = yearsCovering(days, new Date("2026-08-14T00:00:00Z"));
      assert.equal(years.at(-1), 2026, `${days}d reached past the run year`);
      assert.ok(years.length >= 1);
    }
  });
});

describe("parsePtr — dates", () => {
  test("the window key is the transaction date, not the filing date", () => {
    // Miller signed on 08/13/2026 and reported trades from 03/10/2025.
    const { trades, rowsOutsideUniverse } = parse(MILLER, {
      docId: "20033779",
      filedOn: "2026-08-13",
    });

    // All four symbols are outside the universe, so nothing is scored — but
    // the dates still have to come out of the right columns.
    assert.equal(trades.length, 0);
    assert.equal(rowsOutsideUniverse, 4);
  });

  test("a 2025 transaction in a 2026 filing keeps its own date", () => {
    // Same rows, reachable by pointing the universe check at a symbol that is
    // in it: swap the ticker, keep every column position identical.
    const text = MILLER.replace("(PFE)", "(AMD)");
    const { trades } = parse(text, { docId: "20033779", filedOn: "2026-08-13" });

    const t = trades[0];
    assert.ok(t, "the AMD row should have parsed");
    assert.equal(t.ticker, "AMD");
    assert.equal(t.transactionDate, "2025-03-10");
    assert.equal(t.notificationDate, "2025-04-11");
    assert.equal(t.filedOn, "2026-08-13");
    assert.ok(
      t.transactionDate < t.filedOn,
      "a transaction must precede its own disclosure",
    );
  });

  test("that trade is outside a 90-day window even though the filing is inside it", () => {
    const text = MILLER.replace("(PFE)", "(AMD)");
    const { trades } = parse(text, { docId: "20033779", filedOn: "2026-08-13" });

    const summary = summariseCongressTrades(trades, 90, {
      now: new Date("2026-08-14T00:00:00Z"),
    });

    assert.equal(summary.trades.length, 0, "a 17-month-old trade must not be in scope");
    assert.equal(summary.net, 0);
    assert.equal(summary.sales, 0);
  });

  test("Tran's crypto sale carries a year of disclosure lag", () => {
    const { trades, rowsOutsideUniverse } = parse(TRAN, { docId: "20035183" });
    assert.equal(trades.length, 0, "LTC is not a universe equity");
    assert.equal(rowsOutsideUniverse, 1);

    const withTicker = parse(TRAN.replace("(LTC)", "(NVDA)"));
    const t = withTicker.trades[0];
    assert.ok(t);
    assert.equal(t.transactionDate, "2025-07-28");
    assert.equal(t.notificationDate, "2026-07-21");
    assert.equal(t.assetType, "CT");
  });
});

describe("parsePtr — wrapped rows", () => {
  test("a ticker on the line after the row is still found", () => {
    // Pelosi's `(INTC) [OP]` sits two lines below its own transaction row.
    const { trades } = parse(PELOSI);
    const intc = trades.find((t) => t.ticker === "INTC");

    assert.ok(intc, "INTC was not recovered from the wrapped line");
    assert.equal(intc.transactionDate, "2026-05-29");
    assert.equal(intc.owner, "SP");
    assert.equal(intc.direction, "purchase");
    assert.equal(intc.assetType, "OP");
    assert.match(intc.assetDescription, /Intel Corporation - Common Stock \(INTC\) \[OP\]/);
  });

  test("the row's own sub-fields are not swallowed into the asset", () => {
    const { trades } = parse(PELOSI);
    const intc = trades.find((t) => t.ticker === "INTC");
    assert.ok(intc);
    // "D : Purchased 200 call options with a strike price of $50…" is a
    // labelled sub-field. Absorbing it would put a $50 into the asset text
    // right beside an amount parser.
    assert.doesNotMatch(intc.assetDescription, /call options/);
    assert.doesNotMatch(intc.assetDescription, /\$50\b/);
  });

  test("a second row in the same filing does not bleed into the first", () => {
    const { trades, rowsOutsideUniverse } = parse(PELOSI);
    assert.equal(trades.length, 1, "only INTC is in the universe");
    assert.equal(rowsOutsideUniverse, 1, "the UBER row is counted, not silently lost");
    assert.doesNotMatch(trades[0]?.assetDescription ?? "", /Uber/);
  });

  test("a ticker wrapped onto the next line together with the asset name", () => {
    const { trades } = parse(MOSKOWITZ_DC, { docId: "20034963" });
    const t = trades[0];
    assert.ok(t);
    assert.equal(t.ticker, "AMAT");
    assert.equal(t.assetType, "ST");
    assert.match(t.assetDescription, /Applied Materials, Inc\. - Common Stock \(AMAT\)/);
  });

  test("the filer and district come from the document, not the index", () => {
    const { filer, stateDistrict } = parse(PELOSI, {
      filer: "index name",
      stateDistrict: "??",
    });
    assert.equal(filer, "Hon. Nancy Pelosi");
    assert.equal(stateDistrict, "CA11");
  });

  test("CRLF and LF extractions parse identically", () => {
    const lf = parse(PELOSI);
    const crlf = parse(PELOSI.replace(/\n/g, "\r\n"));
    assert.deepEqual(crlf.trades, lf.trades);
    assert.equal(crlf.filer, lf.filer);
    assert.equal(crlf.stateDistrict, lf.stateDistrict);
  });
});

describe("parsePtr — amount ranges", () => {
  test("a bracket is a bracket, never a single number", () => {
    const { trades } = parse(PELOSI);
    const amount = trades[0]?.amount;

    assert.ok(amount);
    assert.equal(amount.low, 1_000_001);
    assert.equal(amount.high, 5_000_000);
    assert.equal(amount.asFiled, "$1,000,001 - $5,000,000");
    // The shape itself is the guarantee: there is nowhere to put a midpoint.
    assert.deepEqual(Object.keys(amount).sort(), ["asFiled", "high", "low"]);
  });

  test("a bracket wholly on the anchor line parses", () => {
    const { trades } = parse(MOSKOWITZ_DC);
    assert.deepEqual(trades[0]?.amount, {
      low: 1_001,
      high: 15_000,
      asFiled: "$1,001 - $15,000",
    });
  });

  test("the top of the bracket is recovered when it shares a line with the asset", () => {
    // Regression: `Stock (MSFT) [ST]        $50,000` used to leave `high`
    // undefined and print "$15,001 -", which is not what was filed — and is
    // the same shape as the genuinely open-ended top bracket.
    const { trades } = parse(JACKSON_PARTIAL, { docId: "20034688" });
    const t = trades[0];

    assert.ok(t);
    assert.deepEqual(t.amount, {
      low: 15_001,
      high: 50_000,
      asFiled: "$15,001 - $50,000",
    });
    assert.doesNotMatch(t.assetDescription, /50,000/, "the figure must leave the asset text");
  });

  test("the open-ended top bracket is the only legitimate undefined high", () => {
    const { trades } = parse(TOP_BRACKET);
    const amount = trades[0]?.amount;

    assert.ok(amount);
    assert.equal(amount.low, 50_000_001);
    assert.equal(amount.high, undefined);
    assert.equal(amount.asFiled, "$50,000,001 +");
  });

  test("an unrecoverable bracket is undefined, never zero and never guessed", () => {
    const noAmount = TOP_BRACKET.replace("$50,000,001 +", "");
    const { trades } = parse(noAmount);

    assert.equal(trades.length, 1, "the trade itself is still a finding");
    assert.equal(trades[0]?.amount, undefined);
    assert.match(describeTrade(trades[0] as CongressTrade), /amount UNVERIFIED/);
  });

  test("no figure below the low bound is mistaken for the bracket top", () => {
    const text = TOP_BRACKET.replace(
      "$50,000,001 +",
      "$1,000,001 -",
    ).replace("               (NVDA) [ST]", "               (NVDA) [ST]                         $500");

    const { trades } = parse(text);
    assert.equal(trades[0]?.amount?.high, undefined, "$500 is not the top of a $1,000,001 bracket");
  });

  test("no code anywhere derives a single value from a range", () => {
    // The rule is structural, so the check is too: nothing in the source may
    // average, halve or midpoint a disclosed bracket. Grepping is crude, but
    // a midpoint added later would be silent otherwise.
    const src = join(dirname(fileURLToPath(import.meta.url)), "..");
    const offenders: string[] = [];

    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(path);
          continue;
        }
        // Tests describe the rule in prose; only production code is scanned.
        if (!entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts")) continue;

        const code = readFileSync(path, "utf8")
          .replace(/\/\*[\s\S]*?\*\//g, "")
          .replace(/^\s*\/\/.*$/gm, "");

        for (const pattern of [
          /\bmid_?point\b/i,
          /\b(avg|average|mean)Amount\b/i,
          /\bamount(Value|Estimate|Usd)\b/i,
          /\.(low|high)\s*\+\s*[\w.]*\.(high|low)\b/,
        ]) {
          if (pattern.test(code)) offenders.push(`${path} :: ${pattern}`);
        }
      }
    };

    walk(src);
    assert.deepEqual(offenders, [], `a disclosed bracket is being collapsed:\n${offenders.join("\n")}`);
  });
});

describe("parsePtr — owner codes", () => {
  const owner = (text: string): string | undefined => parse(text).trades[0]?.owner;

  test("SP is a spouse trade", () => {
    assert.equal(owner(PELOSI), "SP");
  });

  test("DC is a dependent child", () => {
    assert.equal(owner(MOSKOWITZ_DC), "DC");
  });

  test("JT is a joint account", () => {
    assert.equal(owner(JACKSON_PARTIAL), "JT");
  });

  test("an absent code is the member's own trade, not an unknown", () => {
    // `self` is this parser's word for an empty column, not a code the Clerk
    // publishes. Tran's row carries no owner.
    assert.equal(owner(TRAN.replace("(LTC)", "(NVDA)")), "self");
  });

  test("the code is stripped from the asset description it prefixed", () => {
    const t = parse(PELOSI).trades[0];
    assert.ok(t);
    assert.ok(!t.assetDescription.startsWith("SP"), t.assetDescription);
  });

  test("every owner code renders a word rather than a code", () => {
    assert.match(describeTrade(parse(PELOSI).trades[0] as CongressTrade), /\(spouse\)/);
    assert.match(describeTrade(parse(MOSKOWITZ_DC).trades[0] as CongressTrade), /\(dependent child\)/);
    assert.match(describeTrade(parse(JACKSON_PARTIAL).trades[0] as CongressTrade), /\(joint\)/);
  });
});

describe("parsePtr — transaction types", () => {
  test("P is a purchase", () => {
    assert.equal(parse(MOSKOWITZ_DC).trades[0]?.direction, "purchase");
  });

  test("S is a sale", () => {
    const text = MILLER.replace("(PFE)", "(AMD)");
    assert.equal(parse(text).trades[0]?.direction, "sale");
  });

  test("S (partial) is its own direction, not an S with debris", () => {
    const t = parse(JACKSON_PARTIAL).trades[0];
    assert.equal(t?.direction, "partial-sale");
    assert.equal(t?.ticker, "MSFT");
  });

  test("E is an exchange and is neither a buy nor a sell", () => {
    const text = HERN_EXCHANGE.replace("(CTRA)", "(NVDA)");
    const { trades } = parse(text);
    assert.equal(trades[0]?.direction, "exchange");

    const summary = summariseCongressTrades(trades, 90, {
      now: new Date("2026-06-01T00:00:00Z"),
    });
    assert.equal(summary.trades.length, 1, "the exchange is still disclosed");
    assert.equal(summary.purchases, 0);
    assert.equal(summary.sales, 0);
    assert.equal(summary.net, 0, "a change of instrument is not a change of exposure");
  });

  test("an unknown transaction code produces nothing rather than a guess", () => {
    const text = MOSKOWITZ_DC.replace(
      "Applied Materials, Inc. - Common P  ",
      "Applied Materials, Inc. - Common X  ",
    );
    assert.equal(parse(text).trades.length, 0);
  });
});

describe("parsePtr — asset types", () => {
  test("ST is carried through", () => {
    assert.equal(parse(MOSKOWITZ_DC).trades[0]?.assetType, "ST");
  });

  test("OP stays distinguishable from stock", () => {
    const t = parse(PELOSI).trades[0];
    assert.equal(t?.assetType, "OP");
    assert.match(describeTrade(t as CongressTrade), /\[OP\]/);
  });

  test("CT is carried through", () => {
    assert.equal(parse(TRAN.replace("(LTC)", "(NVDA)")).trades[0]?.assetType, "CT");
  });

  test("options are counted separately from share trades", () => {
    const trades = [
      ...parse(PELOSI).trades,
      ...parse(MOSKOWITZ_DC).trades,
    ];
    const summary = summariseCongressTrades(trades, 90, {
      now: new Date("2026-06-25T00:00:00Z"),
    });

    assert.equal(summary.trades.length, 2);
    assert.equal(summary.optionTrades, 1, "the Pelosi INTC row is options, not shares");
  });

  test("a row with no asset-type code leaves the field undefined", () => {
    const text = MOSKOWITZ_DC.replace(" [ST]", "");
    assert.equal(parse(text).trades[0]?.assetType, undefined);
  });
});

describe("parsePtr — ticker validation", () => {
  test("a plausible symbol that is not in the universe never becomes a position", () => {
    // GOOG is real and wrong (the universe holds GOOGL); VTI is real and out
    // of scope. Both sit inside company names that carry their own brackets.
    const { trades, rowsOutsideUniverse } = parse(NEAR_MISS);

    assert.deepEqual(trades, []);
    assert.equal(rowsOutsideUniverse, 2, "both rows are counted, not silently dropped");
  });

  test("parenthesised debris in a company name is not a ticker", () => {
    const { trades } = parse(NEAR_MISS);
    assert.equal(trades.length, 0);
    for (const symbol of ["Class C", "US", "GOOG", "VTI"]) {
      assert.ok(!trades.some((t) => t.ticker === symbol));
    }
  });

  test("a row carrying no symbol at all is counted, not dropped", () => {
    // Treasury and municipal rows are the bulk of the non-equity volume.
    const text = MOSKOWITZ_DC.replace("Stock (AMAT) [ST]", "UNITED STATES TREAS 4.125% [GS]");
    const { trades, rowsOutsideUniverse } = parse(text);
    assert.equal(trades.length, 0);
    assert.equal(rowsOutsideUniverse, 1);
  });

  test("every ticker produced is an exact universe member", () => {
    const tickers = new Set(UNIVERSE.map((e) => e.ticker));
    for (const fixture of [PELOSI, MOSKOWITZ_DC, JACKSON_PARTIAL, TOP_BRACKET]) {
      for (const t of parse(fixture).trades) {
        assert.ok(tickers.has(t.ticker), `${t.ticker} is not in the universe`);
      }
    }
  });

  test("the first universe match in the row wins", () => {
    // Documented behaviour, and the residual false-positive vector: a basket
    // product naming a constituent before its own symbol would be read as a
    // trade in the constituent. No filing in the sampled window does this, and
    // universe membership is what keeps ordinary parse debris out.
    const text = TOP_BRACKET.replace(
      "NVIDIA Corporation - Common Stock",
      "Some Fund (AMD) Holding NVIDIA  ",
    );
    assert.equal(parse(text).trades[0]?.ticker, "AMD");
  });
});

describe("parsePtr — unreadable rows are counted, not lost", () => {
  test("an extraction with no transaction table yields nothing and throws nothing", () => {
    const { trades, rowsOutsideUniverse, rowsUnparsed } = parse(LEGACY_SCAN);
    assert.deepEqual(trades, []);
    assert.equal(rowsOutsideUniverse, 0);
    assert.equal(rowsUnparsed, 0);
  });

  test("a row whose type code drifted off its own line is counted as unread", () => {
    // `pdftotext` loses the column alignment on some long filings and strands
    // the dates on a line of their own. The row is not recoverable, but the
    // hole in the evidence has to be visible.
    const drifted = `Name:          Hon. Test Member

State/District: ZZ99

ID       Owner Asset                           Transaction Date  Notification Amount
         SP    NVIDIA Corporation - Common Stock
                                                                 05/29/2026 05/29/2026 $1,001 - $15,000
`;
    const { trades, rowsUnparsed } = parse(drifted);
    assert.equal(trades.length, 0);
    assert.equal(rowsUnparsed, 1);
  });

  test("a clean filing reports no unread rows", () => {
    for (const fixture of [PELOSI, MILLER, TRAN, MOSKOWITZ_DC, JACKSON_PARTIAL]) {
      assert.equal(parse(fixture).rowsUnparsed, 0);
    }
  });
});

describe("summariseCongressTrades", () => {
  const NOW = new Date("2026-08-14T00:00:00Z");

  function trade(over: Partial<CongressTrade>): CongressTrade {
    return {
      ticker: "NVDA",
      filer: "Hon. A",
      stateDistrict: "ZZ99",
      owner: "self",
      direction: "purchase",
      transactionDate: "2026-08-01",
      notificationDate: "2026-08-02",
      filedOn: "2026-08-03",
      amount: { low: 1001, high: 15000, asFiled: "$1,001 - $15,000" },
      assetType: "ST",
      assetDescription: "NVIDIA Corporation (NVDA) [ST]",
      docId: "1",
      url: "",
      ...over,
    };
  }

  test("net is a count of purchases less sales, never a dollar figure", () => {
    const s = summariseCongressTrades(
      [
        trade({ direction: "purchase" }),
        trade({ direction: "sale", filer: "Hon. B" }),
        trade({ direction: "partial-sale", filer: "Hon. C" }),
      ],
      90,
      { now: NOW },
    );

    assert.equal(s.purchases, 1);
    assert.equal(s.sales, 2, "a partial sale is still a sale");
    assert.equal(s.net, -1);
    assert.equal(s.distinctFilers, 3);
    assert.equal(typeof s.net, "number");
    assert.ok(!("value" in s), "no dollar total may exist on the summary");
  });

  test("only the transaction date decides the window", () => {
    const stale = trade({ transactionDate: "2025-03-10", filedOn: "2026-08-13" });
    const fresh = trade({ transactionDate: "2026-08-01", filedOn: "2026-08-13" });

    const s = summariseCongressTrades([stale, fresh], 90, { now: NOW });
    assert.equal(s.trades.length, 1);
    assert.equal(s.trades[0]?.transactionDate, "2026-08-01");
  });

  test("an empty window is neutral evidence, not an error", () => {
    const s = summariseCongressTrades([], 90, { now: NOW });
    assert.deepEqual(
      { p: s.purchases, sl: s.sales, n: s.net, f: s.distinctFilers, o: s.optionTrades },
      { p: 0, sl: 0, n: 0, f: 0, o: 0 },
    );
  });

  test("the unreadable count travels with the summary", () => {
    // Without it, "no disclosures" out of a partly unreadable window reads
    // identically to "no disclosures" out of a complete one.
    const s = summariseCongressTrades([], 90, { now: NOW, unreadablePtrs: 18 });
    assert.equal(s.unreadablePtrs, 18);
    assert.equal(s.trades.length, 0);
  });

  test("a trade exactly on the window boundary is inside it", () => {
    const boundary = new Date(NOW.getTime() - 90 * 86_400_000).toISOString().slice(0, 10);
    const s = summariseCongressTrades([trade({ transactionDate: boundary })], 90, { now: NOW });
    assert.equal(s.trades.length, 1);
  });
});

describe("parseDisclosureIndex", () => {
  const xml = (members: string): string =>
    `<?xml version="1.0"?><FinancialDisclosure>${members}</FinancialDisclosure>`;

  const member = (over: Record<string, string> = {}): string => {
    const fields: Record<string, string> = {
      Prefix: "Hon.",
      First: "Nancy",
      Last: "Pelosi",
      FilingType: "P",
      StateDst: "CA11",
      Year: "2026",
      FilingDate: "6/23/2026",
      DocID: "20034836",
      ...over,
    };
    return `<Member>${Object.entries(fields)
      .filter(([, v]) => v !== "")
      .map(([k, v]) => `<${k}>${v}</${k}>`)
      .join("")}</Member>`;
  };

  test("keeps only Periodic Transaction Reports", () => {
    const filings = parseDisclosureIndex(
      xml(
        member() +
          member({ FilingType: "A", DocID: "1" }) +
          member({ FilingType: "C", DocID: "2" }) +
          member({ FilingType: "X", DocID: "3" }),
      ),
      2026,
    );

    assert.equal(filings.length, 1);
    assert.equal(filings[0]?.docId, "20034836");
  });

  test("assembles the filer name and the PDF url", () => {
    const f = parseDisclosureIndex(xml(member()), 2026)[0];
    assert.equal(f?.filer, "Hon. Nancy Pelosi");
    assert.equal(f?.stateDistrict, "CA11");
    assert.equal(f?.filedOn, "2026-06-23");
    assert.equal(
      f?.url,
      "https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2026/20034836.pdf",
    );
  });

  test("a single Member is not treated as a character array", () => {
    // fast-xml-parser returns an object rather than a one-element array when
    // a year holds exactly one filing.
    assert.equal(parseDisclosureIndex(xml(member()), 2026).length, 1);
  });

  test("an unparseable filing date drops the row rather than dating it now", () => {
    const filings = parseDisclosureIndex(
      xml(member({ FilingDate: "not a date" }) + member({ DocID: "999" })),
      2026,
    );
    assert.deepEqual(filings.map((f) => f.docId), ["999"]);
  });

  test("a missing DocID drops the row — there is no PDF to fetch", () => {
    assert.equal(parseDisclosureIndex(xml(member({ DocID: "" })), 2026).length, 0);
  });

  test("an empty or absent index is an empty list, not a throw", () => {
    assert.deepEqual(parseDisclosureIndex(xml(""), 2026), []);
    assert.deepEqual(parseDisclosureIndex("<FinancialDisclosure/>", 2026), []);
  });

  test("a leading byte-order mark does not defeat the parser", () => {
    assert.equal(parseDisclosureIndex("﻿" + xml(member()), 2026).length, 1);
  });
});

describe("extractPdfText", () => {
  test("refuses anything that is not a PDF rather than shelling out", () => {
    // A 404 page or an HTML error body must not reach `pdftotext`.
    return assert.rejects(
      () => extractPdfText(Buffer.from("<html>Not Found</html>")),
      /not a PDF/,
    );
  });
});

describe("ptrUrl", () => {
  test("points at the Clerk's own archive for the filing year", () => {
    assert.equal(
      ptrUrl(2025, "9116292"),
      "https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2025/9116292.pdf",
    );
  });
});
