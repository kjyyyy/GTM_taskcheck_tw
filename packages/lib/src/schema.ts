export type SourceName = 'gcis' | 'tax' | 'pcc' | 'gmaps' | 'gonghui' | 'i104';

/**
 * Registry sources are authoritative for firmographics.
 * `i104` contributes only size/hiring/統編 (it leaves other firmographic fields undefined,
 * so it never clobbers GCIS), but is treated as a registry source so it can write employeeCount.
 */
export const REGISTRY_SOURCES: readonly SourceName[] = ['gcis', 'tax', 'pcc', 'i104'];
/** Contact sources are authoritative ONLY for `contact.*`. */
export const CONTACT_SOURCES: readonly SourceName[] = ['gmaps', 'gonghui'];

export interface ContactChannels {
  phone: string | null;
  lineId: string | null;
  email: string | null;
  website: string | null;
}

export interface IntentSignals {
  recentTenderWin: boolean;
  lastAwardDate: string | null;
  lastAwardAmount: number | null;
  hiringActive: boolean;
}

/**
 * Scoring is owned in Airtable: `fit` is a formula field; `pain`/`power`/`will`
 * are entered manually after a conversation. The ingest pipeline must NEVER write these.
 */
export interface Scoring {
  fit: number | null;
  pain: number | null;
  power: number | null;
  will: number | null;
  tier: 'A' | 'B' | 'C' | null;
}

export interface Provenance {
  sources: SourceName[];
  sourceMatchConfidence: Record<string, number>;
  firstSeen: string; // ISO date
  lastRefreshed: string; // ISO date
}

export interface CompanyRecord {
  id: string; // `tw-${統編}` for registry firms; `gm-${placeId|phone}` for standalone Maps leads
  unifiedBusinessNo: string; // 統一編號 — the join key; '' for standalone (unverified) Maps leads
  verified: boolean; // true when a 統編 backs this record (registry-matched); false = Maps-only lead
  companyName: string;
  responsiblePerson: string | null; // 負責人 = decision maker (from GCIS)
  companyStatus: string | null;
  isActive: boolean;
  capitalAmount: number | null; // 資本額 — universal size proxy (present for all GCIS firms)
  employeeCount: number | null; // 員工人數 — direct size signal from 104 (subset that posts jobs)
  addressRaw: string | null;
  county: string | null;
  district: string | null;
  industryItems: string[]; // 營業項目代碼
  tradeCategory: string | null; // derived in trade.ts
  contact: ContactChannels;
  signals: IntentSignals;
  // Google Maps prioritization signals (present for Maps-sourced or Maps-matched rows).
  rating: number | null; // totalScore (0–5)
  reviewCount: number | null; // reviewsCount
  mapsCategory: string | null; // categoryName
  mapsUrl: string | null; // Google Maps listing url
  placeId: string | null; // Google Maps place id (stable synthetic-key source for leads)
  scoring: Scoring; // owned in Airtable — ingest must never overwrite
  provenance: Provenance;
}

/** What each source emits after normalisation, before merge. */
export type PartialRecord = Partial<CompanyRecord> & {
  unifiedBusinessNo?: string;
  source?: SourceName;
};

/** Build the canonical primary key from a 統一編號. */
export function makeId(unifiedBusinessNo: string): string {
  return `tw-${unifiedBusinessNo}`;
}
