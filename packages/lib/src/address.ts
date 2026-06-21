export interface ParsedAddress {
  county: string | null; // 縣市
  district: string | null; // 區 / 鄉 / 鎮 / 縣轄市
}

/** Strip a leading postal code (3 or 3+3 digits) and surrounding whitespace. */
function stripPostalCode(addressRaw: string): string {
  return addressRaw.replace(/^\s*\d{3}(?:-?\d{2,3})?\s*/, '').trim();
}

/**
 * Parse 縣市 / 區 out of a raw Taiwanese address.
 *
 * `counties` is the authoritative 縣市 list from `config/counties.json` — pass it in
 * rather than hardcoding, per the targeting convention. The district is the first token
 * after the county ending in 區/鄉/鎮/市.
 */
export function parseAddress(
  addressRaw: string | null | undefined,
  counties: readonly string[],
): ParsedAddress {
  if (!addressRaw) return { county: null, district: null };

  const cleaned = stripPostalCode(addressRaw);

  // Longest county name first so "臺中市" wins over a bare "市" style false match.
  const sorted = [...counties].sort((a, b) => b.length - a.length);
  const county = sorted.find((c) => cleaned.startsWith(c)) ?? null;

  let district: string | null = null;
  const afterCounty = county ? cleaned.slice(county.length) : cleaned;
  const districtMatch = afterCounty.match(/^([\u4e00-\u9fa5]{1,4}?[區鄉鎮市])/);
  if (districtMatch) district = districtMatch[1];

  return { county, district };
}
