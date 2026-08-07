/**
 * Rate-limited HTTP client for SEC EDGAR.
 *
 * The SEC requires a User-Agent carrying real contact information and blocks
 * clients that exceed ~10 requests/second. Both are enforced here rather than
 * left to callers: a single un-throttled loop over the universe is enough to
 * get an IP banned.
 *
 * See https://www.sec.gov/os/webmaster-faq#developers
 */

/** ~8 req/sec, comfortably inside the SEC's 10/sec ceiling. */
const MIN_INTERVAL_MS = 125;

const MAX_RETRIES = 3;

let queue: Promise<unknown> = Promise.resolve();
let lastRequestAt = 0;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function secUserAgent(): string {
  const ua = process.env.SEC_USER_AGENT?.trim();
  if (!ua) {
    throw new Error(
      "SEC_USER_AGENT is not set. The SEC requires a User-Agent with contact " +
        'info, e.g. SEC_USER_AGENT="StockResearch you@example.com". ' +
        "Add it to .env — see .env.example.",
    );
  }
  return ua;
}

/**
 * Serialises every request through one queue so the rate limit holds no matter
 * how many callers run concurrently.
 */
async function throttle<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(async () => {
    const wait = lastRequestAt + MIN_INTERVAL_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastRequestAt = Date.now();
    return fn();
  });
  // Keep the chain alive even if this link rejects.
  queue = run.catch(() => undefined);
  return run;
}

export async function secFetchJson<T>(url: string): Promise<T> {
  return throttle(async () => {
    let lastError: unknown;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        const res = await fetch(url, {
          headers: {
            "User-Agent": secUserAgent(),
            "Accept-Encoding": "gzip, deflate",
            Accept: "application/json",
          },
        });

        if (res.status === 404) {
          throw new NotFoundError(url);
        }

        // 403 from EDGAR almost always means the User-Agent was rejected, and
        // retrying with the same header will not help.
        if (res.status === 403) {
          throw new Error(
            `SEC returned 403 for ${url}. This usually means SEC_USER_AGENT is ` +
              "missing contact details or the IP is rate-limited.",
          );
        }

        if (res.status === 429 || res.status >= 500) {
          throw new RetryableError(`HTTP ${res.status} for ${url}`);
        }

        if (!res.ok) {
          throw new Error(`HTTP ${res.status} for ${url}`);
        }

        return (await res.json()) as T;
      } catch (err) {
        lastError = err;
        if (err instanceof NotFoundError) throw err;

        const retryable = err instanceof RetryableError || err instanceof TypeError;
        if (!retryable || attempt === MAX_RETRIES) throw err;

        await sleep(500 * 2 ** (attempt - 1));
      }
    }

    throw lastError;
  });
}

export class NotFoundError extends Error {
  constructor(url: string) {
    super(`Not found: ${url}`);
    this.name = "NotFoundError";
  }
}

class RetryableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RetryableError";
  }
}
