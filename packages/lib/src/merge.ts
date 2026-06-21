import {
  type CompanyRecord,
  type PartialRecord,
  type SourceName,
  CONTACT_SOURCES,
  REGISTRY_SOURCES,
  makeId,
} from './schema.js';

const isRegistrySource = (s: SourceName): boolean => REGISTRY_SOURCES.includes(s);
const isContactSource = (s: SourceName): boolean => CONTACT_SOURCES.includes(s);

const todayIso = (): string => new Date().toISOString().slice(0, 10);

/** A fresh canonical record with safe defaults. */
function createEmpty(unifiedBusinessNo: string, now: string): CompanyRecord {
  return {
    id: makeId(unifiedBusinessNo),
    unifiedBusinessNo,
    verified: unifiedBusinessNo !== '',
    companyName: '',
    responsiblePerson: null,
    companyStatus: null,
    isActive: false,
    capitalAmount: null,
    employeeCount: null,
    addressRaw: null,
    county: null,
    district: null,
    industryItems: [],
    tradeCategory: null,
    contact: { phone: null, lineId: null, email: null, website: null },
    signals: { recentTenderWin: false, lastAwardDate: null, lastAwardAmount: null, hiringActive: false },
    rating: null,
    reviewCount: null,
    mapsCategory: null,
    mapsUrl: null,
    placeId: null,
    scoring: { fit: null, pain: null, power: null, will: null, tier: null },
    provenance: { sources: [], sourceMatchConfidence: {}, firstSeen: now, lastRefreshed: now },
  };
}

/** Overwrite `target` with `value` only when the incoming value is defined (not undefined). */
function applyIfDefined<T, K extends keyof T>(target: T, key: K, value: T[K] | undefined): void {
  if (value !== undefined) target[key] = value;
}

/**
 * Upsert a normalised partial onto an existing record (or create one).
 *
 * Rules (§6.1):
 *  - merge by unifiedBusinessNo
 *  - registry sources win on firmographics; contact sources win only on contact.*
 *  - NEVER overwrite scoring.* or any downstream-owned field
 *  - update provenance.sources / lastRefreshed
 *
 * Note: contact rows lacking a 統編 must be resolved to a target via `matchConfidence`
 * BEFORE calling this (the caller supplies the matched record as `existing`). This
 * function never lets a contact source touch a firmographic field, and vice versa.
 */
export function mergeRecord(
  existing: CompanyRecord | null,
  incoming: PartialRecord,
  source: SourceName,
  now: string = todayIso(),
): CompanyRecord {
  const key = incoming.unifiedBusinessNo ?? existing?.unifiedBusinessNo;
  if (!key) {
    throw new Error('mergeRecord: cannot merge without a unifiedBusinessNo (resolve contact rows via matchConfidence first)');
  }

  const base = existing ?? createEmpty(key, now);
  const result: CompanyRecord = {
    ...base,
    contact: { ...base.contact },
    signals: { ...base.signals },
    scoring: { ...base.scoring }, // preserved verbatim — never overwritten below
    provenance: {
      ...base.provenance,
      sources: [...base.provenance.sources],
      sourceMatchConfidence: { ...base.provenance.sourceMatchConfidence },
    },
    industryItems: [...base.industryItems],
  };

  if (isRegistrySource(source)) {
    // Registry is authoritative for firmographics (last-write-wins within registry).
    applyIfDefined(result, 'companyName', incoming.companyName);
    applyIfDefined(result, 'responsiblePerson', incoming.responsiblePerson);
    applyIfDefined(result, 'companyStatus', incoming.companyStatus);
    applyIfDefined(result, 'isActive', incoming.isActive);
    applyIfDefined(result, 'capitalAmount', incoming.capitalAmount);
    applyIfDefined(result, 'employeeCount', incoming.employeeCount);
    applyIfDefined(result, 'addressRaw', incoming.addressRaw);
    applyIfDefined(result, 'county', incoming.county);
    applyIfDefined(result, 'district', incoming.district);
    applyIfDefined(result, 'tradeCategory', incoming.tradeCategory);
    if (incoming.industryItems) {
      result.industryItems = [...new Set([...result.industryItems, ...incoming.industryItems])];
    }
  }

  if (isContactSource(source)) {
    // Contact sources are authoritative ONLY for contact channels...
    if (incoming.contact) {
      applyIfDefined(result.contact, 'phone', incoming.contact.phone);
      applyIfDefined(result.contact, 'lineId', incoming.contact.lineId);
      applyIfDefined(result.contact, 'email', incoming.contact.email);
      applyIfDefined(result.contact, 'website', incoming.contact.website);
    }
    // ...plus Google Maps prioritization signals (rating/reviews/category/url/placeId),
    // which attach to matched registry firms too — they are not firmographics.
    applyIfDefined(result, 'rating', incoming.rating);
    applyIfDefined(result, 'reviewCount', incoming.reviewCount);
    applyIfDefined(result, 'mapsCategory', incoming.mapsCategory);
    applyIfDefined(result, 'mapsUrl', incoming.mapsUrl);
    applyIfDefined(result, 'placeId', incoming.placeId);
  }

  // Intent signals come from registry sources (mainly PCC). Merge any provided fields.
  if (incoming.signals) {
    applyIfDefined(result.signals, 'recentTenderWin', incoming.signals.recentTenderWin);
    applyIfDefined(result.signals, 'lastAwardDate', incoming.signals.lastAwardDate);
    applyIfDefined(result.signals, 'lastAwardAmount', incoming.signals.lastAwardAmount);
    applyIfDefined(result.signals, 'hiringActive', incoming.signals.hiringActive);
  }

  // Provenance bookkeeping.
  if (!result.provenance.sources.includes(source)) result.provenance.sources.push(source);
  if (incoming.provenance?.sourceMatchConfidence) {
    Object.assign(result.provenance.sourceMatchConfidence, incoming.provenance.sourceMatchConfidence);
  }
  result.provenance.lastRefreshed = now;

  return result;
}

