/**
 * Mapping from the line items we care about to XBRL tags.
 *
 * Two complications this map has to absorb:
 *
 * - **Companies switch tags mid-history.** NVDA reported revenue under
 *   `RevenueFromContractWithCustomerExcludingAssessedTax` through FY2022 and
 *   `Revenues` before and after. So `usGaap` is not a first-match-wins chain —
 *   the extractor merges every tag in it and lets earlier entries win ties on
 *   the same period. Order by preference, not by expected availability.
 *
 * - **Foreign private issuers file IFRS.** GlobalFoundries (GFS) publishes
 *   only `ifrs-full` concepts, whose tag names differ entirely from US-GAAP.
 *   Each concept therefore carries a parallel `ifrs` chain.
 */

export type PeriodKind = "duration" | "instant";

export interface ConceptDef {
  kind: PeriodKind;
  /** US-GAAP tags, merged. Ordered by preference for tie-breaking. */
  usGaap: readonly string[];
  /** IFRS equivalents for foreign private issuers. */
  ifrs?: readonly string[];
  /** Non-default taxonomy (currently only `dei`). */
  taxonomy?: string;
  /** Fixed unit; when absent the company's reporting currency is used. */
  unit?: string;
}

export const CONCEPTS = {
  revenue: {
    kind: "duration",
    usGaap: [
      "RevenueFromContractWithCustomerExcludingAssessedTax",
      "RevenueFromContractWithCustomerIncludingAssessedTax",
      "Revenues",
      "SalesRevenueNet",
      "SalesRevenueGoodsNet",
    ],
    ifrs: ["Revenue", "RevenueFromContractsWithCustomers"],
  },
  grossProfit: {
    kind: "duration",
    usGaap: ["GrossProfit"],
    ifrs: ["GrossProfit"],
  },
  operatingIncome: {
    kind: "duration",
    usGaap: ["OperatingIncomeLoss"],
    ifrs: ["ProfitLossFromOperatingActivities"],
  },
  netIncome: {
    kind: "duration",
    usGaap: ["NetIncomeLoss", "ProfitLoss"],
    ifrs: ["ProfitLoss"],
  },
  researchAndDevelopment: {
    kind: "duration",
    usGaap: ["ResearchAndDevelopmentExpense"],
    ifrs: ["ResearchAndDevelopmentExpense"],
  },
  interestExpense: {
    kind: "duration",
    usGaap: ["InterestExpense", "InterestExpenseDebt", "InterestExpenseNonoperating"],
    ifrs: ["InterestExpense", "FinanceCosts"],
  },
  operatingCashFlow: {
    kind: "duration",
    usGaap: [
      "NetCashProvidedByUsedInOperatingActivities",
      "NetCashProvidedByUsedInOperatingActivitiesContinuingOperations",
    ],
    ifrs: ["CashFlowsFromUsedInOperatingActivities"],
  },
  capex: {
    kind: "duration",
    usGaap: [
      "PaymentsToAcquirePropertyPlantAndEquipment",
      "PaymentsToAcquireProductiveAssets",
    ],
    ifrs: ["PurchaseOfPropertyPlantAndEquipmentClassifiedAsInvestingActivities"],
  },
  depreciationAmortization: {
    kind: "duration",
    usGaap: [
      "DepreciationDepletionAndAmortization",
      "DepreciationAmortizationAndAccretionNet",
      "DepreciationAndAmortization",
      "Depreciation",
    ],
    ifrs: ["DepreciationAndAmortisationExpense"],
  },
  /** Weighted-average diluted count — Piotroski's dilution test needs a flow,
   *  not the cover-page instant in `sharesOutstanding`. */
  dilutedShares: {
    kind: "duration",
    unit: "shares",
    usGaap: ["WeightedAverageNumberOfDilutedSharesOutstanding"],
    ifrs: ["WeightedAverageNumberOfDilutedSharesOutstanding"],
  },

  assets: { kind: "instant", usGaap: ["Assets"], ifrs: ["Assets"] },
  currentAssets: {
    kind: "instant",
    usGaap: ["AssetsCurrent"],
    ifrs: ["CurrentAssets"],
  },
  liabilities: { kind: "instant", usGaap: ["Liabilities"], ifrs: ["Liabilities"] },
  currentLiabilities: {
    kind: "instant",
    usGaap: ["LiabilitiesCurrent"],
    ifrs: ["CurrentLiabilities"],
  },
  equity: {
    kind: "instant",
    usGaap: [
      "StockholdersEquity",
      "StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest",
    ],
    ifrs: ["Equity", "EquityAttributableToOwnersOfParent"],
  },
  cash: {
    kind: "instant",
    usGaap: [
      "CashAndCashEquivalentsAtCarryingValue",
      "CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents",
    ],
    ifrs: ["CashAndCashEquivalents"],
  },
  shortTermInvestments: {
    kind: "instant",
    usGaap: [
      "ShortTermInvestments",
      "MarketableSecuritiesCurrent",
      "AvailableForSaleSecuritiesDebtSecuritiesCurrent",
    ],
    ifrs: ["OtherCurrentFinancialAssets"],
  },
  longTermDebt: {
    kind: "instant",
    usGaap: ["LongTermDebtNoncurrent", "LongTermDebt"],
    ifrs: ["NoncurrentPortionOfNoncurrentBorrowings", "Borrowings"],
  },
  shortTermDebt: {
    kind: "instant",
    usGaap: [
      "LongTermDebtCurrent",
      "DebtCurrent",
      "ShortTermBorrowings",
      "OtherShortTermBorrowings",
    ],
    ifrs: ["CurrentPortionOfNoncurrentBorrowings", "ShorttermBorrowings"],
  },
  inventory: {
    kind: "instant",
    usGaap: ["InventoryNet"],
    ifrs: ["Inventories"],
  },
  retainedEarnings: {
    kind: "instant",
    usGaap: [
      "RetainedEarningsAccumulatedDeficit",
      "RetainedEarningsAppropriated",
    ],
    ifrs: ["RetainedEarnings"],
  },
  sharesOutstanding: {
    kind: "instant",
    taxonomy: "dei",
    unit: "shares",
    usGaap: ["EntityCommonStockSharesOutstanding"],
  },
} as const satisfies Record<string, ConceptDef>;

export type ConceptName = keyof typeof CONCEPTS;

export const CONCEPT_NAMES = Object.keys(CONCEPTS) as ConceptName[];

/** Concepts denominated in the reporting currency (i.e. not share counts). */
export function isMonetary(name: ConceptName): boolean {
  const def: ConceptDef = CONCEPTS[name];
  return def.unit === undefined;
}
