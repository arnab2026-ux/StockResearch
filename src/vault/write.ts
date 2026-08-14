/**
 * Persists screen results into an Obsidian vault as plain markdown.
 *
 * Written directly to disk rather than through the Local REST API plugin: a
 * vault is just a folder of markdown files, Obsidian picks up external changes
 * automatically, and a direct write needs no plugin, no API key, and no
 * running application — which matters when the screen runs on a schedule.
 *
 * The vault is also what makes change detection possible. Score movement,
 * consensus shifts and new 13D/G positions are all differences against the
 * previous run, and there is nowhere else to hold that baseline.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { isVerified, valueOf } from "../lib/provenance.js";
import { OWNER_LABELS } from "../providers/houseDisclosures.js";
import type { ScreenedCompany } from "../screen/run.js";
import { FACTOR_LABELS, WEIGHTS, type FactorName } from "../screen/score.js";
import {
  appendToSection,
  ensureSection,
  getSectionLines,
  parseNote,
  serializeNote,
} from "./markdown.js";

export const COMPANIES_DIR = "10-Companies";
export const SCREENS_DIR = "20-Screens";

const THESIS_PLACEHOLDER =
  "_Your analysis goes here. The screen never edits this section._";

export interface VaultWriteResult {
  companiesWritten: number;
  screenNotePath: string;
  changes: string[];
}

function fixed(n: number | undefined, digits: number): string {
  return n === undefined ? "" : n.toFixed(digits);
}

/** Frontmatter is machine-owned; this rebuilds it from scratch each run. */
function buildFrontmatter(
  c: ScreenedCompany,
  prior: Map<string, string>,
  runDate: string,
): Map<string, string> {
  const fm = new Map<string, string>();
  const priorScore = prior.get("score");

  fm.set("ticker", c.ticker);
  fm.set("name", c.name);
  fm.set("category", c.entry.category);
  fm.set("exchange", c.entry.exchange);
  fm.set("currency", c.currency);
  // Preserved rather than set: status is the user's to change.
  fm.set("status", prior.get("status") ?? "watchlist");
  fm.set("last_screened", runDate);

  fm.set("score", c.score.value === undefined ? "" : c.score.value.toFixed(1));
  if (priorScore) fm.set("score_prev", priorScore);
  fm.set("coverage", c.score.coverage.toFixed(2));

  fm.set("price", fixed(valueOf(c.price), 2));
  fm.set("market_cap", fixed(valueOf(c.marketCap), 0));
  fm.set("pe", fixed(valueOf(c.peRatio), 1));
  fm.set("peg", fixed(valueOf(c.peg), 2));
  fm.set("peg_growth", fixed(valueOf(c.epsGrowth)?.percentPerYear, 1));
  fm.set("fcf", fixed(valueOf(c.fcf), 0));
  fm.set("fcf_basis", c.fcfBasis);
  fm.set("fcf_yield", fixed(valueOf(c.fcfYield), 4));
  fm.set("price_target", fixed(valueOf(c.priceTarget), 2));
  fm.set("upside", fixed(valueOf(c.upsideToTarget), 4));

  if (c.insider) {
    fm.set("insider_net_usd", c.insider.netValue.toFixed(0));
    fm.set("holder_net_pp", c.insider.netHolderPercentChange.toFixed(2));
    fm.set("ownership_window_days", String(c.insider.windowDays));
  }

  // Counts only. The House discloses a dollar bracket, not a value, and a
  // frontmatter field holding a number would be read as one.
  if (c.congress) {
    fm.set("congress_buys", String(c.congress.purchases));
    fm.set("congress_sells", String(c.congress.sales));
    fm.set("congress_net", String(c.congress.net));
    fm.set("congress_filers", String(c.congress.distinctFilers));
    fm.set("congress_option_trades", String(c.congress.optionTrades));
    // Coverage, not a finding. Without it a zero above is indistinguishable
    // from "nobody could read the filings".
    fm.set("congress_unreadable_ptrs", String(c.congress.unreadablePtrs));
  }

  fm.set("f_score", `${c.strength.fScore.score}/${c.strength.fScore.available}`);
  if (c.strength.altman.zone) fm.set("altman_zone", c.strength.altman.zone);

  const evaluable = c.filters.filter((f) => f.passed !== undefined);
  fm.set("filters_passed", String(evaluable.filter((f) => f.passed).length));
  fm.set("filters_evaluable", String(evaluable.length));
  fm.set("qualifies", String(c.qualifies));

  fm.set("tags", "equity, us-screen");
  return fm;
}

