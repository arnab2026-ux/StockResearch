/**
 * Financial strength: Piotroski F-Score and Altman Z''-Score.
 *
 * Both are applicability-sensitive, and saying so is part of the output.
 * Piotroski was derived on high book-to-market value stocks and Altman on
 * manufacturers; neither was designed for pre-revenue biotech burning cash by
 * design. The scores are still computed for those companies, but flagged, so
 * a weak F-Score on a clinical-stage name is not read as a red flag when it
 * simply reflects the business model.
 */

import type { NormalizedCompany } from "../edgar/normalize.js";
import { isVerified, unverified, valueOf, type Sourced } from "../lib/provenance.js";
import { computeRatios, readAt, snapshotAt } from "./fundamentals.js";

// ---------------------------------------------------------------------------
// Piotroski F-Score
// ---------------------------------------------------------------------------

export interface Signal {
  name: string;
  /** undefined when inputs were unavailable — scored as 0 but reported apart. */
  passed: boolean | undefined;
  detail: string;
}

export interface FScore {
  /** 0-9. Unavailable signals score zero, so read `available` alongside. */
  score: number;
  /** How many of the nine signals could actually be evaluated. */
  available: number;
  signals: Signal[];
}

function signal(name: string, passed: boolean | undefined, detail: string): Signal {
  return { name, passed, detail };
}

function pct(n: number | undefined): string {
  return n === undefined ? "n/a" : `${(n * 100).toFixed(1)}%`;
}

function num(n: number | undefined): string {
  return n === undefined ? "n/a" : n.toFixed(2);
}

/**
 * Nine binary signals across profitability, leverage/liquidity, and
 * efficiency, each comparing the latest fiscal year with the one before.
 */
export function piotroskiFScore(company: NormalizedCompany): FScore {
  const ends = (company.annual.revenue ?? []).map((v) => v.end);
  const curEnd = ends.at(-1);
  const prevEnd = ends.at(-2);

  if (!curEnd || !prevEnd) {
    return {
      score: 0,
      available: 0,
      signals: [signal("all", undefined, "needs two fiscal years of data")],
    };
  }

  const cur = computeRatios(snapshotAt(company, curEnd));
  const prev = computeRatios(snapshotAt(company, prevEnd));

  const curNi = valueOf(readAt(company, "netIncome", curEnd));
  const curOcf = valueOf(readAt(company, "operatingCashFlow", curEnd));
  const curRoa = valueOf(cur.returnOnAssets);
  const prevRoa = valueOf(prev.returnOnAssets);
  const curShares = valueOf(readAt(company, "dilutedShares", curEnd));
  const prevShares = valueOf(readAt(company, "dilutedShares", prevEnd));

  const curLtdRatio = ltdToAssets(company, curEnd);
  const prevLtdRatio = ltdToAssets(company, prevEnd);

  const cmp = (
    a: number | undefined,
    b: number | undefined,
    test: (x: number, y: number) => boolean,
  ): boolean | undefined => (a === undefined || b === undefined ? undefined : test(a, b));

  const signals: Signal[] = [
    signal(
      "ROA positive",
      curRoa === undefined ? undefined : curRoa > 0,
      `ROA ${pct(curRoa)}`,
    ),
    signal(
      "Operating cash flow positive",
      curOcf === undefined ? undefined : curOcf > 0,
      `OCF ${curOcf === undefined ? "n/a" : (curOcf / 1e9).toFixed(2) + "B"}`,
    ),
    signal(
      "ROA improving",
      cmp(curRoa, prevRoa, (a, b) => a > b),
      `${pct(prevRoa)} → ${pct(curRoa)}`,
    ),
    // Accrual quality: earnings backed by cash rather than accounting timing.
    signal(
      "Cash flow exceeds net income",
      cmp(curOcf, curNi, (a, b) => a > b),
      `OCF vs net income`,
    ),
    signal(
      "Leverage decreasing",
      cmp(curLtdRatio, prevLtdRatio, (a, b) => a < b),
      `LT debt/assets ${pct(prevLtdRatio)} → ${pct(curLtdRatio)}`,
    ),
    signal(
      "Current ratio improving",
      cmp(valueOf(cur.currentRatio), valueOf(prev.currentRatio), (a, b) => a > b),
      `${num(valueOf(prev.currentRatio))} → ${num(valueOf(cur.currentRatio))}`,
    ),
    signal(
      "No share dilution",
      cmp(curShares, prevShares, (a, b) => a <= b),
      `diluted shares ${prevShares && curShares ? ((curShares / prevShares - 1) * 100).toFixed(1) + "%" : "n/a"}`,
    ),
    signal(
      "Gross margin improving",
      cmp(valueOf(cur.grossMargin), valueOf(prev.grossMargin), (a, b) => a > b),
      `${pct(valueOf(prev.grossMargin))} → ${pct(valueOf(cur.grossMargin))}`,
    ),
    signal(
      "Asset turnover improving",
      cmp(valueOf(cur.assetTurnover), valueOf(prev.assetTurnover), (a, b) => a > b),
      `${num(valueOf(prev.assetTurnover))} → ${num(valueOf(cur.assetTurnover))}`,
    ),
  ];

  return {
    score: signals.filter((s) => s.passed === true).length,
    available: signals.filter((s) => s.passed !== undefined).length,
    signals,
  };
}

