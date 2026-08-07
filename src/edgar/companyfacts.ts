/** Fetches and normalizes XBRL companyfacts for one company. */

import { cached } from "../lib/cache.js";
import { NotFoundError, secFetchJson } from "../lib/http.js";
import { normalize, type NormalizedCompany, type NormalizeOptions } from "./normalize.js";
import type { CompanyFacts } from "./types.js";

/** Filings land a handful of times a year; a day is a conservative TTL. */
const TTL_HOURS = 24;

function factsUrl(cik: string): string {
  return `https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`;
}

export interface FetchResult {
  company: NormalizedCompany;
  cacheHit: boolean;
}

export async function fetchCompanyFacts(
  cik: string,
  opts: NormalizeOptions & { refresh?: boolean } = {},
): Promise<FetchResult> {
  const { refresh, ...normalizeOpts } = opts;

  const { value, hit } = await cached<CompanyFacts>(
    `companyfacts_CIK${cik}`,
    { ttlHours: TTL_HOURS, ...(refresh !== undefined ? { refresh } : {}) },
    () => secFetchJson<CompanyFacts>(factsUrl(cik)),
  );

  return { company: normalize(value, cik, normalizeOpts), cacheHit: hit };
}

export { NotFoundError };
