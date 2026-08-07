/**
 * HTTP client for public market-data endpoints outside EDGAR.
 *
 * These are undocumented JSON endpoints backing public web pages, not
 * contracted APIs. Two consequences shape this module:
 *
 * - They can change or disappear without notice, so every failure degrades to
 *   `Unverified` rather than throwing. A missing analyst rating must never
 *   take down a screen that has good fundamentals data.
 * - Unlike EDGAR, these sites' terms restrict automated access. Requests are
 *   therefore rate-limited well below anything burdensome and cached hard, so
 *   a weekly screen makes roughly one request per source per ticker per day.
 */

import { cached } from "./cache.js";
import { today, unverified, type Sourced, type Source } from "./provenance.js";

/** Deliberately conservative: one request per second per host. */
const MIN_INTERVAL_MS = 1000;

const TIMEOUT_MS = 25_000;

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const queues = new Map<string, Promise<unknown>>();
const lastRequestAt = new Map<string, number>();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Serialises per host so one slow source cannot stall the others. */
async function throttleHost<T>(host: string, fn: () => Promise<T>): Promise<T> {
  const previous = queues.get(host) ?? Promise.resolve();

  const run = previous.then(async () => {
    const wait = (lastRequestAt.get(host) ?? 0) + MIN_INTERVAL_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastRequestAt.set(host, Date.now());
    return fn();
  });

  queues.set(
    host,
    run.catch(() => undefined),
  );
  return run;
}

export class WebFetchError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "WebFetchError";
  }
}

export interface WebFetchOptions {
  /** Cache lifetime. Quotes want hours; ratings and surprises want a day. */
  ttlHours: number;
  refresh?: boolean;
  /** Extra headers, e.g. a Referer some endpoints require. */
  headers?: Record<string, string>;
  cacheKey?: string;
}

export async function fetchJson<T>(url: string, opts: WebFetchOptions): Promise<T> {
  const host = new URL(url).host;

  const { value } = await cached<T>(
    opts.cacheKey ?? url,
    { ttlHours: opts.ttlHours, ...(opts.refresh !== undefined ? { refresh: opts.refresh } : {}) },
    () =>
      throttleHost(host, async () => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

        try {
          const res = await fetch(url, {
            signal: controller.signal,
            headers: {
              "User-Agent": BROWSER_UA,
              Accept: "application/json, text/plain, */*",
              "Accept-Language": "en-US,en;q=0.9",
              ...opts.headers,
            },
          });

          if (!res.ok) {
            throw new WebFetchError(`HTTP ${res.status} for ${url}`, res.status);
          }

          return (await res.json()) as T;
        } finally {
          clearTimeout(timer);
        }
      }),
  );

  return value;
}

/**
 * Runs a provider call and converts any failure into an Unverified value.
 *
 * This is the boundary where an unreliable source stops being able to break
 * the screen: the reason is preserved and printed beside the figure, so a
 * blank cell always explains itself.
 */
export async function attempt<T>(
  label: string,
  fn: () => Promise<Sourced<T>>,
): Promise<Sourced<T>> {
  try {
    return await fn();
  } catch (err) {
    const detail =
      err instanceof WebFetchError
        ? err.message
        : err instanceof Error
          ? err.message
          : String(err);
    return unverified(`${label} unavailable: ${detail}`);
  }
}

export function webSource(name: string, url: string, asOf?: string): Source {
  return { name, url, asOf: asOf ?? today(), retrievedAt: today() };
}

/** Parses "$312.83", "4,564,621,678,600", "1.6" into a number. */
export function parseLooseNumber(raw: unknown): number | undefined {
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : undefined;
  if (typeof raw !== "string") return undefined;

  const cleaned = raw.replace(/[$,%\s]/g, "").replace(/,/g, "");
  if (cleaned === "" || cleaned === "N/A" || cleaned === "--") return undefined;

  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : undefined;
}
