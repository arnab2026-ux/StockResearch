/**
 * Schedule 13D/G — positions held by beneficial owners above 5%.
 *
 * Two traps make the naive reading of these filings actively misleading:
 *
 * 1. **A company's submissions feed contains filings where it is the filer,
 *    not the subject.** NVIDIA's feed carries its own 13Gs disclosing stakes
 *    in CoreWeave and Nebius. Counting those as "a large investor bought
 *    NVIDIA" inverts the signal. Two of five recent NVIDIA 13D/G filings were
 *    of this kind, so the error is common rather than incidental. Every
 *    filing is therefore checked against the issuer CIK.
 *
 * 2. **An amendment reporting 0% is an exit, not an accumulation.** Vanguard's
 *    March 2026 amendment on NVIDIA reports `classPercent` 0 — the position
 *    dropped below the reporting threshold. Treating any 13D/G filing as
 *    bullish counts a large holder leaving as though they had arrived.
 *
 * The output is therefore a net change in percentage points held, not a count
 * of filings.
 */

import { XMLParser } from "fast-xml-parser";

import { NotFoundError, secFetchText } from "../lib/http.js";

const parser = new XMLParser({
  ignoreAttributes: true,
  parseTagValue: false,
  trimValues: true,
  // Strip the sch:/com: namespace prefixes so lookups are plain names.
  transformTagName: (tag: string) => tag.replace(/^[^:]+:/, ""),
});

export interface MajorHolderFiling {
  filedAt: string;
  form: string;
  isAmendment: boolean;
  issuerCik: string;
  issuerName: string;
  reportingPerson: string;
  shares: number | undefined;
  /** Percent of class held, as reported on the cover page. */
  classPercent: number | undefined;
  accession: string;
  url: string;
}

function findFirst(node: unknown, key: string): unknown {
  if (node === null || typeof node !== "object") return undefined;
  const obj = node as Record<string, unknown>;
  if (key in obj) return obj[key];

  for (const value of Object.values(obj)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        const hit = findFirst(item, key);
        if (hit !== undefined) return hit;
      }
    } else if (typeof value === "object") {
      const hit = findFirst(value, key);
      if (hit !== undefined) return hit;
    }
  }
  return undefined;
}

function text(node: unknown, key: string): string | undefined {
  const hit = findFirst(node, key);
  if (hit === undefined || hit === null) return undefined;
  if (typeof hit === "string") return hit.trim();
  if (typeof hit === "number") return String(hit);
  return undefined;
}

