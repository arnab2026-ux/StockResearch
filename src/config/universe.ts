/**
 * Screening universe: AI, AI-adjacent semiconductor manufacturing, AI-driven
 * biotech, and defence. Nasdaq-weighted, but NYSE names are included where
 * they are core to a theme — the defence primes are almost all NYSE.
 *
 * Tickers here are *candidates* — `resolveUniverse()` validates every one
 * against the SEC's own ticker file, so a typo or a delisted name surfaces
 * as an unresolved warning rather than silently dropping out of the screen.
 */

export type Category =
  | "ai-core"
  | "ai-software"
  | "semis"
  | "semicap"
  | "biotech"
  | "defence";

export type Exchange = "nasdaq" | "nyse";

export interface UniverseEntry {
  ticker: string;
  category: Category;
  exchange: Exchange;
  /** Foreign private issuers file 20-F, not 10-K — different XBRL coverage. */
  foreignIssuer?: boolean;
}

export const UNIVERSE: readonly UniverseEntry[] = [
  // --- AI core: the hyperscalers and model/compute owners -----------------
  { ticker: "NVDA", category: "ai-core", exchange: "nasdaq" },
  { ticker: "MSFT", category: "ai-core", exchange: "nasdaq" },
  { ticker: "GOOGL", category: "ai-core", exchange: "nasdaq" },
  { ticker: "AMZN", category: "ai-core", exchange: "nasdaq" },
  { ticker: "META", category: "ai-core", exchange: "nasdaq" },
  { ticker: "AVGO", category: "ai-core", exchange: "nasdaq" },
  { ticker: "CBRS", category: "ai-core", exchange: "nasdaq" },
  { ticker: "TSLA", category: "ai-core", exchange: "nasdaq" },

  // --- AI software / applied AI ------------------------------------------
  { ticker: "PLTR", category: "ai-software", exchange: "nasdaq" },
  { ticker: "CRWD", category: "ai-software", exchange: "nasdaq" },
  { ticker: "DDOG", category: "ai-software", exchange: "nasdaq" },
  { ticker: "MDB", category: "ai-software", exchange: "nasdaq" },
  { ticker: "SNOW", category: "ai-software", exchange: "nyse" },
  { ticker: "NOW", category: "ai-software", exchange: "nyse" },
  { ticker: "AI", category: "ai-software", exchange: "nyse" },

  // --- Semiconductors: logic, memory, analog, networking -----------------
  { ticker: "AMD", category: "semis", exchange: "nasdaq" },
  { ticker: "INTC", category: "semis", exchange: "nasdaq" },
  { ticker: "MU", category: "semis", exchange: "nasdaq" },
  { ticker: "QCOM", category: "semis", exchange: "nasdaq" },
  { ticker: "MRVL", category: "semis", exchange: "nasdaq" },
  { ticker: "ADI", category: "semis", exchange: "nasdaq" },
  { ticker: "TXN", category: "semis", exchange: "nasdaq" },
  { ticker: "NXPI", category: "semis", exchange: "nasdaq" },
  { ticker: "MCHP", category: "semis", exchange: "nasdaq" },
  { ticker: "ON", category: "semis", exchange: "nasdaq" },
  { ticker: "MPWR", category: "semis", exchange: "nasdaq" },
  { ticker: "SWKS", category: "semis", exchange: "nasdaq" },
  { ticker: "CRUS", category: "semis", exchange: "nasdaq" },
  { ticker: "GFS", category: "semis", exchange: "nasdaq" },
  { ticker: "ALAB", category: "semis", exchange: "nasdaq" },
  { ticker: "CRDO", category: "semis", exchange: "nasdaq" },
  { ticker: "ARM", category: "semis", exchange: "nasdaq", foreignIssuer: true },

  // --- Semicap: equipment, metrology, materials --------------------------
  { ticker: "AMAT", category: "semicap", exchange: "nasdaq" },
  { ticker: "LRCX", category: "semicap", exchange: "nasdaq" },
  { ticker: "KLAC", category: "semicap", exchange: "nasdaq" },
  { ticker: "TER", category: "semicap", exchange: "nasdaq" },
  { ticker: "ENTG", category: "semicap", exchange: "nasdaq" },
  { ticker: "ACLS", category: "semicap", exchange: "nasdaq" },
  { ticker: "NVMI", category: "semicap", exchange: "nasdaq", foreignIssuer: true },
  { ticker: "CAMT", category: "semicap", exchange: "nasdaq", foreignIssuer: true },
  { ticker: "ASML", category: "semicap", exchange: "nasdaq", foreignIssuer: true },

  // --- AI-driven biotech: ML-native drug discovery and diagnostics -------
  { ticker: "RXRX", category: "biotech", exchange: "nasdaq" },
  { ticker: "SDGR", category: "biotech", exchange: "nasdaq" },
  { ticker: "ABSI", category: "biotech", exchange: "nasdaq" },
  { ticker: "TEM", category: "biotech", exchange: "nasdaq" },
  { ticker: "CRSP", category: "biotech", exchange: "nasdaq" },
  { ticker: "NTRA", category: "biotech", exchange: "nasdaq" },
  { ticker: "ILMN", category: "biotech", exchange: "nasdaq" },
  { ticker: "PACB", category: "biotech", exchange: "nasdaq" },
  { ticker: "TXG", category: "biotech", exchange: "nasdaq" },
  { ticker: "TWST", category: "biotech", exchange: "nasdaq" },
  { ticker: "MRNA", category: "biotech", exchange: "nasdaq" },
  { ticker: "MDGL", category: "biotech", exchange: "nasdaq" },
  { ticker: "DNA", category: "biotech", exchange: "nyse" },

  // --- Defence: primes, then services and defence tech -------------------
  // Mature primes and higher-growth defence tech score very differently on
  // FCF yield and PEG, so both ends are present rather than just the primes.
  { ticker: "LMT", category: "defence", exchange: "nyse" },
  { ticker: "RTX", category: "defence", exchange: "nyse" },
  { ticker: "NOC", category: "defence", exchange: "nyse" },
  { ticker: "GD", category: "defence", exchange: "nyse" },
  { ticker: "LHX", category: "defence", exchange: "nyse" },
  { ticker: "HII", category: "defence", exchange: "nyse" },
  { ticker: "LDOS", category: "defence", exchange: "nyse" },
  { ticker: "BAH", category: "defence", exchange: "nyse" },
  { ticker: "AVAV", category: "defence", exchange: "nasdaq" },
  { ticker: "KTOS", category: "defence", exchange: "nasdaq" },
];

export const CATEGORY_LABELS: Record<Category, string> = {
  "ai-core": "AI core",
  "ai-software": "AI software",
  semis: "Semiconductors",
  semicap: "Semicap equipment",
  biotech: "AI-driven biotech",
  defence: "Defence",
};

export function tickersIn(category: Category): string[] {
  return UNIVERSE.filter((e) => e.category === category).map((e) => e.ticker);
}
