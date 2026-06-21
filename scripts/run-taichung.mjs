/**
 * Local Taichung orchestration — a no-Apify way to run the pipeline end-to-end into Airtable
 * for validation / first leads. Mirrors actors/gcis (taichung-csv) + actors/gonghui, then uses
 * @ruizhu/lib for merge/match/enrich/upsert. For production scale, run the actors on Apify.
 *
 * Usage: node scripts/run-taichung.mjs [maxRecords]
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parse } from 'csv-parse/sync';
import * as cheerio from 'cheerio';
import { mergeRecord, matchConfidence, parseAddress, upsertCompanies, buildStandaloneLead } from '../packages/lib/dist/index.js';

const execFileP = promisify(execFile);

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cfg = (f) => JSON.parse(readFileSync(resolve(root, 'config', f), 'utf8'));

// Load .env into process.env (upsertCompanies reads AIRTABLE_* at call time).
for (const line of readFileSync(resolve(root, '.env'), 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_]+)=(.*?)(?:\s+#.*)?$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
}

const args = process.argv.slice(2);
const maxRecords = Number(args.find((a) => /^\d+$/.test(a)) ?? 60);
const withGmaps = args.includes('gmaps');
const reuseRunId = args.find((a) => a.startsWith('reuse='))?.slice('reuse='.length); // skip a paid re-scrape
const { counties } = cfg('counties.json');
const gcisSources = cfg('gcis-sources.json');
const { sites } = cfg('gonghui-sites.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * The gov endpoints (data.gcis.nat.gov.tw) have a slow TLS handshake that Node's undici
 * aborts; curl -4 handles it reliably. Shell out to curl for those, with retries.
 */
async function curlText(url, { tries = 4, timeoutSec = 60 } = {}) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const { stdout } = await execFileP('curl', ['-s', '-4', '--max-time', String(timeoutSec), url], {
        maxBuffer: 64 * 1024 * 1024,
      });
      if (stdout && stdout.length) return stdout;
    } catch (e) {
      lastErr = e;
    }
    await sleep(1000 * 2 ** i);
  }
  throw lastErr ?? new Error(`curl failed: ${url}`);
}

// --- 1. GCIS Taichung CSV ---
const fileOid = gcisSources.sources.taichungConstruction.fileOid;
console.log('GCIS: downloading Taichung CSV…');
const csv = await curlText(`https://data.gcis.nat.gov.tw/od/file?oid=${fileOid}`, { timeoutSec: 120 });
const rows = parse(csv, { columns: true, skip_empty_lines: true, relax_column_count: true, bom: true });

const byTongbian = new Map();
for (const row of rows) {
  const ubn = (row['統一編號'] ?? '').trim();
  if (!ubn) continue;
  const addressRaw = (row['公司地址'] || row['營業地址（財政資訊中心匯入）'] || '').trim() || null;
  const { county, district } = parseAddress(addressRaw, counties);
  const merged = mergeRecord(byTongbian.get(ubn) ?? null, {
    source: 'gcis',
    unifiedBusinessNo: ubn,
    companyName: (row['公司名稱'] ?? '').trim(),
    responsiblePerson: null,
    isActive: true,
    capitalAmount: Number(row['資本總額']) || null,
    addressRaw,
    county,
    district,
    industryItems: [],
    tradeCategory: '營造',
  }, 'gcis');
  byTongbian.set(ubn, merged);
}
console.log(`GCIS: ${byTongbian.size} Taichung firms.`);

