/**
 * Derived fundamentals: a single-period snapshot plus the ratios that feed
 * financial-strength scoring.
 *
 * Everything is wrapped in `Sourced` so a figure can never reach the report
 * without a citation, and a missing input propagates as UNVERIFIED instead of
 * quietly becoming zero.
 */

import type { ConceptName } from "../edgar/concepts.js";
import type { NormalizedCompany, PeriodValue, Periodicity } from "../edgar/normalize.js";
import { valueAt } from "../edgar/normalize.js";
import {
  derive,
  edgarSource,
  sourced,
  unverified,
  type Sourced,
} from "../lib/provenance.js";

const DAY_MS = 86_400_000;

/**
 * Concepts where absence in an XBRL filing genuinely means nil.
 *
 * XBRL filers tag the lines they have. A company with short-term borrowings
 * tags them; one with none simply omits the concept. Treating that omission as
 * UNVERIFIED would make net debt unverifiable for roughly half our universe —
 * mostly cash-rich semis and pre-revenue biotech that genuinely carry no debt.
 *
 * This is an inference, so it is named, narrow, and recorded in the source
 * string rather than hidden inside a `?? 0`.
 */
const NIL_WHEN_ABSENT: ReadonlySet<ConceptName> = new Set<ConceptName>([
  "shortTermDebt",
  "longTermDebt",
  "shortTermInvestments",
  "inventory",
]);

export interface Snapshot {
  end: string;
  currency: string;
  get: (name: ConceptName) => Sourced<number>;
}

/**
 * Reads a concept at a period end, applying the nil-when-absent rule.
 *
 * `hasBalanceSheet` guards the inference: if we could not read the balance
 * sheet at all, an absent debt line tells us nothing and must stay UNVERIFIED.
 */
export function readAt(
  company: NormalizedCompany,
  name: ConceptName,
  end: string,
  periodicity: Periodicity = "annual",
): Sourced<number> {
  const hit = valueAt(company, name, end, periodicity);
  if (hit) {
    return sourced(hit.value, {
      ...edgarSource(company.cik, hit.end),
      name: `SEC EDGAR ${hit.form} (${hit.accn})`,
    });
  }

  const balanceSheetPresent = valueAt(company, "assets", end, periodicity) !== undefined;

  // Many filers tag `LiabilitiesAndStockholdersEquity` and the individual
  // components but never a total `Liabilities` line. The accounting identity
  // recovers it exactly — this is arithmetic, not an estimate.
  if (name === "liabilities") {
    const assets = valueAt(company, "assets", end, periodicity);
    const equity = valueAt(company, "equity", end, periodicity);
    if (assets && equity) {
      return sourced(assets.value - equity.value, {
        name: "Derived from SEC EDGAR (total assets less shareholders equity)",
        url: `https://data.sec.gov/api/xbrl/companyfacts/CIK${company.cik}.json`,
        asOf: end,
        retrievedAt: new Date().toISOString().slice(0, 10),
      });
    }
  }

  if (NIL_WHEN_ABSENT.has(name) && balanceSheetPresent) {
    return sourced(0, {
      name: "SEC EDGAR (concept absent from filing, treated as nil)",
      url: `https://data.sec.gov/api/xbrl/companyfacts/CIK${company.cik}.json`,
      asOf: end,
      retrievedAt: new Date().toISOString().slice(0, 10),
    });
  }

  return unverified(`${name} not reported for period ending ${end}`);
}

export function snapshotAt(
  company: NormalizedCompany,
  end: string,
  periodicity: Periodicity = "annual",
): Snapshot {
  return {
    end,
    currency: company.currency,
    get: (name) => readAt(company, name, end, periodicity),
  };
}

/** Fiscal year ends present for this company, oldest first. */
export function annualPeriodEnds(company: NormalizedCompany): string[] {
  return (company.annual.revenue ?? []).map((v) => v.end);
}

// ---------------------------------------------------------------------------
// Trailing twelve months
// ---------------------------------------------------------------------------

export type FlowBasis = "ttm" | "fy";

export interface FlowValue {
  amount: Sourced<number>;
  basis: FlowBasis;
  /** Explains the basis in report output, e.g. why TTM was unavailable. */
  note: string;
  /** Period end the figure runs to. */
  asOf: string | undefined;
}

function daysBetween(a: string, b: string): number {
  return Math.abs(Date.parse(a) - Date.parse(b)) / DAY_MS;
}

/** The day after a period ends, i.e. the start of the next fiscal year. */
function dayAfter(iso: string): string {
  const d = new Date(Date.parse(iso) + DAY_MS);
  return d.toISOString().slice(0, 10);
}

function span(v: PeriodValue): number | undefined {
  return v.start ? (Date.parse(v.end) - Date.parse(v.start)) / DAY_MS : undefined;
}

