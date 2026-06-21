/**
 * Deliver step — read source datasets → merge by 統編 → filter → upsert to Airtable.
 *
 * This is the ONLY writer to Airtable. It merges per §6.1 (registry wins firmographics,
 * contact sources win only contact.*, scoring.* never overwritten), resolves contact-only
 * rows via matchConfidence, keeps the working set ≤ 1,000 (free-tier cap), and upserts.
 */
import { Actor, log } from 'apify';
import {
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
}

await Actor.init();

const { datasetIds = [], maxRecords = 1000, matchThreshold = 0.85 } = (await Actor.getInput<Input>()) ?? { datasetIds: [] };

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

// Keep Airtable under the 1,000-record free cap: push only the qualified working set.
const working = [...byTongbian.values()].filter((r) => r.isActive).slice(0, maxRecords);

if (working.length === 0) {
  log.warning('Deliver produced 0 qualified rows — nothing upserted (check upstream datasets).');
} else {
  await upsertCompanies(working);
  log.info(`Upserted ${working.length} records to Airtable (of ${byTongbian.size} merged).`);
}

await Actor.exit();