// --- 2. 公會 roster (contact + decision maker) ---
const today = () => new Date().toISOString().slice(0, 10);
const contactOnly = [];
for (const site of sites) {
  for (const url of site.startUrls) {
    const html = await curlText(url);
    const $ = cheerio.load(html);
    let n = 0;
    $(site.rowSelector).each((_, el) => {
      if (site.numericFirstCell && !/^\d+$/.test($(el).children().first().text().trim())) return;
      const companyName = $(el).find(site.nameSelector).text().trim();
      if (!companyName) return;
      const phone = $(el).find(site.phoneSelector).text().trim() || null;
      const addressRaw = site.addressSelector ? $(el).find(site.addressSelector).text().trim() || null : null;
      const parsed = addressRaw ? parseAddress(addressRaw, counties) : { county: null, district: null };
      contactOnly.push({
        source: 'gonghui',
        companyName,
        addressRaw,
        county: parsed.county ?? site.county ?? null,
        district: parsed.district,
        contact: { phone, lineId: null, email: null, website: null },
        provenance: { sources: ['gonghui'], sourceMatchConfidence: {}, firstSeen: today(), lastRefreshed: today() },
      });
      n += 1;
    });
    console.log(`公會 [${site.name}]: ${n} members.`);
  }
}

// --- 2b. Google Maps (optional, paid) — phone + no-website signal for non-公會 firms ---
if (withGmaps) {
  const token = process.env.APIFY_TOKEN;
  if (!token) throw new Error('APIFY_TOKEN missing from .env');
  const { searchTerms } = cfg('gmaps-search-terms.json');
  const ACTOR = 'nwua9Gu5YrADL7ZDj'; // compass/crawler-google-places
  const input = {
    searchStringsArray: searchTerms,
    locationQuery: '臺中市, Taiwan',
    language: 'zh-TW',
    maxCrawledPlacesPerSearch: 15, // bounded — keeps cost < ~$1
    skipClosedPlaces: true,
    maxReviews: 0,
    maxImages: 0,
  };
  let runId;
  let datasetId;
  let status;
  if (reuseRunId) {
    // Reuse a prior successful run's dataset — no new (paid) scrape.
    const r = await fetch(`https://api.apify.com/v2/actor-runs/${reuseRunId}?token=${token}`).then((x) => x.json());
    runId = reuseRunId;
    datasetId = r.data.defaultDatasetId;
    status = r.data.status;
    console.log(`gmaps: reusing run ${runId} (dataset ${datasetId}) → ${status}`);
  } else {
    console.log(`gmaps: starting Apify run (${searchTerms.length} terms × 15 places)…`);
    const start = await fetch(`https://api.apify.com/v2/acts/${ACTOR}/runs?token=${token}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    }).then((r) => r.json());
    runId = start.data.id;
    datasetId = start.data.defaultDatasetId;
    status = start.data.status;
    for (let i = 0; i < 120 && !['SUCCEEDED', 'FAILED', 'ABORTED', 'TIMED-OUT'].includes(status); i++) {
      await sleep(10000);
      const r = await fetch(`https://api.apify.com/v2/actor-runs/${runId}?token=${token}`).then((x) => x.json());
      status = r.data.status;
    }
    console.log(`gmaps: run ${runId} → ${status}`);
  }
  if (status === 'SUCCEEDED') {
    const places = await fetch(`https://api.apify.com/v2/datasets/${datasetId}/items?token=${token}&clean=true`).then((r) => r.json());
    let n = 0;
    for (const p of places) {
      if (!p.title || p.permanentlyClosed || p.temporarilyClosed) continue;
      const parsed = parseAddress(p.address ?? null, counties);
      contactOnly.push({
        source: 'gmaps',
        companyName: p.title,
        addressRaw: p.address ?? null,
        county: parsed.county,
        district: parsed.district,
        contact: { phone: p.phoneUnformatted ?? p.phone ?? null, lineId: null, email: null, website: p.website ?? null },
        rating: p.totalScore ?? null,
        reviewCount: p.reviewsCount ?? null,
        mapsCategory: p.categoryName ?? null,
        mapsUrl: p.url ?? null,
        placeId: p.placeId ?? null,
        provenance: { sources: ['gmaps'], sourceMatchConfidence: {}, firstSeen: today(), lastRefreshed: today() },
      });
      n += 1;
    }
    console.log(`gmaps: ${n} places (${places.length} raw).`);
  } else {
    console.warn('gmaps: run did not succeed — continuing without Maps rows.');
  }
}