/**
 * Trailing-twelve-month value of a flow concept.
 *
 * Most filers never tag the fourth quarter on its own — the 10-K reports the
 * full year and Q4 is only implied by subtraction — so summing four discrete
 * quarters usually fails. The reliable construction uses the year-to-date
 * figures that every 10-Q reports:
 *
 *     TTM = prior fiscal year + current YTD − year-ago YTD
 *
 * For NVIDIA that is 102.72B + 50.34B − 27.41B = 125.65B, against a fiscal
 * year figure of 102.72B. Using the fiscal year alone understates trailing
 * cash flow by 22% two quarters after year end, which flows straight into FCF
 * yield and therefore a quarter of the composite score.
 *
 * Falls back to four discrete quarters where they exist, then to the fiscal
 * year, labelling the basis in every case rather than presenting a stale
 * annual figure as though it were trailing.
 */
export function trailingTwelveMonths(
  company: NormalizedCompany,
  name: ConceptName,
): FlowValue {
  const cikUrl = `https://data.sec.gov/api/xbrl/companyfacts/CIK${company.cik}.json`;
  const retrievedAt = new Date().toISOString().slice(0, 10);

  const annualSeries = company.annual[name] ?? [];
  const latestFy = annualSeries.at(-1);
  const durations = company.durations[name] ?? [];

  // --- preferred: fiscal year rolled forward by year-to-date ---------------
  if (latestFy?.start) {
    const fyStart = dayAfter(latestFy.end);

    // Year-to-date periods of the current fiscal year all share its start.
    const currentYtd = durations
      .filter((d) => d.start && daysBetween(d.start, fyStart) <= 5 && d.end > latestFy.end)
      .sort((a, b) => a.end.localeCompare(b.end))
      .at(-1);

    const currentSpan = currentYtd ? span(currentYtd) : undefined;

    if (currentYtd && currentSpan !== undefined) {
      // The equivalent stretch of the prior year: same start-of-year anchor,
      // same length. Comparing unlike spans would corrupt the subtraction.
      const priorYtd = durations.find((d) => {
        if (!d.start || !latestFy.start) return false;
        const s = span(d);
        return (
          daysBetween(d.start, latestFy.start) <= 5 &&
          s !== undefined &&
          Math.abs(s - currentSpan) <= 10
        );
      });

      if (priorYtd) {
        const value = latestFy.value + currentYtd.value - priorYtd.value;
        return {
          amount: sourced(value, {
            name: `Derived from SEC EDGAR (FY to ${latestFy.end} rolled forward to ${currentYtd.end})`,
            url: cikUrl,
            asOf: currentYtd.end,
            retrievedAt,
          }),
          basis: "ttm",
          note:
            `FY to ${latestFy.end} plus ${Math.round(currentSpan)}d YTD to ` +
            `${currentYtd.end} less year-ago YTD to ${priorYtd.end}`,
          asOf: currentYtd.end,
        };
      }
    }
  }

  // --- fallback: four discrete quarters ------------------------------------
  const quarters = company.quarterly[name] ?? [];
  if (quarters.length >= 4) {
    const last4 = quarters.slice(-4);
    const first = last4[0];
    const last = last4[last4.length - 1];

    if (first?.start && last) {
      const total = (Date.parse(last.end) - Date.parse(first.start)) / DAY_MS;
      if (total >= 330 && total <= 400) {
        return {
          amount: sourced(
            last4.reduce((sum, q) => sum + q.value, 0),
            {
              name: `SEC EDGAR 10-Q/10-K (4 quarters to ${last.end})`,
              url: cikUrl,
              asOf: last.end,
              retrievedAt,
            },
          ),
          basis: "ttm",
          note: `sum of 4 quarters, ${first.start} to ${last.end}`,
          asOf: last.end,
        };
      }
    }
  }

  // --- last resort: the fiscal year as filed -------------------------------
  if (latestFy) {
    return {
      amount: sourced(latestFy.value, {
        name: `SEC EDGAR ${latestFy.form} (${latestFy.accn})`,
        url: cikUrl,
        asOf: latestFy.end,
        retrievedAt,
      }),
      basis: "fy",
      note: `fiscal year to ${latestFy.end}; no year-to-date data to roll it forward`,
      asOf: latestFy.end,
    };
  }

  return {
    amount: unverified(`no annual or quarterly data for ${name}`),
    basis: "fy",
    note: "no data",
    asOf: undefined,
  };
}

