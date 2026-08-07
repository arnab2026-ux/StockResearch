/**
 * Financial strength and insider activity across the universe.
 *
 * Covers the two screening inputs available without a paid data provider:
 * free cash flow (25% of the composite) and insider buying (30%). Price,
 * earnings surprise, and analyst sentiment need a market data key and are
 * reported as UNVERIFIED until one is configured.
 *
 * Usage:
 *   npm run strength                  # whole universe
 *   npm run strength -- NVDA          # detail for one company
 *   npm run strength -- --no-insider  # skip Form 4 fetches (much faster)
 *   npm run strength -- --window=90   # widen the insider lookback
 */

import "dotenv/config";

import { UNIVERSE, CATEGORY_LABELS, type Category } from "../config/universe.js";
import { fetchCompanyFacts } from "../edgar/companyfacts.js";
import {
  fetchInsiderActivity,
  summariseInsiderActivity,
  type InsiderSummary,
} from "../edgar/insider.js";
import type { NormalizedCompany } from "../edgar/normalize.js";
import { resolveTickers } from "../edgar/tickers.js";
import { cite, isVerified, valueOf } from "../lib/provenance.js";
import { computeRatios, snapshotAt, ttmFreeCashFlow } from "../metrics/fundamentals.js";
import { strengthProfile } from "../metrics/strength.js";

/** The brief specifies a 14-day lookback; `--window N` overrides it. */
const DEFAULT_INSIDER_WINDOW_DAYS = 14;

interface Row {
  ticker: string;
  category: Category;
  name: string;
  company: NormalizedCompany;
  insider: InsiderSummary | undefined;
}

function money(n: number | undefined, ccy = ""): string {
  if (n === undefined) return "—";
  const abs = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  const suffix = ccy ? ` ${ccy}` : "";
  if (abs >= 1e9) return `${sign}${(abs / 1e9).toFixed(2)}B${suffix}`;
  if (abs >= 1e6) return `${sign}${(abs / 1e6).toFixed(1)}M${suffix}`;
  if (abs >= 1e3) return `${sign}${(abs / 1e3).toFixed(0)}K${suffix}`;
  return `${sign}${abs.toFixed(0)}${suffix}`;
}

function pct(n: number | undefined): string {
  return n === undefined ? "—" : `${(n * 100).toFixed(1)}%`;
}