/**
 * Events worth recording: things that changed, not the current state.
 *
 * State already lives in frontmatter, so repeating it in the log would make
 * the log unreadable within a couple of months.
 */
function buildEvents(
  c: ScreenedCompany,
  prior: Map<string, string>,
  runDate: string,
): string[] {
  const events: string[] = [];
  const priorScore = Number(prior.get("score"));
  const score = c.score.value;

  if (score !== undefined && Number.isFinite(priorScore)) {
    const delta = score - priorScore;
    if (Math.abs(delta) >= 1) {
      events.push(
        `- ${runDate} — Score ${priorScore.toFixed(1)} → ${score.toFixed(1)} ` +
          `(${delta >= 0 ? "+" : ""}${delta.toFixed(1)})`,
      );
    }
  } else if (score !== undefined && !prior.has("score")) {
    events.push(`- ${runDate} — First screened, score ${score.toFixed(1)}`);
  }

  if (c.insider && c.insider.netHolderPercentChange !== 0) {
    const pp = c.insider.netHolderPercentChange;
    events.push(
      `- ${runDate} — 5%+ holders net ${pp >= 0 ? "+" : ""}${pp.toFixed(2)}pp ` +
        `over ${c.insider.windowDays}d (${c.insider.holdersIncreasing} up, ${c.insider.holdersDecreasing} down)`,
    );
  }

  if (c.insider && c.insider.netValue !== 0) {
    events.push(
      `- ${runDate} — Insiders net ${c.insider.netValue >= 0 ? "+" : "-"}$${Math.abs(
        Math.round(c.insider.netValue),
      ).toLocaleString("en-US")} over ${c.insider.windowDays}d`,
    );
  }

  // Dated by the transaction, not by the filing or the run, so a trade that
  // stays in the window logs once and re-derives to the identical line on
  // every later run — which is what the event log's deduplication keys on.
  // Using the filing date here would also date a March 2025 trade to August
  // 2026, the same error that would wreck the window.
  for (const t of c.congress?.trades ?? []) {
    const assetType = t.assetType ? ` [${t.assetType}]` : "";
    events.push(
      `- ${t.transactionDate} — Congress: ${t.filer} (${OWNER_LABELS[t.owner]}) ` +
        `${t.direction}, ${t.amount?.asFiled ?? "amount UNVERIFIED"}${assetType} ` +
        `(disclosed ${t.filedOn})`,
    );
  }

  // Earnings are dated by their own report date, so the entry is stable
  // across runs and deduplicates naturally.
  if (isVerified(c.surprises)) {
    const latest = c.surprises.value[0];
    if (latest) {
      events.push(
        `- ${latest.reportedOn} — ${latest.fiscalQuarterEnd} EPS ${latest.actualEps} ` +
          `vs ${latest.consensusEps} consensus (${latest.surprisePercent >= 0 ? "+" : ""}${latest.surprisePercent.toFixed(1)}%)`,
      );
    }
  }

  const priorQualifies = prior.get("qualifies");
  if (priorQualifies !== undefined && String(c.qualifies) !== priorQualifies) {
    events.push(
      `- ${runDate} — ${c.qualifies ? "Now passes" : "No longer passes"} every evaluable filter`,
    );
  }

  return events;
}

/** Table cells cannot contain a bare pipe without ending the column. */
function cell(text: string): string {
  return text.replace(/\|/g, "\\|");
}

function factorTable(c: ScreenedCompany): string {
  const rows = (Object.keys(WEIGHTS) as FactorName[]).map((name) => {
    const f = c.factors[name];
    const score = isVerified(f.score) ? f.score.value.toFixed(0) : "UNVERIFIED";
    // An UNVERIFIED score has to carry its reason here as it does on the
    // console. PEG is the common case: its basis line names a perfectly good
    // growth rate even when what failed was the trailing P/E, so the cell
    // reads as though the factor should have scored.
    const basis = isVerified(f.score)
      ? f.detail
      : `${f.detail} — ${f.score.reason}`;
    return `| ${FACTOR_LABELS[name]} | ${(WEIGHTS[name] * 100).toFixed(0)}% | ${score} | ${cell(basis)} |`;
  });

  return [
    "| Factor | Weight | Score | Basis |",
    "| --- | --- | --- | --- |",
    ...rows,
  ].join("\n");
}

