/**
 * Nasdaq's public JSON endpoints — price, market cap, sector, and the
 * earnings surprise history that the screening brief's 25% factor needs.
 *
 * The surprise endpoint is the valuable one: it returns actual EPS beside the
 * consensus forecast for the last four quarters. Consensus estimates are
 * normally proprietary (IBES, Zacks, FactSet), so having them free and
 * already paired with actuals removes the main reason this factor would
 * otherwise be UNVERIFIED.
 */

import { fetchJson, parseLooseNumber, webSource } from "../lib/web.js";
import { sourced, unverified, type Sourced } from "../lib/provenance.js";

const BASE = "https://api.nasdaq.com/api";

/** Nasdaq rejects requests without a matching Referer on some paths. */
const HEADERS = { Referer: "https://www.nasdaq.com/" };

interface NasdaqEnvelope<T> {
  data: T | null;
  message: string | null;
  status: { rCode: number; bCodeMessage: unknown };
}

async function get<T>(path: string, ttlHours: number, refresh?: boolean): Promise<T> {
  const url = `${BASE}${path}`;
  const body = await fetchJson<NasdaqEnvelope<T>>(url, {
    ttlHours,
    headers: HEADERS,
    ...(refresh !== undefined ? { refresh } : {}),
  });

  if (!body.data) {
    throw new Error(body.message ?? `Nasdaq returned no data for ${path}`);
  }
  return body.data;
}

function nasdaqUrl(path: string): string {
  return `${BASE}${path}`;
}

// ---------------------------------------------------------------------------
// Quote and summary
// ---------------------------------------------------------------------------

interface QuoteInfo {
  symbol: string;
  companyName: string;
  primaryData: {
    lastSalePrice: string;
    netChange: string;
    percentageChange: string;
    lastTradeTimestamp: string;
    isRealTime: boolean;
  };
  marketStatus: string;
}

interface SummaryField {
  label: string;
  value: string;
}

interface SummaryData {
  summaryData: Record<string, SummaryField> | null;
}

export interface NasdaqQuote {
  price: Sourced<number>;
  marketCap: Sourced<number>;
  sector: Sourced<string>;
  industry: Sourced<string>;
  /** Consensus one-year analyst price target. */
  oneYearTarget: Sourced<number>;
  companyName: string | undefined;
}

/** Quotes move intraday; a few hours keeps a weekly screen internally consistent. */
const QUOTE_TTL_HOURS = 4;
const SUMMARY_TTL_HOURS = 12;

export async function fetchQuote(ticker: string, refresh?: boolean): Promise<NasdaqQuote> {
  const infoPath = `/quote/${ticker}/info?assetclass=stocks`;
  const summaryPath = `/quote/${ticker}/summary?assetclass=stocks`;

  const [info, summary] = await Promise.all([
    get<QuoteInfo>(infoPath, QUOTE_TTL_HOURS, refresh).catch(() => undefined),
    get<SummaryData>(summaryPath, SUMMARY_TTL_HOURS, refresh).catch(() => undefined),
  ]);

  const price = parseLooseNumber(info?.primaryData?.lastSalePrice);
  const fields = summary?.summaryData ?? undefined;

  const field = (key: string): string | undefined => fields?.[key]?.value;

  const marketCap = parseLooseNumber(field("MarketCap"));
  const target = parseLooseNumber(field("OneYrTarget"));
  const sector = field("Sector");
  const industry = field("Industry");

  const quoteSrc = webSource("Nasdaq quote", nasdaqUrl(infoPath));
  const summarySrc = webSource("Nasdaq summary", nasdaqUrl(summaryPath));

  return {
    companyName: info?.companyName,
    price:
      price !== undefined
        ? sourced(price, quoteSrc)
        : unverified("Nasdaq quote did not return a last sale price"),
    // A zero market cap is Nasdaq's placeholder for "not published", not a
    // company worth nothing, so it must not pass the >$1000M filter.
    marketCap:
      marketCap !== undefined && marketCap > 0
        ? sourced(marketCap, summarySrc)
        : unverified("Nasdaq summary did not return a market cap"),
    sector: sector ? sourced(sector, summarySrc) : unverified("sector not published"),
    industry: industry
      ? sourced(industry, summarySrc)
      : unverified("industry not published"),
    oneYearTarget:
      target !== undefined
        ? sourced(target, summarySrc)
        : unverified("no consensus price target published"),
  };
}

