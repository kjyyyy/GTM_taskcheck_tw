/**
 * Deliver step — read source datasets → merge by 統編 → filter → upsert to Airtable.
 *
 * This is the ONLY writer to Airtable. It merges per §6.1 (registry wins firmographics,
 * contact sources win only contact.*, scoring.* never overwritten), resolves contact-only
 * rows via matchConfidence, keeps the working set ≤ 1,000 (free-tier cap), and upserts.
 */
import { Actor, log } from 'apify';
import {
  buildStandaloneLead,
  matchConfidence,
  mergeRecord,
  upsertCompanies,
  type CompanyRecord,
  type PartialRecord,
} from '@ruizhu/lib';

interface Input {
  datasetIds: string[];
  maxRecords?: number;
  matchThreshold?: number;
  counties?: string[]; // focus the working set on these 縣市 (e.g. ["臺中市"]); empty = nationwide
  maxEmployees?: number; // ICP size ceiling; drops firms whose headcount is KNOWN and above it
  enrichDecisionMaker?: boolean; // backfill 負責人 + active status per-統編 (GCIS company-basic API)
  gcisCompanyApiOid?: string;
  keepUnmatchedLeads?: boolean; // persist phone-bearing Maps/公會 rows that matched no registry firm
}

await Actor.init();

const {
  datasetIds = [],
  maxRecords = 1000,
  matchThreshold = 0.85,
  counties = [],
  maxEmployees,
  enrichDecisionMaker = true,
  gcisCompanyApiOid = '5F64D864-61CB-4D0D-8AD9-492047CC1EA6',
  keepUnmatchedLeads = true,
} = (await Actor.getInput<Input>()) ?? { datasetIds: [] };

/** Normalise 台/臺 spelling so county filtering matches regardless of variant. */
const normaliseCounty = (c: string | null): string => (c ?? '').replace(/台/g, '臺');
const countyFocus = new Set(counties.map(normaliseCounty));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Backfill 負責人 (decision maker) + active status for ONE firm via the GCIS company-basic
 * OpenData API (filtered by 統編). Bounded — only ever called on the small working set.
 * Returns true if the firm is active per its registry status.
 */
async function enrichOne(record: CompanyRecord): Promise<boolean> {
  const url =
    `https://data.gcis.nat.gov.tw/od/data/api/${gcisCompanyApiOid}` +
    `?$format=json&$filter=Business_Accounting_NO eq ${encodeURIComponent(record.unifiedBusinessNo)}&$top=1`;
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(url);
    if (res.ok) {
      const rows = (await res.json()) as Array<{ Responsible_Name?: string; Company_Status_Desc?: string }>;
      const row = rows[0];
      if (!row) return record.isActive; // not found → keep prior assumption
      if (!record.responsiblePerson && row.Responsible_Name) record.responsiblePerson = row.Responsible_Name.trim();
      if (row.Company_Status_Desc) {
        record.companyStatus = row.Company_Status_Desc;
        record.isActive = row.Company_Status_Desc.includes('核准設立');
      }
      return record.isActive;
    }
    if (res.status === 429 || res.status >= 500) {
      await sleep(800 * 2 ** attempt);
      continue;
    }
    return record.isActive; // 4xx (other) → don't block delivery
  }
  return record.isActive;
}

const byTongbian = new Map<string, CompanyRecord>();
const contactOnly: PartialRecord[] = []; // rows lacking 統編 (gmaps / gonghui)

for (const id of datasetIds) {
  const dataset = await Actor.openDataset(id);
  const { items } = await dataset.getData();
  for (const row of items as PartialRecord[]) {
    if (row.unifiedBusinessNo) {
      const merged = mergeRecord(byTongbian.get(row.unifiedBusinessNo) ?? null, row, row.source!);
      byTongbian.set(merged.unifiedBusinessNo, merged);
    } else {
      contactOnly.push(row);
    }
  }
}

// Resolve contact-only rows probabilistically (§6.1). Auto-merge ≥ threshold; else queue.
const needsConfirm: Array<{ candidate: PartialRecord; bestMatch: string | null; confidence: number }> = [];
const records = [...byTongbian.values()];
for (const candidate of contactOnly) {
  let best: CompanyRecord | null = null;
  let bestScore = 0;
  for (const target of records) {
    const score = matchConfidence(candidate, target);
    if (score > bestScore) {
      bestScore = score;
      best = target;
    }
  }
  if (best && bestScore >= matchThreshold) {
    const withConfidence: PartialRecord = {
      ...candidate,
      unifiedBusinessNo: best.unifiedBusinessNo,
      provenance: { ...candidate.provenance, sourceMatchConfidence: { [candidate.source ?? 'unknown']: bestScore } } as PartialRecord['provenance'],
    };
    const merged = mergeRecord(best, withConfidence, candidate.source!);
    byTongbian.set(merged.unifiedBusinessNo, merged);
  } else {
    needsConfirm.push({ candidate, bestMatch: best?.unifiedBusinessNo ?? null, confidence: bestScore });
  }
}

if (needsConfirm.length) {
  log.warning(`${needsConfirm.length} contact rows below match threshold (${matchThreshold}) — queued for manual confirm.`);
  await Actor.setValue('NEEDS_CONFIRM', needsConfirm);
}

const inFocus = (c: string | null): boolean => countyFocus.size === 0 || countyFocus.has(normaliseCounty(c));

// Standalone leads: phone-bearing contact rows that matched NO registry firm. They have no 統編
// (call the business line) and are flagged unverified. They are scarce + high-value, so we reserve
// their budget FIRST, then fill the remaining cap with verified registry firms.
const leads: CompanyRecord[] = [];
if (keepUnmatchedLeads) {
  const seen = new Set<string>();
  for (const { candidate } of needsConfirm) {
    if (!candidate.contact?.phone || !inFocus(candidate.county ?? null)) continue;
    let lead: CompanyRecord;
    try {
      lead = buildStandaloneLead(candidate);
    } catch {
      continue; // no placeId/phone to key on
    }
    if (seen.has(lead.id)) continue;
    seen.add(lead.id);
    leads.push(lead);
  }
}
const leadsToAdd = leads.slice(0, maxRecords);
const registryBudget = Math.max(0, maxRecords - leadsToAdd.length);

// Registry working set: county focus + ICP size gate (only drops firms whose headcount is KNOWN
// and above the ceiling — unknown-size firms are kept). isActive is applied AFTER enrichment so
// registry status can correct the CSV's optimistic default.
const candidates = [...byTongbian.values()]
  .filter((r) => inFocus(r.county))
  .filter((r) => maxEmployees === undefined || r.employeeCount === null || r.employeeCount <= maxEmployees)
  .slice(0, registryBudget);

if (enrichDecisionMaker && candidates.length) {
  log.info(`Enriching 負責人 + status for ${candidates.length} candidates via GCIS company-basic API…`);
  let filled = 0;
  for (const r of candidates) {
    await enrichOne(r);
    if (r.responsiblePerson) filled += 1;
    await sleep(200); // stay polite under the OpenData API
  }
  log.info(`Enrichment done: ${filled}/${candidates.length} have a 負責人.`);
}

const workingRegistry = candidates.filter((r) => r.isActive);
const working = [...workingRegistry, ...leadsToAdd];

if (working.length === 0) {
  log.warning('Deliver produced 0 qualified rows — nothing upserted (check upstream datasets).');
} else {
  await upsertCompanies(working);
  log.info(
    `Upserted ${working.length} records (${workingRegistry.length} verified firms + ${leadsToAdd.length} Maps leads) to Airtable, of ${byTongbian.size} merged.`,
  );
}

await Actor.exit();