function ltdToAssets(company: NormalizedCompany, end: string): number | undefined {
  const ltd = valueOf(readAt(company, "longTermDebt", end));
  const assets = valueOf(readAt(company, "assets", end));
  if (ltd === undefined || assets === undefined || assets === 0) return undefined;
  return ltd / assets;
}

// ---------------------------------------------------------------------------
// Altman Z''-Score
// ---------------------------------------------------------------------------

export type ZZone = "safe" | "grey" | "distress";

export interface AltmanZ {
  score: Sourced<number>;
  zone: ZZone | undefined;
  components: Record<string, number | undefined>;
}

/**
 * Altman Z''-Score — the four-factor revision for non-manufacturers.
 *
 * The original five-factor Z includes a sales/assets term calibrated on
 * manufacturers, which misclassifies asset-light software and fabless chip
 * designers. Z'' drops it and reweights the rest:
 *
 *   Z'' = 6.56·X1 + 3.26·X2 + 6.72·X3 + 1.05·X4
 *
 * Zones: above 2.6 safe, 1.1 to 2.6 grey, below 1.1 distress.
 */
export function altmanZ(company: NormalizedCompany, end: string): AltmanZ {
  const v = (name: Parameters<typeof readAt>[1]): number | undefined =>
    valueOf(readAt(company, name, end));

  const assets = v("assets");
  const currentAssets = v("currentAssets");
  const currentLiabilities = v("currentLiabilities");
  const retained = v("retainedEarnings");
  const operatingIncome = v("operatingIncome");
  const equity = v("equity");
  const liabilities = v("liabilities");

  const components: Record<string, number | undefined> = {
    workingCapitalToAssets:
      currentAssets !== undefined && currentLiabilities !== undefined && assets
        ? (currentAssets - currentLiabilities) / assets
        : undefined,
    retainedEarningsToAssets:
      retained !== undefined && assets ? retained / assets : undefined,
    ebitToAssets:
      operatingIncome !== undefined && assets ? operatingIncome / assets : undefined,
    equityToLiabilities:
      equity !== undefined && liabilities ? equity / liabilities : undefined,
  };

  const missing = Object.entries(components)
    .filter(([, value]) => value === undefined)
    .map(([key]) => key);

  if (missing.length > 0) {
    return {
      score: unverified(`missing inputs: ${missing.join(", ")}`),
      zone: undefined,
      components,
    };
  }

  const x1 = components.workingCapitalToAssets ?? 0;
  const x2 = components.retainedEarningsToAssets ?? 0;
  const x3 = components.ebitToAssets ?? 0;
  const x4 = components.equityToLiabilities ?? 0;

  const score = 6.56 * x1 + 3.26 * x2 + 6.72 * x3 + 1.05 * x4;

  return {
    score: {
      ok: true,
      value: score,
      source: {
        name: "Derived from SEC EDGAR (Altman Z'' four-factor)",
        url: "https://www.sec.gov/edgar",
        asOf: end,
        retrievedAt: new Date().toISOString().slice(0, 10),
      },
    },
    zone: score > 2.6 ? "safe" : score >= 1.1 ? "grey" : "distress",
    components,
  };
}

// ---------------------------------------------------------------------------
// Applicability
// ---------------------------------------------------------------------------

export interface StrengthProfile {
  fScore: FScore;
  altman: AltmanZ;
  caveats: string[];
}

/**
 * Computes both scores and records where they should be read with caution.
 *
 * A clinical-stage biotech with no product revenue will score badly on both
 * by construction. That is a property of the model, not a finding about the
 * company, and the report needs to say so.
 */
export function strengthProfile(company: NormalizedCompany): StrengthProfile {
  const ends = (company.annual.revenue ?? []).map((v) => v.end);
  const end = ends.at(-1);

  if (!end) {
    return {
      fScore: { score: 0, available: 0, signals: [] },
      altman: {
        score: unverified("no annual data"),
        zone: undefined,
        components: {},
      },
      caveats: ["no annual financial data available"],
    };
  }

  const fScore = piotroskiFScore(company);
  const altman = altmanZ(company, end);
  const caveats: string[] = [];

  const ratios = computeRatios(snapshotAt(company, end));
  const netIncome = valueOf(readAt(company, "netIncome", end));
  const revenue = valueOf(readAt(company, "revenue", end));
  const fcf = valueOf(ratios.freeCashFlow);

  if (netIncome !== undefined && netIncome < 0 && fcf !== undefined && fcf < 0) {
    caveats.push(
      "pre-profit and cash-burning: F-Score and Z'' are calibrated on " +
        "established profitable firms and understate such companies",
    );
  }

  if (revenue !== undefined && revenue < 50e6) {
    caveats.push(
      "minimal revenue: margin and turnover signals carry little information",
    );
  }

  if (fScore.available < 9) {
    caveats.push(
      `${9 - fScore.available} of 9 F-Score signals unavailable; score is a floor, not a rating`,
    );
  }

  if (!isVerified(altman.score)) {
    caveats.push("Altman Z'' unavailable");
  }

  if (company.currency !== "USD") {
    caveats.push(
      `reports in ${company.currency}; do not compare absolute figures with USD filers`,
    );
  }

  return { fScore, altman, caveats };
}
