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
    CompanyName: r.companyName,
    ResponsiblePerson: r.responsiblePerson,
    County: r.county,
    District: r.district,
    Phone: r.contact.phone,
    Email: r.contact.email,
    Website: r.contact.website,
    TradeCategory: r.tradeCategory,
    RecentTenderWin: r.signals.recentTenderWin,
    LastAwardDate: r.signals.lastAwardDate,
    LastRefreshed: r.provenance.lastRefreshed,
  };
}

/**
 * Upsert in batches of 10, matching on UnifiedBusinessNo (Airtable performUpsert).
 * Sleeps between batches to stay under the 5 req/sec per-base limit.
 */
export async function upsertCompanies(records: CompanyRecord[]): Promise<void> {
  const base = getBase();
  for (let i = 0; i < records.length; i += 10) {
    const batch = records.slice(i, i + 10).map((r) => ({ fields: toFields(r) }));
    await base(TABLE).update(batch as never, {
      performUpsert: { fieldsToMergeOn: ['UnifiedBusinessNo'] },
      typecast: true,
    } as never);
    await new Promise((res) => setTimeout(res, 250)); // stay under 5 req/s per base
  }
}