function numberAt(node: unknown, key: string): number | undefined {
  const raw = text(node, key);
  if (raw === undefined) return undefined;
  const parsed = Number(raw.replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function parseSchedule13(
  xml: string,
  meta: { filedAt: string; form: string; accession: string; url: string },
): MajorHolderFiling | undefined {
  const doc = parser.parse(xml) as Record<string, unknown>;
  const root = findFirst(doc, "edgarSubmission") ?? doc;

  const issuerCik = text(root, "issuerCik");
  if (!issuerCik) return undefined;

  return {
    filedAt: meta.filedAt,
    form: meta.form,
    isAmendment: /\/A\b/.test(meta.form),
    issuerCik: issuerCik.padStart(10, "0"),
    issuerName: text(root, "issuerName") ?? "unknown",
    reportingPerson: text(root, "reportingPersonName") ?? "unknown",
    shares: numberAt(root, "reportingPersonBeneficiallyOwnedAggregateNumberOfShares"),
    classPercent: numberAt(root, "classPercent"),
    accession: meta.accession,
    url: meta.url,
  };
}

// ---------------------------------------------------------------------------
// Net change
// ---------------------------------------------------------------------------

export interface HolderChange {
  reportingPerson: string;
  /** Percentage points added (positive) or removed (negative). */
  deltaPercent: number;
  from: number;
  to: number;
  basis: "new-position" | "amended" | "exit";
  latestFiledAt: string;
}

export interface MajorHolderSummary {
  /** Net change in percent of class held across all 5%+ holders. */
  netPercentChange: number;
  increases: HolderChange[];
  decreases: HolderChange[];
  /** Amendments whose prior level is unknown, so no delta is claimed. */
  indeterminate: { reportingPerson: string; filedAt: string; classPercent: number | undefined }[];
  /** Filings dropped because the company was the filer, not the subject. */
  filedByCompanyCount: number;
  consideredCount: number;
}

/**
 * Reduces a set of 13D/G filings to a net percentage-point change.
 *
 * Where a holder has two or more filings in view, the delta is the difference
 * between their earliest and latest reported percentage. A single original
 * filing means a holder crossed 5% and is treated as an addition of the
 * reported size. A single amendment cannot be differenced — the prior level
 * lies outside the window — so it is recorded as indeterminate rather than
 * guessed at, except when it reports zero, which is unambiguously an exit.
 */
export function summariseMajorHolders(
  filings: MajorHolderFiling[],
  companyCik: string,
): MajorHolderSummary {
  // Both sides are normalised: EDGAR is inconsistent about zero-padding, and
  // a mismatch here silently discards every filing about the company.
  const cik = companyCik.replace(/\D/g, "").padStart(10, "0");
  const aboutCompany = filings.filter(
    (f) => f.issuerCik.replace(/\D/g, "").padStart(10, "0") === cik,
  );
  const filedByCompanyCount = filings.length - aboutCompany.length;

  const byPerson = new Map<string, MajorHolderFiling[]>();
  for (const f of aboutCompany) {
    const key = f.reportingPerson.toUpperCase();
    const list = byPerson.get(key) ?? [];
    list.push(f);
    byPerson.set(key, list);
  }

  const increases: HolderChange[] = [];
  const decreases: HolderChange[] = [];
  const indeterminate: MajorHolderSummary["indeterminate"] = [];

  for (const [, group] of byPerson) {
    group.sort((a, b) => a.filedAt.localeCompare(b.filedAt));
    const earliest = group[0];
    const latest = group[group.length - 1];
    if (!earliest || !latest) continue;

    const person = latest.reportingPerson;

    if (group.length >= 2) {
      const from = earliest.classPercent;
      const to = latest.classPercent;
      if (from === undefined || to === undefined) {
        indeterminate.push({
          reportingPerson: person,
          filedAt: latest.filedAt,
          classPercent: to,
        });
        continue;
      }
      const change: HolderChange = {
        reportingPerson: person,
        deltaPercent: to - from,
        from,
        to,
        basis: to === 0 ? "exit" : "amended",
        latestFiledAt: latest.filedAt,
      };
      if (change.deltaPercent >= 0) increases.push(change);
      else decreases.push(change);
      continue;
    }

    const only = latest;
    const pct = only.classPercent;

    if (pct === 0) {
      // An amendment reporting nil is an exit regardless of the prior level.
      decreases.push({
        reportingPerson: person,
        // The prior level is unknown; 5% is the reporting threshold and so
        // the smallest defensible magnitude for a position that existed.
        deltaPercent: -5,
        from: 5,
        to: 0,
        basis: "exit",
        latestFiledAt: only.filedAt,
      });
      continue;
    }

    if (!only.isAmendment && pct !== undefined) {
      increases.push({
        reportingPerson: person,
        deltaPercent: pct,
        from: 0,
        to: pct,
        basis: "new-position",
        latestFiledAt: only.filedAt,
      });
      continue;
    }

    indeterminate.push({
      reportingPerson: person,
      filedAt: only.filedAt,
      classPercent: pct,
    });
  }

  const netPercentChange =
    increases.reduce((sum, c) => sum + c.deltaPercent, 0) +
    decreases.reduce((sum, c) => sum + c.deltaPercent, 0);

  return {
    netPercentChange,
    increases,
    decreases,
    indeterminate,
    filedByCompanyCount,
    consideredCount: aboutCompany.length,
  };
}

export interface FetchMajorHoldersOptions {
  windowDays: number;
  maxDocuments?: number;
}

export async function fetchMajorHolderFilings(
  cik: string,
  recent: {
    accessionNumber: string[];
    filingDate: string[];
    form: string[];
    primaryDocument: string[];
  },
  opts: FetchMajorHoldersOptions,
): Promise<{ filings: MajorHolderFiling[]; failures: number }> {
  const { windowDays, maxDocuments = 60 } = opts;
  const since = new Date(Date.now() - windowDays * 86_400_000).toISOString().slice(0, 10);

  const filings: MajorHolderFiling[] = [];
  let failures = 0;
  let fetched = 0;

  for (let i = 0; i < recent.form.length; i++) {
    const filedAt = recent.filingDate[i];
    const form = recent.form[i];
    const accession = recent.accessionNumber[i];
    const doc = recent.primaryDocument[i];

    if (!filedAt || !form || !accession) continue;
    if (filedAt < since) break;
    if (!/^(SC|SCHEDULE)\s+13[DG]\b/i.test(form)) continue;
    if (fetched >= maxDocuments) break;

    const bare = String(Number(cik));
    const url = `https://www.sec.gov/Archives/edgar/data/${bare}/${accession.replace(/-/g, "")}/${(doc ?? "").replace(/^xsl[^/]*\//, "")}`;

    try {
      const xml = await secFetchText(url);
      const parsed = parseSchedule13(xml, { filedAt, form, accession, url });
      if (parsed) filings.push(parsed);
      else failures++;
      fetched++;
    } catch (err) {
      if (!(err instanceof NotFoundError)) failures++;
    }
  }

  return { filings, failures };
}
