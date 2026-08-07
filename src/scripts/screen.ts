/**
 * `npm run screen` — the screening brief, end to end.
 *
 * Every figure printed carries its source and date. Anything that could not be
 * pulled live is printed as UNVERIFIED with the reason, never estimated.
 *
 * This is research output. It ranks and describes; it does not recommend.
 *
 * Usage:
 *   npm run screen                  # full universe
 *   npm run screen -- NVDA AMD      # specific tickers
 *   npm run screen -- --all         # include companies failing the filters
 *   npm run screen -- --window=90   # widen the insider lookback
 *   npm run screen -- --refresh     # bypass caches
 */

import "dotenv/config";

import { UNIVERSE, CATEGORY_LABELS } from "../config/universe.js";
import { resolveTickers } from "../edgar/tickers.js";
import { cite, isVerified, valueOf } from "../lib/provenance.js";
import {
  applyFilters,
  describe,
  gather,
  sectorMedians,
  INSIDER_WINDOW_DAYS,
  type ScreenedCompany,
} from "../screen/run.js";
import { FACTOR_LABELS, WEIGHTS, type FactorName } from "../screen/score.js";
import { writeVault } from "../vault/write.js";

function money(n: number | undefined, ccy = "USD"): string {
  if (n === undefined) return "UNVERIFIED";
  const abs = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  if (abs >= 1e12) return `${sign}$${(abs / 1e12).toFixed(2)}T`;
  if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(1)}M`;
  return `${sign}${abs.toFixed(2)} ${ccy}`;
}

function pct(n: number | undefined, digits = 1): string {
  return n === undefined ? "UNVERIFIED" : `${n >= 0 ? "" : ""}${(n * 100).toFixed(digits)}%`;
}

function mark(passed: boolean | undefined): string {
  return passed === undefined ? "?" : passed ? "✓" : "✗";
}

function renderCompany(c: ScreenedCompany): void {
  const score = c.score.value;
  const header = `${c.name} (${c.ticker})`;
  console.log(`\n${"═".repeat(78)}`);
  console.log(header);
  console.log(
    `  Composite score: ${score === undefined ? "UNVERIFIED" : score.toFixed(1)}/100` +
      `   ·   scoring coverage ${(c.score.coverage * 100).toFixed(0)}%` +
      `   ·   ${CATEGORY_LABELS[c.entry.category]}`,
  );
  console.log(`${"═".repeat(78)}`);

  console.log(`\n  Thesis    ${c.thesis}`);
  console.log(`  Top risk  ${c.topRisk}`);

  const price = valueOf(c.price);
  const target = valueOf(c.priceTarget);
  const upside = valueOf(c.upsideToTarget);

  console.log(`\n  Price vs intrinsic value`);
  console.log(`    Current price      ${cite(c.price, (v) => money(v, c.currency))}`);
  console.log(`    Consensus target   ${cite(c.priceTarget, (v) => money(v, c.currency))}`);
  console.log(
    `    Implied upside     ${
      upside === undefined ? "UNVERIFIED" : pct(upside)
    }${price !== undefined && target !== undefined ? "" : ""}`,
  );
  console.log(
    `    Note: "intrinsic value" here is the published analyst consensus target,`,
  );
  console.log(`    not a discounted cash flow — a DCF would require estimated inputs.`);

  console.log(`\n  Valuation and cash`);
  console.log(`    Market cap         ${cite(c.marketCap, (v) => money(v))}`);
  console.log(`    P/E (TTM)          ${cite(c.peRatio, (v) => v.toFixed(1))}`);
  console.log(`    TTM EPS            ${cite(c.ttmEps, (v) => v.toFixed(2))}`);
  console.log(
    `    Free cash flow     ${cite(c.fcf, (v) => money(v, c.currency))} (${c.fcfBasis.toUpperCase()} basis)`,
  );
  console.log(`    FCF yield          ${cite(c.fcfYield, (v) => pct(v, 2))}`);

  console.log(`\n  Score breakdown`);
  for (const name of Object.keys(WEIGHTS) as FactorName[]) {
    const factor = c.factors[name];
    const weight = `${(WEIGHTS[name] * 100).toFixed(0)}%`;
    const value = isVerified(factor.score)
      ? `${factor.score.value.toFixed(0).padStart(3)}/100`
      : "UNVERIFIED";
    console.log(`    ${FACTOR_LABELS[name].padEnd(32)} ${weight.padStart(4)}  ${value}`);
    console.log(`      ${factor.detail}`);
    if (!isVerified(factor.score)) {
      console.log(`      reason: ${factor.score.reason}`);
    }
  }

  console.log(`\n  Screening filters`);
  for (const f of c.filters) {
    console.log(`    ${mark(f.passed)} ${f.name.padEnd(40)} ${f.detail}`);
  }

  if (c.strength.caveats.length) {
    console.log(`\n  Caveats`);
    for (const caveat of c.strength.caveats) console.log(`    · ${caveat}`);
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const showAll = args.includes("--all");
  const refresh = args.includes("--refresh");
  const windowArg = args.find((a) => a.startsWith("--window="));
  const insiderWindowDays = windowArg
    ? Number(windowArg.split("=")[1]) || INSIDER_WINDOW_DAYS
    : INSIDER_WINDOW_DAYS;

  const explicit = args.filter((a) => !a.startsWith("--")).map((a) => a.toUpperCase());
  const entries = explicit.length
    ? UNIVERSE.filter((e) => explicit.includes(e.ticker))
    : UNIVERSE;

  if (entries.length === 0) {
    console.error(`No universe entries matched: ${explicit.join(", ")}`);
    process.exitCode = 1;
    return;
  }

  const runAt = new Date().toISOString().replace("T", " ").slice(0, 16);
  console.log(`Stock screen — ${runAt} UTC`);
  console.log(`Universe: ${entries.length} companies · insider window ${insiderWindowDays}d`);
  console.log(`Sources: SEC EDGAR (fundamentals, Form 4, 13D/G), Nasdaq (quote,`);
  console.log(`earnings surprise), TipRanks (analyst consensus and track records).\n`);

  const byTicker = new Map(entries.map((e) => [e.ticker, e]));
  const { resolved, unresolved } = await resolveTickers(entries.map((e) => e.ticker));
  if (unresolved.length) {
    console.warn(`Unresolved tickers: ${unresolved.join(", ")}\n`);
  }

  const companies: ScreenedCompany[] = [];

  for (const company of resolved) {
    const entry = byTicker.get(company.ticker);
    if (!entry) continue;

    try {
      companies.push(
        await gather(company, entry, { refresh, insiderWindowDays }),
      );
      process.stdout.write(".");
    } catch (err) {
      process.stdout.write("x");
      console.error(`\n  ${company.ticker}: ${err instanceof Error ? err.message : err}`);
    }
  }

  console.log("\n");

  // Sector medians need the whole set, so filters run in a second pass.
  const medians = sectorMedians(companies);
  for (const c of companies) {
    c.filters = applyFilters(c, medians);
    const evaluated = c.filters.filter((f) => f.passed !== undefined);
    c.qualifies =
      evaluated.length > 0 && evaluated.every((f) => f.passed === true);
    const described = describe(c);
    c.thesis = described.thesis;
    c.topRisk = described.topRisk;
  }

  const ranked = [...companies].sort(
    (a, b) => (b.score.value ?? -1) - (a.score.value ?? -1),
  );
  const qualifying = ranked.filter((c) => c.qualifies);

  console.log(`── Sector median P/E (computed across this universe) ${"─".repeat(24)}`);
  for (const [sector, median] of [...medians].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${sector.padEnd(32)} ${median.toFixed(1)}`);
  }

  console.log(`\n\n── Ranked watchlist ${"─".repeat(57)}`);
  console.log(
    `${"#".padEnd(4)}${"TICKER".padEnd(8)}${"SCORE".padEnd(8)}${"COV".padEnd(6)}` +
      `${"P/E".padEnd(8)}${"FCF YLD".padEnd(10)}${"UPSIDE".padEnd(9)}${"FILTERS".padEnd(9)}`,
  );

  for (const [i, c] of ranked.entries()) {
    const passed = c.filters.filter((f) => f.passed === true).length;
    const evaluable = c.filters.filter((f) => f.passed !== undefined).length;
    console.log(
      String(i + 1).padEnd(4) +
        c.ticker.padEnd(8) +
        (c.score.value === undefined ? "—" : c.score.value.toFixed(1)).padEnd(8) +
        `${(c.score.coverage * 100).toFixed(0)}%`.padEnd(6) +
        (valueOf(c.peRatio)?.toFixed(1) ?? "—").padEnd(8) +
        (valueOf(c.fcfYield) === undefined
          ? "—"
          : pct(valueOf(c.fcfYield), 2)
        ).padEnd(10) +
        (valueOf(c.upsideToTarget) === undefined
          ? "—"
          : pct(valueOf(c.upsideToTarget), 0)
        ).padEnd(9) +
        `${passed}/${evaluable}`.padEnd(9),
    );
  }

  console.log(`\n\n── Companies passing every evaluable filter ${"─".repeat(33)}`);
  if (qualifying.length === 0) {
    console.log("  None. Filter-by-filter detail is shown per company below.");
  } else {
    for (const c of qualifying) {
      console.log(
        `  ${c.ticker.padEnd(7)} score ${(c.score.value ?? 0).toFixed(1).padStart(5)}  ${c.thesis}`,
      );
    }
  }

  const detailSet = showAll || explicit.length ? ranked : qualifying.length ? qualifying : ranked.slice(0, 5);
  for (const c of detailSet) renderCompany(c);

  // Persist last, so a vault problem cannot cost you the run's output.
  const vaultRoot = process.env.OBSIDIAN_VAULT_PATH?.trim();
  if (vaultRoot && !args.includes("--no-vault")) {
    try {
      const result = await writeVault(vaultRoot, companies, {
        windowDays: insiderWindowDays,
        sectorMedians: medians,
      });

      console.log(`\n\n── Obsidian vault ${"─".repeat(58)}`);
      console.log(`  ${result.companiesWritten} company notes updated in ${vaultRoot}`);
      console.log(`  screen note: ${result.screenNotePath}`);

      if (result.changes.length) {
        console.log(`\n  Changes since the last run:`);
        for (const change of result.changes.slice(0, 25)) console.log(`    ${change}`);
        if (result.changes.length > 25) {
          console.log(`    …and ${result.changes.length - 25} more`);
        }
      } else {
        console.log(`  No changes since the last run.`);
      }
    } catch (err) {
      console.error(
        `\n  Vault write failed: ${err instanceof Error ? err.message : err}`,
      );
      console.error(`  The screen output above is unaffected.`);
    }
  } else if (!vaultRoot) {
    console.log(`\n\n  OBSIDIAN_VAULT_PATH not set — results not persisted.`);
  }

  console.log(`\n\n${"═".repeat(78)}`);
  console.log("Research output only. This is not a recommendation to buy or sell.");
  console.log("Figures marked UNVERIFIED could not be retrieved from a live source");
  console.log("and have not been estimated.");
  console.log(`${"═".repeat(78)}`);
}

await main();
