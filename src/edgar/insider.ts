/**
 * Insider and major-holder activity from SEC Form 4 and Schedule 13D/G.
 *
 * This is the heaviest-weighted screening factor, and it is the one most often
 * got wrong. A Form 4 reports every change in an insider's position, most of
 * which carry no information about conviction: equity grants, option
 * exercises, shares withheld to cover tax on vesting, gifts. Counting those as
 * "insider buying" produces a signal dominated by payroll mechanics.
 *
 * Only open-market purchases (transaction code P) reflect an insider choosing
 * to put their own money in at the prevailing price. That distinction is the
 * whole value of this factor, so it is enforced here rather than left to the
 * scorer.
 *
 * See https://www.sec.gov/files/forms-3-4-5.pdf for the code table.
 */

import { XMLParser } from "fast-xml-parser";

import { cached } from "../lib/cache.js";
import { NotFoundError, secFetchJson, secFetchText } from "../lib/http.js";
import {
  fetchMajorHolderFilings,
  summariseMajorHolders,
  type MajorHolderSummary,
} from "./majorHolders.js";

const DAY_MS = 86_400_000;

/**
 * Form 4 transaction codes, split by whether they signal conviction.
 *
 * P — open-market or private purchase. The signal.
 * S — open-market or private sale. Informative, though often scheduled.
 * A — grant, award, or other acquisition from the issuer. Compensation.
 * M — exercise or conversion of a derivative security.
 * F — shares withheld by the issuer to satisfy tax on vesting.
 * G — bona fide gift.
 * C — conversion of a derivative security.
 * D — disposition to the issuer.
 * X — exercise of an in-the-money derivative security.
 */
export const CONVICTION_BUY_CODES = new Set(["P"]);
export const CONVICTION_SELL_CODES = new Set(["S"]);
/** Compensation and mechanics — excluded from the conviction signal. */
export const NON_CONVICTION_CODES = new Set(["A", "M", "F", "G", "C", "D", "X"]);

export interface InsiderTransaction {
  /** Date the trade occurred, not the filing date. */
  date: string;
  filedAt: string;
  code: string;
  /** A = acquired, D = disposed. */
  acquiredDisposed: string;
  shares: number;
  pricePerShare: number;
  /** shares x price; zero-price grants therefore contribute nothing. */
  value: number;
  ownerName: string;
  isDirector: boolean;
  isOfficer: boolean;
  officerTitle: string;
  isTenPercentOwner: boolean;
  accession: string;
  url: string;
}

export interface InsiderActivity {
  cik: string;
  windowDays: number;
  since: string;
  transactions: InsiderTransaction[];
  /** Net 5%+ holder movement, with filings by this company already removed. */
  majorHolders: MajorHolderSummary;
  /** Form 4s we saw but could not parse, so gaps are visible not silent. */
  parseFailures: { accession: string; reason: string }[];
}

interface SubmissionsResponse {
  filings: {
    recent: {
      accessionNumber: string[];
      filingDate: string[];
      form: string[];
      primaryDocument: string[];
    };
  };
}

const parser = new XMLParser({
  ignoreAttributes: true,
  parseTagValue: false,
  trimValues: true,
});

function archiveUrl(cik: string, accession: string, doc: string): string {
  const bare = String(Number(cik));
  const accnNoDashes = accession.replace(/-/g, "");
  return `https://www.sec.gov/Archives/edgar/data/${bare}/${accnNoDashes}/${doc}`;
}

/**
 * The submissions feed lists the XSL-rendered document; the machine-readable
 * XML sits beside it without the stylesheet directory prefix.
 */
