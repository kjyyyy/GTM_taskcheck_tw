import Airtable from 'airtable';
import type { CompanyRecord } from './schema.js';

const TABLE = process.env.AIRTABLE_TABLE ?? 'Companies';

function getBase(): Airtable.Base {
  const apiKey = process.env.AIRTABLE_API_KEY;
  const baseId = process.env.AIRTABLE_BASE_ID;
  if (!apiKey || !baseId) {
    throw new Error('Missing AIRTABLE_API_KEY / AIRTABLE_BASE_ID env vars');
  }
  return new Airtable({ apiKey }).base(baseId);
}

/**
 * Fields the pipeline owns. Human-owned fields (Pain/Power/Will/Stage) are
 * intentionally excluded so upserts never overwrite them. Fit is a formula field.
 */
function toFields(r: CompanyRecord): Record<string, unknown> {
  return {
    UnifiedBusinessNo: r.unifiedBusinessNo,
    // LeadKey is the merge key for standalone (no-統編) Maps leads; blank for registry firms.
    LeadKey: r.unifiedBusinessNo === '' ? r.id : '',
    Verified: r.verified,
    CompanyName: r.companyName,
    ResponsiblePerson: r.responsiblePerson,
    County: r.county,
    District: r.district,
    CapitalAmount: r.capitalAmount,
    EmployeeCount: r.employeeCount,
    Phone: r.contact.phone,
    Email: r.contact.email,
    Website: r.contact.website,
    TradeCategory: r.tradeCategory,
    Rating: r.rating,
    ReviewsCount: r.reviewCount,
    MapsCategory: r.mapsCategory,
    MapsUrl: r.mapsUrl,
    RecentTenderWin: r.signals.recentTenderWin,
    LastAwardDate: r.signals.lastAwardDate,
    LastRefreshed: r.provenance.lastRefreshed,
  };
}

async function upsertBatch(base: Airtable.Base, records: CompanyRecord[], mergeOn: string): Promise<void> {
  for (let i = 0; i < records.length; i += 10) {
    const batch = records.slice(i, i + 10).map((r) => ({ fields: toFields(r) }));
    await base(TABLE).update(batch as never, {
      performUpsert: { fieldsToMergeOn: [mergeOn] },
      typecast: true,
    } as never);
    await new Promise((res) => setTimeout(res, 250)); // stay under 5 req/s per base
  }
}

/**
 * Upsert in batches of 10 (Airtable performUpsert). Two passes so neither key collides:
 *  - registry firms (have 統編)  -> merge on UnifiedBusinessNo
 *  - standalone Maps leads (no 統編) -> merge on LeadKey (gm-<placeId|phone>)
 */
export async function upsertCompanies(records: CompanyRecord[]): Promise<void> {
  const base = getBase();
  const registry = records.filter((r) => r.unifiedBusinessNo !== '');
  const leads = records.filter((r) => r.unifiedBusinessNo === '');
  if (registry.length) await upsertBatch(base, registry, 'UnifiedBusinessNo');
  if (leads.length) await upsertBatch(base, leads, 'LeadKey');
}
