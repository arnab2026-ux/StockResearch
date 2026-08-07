/**
 * Provenance wrapper for every figure in a screen.
 *
 * The screening brief requires a source and date beside every number, and
 * forbids estimating a figure that cannot be retrieved. Both rules are
 * structural here rather than conventional: a value cannot exist without its
 * source, and `Unverified` is a real variant of the type rather than a
 * sentinel like 0 or NaN that silently flows into arithmetic.
 *
 * The practical consequence is that a missing input can never be mistaken for
 * a zero input — the compiler forces callers to handle both cases.
 */

export interface Source {
  /** Human-readable provider, e.g. "SEC EDGAR companyfacts". */
  name: string;
  url: string;
  /** The date the figure describes — period end, transaction date, quote date. */
  asOf: string;
  /** When we retrieved it. Distinguishes stale cache from fresh pull. */
  retrievedAt: string;
}

export interface Verified<T> {
  ok: true;
  value: T;
  source: Source;
}

export interface Unverified {
  ok: false;
  /** Why the figure is missing. Surfaced in the report, never guessed around. */
  reason: string;
}

export type Sourced<T> = Verified<T> | Unverified;

export function sourced<T>(value: T, source: Source): Verified<T> {
  return { ok: true, value, source };
}

export function unverified(reason: string): Unverified {
  return { ok: false, reason };
}

export function isVerified<T>(s: Sourced<T>): s is Verified<T> {
  return s.ok;
}

/** Value if verified, otherwise undefined. For feeding optional arithmetic. */
export function valueOf<T>(s: Sourced<T> | undefined): T | undefined {
  return s && s.ok ? s.value : undefined;
}

/**
 * Combine several sourced inputs into a derived figure.
 *
 * If any input is unverified the result is unverified, naming the first
 * missing input — a derived number is only as trustworthy as its worst input,
 * and silently dropping one would produce a confidently wrong ratio.
 */
export function derive<K extends string, R>(
  inputs: Record<K, Sourced<number>>,
  fn: (values: Record<K, number>) => R,
  source: Omit<Source, "asOf"> & { asOf?: string },
): Sourced<R> {
  const values = {} as Record<K, number>;
  const asOfDates: string[] = [];

  for (const key of Object.keys(inputs) as K[]) {
    const input = inputs[key];
    if (!input.ok) {
      return unverified(`${key} unavailable: ${input.reason}`);
    }
    values[key] = input.value;
    asOfDates.push(input.source.asOf);
  }

  const result = fn(values);
  if (typeof result === "number" && !Number.isFinite(result)) {
    return unverified("computation produced a non-finite result (division by zero?)");
  }

  // A derived figure is only as current as its oldest input.
  return sourced(result, { ...source, asOf: source.asOf ?? asOfDates.sort()[0] ?? "" });
}

export const UNVERIFIED_LABEL = "UNVERIFIED";

/** Renders a figure with its citation, or the UNVERIFIED marker. */
export function cite<T>(s: Sourced<T> | undefined, format?: (v: T) => string): string {
  if (!s) return `${UNVERIFIED_LABEL} (not computed)`;
  if (!s.ok) return `${UNVERIFIED_LABEL} (${s.reason})`;
  const rendered = format ? format(s.value) : String(s.value);
  return `${rendered} [${s.source.name}, ${s.source.asOf}]`;
}

export function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export function edgarSource(cik: string, asOf: string, doc = "companyfacts"): Source {
  return {
    name: `SEC EDGAR ${doc}`,
    url: `https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`,
    asOf,
    retrievedAt: today(),
  };
}