function filterTable(c: ScreenedCompany): string {
  const rows = c.filters.map(
    (f) =>
      `| ${f.passed === undefined ? "?" : f.passed ? "pass" : "fail"} | ${f.name} | ${f.detail} |`,
  );
  return ["| | Filter | Detail |", "| --- | --- | --- |", ...rows].join("\n");
}

/**
 * States how much of the congressional window was legible.
 *
 * The event log records what was found; nothing there records what could not
 * be looked at. Roughly one PTR in eight is a scan of a paper filing that
 * extracts to nothing, and those filings are not randomly distributed — a
 * member who always files on paper is invisible to this factor on every run.
 * A reader who sees no congressional events has to be able to tell that from
 * a reader whose window was fully read.
 */
function congressCoverageLines(c: ScreenedCompany): string[] {
  if (!c.congress) return [];

  const found =
    c.congress.trades.length === 0
      ? "No congressional disclosures with a transaction date in this window."
      : `${c.congress.trades.length} congressional disclosure(s) in this window ` +
        `(${c.congress.purchases} buy / ${c.congress.sales} sell` +
        (c.congress.optionTrades > 0
          ? `, ${c.congress.optionTrades} in options rather than shares`
          : "") +
        ").";

  const coverage =
    c.congress.unreadablePtrs > 0
      ? ` **${c.congress.unreadablePtrs} PTR(s) in the window could not be read** ` +
        "(scans of paper filings), so this is a floor, not a count."
      : "";

  return [`**Congressional disclosures:** ${found}${coverage}`, ""];
}

async function readIfExists(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
}

export async function writeCompanyNote(
  vaultRoot: string,
  c: ScreenedCompany,
  runDate: string,
): Promise<{ path: string; changes: string[] }> {
  const dir = join(vaultRoot, COMPANIES_DIR);
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${c.ticker}.md`);

  const existing = await readIfExists(path);
  const parsed = existing
    ? parseNote(existing)
    : { frontmatter: new Map<string, string>(), body: "", hadFrontmatter: false };

  const events = buildEvents(c, parsed.frontmatter, runDate);
  const frontmatter = buildFrontmatter(c, parsed.frontmatter, runDate);

  let body = parsed.body;
  body = ensureSection(body, "Thesis", THESIS_PLACEHOLDER);
  body = ensureSection(body, "Event log", "");

  // Report what was actually appended, not what was offered. Re-running the
  // same day re-derives every event, and calling those "changes" would make
  // the console output meaningless.
  const alreadyLogged = new Set(
    getSectionLines(body, "Event log").map((l) => l.trim()),
  );
  const appended = events.filter((e) => !alreadyLogged.has(e.trim()));

  body = appendToSection(body, "Event log", events);

  // The snapshot is machine-owned, so it is replaced wholesale each run
  // rather than appended to.
  const snapshot = [
    `_Last run ${runDate}._`,
    "",
    factorTable(c),
    "",
    filterTable(c),
    "",
    ...congressCoverageLines(c),
    `**Thesis (generated):** ${c.thesis}`,
    "",
    `**Top risk (generated):** ${c.topRisk}`,
  ].join("\n");

  body = replaceSection(body, "Latest screen", snapshot);

  await writeFile(path, serializeNote(frontmatter, body), "utf8");
  return { path, changes: appended };
}

/** Replaces a machine-owned section wholesale, creating it when absent. */
function replaceSection(body: string, heading: string, content: string): string {
  const lines = body.split(/\r?\n/);
  let start = -1;
  let end = lines.length;
  let fenced = false;

  for (const [i, line] of lines.entries()) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    if (fenced) continue;
    const m = /^##\s+(.+?)\s*$/.exec(line);
    if (!m) continue;

    if (start >= 0) {
      end = i;
      break;
    }
    if ((m[1] ?? "").toLowerCase() === heading.toLowerCase()) start = i;
  }

  if (start < 0) {
    const trimmed = body.replace(/\s+$/, "");
    return `${trimmed}${trimmed ? "\n\n" : ""}## ${heading}\n\n${content}\n`;
  }

  return [
    ...lines.slice(0, start + 1),
    "",
    content,
    "",
    ...lines.slice(end),
  ].join("\n");
}

