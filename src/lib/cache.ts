/**
 * Disk cache for EDGAR payloads.
 *
 * companyfacts responses run to several megabytes each (NVDA is ~4 MB), so
 * re-fetching the universe on every run is slow and wasteful of an API that
 * asks callers to be considerate. Entries expire after `ttlHours`; filings
 * appear at most a few times a quarter, so a long TTL is safe.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CACHE_DIR = join(REPO_ROOT, ".cache");

function keyToPath(key: string): string {
  const hash = createHash("sha256").update(key).digest("hex").slice(0, 16);
  // Keep a readable prefix so the cache dir can be eyeballed.
  const slug = key.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 60);
  return join(CACHE_DIR, `${slug}.${hash}.json`);
}

async function isFresh(path: string, ttlHours: number): Promise<boolean> {
  try {
    const info = await stat(path);
    const ageHours = (Date.now() - info.mtimeMs) / 3_600_000;
    return ageHours < ttlHours;
  } catch {
    return false;
  }
}

export interface CacheOptions {
  ttlHours: number;
  /** Bypass the cache and refetch, then overwrite the entry. */
  refresh?: boolean;
}

export async function cached<T>(
  key: string,
  opts: CacheOptions,
  fetcher: () => Promise<T>,
): Promise<{ value: T; hit: boolean }> {
  const path = keyToPath(key);

  if (!opts.refresh && (await isFresh(path, opts.ttlHours))) {
    try {
      return { value: JSON.parse(await readFile(path, "utf8")) as T, hit: true };
    } catch {
      // Corrupt or truncated entry — fall through and refetch.
    }
  }

  const value = await fetcher();
  await mkdir(CACHE_DIR, { recursive: true });
  await writeFile(path, JSON.stringify(value), "utf8");
  return { value, hit: false };
}
