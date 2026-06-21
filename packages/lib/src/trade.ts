/** One entry in `config/industry-codes.json`. */
export interface IndustryCode {
  code: string; // 營業項目代碼, e.g. "E601010"
  desc?: string; // human label, e.g. "電業"
  tradeCategory: string; // derived bucket, e.g. "水電"
}

export type TradeLookup = Map<string, string>;

/** Build a code → tradeCategory lookup from the config list. */
export function buildTradeLookup(codes: readonly IndustryCode[]): TradeLookup {
  return new Map(codes.map((c) => [c.code, c.tradeCategory]));
}

/**
 * Derive a single `tradeCategory` for a firm from its 營業項目代碼.
 *
 * Matches the most specific (longest) code first, then falls back to prefix matches
 * (the GCIS code table is hierarchical, e.g. "E601" covers "E601010"). Returns the
 * first category found, or null if none of the firm's items are in the config set.
 */
export function tradeCategoryFor(
  industryItems: readonly string[],
  lookup: TradeLookup,
): string | null {
  for (const item of industryItems) {
    const exact = lookup.get(item);
    if (exact) return exact;
  }
  // Prefix fallback: a firm item "E601010" should match a configured "E601".
  for (const item of industryItems) {
    for (const [code, category] of lookup) {
      if (item.startsWith(code)) return category;
    }
  }
  return null;
}
