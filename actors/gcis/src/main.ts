/**
 * GCIS company-registry ingest (P0 — PRIMARY firmographics).
 * 資料來源：經濟部商業發展署 (GCIS) 商工行政資料開放平臺.
 *
 * Pulls construction firms by 營業項目代碼, normalises each row into a `PartialRecord`
 * keyed on 統一編號, and writes to this actor's dataset. Dataset UUID/params are the
 * defaults from the spec (§5.2 / Appendix A.2) — confirm the exact IDs in the Phase-0 spike.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Actor, log } from 'apify';
import {
  buildTradeLookup,
  parseAddress,
  tradeCategoryFor,
  type IndustryCode,
  type PartialRecord,
} from '@ruizhu/lib';

interface Input {
  itemCodes?: string[];
  apiBase?: string;
  datasetUuid?: string;
  maxRetries?: number;
}

interface GcisRow {
  Business_Accounting_NO?: string;
  Company_Name?: string;
  Responsible_Name?: string;
  Company_Location?: string;
  Capital_Stock_Amount?: string;
  Company_Status?: string;
  Company_Status_Desc?: string;
}

function loadConfig<T>(file: string): T {
  // `apify run` sets cwd to the actor dir; config lives at the repo root.
  return JSON.parse(readFileSync(resolve(process.cwd(), '../../config', file), 'utf8')) as T;
}

await Actor.init();

const input = (await Actor.getInput<Input>()) ?? {};
const apiBase = input.apiBase ?? process.env.GCIS_API_BASE ?? 'https://data.gcis.nat.gov.tw/od/data/api';
// Default GCIS "公司登記" dataset for query-by-business-item (confirm in Phase-0 spike).
const datasetUuid = input.datasetUuid ?? 'FCB90AB1-E382-45CE-8D4F-394861851E28';
const maxRetries = input.maxRetries ?? 3;

const industryConfig = loadConfig<{ codes: IndustryCode[] }>('industry-codes.json');
const { counties } = loadConfig<{ counties: string[] }>('counties.json');
const tradeLookup = buildTradeLookup(industryConfig.codes);

const itemCodes = input.itemCodes ?? industryConfig.codes.map((c) => c.code);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fetchPage(code: string, skip: number): Promise<GcisRow[]> {
  const url = `${apiBase}/${datasetUuid}?$format=json&$filter=Business_Item eq ${encodeURIComponent(code)}&$skip=${skip}&$top=1000`;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const res = await fetch(url);
    if (res.ok) return (await res.json()) as GcisRow[];
    // Back off on rate limit / transient server errors.
    if (res.status === 429 || res.status >= 500) {
      const wait = 1000 * 2 ** attempt;
      log.warning(`GCIS ${res.status} for code ${code} skip ${skip}; retry ${attempt + 1}/${maxRetries} in ${wait}ms`);
      await sleep(wait);
      continue;
    }
    throw new Error(`GCIS request failed (${res.status}) for code ${code}`);
  }
  throw new Error(`GCIS request exhausted retries for code ${code} skip ${skip}`);
}

let total = 0;
for (const code of itemCodes) {
  for (let skip = 0; ; skip += 1000) {
    const rows = await fetchPage(code, skip);
    if (!rows.length) break;

    const normalised: PartialRecord[] = rows
      .filter((r) => r.Business_Accounting_NO)
      .map((r) => {
        const { county, district } = parseAddress(r.Company_Location, counties);
        const industryItems = [code];
        return {
          source: 'gcis',
          unifiedBusinessNo: r.Business_Accounting_NO!,
          companyName: r.Company_Name ?? '',
          responsiblePerson: r.Responsible_Name ?? null,
          companyStatus: r.Company_Status ?? null,
          isActive: (r.Company_Status ?? '').startsWith('01'),
          capitalAmount: Number(r.Capital_Stock_Amount) || null,
          addressRaw: r.Company_Location ?? null,
          county,
          district,
          industryItems,
          tradeCategory: tradeCategoryFor(industryItems, tradeLookup),
        } satisfies PartialRecord;
      });

    await Actor.pushData(normalised);
    total += normalised.length;
  }
}

if (total === 0) {
  log.warning('GCIS ingest produced 0 rows — possible silent failure (check dataset UUID / item codes).');
} else {
  log.info(`GCIS ingest complete: ${total} rows across ${itemCodes.length} item codes.`);
}

await Actor.exit();
