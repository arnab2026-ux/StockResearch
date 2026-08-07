/**
 * Phase 1 ingestion: pull XBRL fundamentals for the whole universe from
 * EDGAR and report coverage.
 *
 * Usage:
 *   npm run ingest              # whole universe, cache-friendly
 *   npm run ingest -- NVDA AMD  # just these tickers
 *   npm run ingest -- --refresh # bypass cache
 */

import "dotenv/config";

import { UNIVERSE, CATEGORY_LABELS, type Category } from "../config/universe.js";
import { CONCEPT_NAMES, type ConceptName } from "../edgar/concepts.js";
import { fetchCompanyFacts, NotFoundError } from "../edgar/companyfacts.js";
import { latest, valueAt } from "../edgar/normalize.js";
import type { NormalizedCompany } from "../edgar/normalize.js";
import { resolveTickers } from "../edgar/tickers.js";

interface Row {
  ticker: string;
  category: Category;
  name: string;
  company: NormalizedCompany;
  cacheHit: boolean;
}

function fmtMoney(n: number | undefined): string {
  if (n === undefined) return "—";
  const abs = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  if (abs >= 1e12) return `${sign}${(abs / 1e12).toFixed(2)}T`;
  if (abs >= 1e9) return `${sign}${(abs / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${sign}${(abs / 1e6).toFixed(1)}M`;
  return `${sign}${abs.toFixed(0)}`;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const refresh = args.includes("--refresh");
  const explicit = args.filter((a) => !a.startsWith("--")).map((a) => a.toUpperCase());

  const entries = explicit.length
    ? UNIVERSE.filter((e) => explicit.includes(e.ticker))
    : UNIVERSE;

  if (entries.length === 0) {
    console.error(`No universe entries matched: ${explicit.join(", ")}`);
    process.exitCode = 1;
    return;
  }

  const categoryOf = new Map(entries.map((e) => [e.ticker, e.category]));

  console.log(`Resolving ${entries.length} tickers against the SEC ticker file…`);
  const { resolved, unresolved } = await resolveTickers(entries.map((e) => e.ticker));

  if (unresolved.length) {
    console.warn(`\n⚠  Unresolved (not in SEC ticker file): ${unresolved.join(", ")}`);
  }

  const rows: Row[] = [];
  const failures: { ticker: string; reason: string }[] = [];

  console.log(`\nFetching companyfacts for ${resolved.length} companies…`);

  for (const company of resolved) {
    try {
      const { company: normalized, cacheHit } = await fetchCompanyFacts(company.cik, {
        refresh,
      });
      rows.push({
        ticker: company.ticker,
        category: categoryOf.get(company.ticker) ?? "ai-core",
        name: company.name,
        company: normalized,
        cacheHit,
      });
      process.stdout.write(cacheHit ? "." : "+");
    } catch (err) {
      const reason =
        err instanceof NotFoundError
          ? "no XBRL companyfacts (likely a non-US filer or no financial data)"
          : err instanceof Error
            ? err.message
            : String(err);
      failures.push({ ticker: company.ticker, reason });
      process.stdout.write("x");
    }
  }

  console.log("\n");

  const byCategory = new Map<Category, Row[]>();
  for (const row of rows) {
    const list = byCategory.get(row.category) ?? [];
    list.push(row);
    byCategory.set(row.category, list);
  }

  for (const [category, list] of byCategory) {
    console.log(`\n── ${CATEGORY_LABELS[category]} ${"─".repeat(64 - CATEGORY_LABELS[category].length)}`);
    console.log(
      `${"TICKER".padEnd(7)}${"CCY".padEnd(5)}${"FY END".padEnd(12)}${"REVENUE".padEnd(10)}` +
        `${"NET INC".padEnd(10)}${"OCF".padEnd(10)}${"CAPEX".padEnd(10)}${"MISSING".padEnd(8)}`,
    );

    for (const row of list.sort((a, b) => a.ticker.localeCompare(b.ticker))) {
      // Anchor every column to the latest fiscal year that has revenue, so
      // the row describes one period rather than each concept's own latest.
      const rev = latest(row.company, "revenue");
      const end = rev?.end;

      const at = (name: Parameters<typeof valueAt>[1]): number | undefined =>
        end ? valueAt(row.company, name, end)?.value : undefined;

      console.log(
        row.ticker.padEnd(7) +
          row.company.currency.padEnd(5) +
          (end ?? "—").padEnd(12) +
          fmtMoney(rev?.value).padEnd(10) +
          fmtMoney(at("netIncome")).padEnd(10) +
          fmtMoney(at("operatingCashFlow")).padEnd(10) +
          fmtMoney(at("capex")).padEnd(10) +
          String(row.company.missing.length).padEnd(8),
      );
    }
  }

  console.log(`\n\n── Summary ${"─".repeat(41)}`);
  console.log(`  ingested   ${rows.length}/${entries.length}`);
  console.log(`  cache hits ${rows.filter((r) => r.cacheHit).length}`);

  if (failures.length) {
    console.log(`\n  failures:`);
    for (const f of failures) console.log(`    ${f.ticker.padEnd(7)} ${f.reason}`);
  }

  // Per-concept coverage. A concept missing for a handful of companies is a
  // reporting quirk; one missing broadly means the tag chain is wrong, and
  // any metric depending on it degrades silently. Always show the full table.
  const missingCounts = new Map<ConceptName, number>();
  for (const name of CONCEPT_NAMES) missingCounts.set(name, 0);
  for (const row of rows) {
    for (const m of row.company.missing) {
      missingCounts.set(m, (missingCounts.get(m) ?? 0) + 1);
    }
  }

  console.log(`\n── Concept coverage ${"─".repeat(33)}`);
  const sorted = [...missingCounts.entries()].sort((a, b) => b[1] - a[1]);
  for (const [concept, missing] of sorted) {
    const have = rows.length - missing;
    const pct = Math.round((have / rows.length) * 100);
    const flag = pct < 70 ? "  ← check tag chain" : "";
    const bar = "█".repeat(Math.round(pct / 5)).padEnd(20, "·");
    console.log(`  ${concept.padEnd(24)} ${bar} ${String(pct).padStart(3)}%${flag}`);
  }
}

await main();
