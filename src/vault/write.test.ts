/**
 * Vault-writing tests, focused on the one thing the note must never do:
 * report an absence of congressional disclosures without reporting how much
 * of the window was actually legible.
 *
 * Roughly one Periodic Transaction Report in eight is a scan of a paper
 * filing that extracts to nothing. Those are not spread evenly — a member who
 * always files on paper is invisible to this factor on every run — so a note
 * saying "none disclosed" out of a partly unreadable window is a materially
 * weaker claim than the same words out of a complete one.
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";

import { sourced, unverified, type Sourced } from "../lib/provenance.js";
import type { CongressSummary, CongressTrade } from "../providers/houseDisclosures.js";
import type { ScreenedCompany } from "../screen/run.js";
import { COMPANIES_DIR, SCREENS_DIR, writeVault } from "./write.js";

const SRC = {
  name: "test",
  url: "https://example.com",
  asOf: "2026-08-14",
  retrievedAt: "2026-08-14",
};

const num = (v: number): Sourced<number> => sourced(v, SRC);

function trade(over: Partial<CongressTrade> = {}): CongressTrade {
  return {
    ticker: "INTC",
    filer: "Hon. Nancy Pelosi",
    stateDistrict: "CA11",
    owner: "SP",
    direction: "purchase",
    transactionDate: "2026-05-29",
    notificationDate: "2026-05-29",
    filedOn: "2026-06-23",
    amount: { low: 1_000_001, high: 5_000_000, asFiled: "$1,000,001 - $5,000,000" },
    assetType: "OP",
    assetDescription: "Intel Corporation - Common Stock (INTC) [OP]",
    docId: "20034836",
    url: "https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2026/20034836.pdf",
    ...over,
  };
}

function summary(over: Partial<CongressSummary> = {}): CongressSummary {
  const trades = over.trades ?? [];
  return {
    windowDays: 90,
    trades,
    purchases: trades.filter((t) => t.direction === "purchase").length,
    sales: trades.filter((t) => t.direction !== "purchase" && t.direction !== "exchange").length,
    net: 0,
    distinctFilers: new Set(trades.map((t) => t.filer)).size,
    optionTrades: trades.filter((t) => t.assetType === "OP").length,
    unreadablePtrs: 0,
    ...over,
  };
}

function company(over: Partial<ScreenedCompany> = {}): ScreenedCompany {
  const factor = (score: number) => ({ score: num(score), detail: "detail" });

  return {
    ticker: "INTC",
    name: "Intel Corporation",
    entry: { ticker: "INTC", category: "semis", exchange: "nasdaq" },
    currency: "USD",
    price: num(30),
    marketCap: num(140_000_000_000),
    sector: sourced("Technology", SRC),
    priceTarget: num(35),
    ttmEps: num(1),
    peRatio: num(30),
    fcf: num(1_000_000_000),
    fcfBasis: "ttm",
    fcfYield: num(0.007),
    epsGrowth: unverified("no consensus"),
    peg: unverified("no growth rate"),
    insider: undefined,
    congress: summary(),
    surprises: unverified("not fetched"),
    strength: {
      fScore: { score: 5, available: 9, signals: [] },
      altman: { score: unverified("n/a"), zone: undefined, components: {} },
      caveats: [],
    },
    factors: {
      insider: factor(50),
      surprise: factor(50),
      fcfYield: factor(50),
      peg: factor(50),
      sentiment: factor(50),
    },
    score: { value: 50, coverage: 1, missing: [], contributions: [] },
    filters: [{ name: "Market cap > $1000M", passed: true, detail: "$140.00B" }],
    qualifies: true,
    thesis: "a thesis",
    topRisk: "a risk",
    upsideToTarget: num(0.16),
    ...over,
  };
}

async function inTempVault(
  fn: (root: string) => Promise<void>,
  runDate = "2026-08-14",
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "vault-test-"));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
  void runDate;
}

const noteOf = (root: string, ticker: string): Promise<string> =>
  readFile(join(root, COMPANIES_DIR, `${ticker}.md`), "utf8");

describe("congressional coverage in the vault", () => {
  test("an unreadable window is named in the company note, not just counted", () =>
    inTempVault(async (root) => {
      await writeVault(
        root,
        [company({ congress: summary({ unreadablePtrs: 18 }) })],
        { windowDays: 90, sectorMedians: new Map() },
        "2026-08-14",
      );

      const note = await noteOf(root, "INTC");
      assert.match(note, /congress_unreadable_ptrs: 18/);
      assert.match(note, /18 PTR\(s\) in the window could not be read/);
      assert.match(note, /floor, not a count/);
    }));

  test("a fully-read quiet window says so without a coverage warning", () =>
    inTempVault(async (root) => {
      await writeVault(
        root,
        [company({ congress: summary({ unreadablePtrs: 0 }) })],
        { windowDays: 90, sectorMedians: new Map() },
        "2026-08-14",
      );

      const note = await noteOf(root, "INTC");
      assert.match(note, /congress_unreadable_ptrs: 0/);
      assert.match(note, /No congressional disclosures with a transaction date/);
      assert.doesNotMatch(note, /could not be read/);
    }));

  test("a note with disclosures still reports the coverage hole", () =>
    inTempVault(async (root) => {
      await writeVault(
        root,
        [
          company({
            congress: summary({ trades: [trade()], net: 1, unreadablePtrs: 18 }),
          }),
        ],
        { windowDays: 90, sectorMedians: new Map() },
        "2026-08-14",
      );

      const note = await noteOf(root, "INTC");
      assert.match(note, /1 congressional disclosure\(s\)/);
      assert.match(note, /in options rather than shares/);
      assert.match(note, /could not be read/);
    }));

  test("skipping the House pass entirely writes no congressional fields at all", () =>
    inTempVault(async (root) => {
      await writeVault(
        root,
        [company({ congress: undefined })],
        { windowDays: 90, sectorMedians: new Map() },
        "2026-08-14",
      );

      const note = await noteOf(root, "INTC");
      // Not checked is not the same as checked and empty, so there must be no
      // zero for a reader to mistake for a finding.
      assert.doesNotMatch(note, /congress_/);
      assert.doesNotMatch(note, /Congressional disclosures:/);
    }));

  test("the screen note carries the run-level coverage warning", () =>
    inTempVault(async (root) => {
      const { screenNotePath } = await writeVault(
        root,
        [company({ congress: summary({ unreadablePtrs: 18 }) })],
        { windowDays: 90, sectorMedians: new Map() },
        "2026-08-14",
      );

      assert.equal(screenNotePath, join(root, SCREENS_DIR, "2026-08-14-screen.md"));
      const note = await readFile(screenNotePath, "utf8");
      assert.match(note, /congress_unreadable_ptrs: 18/);
      assert.match(note, /Congressional coverage is partial/);
      assert.match(note, /invisible to this\s+factor on every run/);
    }));

  test("the screen note stays quiet when the whole window was read", () =>
    inTempVault(async (root) => {
      const { screenNotePath } = await writeVault(
        root,
        [company()],
        { windowDays: 90, sectorMedians: new Map() },
        "2026-08-14",
      );

      const note = await readFile(screenNotePath, "utf8");
      assert.match(note, /congress_unreadable_ptrs: 0/);
      assert.doesNotMatch(note, /coverage is partial/i);
    }));
});

describe("congressional events in the event log", () => {
  test("a disclosure is dated by its transaction, never by its filing", () =>
    inTempVault(async (root) => {
      // A PTR filed 2026-08-13 reporting a 2025-03-10 trade must log under
      // the transaction date, or the log claims the trade happened this week.
      await writeVault(
        root,
        [
          company({
            congress: summary({
              trades: [trade({ transactionDate: "2025-03-10", filedOn: "2026-08-13" })],
            }),
          }),
        ],
        { windowDays: 90, sectorMedians: new Map() },
        "2026-08-14",
      );

      const note = await noteOf(root, "INTC");
      assert.match(note, /- 2025-03-10 — Congress: Hon\. Nancy Pelosi \(spouse\) purchase/);
      assert.match(note, /\(disclosed 2026-08-13\)/);
    }));

  test("the bracket is logged exactly as filed, never as one number", () =>
    inTempVault(async (root) => {
      await writeVault(
        root,
        [company({ congress: summary({ trades: [trade()] }) })],
        { windowDays: 90, sectorMedians: new Map() },
        "2026-08-14",
      );

      const note = await noteOf(root, "INTC");
      assert.match(note, /\$1,000,001 - \$5,000,000 \[OP\]/);
      assert.doesNotMatch(note, /\$3,000,000/, "no midpoint may appear");
    }));

  test("a missing bracket is written UNVERIFIED rather than omitted", () =>
    inTempVault(async (root) => {
      await writeVault(
        root,
        [company({ congress: summary({ trades: [trade({ amount: undefined })] }) })],
        { windowDays: 90, sectorMedians: new Map() },
        "2026-08-14",
      );

      assert.match(await noteOf(root, "INTC"), /amount UNVERIFIED/);
    }));

  test("re-running the same day does not duplicate a congressional event", () =>
    inTempVault(async (root) => {
      const c = company({ congress: summary({ trades: [trade()] }) });
      const meta = { windowDays: 90, sectorMedians: new Map<string, number>() };

      await writeVault(root, [c], meta, "2026-08-14");
      const second = await writeVault(root, [c], meta, "2026-08-14");

      const note = await noteOf(root, "INTC");
      const occurrences = note.split("Congress: Hon. Nancy Pelosi").length - 1;
      assert.equal(occurrences, 1, "the event log deduplicates on the rendered line");
      assert.deepEqual(second.changes, [], "a re-run reports no new changes");
    }));

  test("the user's own sections survive a write", () =>
    inTempVault(async (root) => {
      await mkdir(join(root, COMPANIES_DIR), { recursive: true });
      await writeFile(
        join(root, COMPANIES_DIR, "INTC.md"),
        "---\nticker: INTC\nstatus: owned\n---\n\n## Thesis\n\nMy own words.\n\n## Notes\n\nKeep me.\n",
        "utf8",
      );

      await writeVault(
        root,
        [company({ congress: summary({ trades: [trade()] }) })],
        { windowDays: 90, sectorMedians: new Map() },
        "2026-08-14",
      );

      const note = await noteOf(root, "INTC");
      assert.match(note, /My own words\./);
      assert.match(note, /## Notes\n\nKeep me\./);
      assert.match(note, /status: owned/, "status is the user's to change");
    }));
});
