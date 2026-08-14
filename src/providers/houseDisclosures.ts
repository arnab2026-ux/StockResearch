/**
 * Congressional trading disclosures from the US House Clerk.
 *
 * Members of the House must report every securities transaction of their own,
 * their spouse's, or a dependent child's within 45 days, under the STOCK Act.
 * The Clerk publishes those Periodic Transaction Reports free, officially, with
 * no key and no terms gate — which puts them on the same footing as EDGAR
 * rather than the undocumented quote endpoints.
 *
 * Two structural facts shape this module.
 *
 * **The source is filer-indexed, not ticker-indexed.** There is no "who traded
 * NVDA" query; there is a year's worth of PTRs, each listing one member's
 * trades. So the whole window is fetched once and inverted into a
 * ticker → trades map, the same shape problem 13F has. Per-company calls would
 * mean re-reading the entire year 51 times.
 *
 * **The reports are PDFs.** 88% are e-filed and extract cleanly through
 * `pdftotext -layout`; the remaining 12% are scans of paper filings and extract
 * to nothing at all. Those are recorded as gaps, never silently dropped — an
 * empty extraction is "we could not read it", which is not the same claim as
 * "this member did not trade".
 *
 * The five traps that decide whether this is signal or noise:
 *
 * 1. **The transaction date is not the filing date.** A PTR filed 8/13/2026 can
 *    report a trade from 03/10/2025. Windowing on the filing date would place a
 *    17-month-old trade inside a 90-day window. The filing date is used for
 *    exactly one thing — deciding which PDFs are worth downloading — and that
 *    is safe only because a transaction always precedes its own disclosure.
 * 2. **Amounts are ranges, never values.** "$1,001 - $15,000" is what was
 *    filed. Collapsing a bracket to a midpoint would be estimating a figure,
 *    which this project forbids outright, so the range is modelled as a range
 *    and the score uses direction and count only.
 * 3. **Options are not shares.** Pelosi's INTC line is `[OP]` — 200 call
 *    options at a $50 strike, not stock. The asset-type code is carried through
 *    so an options trade is never presented as a share purchase.
 * 4. **Parsed symbols are validated against the screening universe.** Company
 *    names are full of parentheses, and a layout-preserving PDF extraction of a
 *    wrapped table produces plenty of debris. Requiring an exact universe match
 *    turns parse noise into nothing instead of into a false position.
 * 5. **Most disclosed trades are not the member's own.** The owner column marks
 *    spouse and dependent-child trades, and they dominate the volume. The code
 *    is carried through and surfaced rather than flattened into "the member
 *    bought".
 *
 * @see https://disclosures-clerk.house.gov/PublicDisclosure
 */

import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { inflateRawSync } from "node:zlib";

import { XMLParser } from "fast-xml-parser";

import { UNIVERSE } from "../config/universe.js";
import { cached } from "../lib/cache.js";
import { fetchBinary } from "../lib/web.js";

const execFileAsync = promisify(execFile);

const DAY_MS = 86_400_000;

const INDEX_URL = (year: number): string =>
  `https://disclosures-clerk.house.gov/public_disc/financial-pdfs/${year}FD.ZIP`;

export const ptrUrl = (year: number, docId: string): string =>
  `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/${year}/${docId}.pdf`;

/** The index changes as filings land; a day is well inside the 45-day duty. */
const INDEX_TTL_HOURS = 24;
/** A filed PTR never changes, so its extracted text is cached for a month. */
const PTR_TTL_HOURS = 720;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Who actually made the trade. `self` is the absence of a code in the owner
 * column, not a code the Clerk publishes.
 */
export type OwnerCode = "SP" | "DC" | "JT" | "self";

export const OWNER_LABELS: Record<OwnerCode, string> = {
  SP: "spouse",
  DC: "dependent child",
  JT: "joint",
  self: "member",
};

export type TradeDirection = "purchase" | "sale" | "partial-sale" | "exchange";

/**
 * A disclosed dollar bracket, kept as a bracket.
 *
 * There is deliberately no `value`, `midpoint` or `estimate` field. The filing
 * says the trade was somewhere between `low` and `high`; any single number
 * derived from that would be invented, and once invented it would be summed,
 * netted and reported as though it had been disclosed.
 */
