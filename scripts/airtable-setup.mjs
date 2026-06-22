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

// 1 when a follow-up is due today or overdue (drives the "Follow-ups due" view). Recomputes daily.
// "Today" is anchored to Asia/Taipei (the ICP's clock) — not GMT, which Airtable's TODAY() uses and
// which would flip the same-day case near the UTC midnight boundary. Both sides land on midnight-UTC
// of their respective calendar date, so the day-granularity comparison is exact.
const TAIPEI_TODAY = "DATETIME_PARSE(DATETIME_FORMAT(SET_TIMEZONE(NOW(), 'Asia/Taipei'), 'YYYY-MM-DD'), 'YYYY-MM-DD')";
const FOLLOWUP_DUE_FORMULA = `IF(AND({NextFollowUpDate}, NOT(IS_AFTER({NextFollowUpDate}, ${TAIPEI_TODAY}))), 1, 0)`;

// Funnel metric helpers (0/1). The grid summary bar's AVERAGE of a 0/1 column = that rate
// (e.g. avg of Connected = connect rate); SUM = the count. Filtering the view changes the
// denominator (filter Connected = 1, then avg of Interested = interest-rate-among-connected).
const TOUCHED_FORMULA = 'IF({Attempts}, 1, 0)';
const CONNECTED_FORMULA = 'IF(FIND("接通", {Disposition} & ""), 1, 0)'; // any 接通-* disposition
const INTERESTED_FORMULA = 'IF({Disposition} = "接通-有興趣", 1, 0)';
const WON_FORMULA = 'IF({Stage} = "Design partner", 1, 0)';

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
  // Outreach tracking (human-owned — logged per call/LINE touch):
  { name: 'LastContactedDate', type: 'date', options: { dateFormat: { name: 'iso' } } },
  { name: 'NextFollowUpDate', type: 'date', options: { dateFormat: { name: 'iso' } } },
  {
    name: 'ContactChannel',
    type: 'singleSelect',
    options: { choices: ['Phone', 'LINE', 'In-person', 'Other'].map((name) => ({ name })) },
  },
  { name: 'Attempts', type: 'number', options: { precision: 0 } },
  {
    name: 'Disposition',
    type: 'singleSelect',
    options: {
      choices: ['接通-有興趣', '接通-暫不需要', '接通-不適合', '未接', '守門員', '約回電', '婉拒勿擾'].map((name) => ({ name })),
    },
  },
  { name: 'Owner', type: 'singleLineText' },
  { name: 'Notes', type: 'multilineText' },
  // Formula fields — added LAST (reference fields above). API supports creating formula fields.
  { name: 'Fit', type: 'formula', options: { formula: FIT_FORMULA } },
  { name: 'FollowUpDue', type: 'formula', options: { formula: FOLLOWUP_DUE_FORMULA } },
  // Funnel metric helpers (0/1) — read rates off the summary bar's Average. Hide in call views.
  { name: 'Touched', type: 'formula', options: { formula: TOUCHED_FORMULA } },
  { name: 'Connected', type: 'formula', options: { formula: CONNECTED_FORMULA } },
  { name: 'Interested', type: 'formula', options: { formula: INTERESTED_FORMULA } },
  { name: 'Won', type: 'formula', options: { formula: WON_FORMULA } },
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

const formulaFields = fields.filter((f) => f.type === 'formula');

if (!existing) {
  // Fresh table: create without formulas, then add each formula so its references resolve.
  const created = await api('/tables', {
    method: 'POST',
    body: JSON.stringify({
      name: tableName,
      description: 'Owner-operated TW subcontractor leads (registry firms keyed on 統一編號; Maps leads on LeadKey).',
      fields: fields.filter((f) => f.type !== 'formula'),
    }),
  });
  for (const f of formulaFields) {
    await api(`/tables/${created.id}/fields`, { method: 'POST', body: JSON.stringify(f) });
    await new Promise((r) => setTimeout(r, 250));
  }
  console.log(`Created table "${created.name}" (${created.id}) with ${created.fields.length + formulaFields.length} fields.`);
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
  // Keep formula fields in sync. The Meta API CAN patch a formula's options; Airtable stores the
  // expression in field-ID form (not names), so we can't reliably diff it — just re-apply (idempotent).
  for (const f of formulaFields) {
    const live = have.get(f.name);
    if (live) {
      await api(`/tables/${existing.id}/fields/${live.id}`, { method: 'PATCH', body: JSON.stringify({ options: f.options }) });
      console.log(`~ ensured "${f.name}" formula matches the canonical expression.`);
      await new Promise((r) => setTimeout(r, 250));
    }
  }
}

console.log(`
Manual step (API can't create views): add a Kanban view grouped on "Stage"
(${STAGE_CHOICES.join(' → ')}). Then you're ready to run the pipeline.`);