// ---------------------------------------------------------------------------
// Earnings surprise
// ---------------------------------------------------------------------------

interface SurpriseRow {
  fiscalQtrEnd: string;
  dateReported: string;
  eps: number | string;
  consensusForecast: string;
  percentageSurprise: string;
}

interface SurpriseData {
  symbol: string;
  earningsSurpriseTable: { rows: SurpriseRow[] } | null;
}

export interface EarningsSurprise {
  fiscalQuarterEnd: string;
  /** ISO date the result was reported. */
  reportedOn: string;
  actualEps: number;
  consensusEps: number;
  /** Percent difference, as published rather than recomputed. */
  surprisePercent: number;
}

const SURPRISE_TTL_HOURS = 24;

/** "7/30/2026" to "2026-07-30". */
function toIsoDate(raw: string): string | undefined {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(raw.trim());
  if (!m) return undefined;
  const [, month, day, year] = m;
  if (!month || !day || !year) return undefined;
  return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
}

export async function fetchEarningsSurprises(
  ticker: string,
  refresh?: boolean,
): Promise<Sourced<EarningsSurprise[]>> {
  const path = `/company/${ticker}/earnings-surprise`;
  const data = await get<SurpriseData>(path, SURPRISE_TTL_HOURS, refresh);
  const rows = data.earningsSurpriseTable?.rows ?? [];

  const parsed: EarningsSurprise[] = [];

  for (const row of rows) {
    const actual = parseLooseNumber(row.eps);
    const consensus = parseLooseNumber(row.consensusForecast);
    const surprise = parseLooseNumber(row.percentageSurprise);
    const reportedOn = toIsoDate(row.dateReported);

    if (actual === undefined || consensus === undefined || !reportedOn) continue;

    parsed.push({
      fiscalQuarterEnd: row.fiscalQtrEnd,
      reportedOn,
      actualEps: actual,
      consensusEps: consensus,
      // Recompute only when Nasdaq omits it, and never when consensus is zero.
      surprisePercent:
        surprise ??
        (consensus !== 0 ? ((actual - consensus) / Math.abs(consensus)) * 100 : 0),
    });
  }

  if (parsed.length === 0) {
    return unverified("Nasdaq published no earnings surprise history");
  }

  // Newest first, so "last two quarters" is the head of the list.
  parsed.sort((a, b) => b.reportedOn.localeCompare(a.reportedOn));

  const newest = parsed[0]?.reportedOn;
  return sourced(parsed, webSource("Nasdaq earnings surprise", nasdaqUrl(path), newest));
}

// ---------------------------------------------------------------------------
// Analyst ratings
// ---------------------------------------------------------------------------

interface RatingsData {
  symbol: string;
  meanRatingType: string | null;
  ratingsSummary: string | null;
  upgradesDowngrades: unknown[];
  brokerNames: string[];
}

export interface NasdaqRatings {
  /** Consensus label, e.g. Buy, Hold. */
  consensus: Sourced<string>;
  analystCount: Sourced<number>;
}

const RATINGS_TTL_HOURS = 24;

export async function fetchRatings(
  ticker: string,
  refresh?: boolean,
): Promise<NasdaqRatings> {
  const path = `/analyst/${ticker}/ratings`;
  const data = await get<RatingsData>(path, RATINGS_TTL_HOURS, refresh);
  const src = webSource("Nasdaq analyst ratings", nasdaqUrl(path));

  // "Based on 29 analysts offering recommendations for 'AAPL'."
  const countMatch = /(\d+)\s+analysts?/i.exec(data.ratingsSummary ?? "");
  const count = countMatch?.[1] ? Number(countMatch[1]) : undefined;

  return {
    consensus: data.meanRatingType
      ? sourced(data.meanRatingType, src)
      : unverified("Nasdaq published no consensus rating"),
    analystCount:
      count !== undefined && count > 0
        ? sourced(count, src)
        : unverified("Nasdaq published no analyst count"),
  };
}