export interface AmountRange {
  low: number;
  /** Absent on the open-ended top bracket ("$50,000,001 +"). */
  high: number | undefined;
  /** Exactly as filed, e.g. "$1,001 - $15,000". This is what gets printed. */
  asFiled: string;
}

export interface CongressTrade {
  /** Validated against UNIVERSE; a non-universe symbol never reaches here. */
  ticker: string;
  filer: string;
  stateDistrict: string;
  owner: OwnerCode;
  direction: TradeDirection;
  /** ISO. The window key — see trap 1. */
  transactionDate: string;
  notificationDate: string;
  /** ISO date the PTR itself was filed. Never used for windowing. */
  filedOn: string;
  /** Undefined when the bracket did not survive extraction — never inferred. */
  amount: AmountRange | undefined;
  /** Asset-type code as filed: ST stock, OP options, CT crypto, and others. */
  assetType: string | undefined;
  assetDescription: string;
  docId: string;
  url: string;
}

/** A PTR we knew about but could not read. Visible, never silently dropped. */
export interface CongressGap {
  docId: string;
  filer: string;
  reason: string;
  url: string;
}

export interface CongressionalTrades {
  /** Universe ticker → trades, newest transaction first. */
  byTicker: Map<string, CongressTrade[]>;
  years: number[];
  ptrsInScope: number;
  ptrsRead: number;
  /** Rows parsed whose symbol was outside the universe, or carried none. */
  rowsOutsideUniverse: number;
  /** Rows in read PTRs that the extractor's layout defeated. See `ParsedPtr`. */
  rowsUnparsed: number;
  gaps: CongressGap[];
}

// ---------------------------------------------------------------------------
// Index
// ---------------------------------------------------------------------------

export interface PtrFiling {
  docId: string;
  filer: string;
  stateDistrict: string;
  /** ISO filing date. */
  filedOn: string;
  year: number;
  url: string;
}

const xml = new XMLParser({
  ignoreAttributes: true,
  parseTagValue: false,
  trimValues: true,
});

interface RawMember {
  Prefix?: string;
  First?: string;
  Last?: string;
  Suffix?: string;
  FilingType?: string;
  StateDst?: string;
  Year?: string;
  FilingDate?: string;
  DocID?: string;
}

/** "6/23/2026" to "2026-06-23". */
export function toIsoDate(raw: string): string | undefined {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(raw.trim());
  if (!m) return undefined;
  const [, month, day, year] = m;
  if (!month || !day || !year) return undefined;
  return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
}

/**
 * Reads one member of a ZIP archive without a dependency.
 *
 * Walked from the central directory rather than by scanning for local file
 * headers: the Clerk's archives set the streaming flag on the local headers,
 * which zeroes the sizes there and leaves them recoverable only from the
 * directory at the tail.
 */
