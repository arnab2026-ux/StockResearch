/**
 * Turns raw XBRL companyfacts into a tidy per-period statement model.
 *
 * Four things make this non-trivial:
 *
 * 1. **Facts repeat.** Every 10-K restates the two prior years as
 *    comparatives, so the same period appears many times across filings —
 *    sometimes with different values after a restatement. We keep the value
 *    from the most recently *filed* document.
 *
 * 2. **`fy`/`fp` describe the filing, not the fact.** A fact inside NVDA's
 *    FY2024 10-K carries `fy: 2024` even when it reports FY2022 revenue, so
 *    filtering on those fields silently mixes periods. We classify instead by
 *    the fact's own `start`/`end` span, which is taxonomy-independent and
 *    survives odd fiscal calendars.
 *
 * 3. **Companies switch tags mid-history.** Taking the first tag that has any
 *    data truncates the series at the switchover — NVDA's revenue stopped in
 *    2022 that way. All tags in a chain are merged instead.
 *
 * 4. **Not everyone reports in USD or US-GAAP.** ASML files US-GAAP tags in
 *    EUR; GlobalFoundries files IFRS. Currency is detected per company and
 *    recorded, so downstream code never silently compares EUR to USD.
 */

import { CONCEPTS, CONCEPT_NAMES, type ConceptDef } from "./concepts.js";
import type { ConceptName } from "./concepts.js";
import type { CompanyFacts, XbrlFact } from "./types.js";

const DAY_MS = 86_400_000;

/** Annual periods cluster near 365 days; 52/53-week filers drift a little. */
const ANNUAL_DAYS = { min: 340, max: 400 };
/** Quarterly periods cluster near 91 days. */
const QUARTER_DAYS = { min: 75, max: 105 };

const NON_CURRENCY_UNITS = new Set(["shares", "pure", "USD/shares", "EUR/shares"]);

export type Periodicity = "annual" | "quarterly";
export type Taxonomy = "us-gaap" | "ifrs-full";

export interface PeriodValue {
  /** Period end date, ISO. This is the key we align series on. */
  end: string;
  start?: string;
  value: number;
  /** Accession of the filing this figure was taken from. */
  accn: string;
  filed: string;
  form: string;
}

export interface NormalizedCompany {
  cik: string;
  entityName: string;
  /** Reporting currency, e.g. USD or EUR. Comparisons must respect this. */
  currency: string;
  /** Which taxonomy supplied the data. */
  taxonomy: Taxonomy;
  /** Which tag(s) supplied each concept, for auditability. */
  tagsUsed: Partial<Record<ConceptName, string[]>>;
  annual: Partial<Record<ConceptName, PeriodValue[]>>;
  quarterly: Partial<Record<ConceptName, PeriodValue[]>>;
  /**
   * Every duration fact regardless of span, deduped.
   *
   * The annual and quarterly buckets discard the six- and nine-month
   * year-to-date periods that 10-Qs report, but those are exactly what a real
   * trailing-twelve-month figure needs: most filers never tag Q4 on its own,
   * so TTM has to be reconstructed as prior fiscal year plus current
   * year-to-date less the year-ago year-to-date.
   */
  durations: Partial<Record<ConceptName, PeriodValue[]>>;
  /** Concepts we could not find under any tag in either chain. */
  missing: ConceptName[];
}

function spanDays(fact: XbrlFact): number | undefined {
  if (!fact.start) return undefined;
  return (Date.parse(fact.end) - Date.parse(fact.start)) / DAY_MS;
}

function inRange(days: number, range: { min: number; max: number }): boolean {
  return days >= range.min && days <= range.max;
}

/**
 * Which taxonomy and currency does this company actually report in?
 *
 * Decided once per company by counting facts across the taxonomies present,
 * so every concept is then read consistently instead of each one guessing.
 */
function detectBasis(facts: CompanyFacts): { taxonomy: Taxonomy; currency: string } {
  const usGaapCount = Object.keys(facts.facts["us-gaap"] ?? {}).length;
  const ifrsCount = Object.keys(facts.facts["ifrs-full"] ?? {}).length;
  const taxonomy: Taxonomy = ifrsCount > usGaapCount ? "ifrs-full" : "us-gaap";

  const bucket = facts.facts[taxonomy] ?? {};
  const unitCounts = new Map<string, number>();

  for (const concept of Object.values(bucket)) {
    for (const [unit, series] of Object.entries(concept.units)) {
      if (NON_CURRENCY_UNITS.has(unit) || unit.includes("/")) continue;
      unitCounts.set(unit, (unitCounts.get(unit) ?? 0) + series.length);
    }
  }

  let currency = "USD";
  let best = 0;
  for (const [unit, count] of unitCounts) {
    if (count > best) {
      best = count;
      currency = unit;
    }
  }

  return { taxonomy, currency };
}

