/**
 * Idempotent Airtable setup for the `Companies` table (matching packages/lib/src/schema.ts)
 * inside the base referenced by AIRTABLE_BASE_ID in .env.
 *
 * - If the table does not exist, it is created (CompanyName is the primary field).
 * - If it exists, only MISSING fields are added (safe to re-run after a schema change).
 * - The `Fit` formula field is created via the API (added last so its referenced fields exist).
 *
 * Usage:  node scripts/airtable-setup.mjs
 *   - AIRTABLE_API_KEY + AIRTABLE_BASE_ID are read from .env.
 *   - Token scopes: schema.bases:write, schema.bases:read, data.records:read/write + base access.
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const envPath = resolve(root, '.env');

function readEnv() {
  const out = {};
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.*?)(?:\s+#.*)?$/);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}

const env = readEnv();
const apiKey = env.AIRTABLE_API_KEY;
const baseId = env.AIRTABLE_BASE_ID;
const tableName = env.AIRTABLE_TABLE || 'Companies';

if (!apiKey) throw new Error('AIRTABLE_API_KEY missing from .env');
if (!baseId || !baseId.startsWith('app')) throw new Error('AIRTABLE_BASE_ID (app...) missing from .env');

const STAGE_CHOICES = ['Sourced', 'Contacted', 'Diagnostic', '現況地圖', 'Design partner'];
const API = 'https://api.airtable.com/v0/meta/bases';
const headers = { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' };

// Fit score (0-7). Scoring lives in Airtable, never in code.
//   contactable & not tech-enabled (0-2) + active intent (0-1) + owner-operated size (0-2)
//   + registry-verified/has 負責人 (0-1) + strong Google Maps reputation (0-1).
// The {CapitalAmount} > 0 guard stops blank-capital (unverified Maps leads) from getting a free
// size point — Airtable treats a blank number as 0, which would otherwise pass `<= 30000000`.
const FIT_FORMULA =
  'IF(AND({Phone} != "", {Website} = ""), 2, IF({Phone} != "", 1, 0))' +
  ' + IF({RecentTenderWin}, 1, 0)' +
  ' + IF({EmployeeCount}, IF({EmployeeCount} <= 10, 2, IF({EmployeeCount} <= 30, 1, 0)), IF(AND({CapitalAmount} > 0, {CapitalAmount} <= 30000000), 1, 0))' +
  ' + IF({Verified}, 1, 0)' +
  ' + IF(AND({Rating} >= 4.5, {ReviewsCount} >= 5), 1, 0)';

// First field is the table's primary field; CompanyName is the friendliest primary.
const fields = [
  { name: 'CompanyName', type: 'singleLineText' },
  { name: 'UnifiedBusinessNo', type: 'singleLineText' }, // merge key for registry firms
  { name: 'LeadKey', type: 'singleLineText' }, // merge key for standalone (no-統編) Maps leads
  { name: 'Verified', type: 'checkbox', options: { icon: 'check', color: 'greenBright' } }, // 統編-backed?
  { name: 'ResponsiblePerson', type: 'singleLineText' },
  { name: 'CompanyStatus', type: 'singleLineText' },
  { name: 'IsActive', type: 'checkbox', options: { icon: 'check', color: 'greenBright' } },
  { name: 'CapitalAmount', type: 'number', options: { precision: 0 } },
  { name: 'EmployeeCount', type: 'number', options: { precision: 0 } },
  { name: 'AddressRaw', type: 'multilineText' },
  { name: 'County', type: 'singleLineText' },
  { name: 'District', type: 'singleLineText' },
  { name: 'TradeCategory', type: 'singleLineText' },
  { name: 'Phone', type: 'singleLineText' },
  { name: 'LineId', type: 'singleLineText' },
  { name: 'Email', type: 'email' },
  { name: 'Website', type: 'url' },
  { name: 'Rating', type: 'number', options: { precision: 1 } }, // Google Maps totalScore
  { name: 'ReviewsCount', type: 'number', options: { precision: 0 } },
  { name: 'MapsCategory', type: 'singleLineText' },
  { name: 'MapsUrl', type: 'url' },
  { name: 'RecentTenderWin', type: 'checkbox', options: { icon: 'check', color: 'greenBright' } },
  { name: 'LastAwardDate', type: 'date', options: { dateFormat: { name: 'iso' } } },
  { name: 'LastAwardAmount', type: 'number', options: { precision: 0 } },
  { name: 'HiringActive', type: 'checkbox', options: { icon: 'check', color: 'greenBright' } },
  { name: 'LastRefreshed', type: 'date', options: { dateFormat: { name: 'iso' } } },
  { name: 'Sources', type: 'multilineText' },
  // Human-owned (pipeline never writes these):
  { name: 'Pain', type: 'number', options: { precision: 0 } },
  { name: 'Power', type: 'number', options: { precision: 0 } },
  { name: 'Will', type: 'number', options: { precision: 0 } },
  { name: 'Tier', type: 'singleSelect', options: { choices: [{ name: 'A' }, { name: 'B' }, { name: 'C' }] } },
  { name: 'Stage', type: 'singleSelect', options: { choices: STAGE_CHOICES.map((name) => ({ name })) } },
  { name: 'LostReason', type: 'singleLineText' },
  // Formula — added LAST (references fields above). API supports creating formula fields.
  { name: 'Fit', type: 'formula', options: { formula: FIT_FORMULA } },
];

async function api(path, init) {
  const res = await fetch(`${API}/${baseId}${path}`, { headers, ...init });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error(`Airtable API error (${res.status}) on ${path}:`, JSON.stringify(json, null, 2));
    process.exit(1);
  }
  return json;
}

const { tables } = await api('/tables', { method: 'GET' });
const existing = tables.find((t) => t.name === tableName);

if (!existing) {
  // Fresh table: create without the formula, then add Fit so its references resolve.
  const created = await api('/tables', {
    method: 'POST',
    body: JSON.stringify({
      name: tableName,
      description: 'Owner-operated TW subcontractor leads (registry firms keyed on 統一編號; Maps leads on LeadKey).',
      fields: fields.filter((f) => f.type !== 'formula'),
    }),
  });
  await api(`/tables/${created.id}/fields`, { method: 'POST', body: JSON.stringify({ name: 'Fit', type: 'formula', options: { formula: FIT_FORMULA } }) });
  console.log(`Created table "${created.name}" (${created.id}) with ${created.fields.length + 1} fields.`);
} else {
  const have = new Map(existing.fields.map((f) => [f.name, f]));
  const missing = fields.filter((f) => !have.has(f.name));
  for (const f of missing) {
    await api(`/tables/${existing.id}/fields`, { method: 'POST', body: JSON.stringify(f) });
    console.log(`+ added field "${f.name}" (${f.type})`);
    await new Promise((r) => setTimeout(r, 250));
  }
  console.log(
    missing.length
      ? `Updated table "${tableName}" (${existing.id}); added ${missing.length} field(s).`
      : `Table "${tableName}" already has all ${fields.length} fields.`,
  );
  // Keep the Fit formula in sync. The Meta API CAN patch a formula's options; Airtable stores the
  // expression in field-ID form (not names), so we can't reliably diff it — just re-apply (idempotent).
  const fit = have.get('Fit');
  if (fit) {
    await api(`/tables/${existing.id}/fields/${fit.id}`, { method: 'PATCH', body: JSON.stringify({ options: { formula: FIT_FORMULA } }) });
    console.log('~ ensured "Fit" formula matches the canonical scoring expression.');
  }
}

console.log(`
Manual step (API can't create views): add a Kanban view grouped on "Stage"
(${STAGE_CHOICES.join(' → ')}). Then you're ready to run the pipeline.`);