/**
 * Build a contact-only record for a Maps/公會 row that did NOT match any registry firm.
 *
 * These leads have no 統一編號, so they get a synthetic stable id (`gm-<placeId>`, falling back
 * to `gm-<phone digits>`) used as the Airtable merge key, and `verified: false`. The decision
 * maker (負責人) is unknown — you call the listed business line. Throws if there is neither a
 * placeId nor a phone (nothing stable to key on, and nothing to call).
 */
export function buildStandaloneLead(incoming: PartialRecord, now: string = todayIso()): CompanyRecord {
  const phoneDigits = normalisePhone(incoming.contact?.phone);
  const key = incoming.placeId ? `gm-${incoming.placeId}` : phoneDigits ? `gm-${phoneDigits}` : null;
  if (!key) {
    throw new Error('buildStandaloneLead: need a placeId or phone to key an unmatched lead');
  }
  const base = createEmpty('', now);
  return {
    ...base,
    id: key,
    verified: false,
    companyName: incoming.companyName ?? '',
    county: incoming.county ?? null,
    district: incoming.district ?? null,
    addressRaw: incoming.addressRaw ?? null,
    tradeCategory: incoming.tradeCategory ?? null,
    contact: {
      phone: incoming.contact?.phone ?? null,
      lineId: incoming.contact?.lineId ?? null,
      email: incoming.contact?.email ?? null,
      website: incoming.contact?.website ?? null,
    },
    rating: incoming.rating ?? null,
    reviewCount: incoming.reviewCount ?? null,
    mapsCategory: incoming.mapsCategory ?? null,
    mapsUrl: incoming.mapsUrl ?? null,
    placeId: incoming.placeId ?? null,
    isActive: true,
    provenance: {
      sources: incoming.source ? [incoming.source] : [],
      sourceMatchConfidence: {},
      firstSeen: now,
      lastRefreshed: now,
    },
  };
}

const COMPANY_SUFFIXES = /(股份)?有限公司|企業社|工程行|工作室|商行|行$|公司|company|co\.?,?\s*ltd\.?/giu;

/** Normalise a company name for fuzzy comparison: drop legal suffixes, spaces, punctuation. */
function normaliseName(name: string): string {
  return name
    .replace(COMPANY_SUFFIXES, '')
    .replace(/[\s\u3000().,、・·-]/g, '')
    .toLowerCase()
    .trim();
}

/** Keep digits only, so "03-1234567" and "(03) 1234 567" compare equal. */
function normalisePhone(phone: string | null | undefined): string {
  return (phone ?? '').replace(/\D/g, '');
}

/** Levenshtein-based similarity in [0, 1]. */
function stringSimilarity(a: string, b: string): number {
  if (!a && !b) return 1;
  if (!a || !b) return 0;
  if (a === b) return 1;
  const m = a.length;
  const n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) => i);
  for (let j = 1; j <= n; j++) {
    let prev = dp[0];
    dp[0] = j;
    for (let i = 1; i <= m; i++) {
      const tmp = dp[i];
      dp[i] = a[i - 1] === b[j - 1] ? prev : 1 + Math.min(prev, dp[i], dp[i - 1]);
      prev = tmp;
    }
  }
  return 1 - dp[m] / Math.max(m, n);
}

/**
 * Probabilistic match for contact sources lacking 統編 (gmaps/gonghui).
 * Returns 0–1 from normalised name + phone + address (county/district) similarity.
 * Auto-merge only when >= 0.85; otherwise queue for manual confirm.
 */
export function matchConfidence(candidate: PartialRecord, target: CompanyRecord): number {
  // Exact phone match is the strongest single signal.
  const candPhone = normalisePhone(candidate.contact?.phone);
  const targetPhone = normalisePhone(target.contact.phone);
  const phoneScore = candPhone && targetPhone ? (candPhone === targetPhone ? 1 : 0) : 0;
  const hasPhone = Boolean(candPhone && targetPhone);

  const nameScore = candidate.companyName
    ? stringSimilarity(normaliseName(candidate.companyName), normaliseName(target.companyName))
    : 0;

  // Canonicalise 台/臺 so e.g. "台中市" (公會) matches "臺中市" (registry CSV).
  const canon = (s: string | null | undefined): string => (s ?? '').replace(/台/g, '臺');
  let geoScore = 0;
  if (candidate.county && target.county) {
    geoScore = canon(candidate.county) === canon(target.county) ? 0.5 : 0;
    if (candidate.district && target.district && canon(candidate.district) === canon(target.district)) {
      geoScore = 1;
    }
  }

  // Weight phone heavily; if no phone on either side, redistribute its weight to name.
  const weights = hasPhone
    ? { phone: 0.5, name: 0.3, geo: 0.2 }
    : { phone: 0, name: 0.8, geo: 0.2 };

  return Number(
    (phoneScore * weights.phone + nameScore * weights.name + geoScore * weights.geo).toFixed(4),
  );
}