/** Trailing-twelve-month free cash flow: operating cash flow less capex. */
export function ttmFreeCashFlow(company: NormalizedCompany): FlowValue {
  const ocf = trailingTwelveMonths(company, "operatingCashFlow");
  const capex = trailingTwelveMonths(company, "capex");

  // Mixing a TTM numerator with an annual capex figure would be wrong, so the
  // weaker basis governs the pair.
  const basis: FlowBasis = ocf.basis === "ttm" && capex.basis === "ttm" ? "ttm" : "fy";

  return {
    amount: derive({ ocf: ocf.amount, capex: capex.amount }, (v) => v.ocf - v.capex, {
      name: "Derived from SEC EDGAR (operating cash flow less capex)",
      url: "https://www.sec.gov/edgar",
      retrievedAt: new Date().toISOString().slice(0, 10),
    }),
    basis,
    note: basis === "ttm" ? ocf.note : `${ocf.note}; capex ${capex.note}`,
    asOf: ocf.asOf,
  };
}

// ---------------------------------------------------------------------------
// Ratios
// ---------------------------------------------------------------------------

function derived(label: string, asOf?: string) {
  return {
    name: `Derived from SEC EDGAR (${label})`,
    url: "https://www.sec.gov/edgar",
    retrievedAt: new Date().toISOString().slice(0, 10),
    ...(asOf !== undefined ? { asOf } : {}),
  };
}

export interface Ratios {
  ebitda: Sourced<number>;
  freeCashFlow: Sourced<number>;
  fcfMargin: Sourced<number>;
  netDebt: Sourced<number>;
  netDebtToEbitda: Sourced<number>;
  interestCoverage: Sourced<number>;
  currentRatio: Sourced<number>;
  grossMargin: Sourced<number>;
  operatingMargin: Sourced<number>;
  netMargin: Sourced<number>;
  returnOnAssets: Sourced<number>;
  returnOnEquity: Sourced<number>;
  assetTurnover: Sourced<number>;
  debtToEquity: Sourced<number>;
}

export function computeRatios(snap: Snapshot): Ratios {
  const g = snap.get;

  const ebitda = derive(
    { op: g("operatingIncome"), da: g("depreciationAmortization") },
    (v) => v.op + v.da,
    derived("operating income plus D&A", snap.end),
  );

  const freeCashFlow = derive(
    { ocf: g("operatingCashFlow"), capex: g("capex") },
    (v) => v.ocf - v.capex,
    derived("operating cash flow less capex", snap.end),
  );

  const netDebt = derive(
    {
      ltd: g("longTermDebt"),
      std: g("shortTermDebt"),
      cash: g("cash"),
      sti: g("shortTermInvestments"),
    },
    (v) => v.ltd + v.std - v.cash - v.sti,
    derived("total debt less cash and short-term investments", snap.end),
  );

  return {
    ebitda,
    freeCashFlow,
    fcfMargin: derive(
      { fcf: freeCashFlow, rev: g("revenue") },
      (v) => v.fcf / v.rev,
      derived("free cash flow over revenue", snap.end),
    ),
    netDebt,
    netDebtToEbitda: derive(
      { nd: netDebt, e: ebitda },
      (v) => v.nd / v.e,
      derived("net debt over EBITDA", snap.end),
    ),
    // Interest expense is signed inconsistently across filers, so magnitude is
    // what matters for a coverage ratio.
    interestCoverage: derive(
      { op: g("operatingIncome"), int: g("interestExpense") },
      (v) => v.op / Math.abs(v.int),
      derived("operating income over interest expense", snap.end),
    ),
    currentRatio: derive(
      { ca: g("currentAssets"), cl: g("currentLiabilities") },
      (v) => v.ca / v.cl,
      derived("current assets over current liabilities", snap.end),
    ),
    grossMargin: derive(
      { gp: g("grossProfit"), rev: g("revenue") },
      (v) => v.gp / v.rev,
      derived("gross profit over revenue", snap.end),
    ),
    operatingMargin: derive(
      { op: g("operatingIncome"), rev: g("revenue") },
      (v) => v.op / v.rev,
      derived("operating income over revenue", snap.end),
    ),
    netMargin: derive(
      { ni: g("netIncome"), rev: g("revenue") },
      (v) => v.ni / v.rev,
      derived("net income over revenue", snap.end),
    ),
    returnOnAssets: derive(
      { ni: g("netIncome"), a: g("assets") },
      (v) => v.ni / v.a,
      derived("net income over total assets", snap.end),
    ),
    returnOnEquity: derive(
      { ni: g("netIncome"), eq: g("equity") },
      (v) => v.ni / v.eq,
      derived("net income over shareholders equity", snap.end),
    ),
    assetTurnover: derive(
      { rev: g("revenue"), a: g("assets") },
      (v) => v.rev / v.a,
      derived("revenue over total assets", snap.end),
    ),
    debtToEquity: derive(
      { ltd: g("longTermDebt"), std: g("shortTermDebt"), eq: g("equity") },
      (v) => (v.ltd + v.std) / v.eq,
      derived("total debt over shareholders equity", snap.end),
    ),
  };
}
