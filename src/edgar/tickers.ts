/** Ticker → CIK resolution against the SEC's canonical ticker file. */

import { cached } from "../lib/cache.js";
import { secFetchJson } from "../lib/http.js";
import type { TickerRecord } from "./types.js";
import { padCik } from "./types.js";

const TICKER_URL = "https://www.sec.gov/files/company_tickers.json";

/** The file changes rarely; a week is plenty. */
const TTL_HOURS = 24 * 7;

export interface Company {
  ticker: string;
  cik: string;
  name: string;
}

let memo: Map<string, Company> | undefined;

export async function tickerMap(refresh = false): Promise<Map<string, Company>> {
  if (memo && !refresh) return memo;

  const { value } = await cached<Record<string, TickerRecord>>(
    "company_tickers",
    { ttlHours: TTL_HOURS, refresh },
    () => secFetchJson<Record<string, TickerRecord>>(TICKER_URL),
  );

  const map = new Map<string, Company>();
  for (const record of Object.values(value)) {
    map.set(record.ticker.toUpperCase(), {
      ticker: record.ticker.toUpperCase(),
      cik: padCik(record.cik_str),
      name: record.title,
    });
  }

  memo = map;
  return map;
}

export interface ResolveResult {
  resolved: Company[];
  /** Tickers absent from the SEC file — typos, delistings, or non-filers. */
  unresolved: string[];
}

export async function resolveTickers(tickers: readonly string[]): Promise<ResolveResult> {
  const map = await tickerMap();
  const resolved: Company[] = [];
  const unresolved: string[] = [];

  for (const t of tickers) {
    const hit = map.get(t.toUpperCase());
    if (hit) resolved.push(hit);
    else unresolved.push(t);
  }

  return { resolved, unresolved };
}
