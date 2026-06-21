export type SourceName = 'gcis' | 'tax' | 'pcc' | 'gmaps' | 'gonghui' | 'i104';

/** Registry sources are authoritative for firmographics. */
export const REGISTRY_SOURCES: readonly SourceName[] = ['gcis', 'tax', 'pcc'];
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
  id: string; // `tw-${unifiedBusinessNo}`
  unifiedBusinessNo: string; // 統一編號 — the join key
  companyName: string;
  responsiblePerson: string | null; // 負責人 = decision maker (from GCIS)
  companyStatus: string | null;
  isActive: boolean;
  capitalAmount: number | null;
  addressRaw: string | null;
  county: string | null;
  district: string | null;
  industryItems: string[]; // 營業項目代碼
  tradeCategory: string | null; // derived in trade.ts
  contact: ContactChannels;
  signals: IntentSignals;
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