export async function writeScreenNote(
  vaultRoot: string,
  companies: ScreenedCompany[],
  runDate: string,
  meta: { windowDays: number; sectorMedians: Map<string, number> },
): Promise<string> {
  const dir = join(vaultRoot, SCREENS_DIR);
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${runDate}-screen.md`);

  const ranked = [...companies].sort(
    (a, b) => (b.score.value ?? -1) - (a.score.value ?? -1),
  );
  const qualifying = ranked.filter((c) => c.qualifies);

  // Run-level, so any company that saw the House pass carries the same number.
  const unreadable = companies.reduce(
    (n, c) => Math.max(n, c.congress?.unreadablePtrs ?? 0),
    0,
  );

  const fm = new Map<string, string>([
    ["type", "screen"],
    ["date", runDate],
    ["universe_size", String(companies.length)],
    ["qualifying", String(qualifying.length)],
    ["ownership_window_days", String(meta.windowDays)],
    ["congress_unreadable_ptrs", String(unreadable)],
    ["tags", "screen, us-equity"],
  ]);

  const rows = ranked.map((c, i) => {
    const score = c.score.value === undefined ? "—" : c.score.value.toFixed(1);
    const pe = valueOf(c.peRatio);
    const y = valueOf(c.fcfYield);
    const evaluable = c.filters.filter((f) => f.passed !== undefined);
    return (
      `| ${i + 1} | [[${c.ticker}]] | ${score} | ${(c.score.coverage * 100).toFixed(0)}% | ` +
      `${pe === undefined ? "—" : pe.toFixed(1)} | ` +
      `${y === undefined ? "—" : (y * 100).toFixed(2) + "%"} | ` +
      `${c.fcfBasis.toUpperCase()} | ` +
      `${evaluable.filter((f) => f.passed).length}/${evaluable.length} |`
    );
  });

  const medians = [...meta.sectorMedians]
    .sort((a, b) => b[1] - a[1])
    .map(([sector, m]) => `- ${sector}: ${m.toFixed(1)}`);

  const body = [
    `# Screen — ${runDate}`,
    "",
    "Research output only. Not a recommendation to buy or sell.",
    "Figures marked UNVERIFIED could not be retrieved live and were not estimated.",
    "",
    "## Passing every evaluable filter",
    "",
    qualifying.length
      ? qualifying
          .map((c) => `- [[${c.ticker}]] — ${(c.score.value ?? 0).toFixed(1)} — ${c.thesis}`)
          .join("\n")
      : "_None this run._",
    "",
    "## Ranked",
    "",
    "| # | Ticker | Score | Coverage | P/E | FCF yield | Basis | Filters |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
    ...rows,
    "",
    "## Sector median P/E",
    "",
    medians.length ? medians.join("\n") : "_Insufficient sample._",
    "",
    "## Sources",
    "",
    "- SEC EDGAR — fundamentals, Form 4, Schedule 13D/G",
    "- US House Clerk — Periodic Transaction Reports (STOCK Act disclosures)",
    "- Nasdaq — price, market cap, earnings surprise, analyst consensus",
    ...(unreadable > 0
      ? [
          "",
          `**Congressional coverage is partial.** ${unreadable} Periodic Transaction ` +
            "Report(s) in this window are scans of paper filings and extract to no " +
            "text at all. Their trades are counted nowhere in this note. The gap " +
            "is not random: a member who files on paper is invisible to this " +
            "factor on every run.",
        ]
      : []),
  ].join("\n");

  await writeFile(path, serializeNote(fm, body), "utf8");
  return path;
}

export async function writeVault(
  vaultRoot: string,
  companies: ScreenedCompany[],
  meta: { windowDays: number; sectorMedians: Map<string, number> },
  runDate = new Date().toISOString().slice(0, 10),
): Promise<VaultWriteResult> {
  const changes: string[] = [];

  for (const c of companies) {
    const result = await writeCompanyNote(vaultRoot, c, runDate);
    for (const change of result.changes) changes.push(`${c.ticker}: ${change.slice(2)}`);
  }

  const screenNotePath = await writeScreenNote(vaultRoot, companies, runDate, meta);
  return { companiesWritten: companies.length, screenNotePath, changes };
}