function rawXmlDoc(primaryDocument: string): string {
  return primaryDocument.replace(/^xsl[^/]*\//, "");
}

function asArray<T>(v: T | T[] | undefined): T[] {
  if (v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}

/** Form 4 wraps most leaf values in a `<value>` element, sometimes with footnotes. */
function leaf(node: unknown): string | undefined {
  if (node === undefined || node === null) return undefined;
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (typeof node === "object" && "value" in node) {
    const v = (node as { value: unknown }).value;
    if (typeof v === "string" || typeof v === "number") return String(v);
  }
  return undefined;
}

function num(node: unknown): number | undefined {
  const raw = leaf(node);
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function parseForm4(
  xml: string,
  meta: { filedAt: string; accession: string; url: string },
): InsiderTransaction[] {
  const doc = parser.parse(xml) as Record<string, unknown>;
  const root = doc.ownershipDocument as Record<string, unknown> | undefined;
  if (!root) throw new Error("no ownershipDocument element");

  const owner = root.reportingOwner as Record<string, unknown> | undefined;
  const ownerId = owner?.reportingOwnerId as Record<string, unknown> | undefined;
  const rel = owner?.reportingOwnerRelationship as Record<string, unknown> | undefined;

  const ownerName = String(ownerId?.rptOwnerName ?? "unknown");
  const isDirector = String(rel?.isDirector ?? "0") === "1";
  const isOfficer = String(rel?.isOfficer ?? "0") === "1";
  const isTenPercentOwner = String(rel?.isTenPercentOwner ?? "0") === "1";
  const officerTitle = String(rel?.officerTitle ?? "");

  const table = root.nonDerivativeTable as Record<string, unknown> | undefined;
  const rows = asArray(table?.nonDerivativeTransaction as unknown);

  const out: InsiderTransaction[] = [];

  for (const row of rows) {
    if (typeof row !== "object" || row === null) continue;
    const r = row as Record<string, unknown>;

    const coding = r.transactionCoding as Record<string, unknown> | undefined;
    const amounts = r.transactionAmounts as Record<string, unknown> | undefined;

    const code = String(coding?.transactionCode ?? "");
    const date = leaf(r.transactionDate);
    const shares = num(amounts?.transactionShares) ?? 0;
    const price = num(amounts?.transactionPricePerShare) ?? 0;
    const acquiredDisposed = leaf(amounts?.transactionAcquiredDisposedCode) ?? "";

    if (!date || !code) continue;

    out.push({
      date,
      filedAt: meta.filedAt,
      code,
      acquiredDisposed,
      shares,
      pricePerShare: price,
      value: shares * price,
      ownerName,
      isDirector,
      isOfficer,
      officerTitle,
      isTenPercentOwner,
      accession: meta.accession,
      url: meta.url,
    });
  }

  return out;
}

/**
 * EDGAR labels Schedule 13D/G filings two different ways — "SC 13G" and
 * "SCHEDULE 13G", with "/A" suffixes for amendments — and uses both in the
 * same company feed. Matching only the abbreviated spelling silently drops
 * the newer filings.
 *
 * 13F-HR is deliberately excluded: institutional holdings are reported
 * quarterly with a 45-day lag, so they cannot evidence activity inside a
 * 14-day window no matter how they are parsed.
 */
const MAJOR_HOLDER_FORMS = /^(SC|SCHEDULE)\s+13[DG]\b/i;

export function isMajorHolderForm(form: string): boolean {
  return MAJOR_HOLDER_FORMS.test(form);
}

export interface FetchInsiderOptions {
  windowDays?: number;
  refresh?: boolean;
  /** Cap on Form 4 documents fetched per company, to bound request volume. */
  maxDocuments?: number;
}

export async function fetchInsiderActivity(
  cik: string,
  opts: FetchInsiderOptions = {},
): Promise<InsiderActivity> {
  const { windowDays = 90, refresh = false, maxDocuments = 80 } = opts;

  const { value: submissions } = await cached<SubmissionsResponse>(
    `submissions_CIK${cik}`,
    { ttlHours: 6, refresh },
    () => secFetchJson<SubmissionsResponse>(`https://data.sec.gov/submissions/CIK${cik}.json`),
  );

  const recent = submissions.filings.recent;
  const since = new Date(Date.now() - windowDays * DAY_MS).toISOString().slice(0, 10);

  const transactions: InsiderTransaction[] = [];
  const parseFailures: { accession: string; reason: string }[] = [];

  let fetched = 0;

  for (let i = 0; i < recent.form.length; i++) {
    const filedAt = recent.filingDate[i];
    const form = recent.form[i];
    const accession = recent.accessionNumber[i];
    const primaryDocument = recent.primaryDocument[i];

    if (!filedAt || !form || !accession) continue;
    // The feed is newest-first, so the first out-of-window entry ends the scan.
    if (filedAt < since) break;

    // 13D/G documents are fetched separately so each can be checked against
    // the issuer CIK — the submissions feed also carries filings where this
    // company is the investor rather than the subject.
    if (isMajorHolderForm(form)) continue;

    if (form !== "4") continue;
    if (fetched >= maxDocuments) {
      parseFailures.push({ accession, reason: "document cap reached" });
      continue;
    }

    const url = archiveUrl(cik, accession, rawXmlDoc(primaryDocument ?? ""));

    try {
      const xml = await secFetchText(url);
      transactions.push(...parseForm4(xml, { filedAt, accession, url }));
      fetched++;
    } catch (err) {
      parseFailures.push({
        accession,
        reason: err instanceof NotFoundError ? "XML document not found" : String(err),
      });
    }
  }

  const { filings, failures } = await fetchMajorHolderFilings(cik, recent, {
    windowDays,
  });
  if (failures > 0) {
    parseFailures.push({
      accession: "13D/G",
      reason: `${failures} schedule filing(s) could not be parsed`,
    });
  }

  return {
    cik,
    windowDays,
    since,
    transactions,
    majorHolders: summariseMajorHolders(filings, cik),
    parseFailures,
  };
}

// ---------------------------------------------------------------------------
// Summarising
// ---------------------------------------------------------------------------

export interface InsiderSummary {
  windowDays: number;
  /** Open-market purchases only (code P). */
  buyCount: number;
  buyValue: number;
  /** Open-market sales only (code S). */
  sellCount: number;
  sellValue: number;
  /** Distinct insiders making open-market purchases. Breadth beats size. */
  distinctBuyers: number;
  distinctSellers: number;
  /** Net insider dollar flow: purchases less sales. Can be negative. */
  netValue: number;
  /** Grants, exercises and withholdings seen but deliberately excluded. */
  excludedCount: number;

  /** Net percentage points of the class added by 5%+ holders. Can be negative. */
  netHolderPercentChange: number;
  holdersIncreasing: number;
  holdersDecreasing: number;
  /** Amendments whose prior level was outside the window. */
  holdersIndeterminate: number;
  /** 13D/G filings discarded because this company was the filer. */
  filedByCompanyCount: number;

  /**
   * True when the net flow is positive on either measure. Note this is
   * accumulation, not merely activity: selling insiders and exiting funds
   * push it false.
   */
  netAccumulation: boolean;
}

export function summariseInsiderActivity(activity: InsiderActivity): InsiderSummary {
  const buys = activity.transactions.filter(
    (t) => CONVICTION_BUY_CODES.has(t.code) && t.acquiredDisposed === "A",
  );
  const sells = activity.transactions.filter(
    (t) => CONVICTION_SELL_CODES.has(t.code) && t.acquiredDisposed === "D",
  );
  const excluded = activity.transactions.filter((t) => NON_CONVICTION_CODES.has(t.code));

  const buyValue = buys.reduce((sum, t) => sum + t.value, 0);
  const sellValue = sells.reduce((sum, t) => sum + t.value, 0);
  const netValue = buyValue - sellValue;
  const holders = activity.majorHolders;

  return {
    windowDays: activity.windowDays,
    buyCount: buys.length,
    buyValue,
    sellCount: sells.length,
    sellValue,
    distinctBuyers: new Set(buys.map((t) => t.ownerName)).size,
    distinctSellers: new Set(sells.map((t) => t.ownerName)).size,
    netValue,
    excludedCount: excluded.length,
    netHolderPercentChange: holders.netPercentChange,
    holdersIncreasing: holders.increases.length,
    holdersDecreasing: holders.decreases.length,
    holdersIndeterminate: holders.indeterminate.length,
    filedByCompanyCount: holders.filedByCompanyCount,
    netAccumulation: netValue > 0 || holders.netPercentChange > 0,
  };
}
