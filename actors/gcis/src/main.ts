/**
 * GCIS company-registry ingest (P0 — PRIMARY firmographics).
 * 資料來源：經濟部商業發展署 (GCIS) 商工行政資料開放平臺.
 *
 * Two modes (see config/gcis-sources.json):
 *  - "taichung-csv" (DEFAULT): download a county open-data CSV (e.g. 台中市公司登記資料-E營造及工程業,
 *    ~22k rows) and normalise each row. This is the verified, concrete firmographics source.
 *    The CSV has 統編 + 名稱 + 地址 + 資本總額 + 行業代號 but NO 負責人 — the deliver step backfills
 *    負責人 + active status per-統編 via the GCIS company-basic API for the small working set.
 *  - "api": query-by-business-item against the OpenData API (kept for later national scaling).
 *
 * Either way, output is a `PartialRecord` keyed on 統一編號.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'csv-parse/sync';
import { Actor, log } from 'apify';
import {
  buildTradeLookup,
  parseAddress,
  tradeCategoryFor,
  type IndustryCode,
  type PartialRecord,
} from '@ruizhu/lib';

interface Input {
  mode?: 'taichung-csv' | 'api';
  // taichung-csv mode
  csvFileOid?: string;
  csvUrl?: string;
  counties?: string[]; // optional county filter (CSV may already be one county)
  defaultTradeCategory?: string;
  // api mode
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

const FILE_BASE = 'https://data.gcis.nat.gov.tw/od/file?oid=';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

await Actor.init();

const input = (await Actor.getInput<Input>()) ?? {};
const mode = input.mode ?? 'taichung-csv';
const { counties } = loadConfig<{ counties: string[] }>('counties.json');

let total = 0;

if (mode === 'taichung-csv') {
  // ---- Taichung (or any county) open-data CSV ----
  const sources = loadConfig<{ sources?: Record<string, { fileOid: string }> }>('gcis-sources.json');
  const fileOid = input.csvFileOid ?? sources.sources?.taichungConstruction?.fileOid ?? '37EE81A7-2B21-49D5-B45F-5914C395C254';
  const csvUrl = input.csvUrl ?? `${FILE_BASE}${fileOid}`;
  const defaultTrade = input.defaultTradeCategory ?? '營造';
  const countyFilter = new Set((input.counties ?? []).map((c) => c.replace(/台/g, '臺')));

  log.info(`GCIS CSV ingest: ${csvUrl}`);
  const res = await fetch(csvUrl);
  if (!res.ok) throw new Error(`GCIS CSV download failed (${res.status})`);
  const text = await res.text();

  const rows = parse(text, { columns: true, skip_empty_lines: true, relax_column_count: true, bom: true }) as Record<string, string>[];

  const normalised: PartialRecord[] = [];
  for (const row of rows) {
    const unifiedBusinessNo = (row['統一編號'] ?? '').trim();
    if (!unifiedBusinessNo) continue;
    const addressRaw = (row['公司地址'] || row['營業地址（財政資訊中心匯入）'] || '').trim() || null;
    const { county, district } = parseAddress(addressRaw, counties);
    if (countyFilter.size && (!county || !countyFilter.has(county.replace(/台/g, '臺')))) continue;
    const industryCode = (row['行業代號（財政資訊中心匯入）'] ?? '').trim();
    normalised.push({
      source: 'gcis',
      unifiedBusinessNo,
      companyName: (row['公司名稱'] ?? '').trim(),
      responsiblePerson: null, // not in the bulk CSV — deliver backfills per-統編
      isActive: true, // registered in the dataset; deliver enrichment corrects via status
      capitalAmount: Number(row['資本總額']) || null,
      addressRaw,
      county,
      district,
      industryItems: industryCode ? [industryCode] : [],
      tradeCategory: defaultTrade, // whole dataset is E營造及工程業
    });
  }

  if (normalised.length) {
    // push in chunks to avoid oversized single requests
    for (let i = 0; i < normalised.length; i += 500) {
      await Actor.pushData(normalised.slice(i, i + 500));
    }
    total = normalised.length;
  }
} else {
  // ---- legacy query-by-business-item API mode (national scaling) ----
  const apiBase = input.apiBase ?? process.env.GCIS_API_BASE ?? 'https://data.gcis.nat.gov.tw/od/data/api';
  const datasetUuid = input.datasetUuid ?? 'FCB90AB1-E382-45CE-8D4F-394861851E28';
  const maxRetries = input.maxRetries ?? 3;
  const industryConfig = loadConfig<{ codes: IndustryCode[] }>('industry-codes.json');
  const tradeLookup = buildTradeLookup(industryConfig.codes);
  const itemCodes = input.itemCodes ?? industryConfig.codes.map((c) => c.code);

  async function fetchPage(code: string, skip: number): Promise<GcisRow[]> {
    const url = `${apiBase}/${datasetUuid}?$format=json&$filter=Business_Item eq ${encodeURIComponent(code)}&$skip=${skip}&$top=1000`;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const res = await fetch(url);
      if (res.ok) return (await res.json()) as GcisRow[];
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

  for (const code of itemCodes) {
    for (let skip = 0; ; skip += 1000) {
      const apiRows = await fetchPage(code, skip);
      if (!apiRows.length) break;
      const normalised: PartialRecord[] = apiRows
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
}

if (total === 0) {
  log.warning('GCIS ingest produced 0 rows — check the CSV oid / item codes / county filter.');
} else {
  log.info(`GCIS ingest complete: ${total} rows (mode=${mode}).`);
}

await Actor.exit();