function readZipEntry(zip: Buffer, nameEndsWith: string): Buffer | undefined {
  const EOCD_SIG = 0x0605_4b50;
  const CENTRAL_SIG = 0x0201_4b50;

  let eocd = -1;
  for (let i = zip.length - 22; i >= 0 && i >= zip.length - 22 - 0xffff; i--) {
    if (zip.readUInt32LE(i) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return undefined;

  const entries = zip.readUInt16LE(eocd + 10);
  let p = zip.readUInt32LE(eocd + 16);

  for (let n = 0; n < entries; n++) {
    if (p + 46 > zip.length || zip.readUInt32LE(p) !== CENTRAL_SIG) return undefined;

    const method = zip.readUInt16LE(p + 10);
    const compressedSize = zip.readUInt32LE(p + 20);
    const nameLen = zip.readUInt16LE(p + 28);
    const extraLen = zip.readUInt16LE(p + 30);
    const commentLen = zip.readUInt16LE(p + 32);
    const localOffset = zip.readUInt32LE(p + 42);
    const name = zip.toString("utf8", p + 46, p + 46 + nameLen);

    if (name.toLowerCase().endsWith(nameEndsWith.toLowerCase())) {
      const localNameLen = zip.readUInt16LE(localOffset + 26);
      const localExtraLen = zip.readUInt16LE(localOffset + 28);
      const start = localOffset + 30 + localNameLen + localExtraLen;
      const body = zip.subarray(start, start + compressedSize);
      return method === 0 ? Buffer.from(body) : inflateRawSync(body);
    }

    p += 46 + nameLen + extraLen + commentLen;
  }

  return undefined;
}

/**
 * Extracts the Periodic Transaction Reports from a year's filing index.
 *
 * `FilingType` P is the PTR — the trades. The other types (A annual, C
 * candidate, W withdrawal, X extension, D, H, T) are the annual disclosure
 * machinery and carry no transaction dates, so including them would mean
 * downloading roughly four PDFs for every one worth reading.
 */
export function parseDisclosureIndex(indexXml: string, year: number): PtrFiling[] {
  const doc = xml.parse(indexXml.replace(/^﻿/, "")) as {
    FinancialDisclosure?: { Member?: RawMember | RawMember[] };
  };

  const raw = doc.FinancialDisclosure?.Member;
  const members = raw === undefined ? [] : Array.isArray(raw) ? raw : [raw];

  const filings: PtrFiling[] = [];

  for (const m of members) {
    if ((m.FilingType ?? "").trim().toUpperCase() !== "P") continue;

    const docId = (m.DocID ?? "").trim();
    const filedOn = toIsoDate(m.FilingDate ?? "");
    if (!docId || !filedOn) continue;

    const name = [m.Prefix, m.First, m.Last, m.Suffix]
      .map((part) => (part ?? "").trim())
      .filter(Boolean)
      .join(" ");

    filings.push({
      docId,
      filer: name || "unknown",
      stateDistrict: (m.StateDst ?? "").trim(),
      filedOn,
      year,
      url: ptrUrl(year, docId),
    });
  }

  return filings;
}

export async function fetchDisclosureIndex(
  year: number,
  opts: { refresh?: boolean } = {},
): Promise<PtrFiling[]> {
  const { value } = await cached<PtrFiling[]>(
    `house_fd_index_${year}`,
    { ttlHours: INDEX_TTL_HOURS, ...(opts.refresh !== undefined ? { refresh: opts.refresh } : {}) },
    async () => {
      const zip = await fetchBinary(INDEX_URL(year));
      const entry = readZipEntry(zip, `${year}FD.xml`);
      if (!entry) throw new Error(`${year}FD.xml not present in the Clerk's archive`);
      return parseDisclosureIndex(entry.toString("utf8"), year);
    },
  );

  return value;
}

// ---------------------------------------------------------------------------
// PDF text
// ---------------------------------------------------------------------------

/**
 * Poppler/Xpdf's `pdftotext`, resolved from PATH unless overridden.
 *
 * Shelling out beats adding a JavaScript PDF library: the layout-preserving
 * mode is what makes the transaction table parseable at all, and the binary
 * ships with Git for Windows, so there is nothing to install here.
 */
const PDFTOTEXT = process.env.PDFTOTEXT_BIN?.trim() || "pdftotext";

export async function extractPdfText(pdf: Buffer): Promise<string> {
  if (pdf.subarray(0, 4).toString("latin1") !== "%PDF") {
    throw new Error("response was not a PDF");
  }

  const dir = await mkdtemp(join(tmpdir(), "house-ptr-"));
  const path = join(dir, "ptr.pdf");

  try {
    await writeFile(path, pdf);
    // `-layout` keeps the column positions, which is the only thing that makes
    // the owner, type, date and amount columns recoverable from a flat string.
    const { stdout } = await execFileAsync(
      PDFTOTEXT,
      ["-layout", "-enc", "UTF-8", path, "-"],
      { maxBuffer: 32 * 1024 * 1024, encoding: "utf8" },
    );
    return stdout;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Extracted text for one PTR, cached by document id.
 *
 * An empty result is cached like any other: the legacy scanned filings will
 * still be empty next month, and re-downloading them every run to rediscover
 * that would be the same waste every time. A thrown error is not cached, so a
 * network blip or a missing `pdftotext` is retried rather than remembered.
 */
export async function fetchPtrText(
  filing: PtrFiling,
  opts: { refresh?: boolean } = {},
): Promise<string> {
  const { value } = await cached<{ text: string }>(
    `house_ptr_${filing.year}_${filing.docId}`,
    { ttlHours: PTR_TTL_HOURS, ...(opts.refresh !== undefined ? { refresh: opts.refresh } : {}) },
    async () => ({ text: await extractPdfText(await fetchBinary(filing.url)) }),
  );

  return value.text;
}

// ---------------------------------------------------------------------------
// Parsing a PTR
// ---------------------------------------------------------------------------

/**
 * A transaction row, anchored on the two dates rather than on column offsets.
 *
 * The asset description is free text that routinely contains hyphens, commas
 * and the letters that also serve as transaction codes ("… - Class P Common
 * Stock"). What cannot appear inside it is a transaction code immediately
 * followed by two dates, so that triple is the anchor and everything to its
 * left is the asset. Column positions are not usable: the ID column is empty
 * on many rows and the owner column is empty on the member's own trades, so
 * every field shifts left.
 */
const TRANSACTION_ROW =
  /^(?:\s*\d{6,}\s+)?(?<body>.*?)\s+(?<type>S \(partial\)|[PSE])\s+(?<tx>\d{1,2}\/\d{1,2}\/\d{4})\s+(?<notified>\d{1,2}\/\d{1,2}\/\d{4})(?<tail>.*)$/;

/**
 * A line carrying a transaction/notification date pair, used only to notice
 * rows the anchor above failed to read.
 *
 * `pdftotext` occasionally loses the column alignment on a long filing and
 * strands the transaction-type code on a different line from its dates. The
 * row then matches nothing and would otherwise vanish without trace, which is
 * the one thing this module is not allowed to do: an unread row is a hole in
 * the evidence, not an absence of trading. Counting them keeps the hole
 * visible even though the row itself is not recoverable.
 */
const DATE_PAIR = /\d{1,2}\/\d{1,2}\/\d{2,4}\s+\d{1,2}\/\d{1,2}\/\d{2,4}/;

/** "$1,001 - $15,000", "$1,000,001 -" with the top half wrapped, "$50,000,001 +". */
const AMOUNT = /\$([\d,]+)\s*(?:-\s*(?:\$([\d,]+))?|(\+))/;
/**
 * The upper half of a wrapped bracket, sitting in the amount column of a
 * continuation line.
 *
 * It is not always alone on that line. When the asset name wraps too, the
 * extractor puts both on the same line — "Stock (MSFT) [ST]      $50,000" —
 * and matching only a line that holds nothing else loses the top of the
 * bracket. That is not a cosmetic loss: `high` left undefined is the same
 * shape as the genuinely open-ended "$50,000,001 +" bracket, and `asFiled`
 * then prints "$15,001 -", which is not what was filed.
 *
 * Anchored to the end of the line and required to be column-separated (start
 * of line, or two or more spaces) so a dollar figure inside prose cannot be
 * mistaken for the bracket top.
 */
const TRAILING_AMOUNT = /(?:^\s*|\s{2,})\$([\d,]+)\s*$/;

const TICKER = /\(([A-Z][A-Z0-9.-]{0,5})\)/g;
const ASSET_TYPE = /\[([A-Z]{2,3})\]/;

/**
 * Lines that end a wrapped row: the labelled sub-fields beneath a transaction
 * (filing status, sub-holding, description, comment), the table footnote, and
 * the furniture repeated at every page break.
 */
const ROW_TERMINATORS = [
  /^\s*\*\s*For the complete list/i,
  /Filing ID #/i,
  /Clerk of the House/i,
  /^\s*(Name|Status|State\/District|ID|Owner|Asset|Type|Date)\s*:/i,
  /^\s*ID\s+Owner\s+Asset/i,
  /^\s*Digitally Signed/i,
];

/** "F S : New", "D : Purchased 200 call options…" — a labelled sub-field. */
function isLabelledField(line: string): boolean {
  const colon = line.indexOf(":");
  return colon > 0 && colon <= 30;
}

function isTerminator(line: string): boolean {
  return ROW_TERMINATORS.some((re) => re.test(line)) || isLabelledField(line);
}

const DIRECTIONS: Record<string, TradeDirection> = {
  P: "purchase",
  S: "sale",
  "S (partial)": "partial-sale",
  E: "exchange",
};

const UNIVERSE_TICKERS = new Set(UNIVERSE.map((e) => e.ticker));

function parseAmount(text: string): AmountRange | undefined {
  const m = AMOUNT.exec(text);
  if (!m) return undefined;

  const low = Number((m[1] ?? "").replace(/,/g, ""));
  if (!Number.isFinite(low)) return undefined;

  const high = m[2] === undefined ? undefined : Number(m[2].replace(/,/g, ""));

  return {
    low,
    high: high !== undefined && Number.isFinite(high) ? high : undefined,
    asFiled: m[3]
      ? `$${m[1]} +`
      : high === undefined
        ? `$${m[1]} -`
        : `$${m[1]} - $${m[2]}`,
  };
}

export interface ParsedPtr {
  filer: string;
  stateDistrict: string;
  trades: CongressTrade[];
  /** Rows read whose symbol was not an exact universe match. */
  rowsOutsideUniverse: number;
  /**
   * Lines that looked like a transaction row but could not be read at all —
   * the extractor lost the column alignment. Never inferred, only counted.
   */
  rowsUnparsed: number;
}

/**
 * Reads the transaction table out of one extracted PTR.
 *
 * Tolerant across lines by necessity: the asset description, its ticker, its
 * asset-type code and the upper half of the amount range all wrap onto
 * following lines, and which of them wrap depends on the length of the company
 * name. So a row is the anchor line plus every continuation line until a
 * labelled sub-field, page furniture or the next row.
 */
export function parsePtr(
  text: string,
  meta: { docId: string; url: string; filedOn: string; filer: string; stateDistrict: string },
): ParsedPtr {
  const lines = text.split(/\r?\n/);

  const filer = /^\s*Name:\s*(.+?)\s*$/m.exec(text)?.[1] ?? meta.filer;
  const stateDistrict =
    /^\s*State\/District:\s*(\S+)\s*$/m.exec(text)?.[1] ?? meta.stateDistrict;

  const trades: CongressTrade[] = [];
  let rowsOutsideUniverse = 0;
  let rowsUnparsed = 0;

  for (const [i, line] of lines.entries()) {
    const groups = isTerminator(line) ? undefined : TRANSACTION_ROW.exec(line)?.groups;
    if (!groups) {
      // A stranded date pair is a row this parser could not read. It is
      // counted rather than reconstructed — guessing which asset it belonged
      // to would be inventing a position.
      if (DATE_PAIR.test(line)) rowsUnparsed++;
      continue;
    }

    const transactionDate = toIsoDate(groups.tx ?? "");
    const notificationDate = toIsoDate(groups.notified ?? "");
    const direction = DIRECTIONS[groups.type ?? ""];
    if (!transactionDate || !notificationDate || !direction) {
      rowsUnparsed++;
      continue;
    }

    // Continuation lines, bounded: blanks separate a row from its sub-fields
    // rather than ending it, but two in a row mean the table moved on.
    const continued: string[] = [];
    let blanks = 0;
    for (let j = i + 1; j < lines.length && continued.length + blanks < 6; j++) {
      const next = lines[j] ?? "";
      if (next.trim() === "") {
        if (++blanks >= 2) break;
        continue;
      }
      if (isTerminator(next) || TRANSACTION_ROW.test(next)) break;
      continued.push(next);
    }

    let amount = parseAmount(groups.tail ?? "");
    const assetLines: string[] = [];

    for (const next of continued) {
      let rest = next;

      // The upper half of a wrapped bracket. It belongs to the low value
      // already read, so it completes the range instead of starting one, and
      // is taken out of the asset text rather than left to trail it.
      const trailing = TRAILING_AMOUNT.exec(next);
      if (
        trailing &&
        amount &&
        amount.high === undefined &&
        !amount.asFiled.endsWith("+")
      ) {
        const high = Number((trailing[1] ?? "").replace(/,/g, ""));
        // A figure below the low bound is not this bracket's ceiling.
        if (Number.isFinite(high) && high >= amount.low) {
          amount = {
            low: amount.low,
            high,
            asFiled: `$${amount.low.toLocaleString("en-US")} - $${trailing[1]}`,
          };
          rest = next.slice(0, trailing.index);
        }
      }

      if (rest.trim() === "") continue;
      // A range that wrapped whole rather than in half.
      if (!amount) amount = parseAmount(rest);
      assetLines.push(rest);
    }

    let body = (groups.body ?? "").trim();
    let owner: OwnerCode = "self";
    const ownerMatch = /^(SP|DC|JT)\b\s*/.exec(body);
    if (ownerMatch) {
      owner = ownerMatch[1] as OwnerCode;
      body = body.slice(ownerMatch[0].length);
    }

    const assetDescription = [body, ...assetLines.map((l) => l.trim())]
      .filter(Boolean)
      .join(" ")
      .replace(/\s{2,}/g, " ")
      .trim();

    // Trap 4: the first parenthesised token that is an exact universe match
    // wins, and a row with none is discarded rather than guessed at. Asset
    // descriptions are full of parentheses, so this is what keeps extraction
    // noise from becoming a fabricated position.
    let ticker: string | undefined;
    for (const candidate of assetDescription.matchAll(TICKER)) {
      const symbol = candidate[1];
      if (symbol && UNIVERSE_TICKERS.has(symbol)) {
        ticker = symbol;
        break;
      }
    }

    if (!ticker) {
      rowsOutsideUniverse++;
      continue;
    }

    trades.push({
      ticker,
      filer,
      stateDistrict,
      owner,
      direction,
      transactionDate,
      notificationDate,
      filedOn: meta.filedOn,
      amount,
      assetType: ASSET_TYPE.exec(assetDescription)?.[1],
      assetDescription,
      docId: meta.docId,
      url: meta.url,
    });
  }

  return { filer, stateDistrict, trades, rowsOutsideUniverse, rowsUnparsed };
}

// ---------------------------------------------------------------------------
// Fetching a window
// ---------------------------------------------------------------------------

/**
 * The index years a lookback window needs.
 *
 * The Clerk indexes by *filing* year, and a member has 45 days to disclose, so
 * a trade made in December surfaces in the following year's index. A run in
 * August needs only the current year; a run in January with a 90-day window
 * reaches back into October and needs the previous year's index too. No later
 * year is ever needed, because a filing cannot precede its own transaction.
 */
export function yearsCovering(windowDays: number, now = new Date()): number[] {
  const since = new Date(now.getTime() - windowDays * DAY_MS);
  const years: number[] = [];
  for (let y = since.getUTCFullYear(); y <= now.getUTCFullYear(); y++) years.push(y);
  return years;
}

export interface FetchCongressOptions {
  /**
   * ISO date. PTRs filed before this are skipped entirely — a filing cannot
   * report a transaction later than itself, so nothing in-window can hide in
   * one. This is the only thing the filing date decides.
   */
  since?: string;
  refresh?: boolean;
  /** Ceiling on PDFs fetched, so a first cold run cannot take an hour. */
  maxDocuments?: number;
  onProgress?: (done: number, total: number) => void;
}

/**
 * Every disclosed trade in universe names, keyed by ticker.
 *
 * Nothing in here throws at the caller. A dead index year, a 404 on a PDF, a
 * missing `pdftotext` and a scanned filing that extracts to nothing all become
 * entries in `gaps`: the ownership factor has to be able to say "the House
 * feed was checked and had nothing" separately from "the House feed could not
 * be read", and it cannot do that if a failure takes the screen down.
 */
export async function fetchCongressionalTrades(
  years: number[],
  opts: FetchCongressOptions = {},
): Promise<CongressionalTrades> {
  const { since, refresh, maxDocuments = 400, onProgress } = opts;

  const byTicker = new Map<string, CongressTrade[]>();
  const gaps: CongressGap[] = [];
  let ptrsRead = 0;
  let rowsOutsideUniverse = 0;
  let rowsUnparsed = 0;

  const filings: PtrFiling[] = [];

  for (const year of years) {
    try {
      const index = await fetchDisclosureIndex(year, {
        ...(refresh !== undefined ? { refresh } : {}),
      });
      filings.push(...index.filter((f) => since === undefined || f.filedOn >= since));
    } catch (err) {
      gaps.push({
        docId: `${year}FD`,
        filer: "—",
        reason: `index unavailable: ${err instanceof Error ? err.message : String(err)}`,
        url: INDEX_URL(year),
      });
    }
  }

  // Newest first, so a `maxDocuments` cut loses the oldest filings in the
  // window rather than an arbitrary slice of it.
  filings.sort((a, b) => b.filedOn.localeCompare(a.filedOn));
  const inScope = filings.slice(0, maxDocuments);

  if (filings.length > inScope.length) {
    gaps.push({
      docId: "—",
      filer: "—",
      reason: `${filings.length - inScope.length} PTR(s) beyond the ${maxDocuments}-document cap were not read`,
      url: "https://disclosures-clerk.house.gov/PublicDisclosure",
    });
  }

  for (const [i, filing] of inScope.entries()) {
    onProgress?.(i, inScope.length);

    let text: string;
    try {
      text = await fetchPtrText(filing, { ...(refresh !== undefined ? { refresh } : {}) });
    } catch (err) {
      gaps.push({
        docId: filing.docId,
        filer: filing.filer,
        reason: err instanceof Error ? err.message : String(err),
        url: filing.url,
      });
      continue;
    }

    if (text.trim() === "") {
      // A scan of a paper filing. Legible to a person, empty to the extractor.
      gaps.push({
        docId: filing.docId,
        filer: filing.filer,
        reason: "no extractable text (legacy scanned filing)",
        url: filing.url,
      });
      continue;
    }

    ptrsRead++;

    const parsed = parsePtr(text, {
      docId: filing.docId,
      url: filing.url,
      filedOn: filing.filedOn,
      filer: filing.filer,
      stateDistrict: filing.stateDistrict,
    });

    rowsOutsideUniverse += parsed.rowsOutsideUniverse;
    rowsUnparsed += parsed.rowsUnparsed;

    for (const trade of parsed.trades) {
      const list = byTicker.get(trade.ticker) ?? [];
      list.push(trade);
      byTicker.set(trade.ticker, list);
    }
  }

  onProgress?.(inScope.length, inScope.length);

  for (const list of byTicker.values()) {
    list.sort((a, b) => b.transactionDate.localeCompare(a.transactionDate));
  }

  return {
    byTicker,
    years,
    ptrsInScope: inScope.length,
    ptrsRead,
    rowsOutsideUniverse,
    rowsUnparsed,
    gaps,
  };
}

// ---------------------------------------------------------------------------
// Summarising a window
// ---------------------------------------------------------------------------

export interface CongressSummary {
  windowDays: number;
  /** Trades whose *transaction* date falls inside the window. */
  trades: CongressTrade[];
  purchases: number;
  sales: number;
  /** Purchases less sales, as a count. Never a dollar figure — see trap 2. */
  net: number;
  distinctFilers: number;
  /** Trades in derivatives rather than shares, kept countable separately. */
  optionTrades: number;
  /** PTRs in the window that could not be read, so the gap stays visible. */
  unreadablePtrs: number;
}

/** `[OP]` options, `[OL]` other-securities options as the Clerk codes them. */
const OPTION_ASSET_TYPES = new Set(["OP", "OL"]);

/**
 * Reduces one ticker's disclosed trades to a window summary.
 *
 * The window is applied to the transaction date and nothing else. A PTR filed
 * yesterday reporting a trade from last March is a 17-month-old event; treating
 * its filing date as the event date is the single easiest way to turn this
 * source into noise that looks like a fresh signal.
 *
 * An exchange (`E`) counts as neither a purchase nor a sale: it is a change of
 * instrument, not a change of exposure, and it carries no direction to read.
 */
export function summariseCongressTrades(
  trades: CongressTrade[],
  windowDays: number,
  opts: { now?: Date; unreadablePtrs?: number } = {},
): CongressSummary {
  const now = opts.now ?? new Date();
  const since = new Date(now.getTime() - windowDays * DAY_MS).toISOString().slice(0, 10);

  const inWindow = trades.filter((t) => t.transactionDate >= since);

  const purchases = inWindow.filter((t) => t.direction === "purchase").length;
  const sales = inWindow.filter(
    (t) => t.direction === "sale" || t.direction === "partial-sale",
  ).length;

  return {
    windowDays,
    trades: inWindow,
    purchases,
    sales,
    net: purchases - sales,
    distinctFilers: new Set(inWindow.map((t) => t.filer)).size,
    optionTrades: inWindow.filter(
      (t) => t.assetType !== undefined && OPTION_ASSET_TYPES.has(t.assetType),
    ).length,
    unreadablePtrs: opts.unreadablePtrs ?? 0,
  };
}

/** "Hon. Nancy Pelosi (spouse) purchase 2026-05-29, $1,000,001 - $5,000,000 [OP]". */
export function describeTrade(t: CongressTrade): string {
  const type = t.assetType ? ` [${t.assetType}]` : "";
  return (
    `${t.filer} (${OWNER_LABELS[t.owner]}) ${t.direction} ${t.transactionDate}, ` +
    `${t.amount?.asFiled ?? "amount UNVERIFIED"}${type}`
  );
}
