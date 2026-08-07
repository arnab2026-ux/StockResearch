/** Shapes returned by the SEC EDGAR XBRL APIs. */

/** One reported value for one period, as it appeared in one filing. */
export interface XbrlFact {
  /** Present for duration concepts (income/cash-flow); absent for instants. */
  start?: string;
  end: string;
  val: number;
  /** Accession number of the filing this value came from. */
  accn: string;
  fy: number;
  fp: string;
  form: string;
  /** Date the filing was submitted — used to prefer the newest restatement. */
  filed: string;
  frame?: string;
}

export interface XbrlConcept {
  label?: string;
  description?: string;
  units: Record<string, XbrlFact[]>;
}

export interface CompanyFacts {
  cik: number;
  entityName: string;
  facts: Record<string, Record<string, XbrlConcept>>;
}

export interface TickerRecord {
  cik_str: number;
  ticker: string;
  title: string;
}

/** Zero-pads a CIK to the 10-digit form the data.sec.gov paths require. */
export function padCik(cik: number | string): string {
  return String(cik).replace(/\D/g, "").padStart(10, "0");
}