// --- 3. Match contact-only rows onto GCIS firms; keep unmatched phone-bearing as leads ---
const inFocus = (c) => (c ?? '').replace(/台/g, '臺') === '臺中市';
const registry = [...byTongbian.values()];
const matchedKeys = new Set();
const leadById = new Map(); // unmatched standalone leads, deduped by synthetic id
let matched = 0;
for (const cand of contactOnly) {
  let best = null;
  let bestScore = 0;
  for (const t of registry) {
    const s = matchConfidence(cand, t);
    if (s > bestScore) { bestScore = s; best = t; }
  }
  if (best && bestScore >= 0.85) {
    byTongbian.set(best.unifiedBusinessNo, mergeRecord(best, { ...cand, unifiedBusinessNo: best.unifiedBusinessNo }, cand.source));
    matchedKeys.add(best.unifiedBusinessNo);
    matched += 1;
  } else if (cand.contact?.phone && inFocus(cand.county)) {
    try {
      const lead = buildStandaloneLead(cand);
      leadById.set(lead.id, lead);
    } catch { /* no placeId/phone to key on */ }
  }
}
console.log(`Matched ${matched}/${contactOnly.length} contact rows onto GCIS firms; ${leadById.size} unmatched leads kept.`);

// --- 4. Budget: reserve the scarce Maps leads first, then fill the rest with verified firms ---
const leads = [...leadById.values()].slice(0, maxRecords);
const registryBudget = Math.max(0, maxRecords - leads.length);
const all = [...byTongbian.values()].filter((r) => inFocus(r.county));
const workingRegistry = [
  ...all.filter((r) => matchedKeys.has(r.unifiedBusinessNo)),
  ...all.filter((r) => !matchedKeys.has(r.unifiedBusinessNo)),
].slice(0, registryBudget);

// --- 5. Backfill 負責人 + status for registry firms (GCIS company-basic API) ---
const oid = gcisSources.companyApiOid;
console.log(`Enriching 負責人 for ${workingRegistry.length} firms…`);
let filled = 0;
for (const r of workingRegistry) {
  const url = `https://data.gcis.nat.gov.tw/od/data/api/${oid}?$format=json&$filter=Business_Accounting_NO%20eq%20${encodeURIComponent(r.unifiedBusinessNo)}&$top=1`;
  try {
    const [row] = JSON.parse(await curlText(url, { tries: 3, timeoutSec: 30 }));
    if (row) {
      if (!r.responsiblePerson && row.Responsible_Name) r.responsiblePerson = row.Responsible_Name.trim();
      if (row.Company_Status_Desc) { r.companyStatus = row.Company_Status_Desc; r.isActive = row.Company_Status_Desc.includes('核准設立'); }
    }
  } catch { /* skip on transient error */ }
  if (r.responsiblePerson) filled += 1;
  await sleep(200);
}
console.log(`Enriched: ${filled}/${workingRegistry.length} have a 負責人.`);

// --- 6. Upsert to Airtable: active verified firms + standalone leads ---
const activeRegistry = workingRegistry.filter((r) => r.isActive);
const out = [...activeRegistry, ...leads];
console.log(`Upserting ${out.length} rows (${activeRegistry.length} verified firms + ${leads.length} Maps leads)…`);
await upsertCompanies(out);
console.log('Done. Sample verified firms:');
for (const r of activeRegistry.slice(0, 3)) {
  console.log(`  ${r.companyName} · 負責人 ${r.responsiblePerson ?? '—'} · ${r.county}${r.district ?? ''} · 電話 ${r.contact.phone ?? '—'} · ⭐${r.rating ?? '—'}`);
}
console.log('Sample unverified Maps leads:');
for (const r of leads.slice(0, 3)) {
  console.log(`  ${r.companyName} · ${r.county}${r.district ?? ''} · 電話 ${r.contact.phone ?? '—'} · ${r.mapsCategory ?? '—'} · ⭐${r.rating ?? '—'} (${r.reviewCount ?? 0})`);
}