/**
 * Collapse repeated reports of the same period down to one value.
 *
 * Preference order: most recently filed wins (restatements supersede), then
 * the audited 10-K over the 10-Q, then the earlier tag in the concept's chain.
 */
function dedupeByPeriod(facts: (XbrlFact & { tagRank: number })[]): PeriodValue[] {
  const best = new Map<string, XbrlFact & { tagRank: number }>();

  for (const fact of facts) {
    const key = fact.start ? `${fact.start}|${fact.end}` : fact.end;
    const incumbent = best.get(key);

    if (!incumbent) {
      best.set(key, fact);
      continue;
    }

    if (fact.filed !== incumbent.filed) {
      if (fact.filed > incumbent.filed) best.set(key, fact);
      continue;
    }

    const audited = fact.form.startsWith("10-K") || fact.form.startsWith("20-F");
    const incumbentAudited =
      incumbent.form.startsWith("10-K") || incumbent.form.startsWith("20-F");

    if (audited !== incumbentAudited) {
      if (audited) best.set(key, fact);
      continue;
    }

    if (fact.tagRank < incumbent.tagRank) best.set(key, fact);
  }

  return [...best.values()]
    .map((f) => ({
      end: f.end,
      ...(f.start !== undefined ? { start: f.start } : {}),
      value: f.val,
      accn: f.accn,
      filed: f.filed,
      form: f.form,
    }))
    .sort((a, b) => a.end.localeCompare(b.end));
}

function tagChain(def: ConceptDef, taxonomy: Taxonomy): readonly string[] {
  if (def.taxonomy === "dei") return def.usGaap;
  return taxonomy === "ifrs-full" ? (def.ifrs ?? []) : def.usGaap;
}

/**
 * Pull one concept out of the fact set, merging every tag in its chain so a
 * mid-history tag switch does not truncate the series.
 */
/** `all` keeps every duration span, including year-to-date periods. */
type SpanFilter = Periodicity | "all";

function extractConcept(
  facts: CompanyFacts,
  name: ConceptName,
  periodicity: SpanFilter,
  basis: { taxonomy: Taxonomy; currency: string },
): { values: PeriodValue[]; tags: string[] } | undefined {
  const def: ConceptDef = CONCEPTS[name];
  const taxonomyKey = def.taxonomy ?? basis.taxonomy;
  const unit = def.unit ?? basis.currency;
  const bucket = facts.facts[taxonomyKey];
  if (!bucket) return undefined;

  const merged: (XbrlFact & { tagRank: number })[] = [];
  const contributing: string[] = [];
  const chain = tagChain(def, basis.taxonomy);

  for (const [rank, tag] of chain.entries()) {
    const concept = bucket[tag];
    if (!concept) continue;

    const series = concept.units[unit];
    if (!series || series.length === 0) continue;

    const filtered =
      def.kind === "instant"
        ? // Instants carry no span; periodicity is implied by the statement
          // they appear in, so keep them all and align on date later.
          series.filter((f) => !f.start)
        : series.filter((f) => {
            const days = spanDays(f);
            if (days === undefined) return false;
            if (periodicity === "all") return days > 0;
            return inRange(days, periodicity === "annual" ? ANNUAL_DAYS : QUARTER_DAYS);
          });

    if (filtered.length === 0) continue;

    contributing.push(tag);
    for (const f of filtered) merged.push({ ...f, tagRank: rank });
  }

  if (merged.length === 0) return undefined;

  return { values: dedupeByPeriod(merged), tags: contributing };
}

export interface NormalizeOptions {
  /** Keep only the most recent N periods of each series. */
  maxAnnual?: number;
  maxQuarterly?: number;
}