async function detail(row: Row, windowDays: number): Promise<void> {
  const { company } = row;
  const end = (company.annual.revenue ?? []).at(-1)?.end;
  console.log(`\n${row.ticker} — ${company.entityName}`);
  console.log(`${"─".repeat(70)}`);
  console.log(`  CIK ${company.cik} · ${company.taxonomy} · reports in ${company.currency}`);

  if (!end) {
    console.log("  no annual data");
    return;
  }

  const ratios = computeRatios(snapshotAt(company, end));
  const fcf = ttmFreeCashFlow(company);
  const profile = strengthProfile(company);

  console.log(`\n  Free cash flow (${fcf.basis.toUpperCase()})`);
  console.log(`    ${cite(fcf.amount, (v) => money(v, company.currency))}`);
  console.log(`    basis: ${fcf.note}`);

  console.log(`\n  Ratios (FY ending ${end})`);
  for (const [label, value] of [
    ["Gross margin", ratios.grossMargin],
    ["Operating margin", ratios.operatingMargin],
    ["FCF margin", ratios.fcfMargin],
    ["Return on equity", ratios.returnOnEquity],
  ] as const) {
    console.log(`    ${label.padEnd(20)} ${cite(value, (v) => pct(v))}`);
  }
  for (const [label, value] of [
    ["Net debt", ratios.netDebt],
    ["Net debt / EBITDA", ratios.netDebtToEbitda],
    ["Current ratio", ratios.currentRatio],
    ["Interest coverage", ratios.interestCoverage],
  ] as const) {
    const fmt = label === "Net debt" ? (v: number) => money(v, company.currency) : (v: number) => v.toFixed(2);
    console.log(`    ${label.padEnd(20)} ${cite(value, fmt)}`);
  }

  console.log(`\n  Piotroski F-Score: ${profile.fScore.score}/9 (${profile.fScore.available} of 9 signals available)`);
  for (const s of profile.fScore.signals) {
    const mark = s.passed === undefined ? "?" : s.passed ? "✓" : "✗";
    console.log(`    ${mark} ${s.name.padEnd(30)} ${s.detail}`);
  }

  const zone = profile.altman.zone;
  console.log(
    `\n  Altman Z'': ${cite(profile.altman.score, (v) => v.toFixed(2))}` +
      (zone ? `  → ${zone}` : ""),
  );

  if (row.insider) {
    const i = row.insider;
    console.log(`\n  Insider activity (last ${windowDays} days)`);
    console.log(`    open-market buys   ${i.buyCount} by ${i.distinctBuyers} insider(s), ${money(i.buyValue, "USD")}`);
    console.log(`    open-market sells  ${i.sellCount}, ${money(i.sellValue, "USD")}`);
    console.log(`    net                ${money(i.netValue, "USD")}`);
    console.log(`    excluded           ${i.excludedCount} grant/exercise/withholding/gift events`);
    console.log(`    13D/G filings      ${i.majorHolderFilingCount}`);
  }

  if (profile.caveats.length) {
    console.log(`\n  Caveats`);
    for (const c of profile.caveats) console.log(`    · ${c}`);
  }

  console.log(`\n  UNVERIFIED (no data source configured)`);
  console.log(`    Price, market cap, P/E, earnings surprise, analyst sentiment,`);
  console.log(`    intrinsic value — all require a market data provider.`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const skipInsider = args.includes("--no-insider");
  const windowArg = args.find((a) => a.startsWith("--window="));
  const windowDays = windowArg
    ? Number(windowArg.split("=")[1]) || DEFAULT_INSIDER_WINDOW_DAYS
    : DEFAULT_INSIDER_WINDOW_DAYS;
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
  const { resolved } = await resolveTickers(entries.map((e) => e.ticker));

  console.log(
    `Loading ${resolved.length} companies${skipInsider ? "" : ` with Form 4 activity over ${windowDays} days`}…`,
  );

  const rows: Row[] = [];

  for (const company of resolved) {
    try {
      const { company: normalized } = await fetchCompanyFacts(company.cik);
      let insider: InsiderSummary | undefined;

      if (!skipInsider) {
        const activity = await fetchInsiderActivity(company.cik, { windowDays });
        insider = summariseInsiderActivity(activity);
      }

      rows.push({
        ticker: company.ticker,
        category: categoryOf.get(company.ticker) ?? "ai-core",
        name: company.name,
        company: normalized,
        insider,
      });
      process.stdout.write(".");
    } catch (err) {
      process.stdout.write("x");
      console.error(`\n  ${company.ticker}: ${err instanceof Error ? err.message : err}`);
    }
  }

  console.log("\n");

  if (explicit.length && rows.length <= 3) {
    for (const row of rows) await detail(row, windowDays);
    return;
  }

  const byCategory = new Map<Category, Row[]>();
  for (const row of rows) {
    const list = byCategory.get(row.category) ?? [];
    list.push(row);
    byCategory.set(row.category, list);
  }

  for (const [category, list] of byCategory) {
    const label = CATEGORY_LABELS[category];
    console.log(`\n── ${label} ${"─".repeat(Math.max(2, 68 - label.length))}`);
    console.log(
      `${"TICKER".padEnd(7)}${"FCF (TTM)".padEnd(13)}${"BASIS".padEnd(7)}` +
        `${"FCF MGN".padEnd(9)}${"F".padEnd(6)}${"Z''".padEnd(10)}` +
        `${"INSIDER BUY".padEnd(13)}${"13D/G".padEnd(7)}`,
    );

    for (const row of list.sort((a, b) => a.ticker.localeCompare(b.ticker))) {
      const end = (row.company.annual.revenue ?? []).at(-1)?.end;
      const ratios = end ? computeRatios(snapshotAt(row.company, end)) : undefined;
      const fcf = ttmFreeCashFlow(row.company);
      const profile = strengthProfile(row.company);
      const z = profile.altman;

      const zText = isVerified(z.score)
        ? `${z.score.value.toFixed(1)} ${(z.zone ?? "").slice(0, 3)}`
        : "—";

      const buy = row.insider
        ? row.insider.buyCount > 0
          ? `${row.insider.buyCount}× ${money(row.insider.buyValue)}`
          : "—"
        : "n/a";

      console.log(
        row.ticker.padEnd(7) +
          money(valueOf(fcf.amount), row.company.currency).padEnd(13) +
          fcf.basis.toUpperCase().padEnd(7) +
          pct(valueOf(ratios?.fcfMargin)).padEnd(9) +
          `${profile.fScore.score}/${profile.fScore.available}`.padEnd(6) +
          zText.padEnd(10) +
          buy.padEnd(13) +
          String(row.insider?.majorHolderFilingCount ?? "n/a").padEnd(7),
      );
    }
  }

  const withFcf = rows.filter((r) => isVerified(ttmFreeCashFlow(r.company).amount));
  const positiveFcf = withFcf.filter(
    (r) => (valueOf(ttmFreeCashFlow(r.company).amount) ?? 0) > 0,
  );
  const ttmBasis = rows.filter((r) => ttmFreeCashFlow(r.company).basis === "ttm");
  const insiderSignal = rows.filter((r) => r.insider?.hasSignal);

  console.log(`\n\n── Summary ${"─".repeat(60)}`);
  console.log(`  companies              ${rows.length}`);
  console.log(`  FCF available          ${withFcf.length}`);
  console.log(`  FCF positive           ${positiveFcf.length}`);
  console.log(`  true TTM basis         ${ttmBasis.length} (rest fall back to fiscal year)`);
  if (!skipInsider) {
    console.log(`  insider or 13D/G signal ${insiderSignal.length} (window: ${windowDays}d)`);
    for (const r of insiderSignal) {
      const i = r.insider;
      if (!i) continue;
      console.log(
        `    ${r.ticker.padEnd(7)} ${i.buyCount} buy(s) ${money(i.buyValue)}` +
          `, ${i.majorHolderFilingCount} 13D/G`,
      );
    }
  }

  console.log(`\n  UNVERIFIED across all rows: price, market cap, P/E vs sector,`);
  console.log(`  earnings surprise, analyst sentiment, intrinsic value.`);
  console.log(`  These need a market data provider — none configured yet.`);
}

await main();