/**
 * Fiscal year ends for this company, taken from a duration concept.
 *
 * Balance-sheet instants carry no period length, so there is nothing in the
 * fact itself to say whether 2025-03-31 is a fiscal year end or a first
 * quarter close. Anchoring them to the dates on which annual income-statement
 * periods end is what separates the two.
 */
function detectAnnualEnds(
  facts: CompanyFacts,
  basis: { taxonomy: Taxonomy; currency: string },
  limit: number,
): string[] {
  for (const anchor of ["revenue", "netIncome", "operatingCashFlow"] as const) {
    const found = extractConcept(facts, anchor, "annual", basis);
    if (found && found.values.length > 0) {
      return found.values.slice(-limit).map((v) => v.end);
    }
  }
  return [];
}

function nearAny(end: string, candidates: readonly string[], toleranceDays = 5): boolean {
  const target = Date.parse(end);
  return candidates.some(
    (c) => Math.abs(Date.parse(c) - target) / DAY_MS <= toleranceDays,
  );
}

export function normalize(
  facts: CompanyFacts,
  cik: string,
  opts: NormalizeOptions = {},
): NormalizedCompany {
  const { maxAnnual = 6, maxQuarterly = 12 } = opts;
  const basis = detectBasis(facts);

  const out: NormalizedCompany = {
    cik,
    entityName: facts.entityName,
    currency: basis.currency,
    taxonomy: basis.taxonomy,
    tagsUsed: {},
    annual: {},
    quarterly: {},
    durations: {},
    missing: [],
  };

  const annualEnds = detectAnnualEnds(facts, basis, maxAnnual);

  for (const name of CONCEPT_NAMES) {
    const def: ConceptDef = CONCEPTS[name];

    if (def.kind === "instant") {
      // Instants are periodicity-agnostic, so one extraction serves both.
      const all = extractConcept(facts, name, "annual", basis);
      if (!all) {
        out.missing.push(name);
        continue;
      }

      // Without this filter the annual series would be truncated to the most
      // recent balance-sheet dates, which are quarterly — dropping the prior
      // fiscal year end that every year-over-year comparison depends on.
      const annualValues =
        annualEnds.length > 0
          ? all.values.filter((v) => nearAny(v.end, annualEnds))
          : all.values;

      if (annualValues.length > 0) out.annual[name] = annualValues.slice(-maxAnnual);
      out.quarterly[name] = all.values.slice(-maxQuarterly);
      out.tagsUsed[name] = all.tags;
      continue;
    }

    const annual = extractConcept(facts, name, "annual", basis);
    const quarterly = extractConcept(facts, name, "quarterly", basis);

    if (!annual && !quarterly) {
      out.missing.push(name);
      continue;
    }

    if (annual) {
      out.annual[name] = annual.values.slice(-maxAnnual);
      out.tagsUsed[name] = annual.tags;
    }
    if (quarterly) {
      out.quarterly[name] = quarterly.values.slice(-maxQuarterly);
      out.tagsUsed[name] ??= quarterly.tags;
    }

    const all = extractConcept(facts, name, "all", basis);
    if (all) out.durations[name] = all.values.slice(-(maxQuarterly * 3));
  }

  return out;
}

/** Most recent value of a concept, or undefined if the series is absent. */
export function latest(
  company: NormalizedCompany,
  name: ConceptName,
  periodicity: Periodicity = "annual",
): PeriodValue | undefined {
  const series = periodicity === "annual" ? company.annual[name] : company.quarterly[name];
  return series?.at(-1);
}

/**
 * Value of a concept at a specific period end.
 *
 * Balance-sheet instants land on the same date as the fiscal year end, but
 * filers occasionally differ by a day or two, so a small tolerance applies.
 */
export function valueAt(
  company: NormalizedCompany,
  name: ConceptName,
  end: string,
  periodicity: Periodicity = "annual",
  toleranceDays = 5,
): PeriodValue | undefined {
  const series = periodicity === "annual" ? company.annual[name] : company.quarterly[name];
  if (!series) return undefined;

  const exact = series.find((v) => v.end === end);
  if (exact) return exact;

  const target = Date.parse(end);
  let nearest: PeriodValue | undefined;
  let nearestGap = Infinity;

  for (const v of series) {
    const gap = Math.abs(Date.parse(v.end) - target) / DAY_MS;
    if (gap <= toleranceDays && gap < nearestGap) {
      nearest = v;
      nearestGap = gap;
    }
  }

  return nearest;
}
