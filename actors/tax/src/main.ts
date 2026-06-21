/**
 * 財政部 全國營業(稅籍)登記資料集 ingest (P1 — active-status complement). STUB.
 * 資料來源：財政部財政資訊中心.
 *
 * Daily-updated bulk CSV (data.gov.tw dataset 9400 / BGMOPEN1 family). Use to (a) cross-check
 * active operating status and (b) catch 行號 / sole proprietors not in the company registry.
 * Filter by 行業 code + 縣市; join to GCIS by 統編 (§5.3).
 *
 * Implement: download CSV → parse → normalise each row to a PartialRecord (source 'tax',
 * isActive from operating status). Plain fetch + a CSV parser; no proxy needed.
 */
import { Actor, log } from 'apify';
import type { PartialRecord } from '@ruizhu/lib';

interface Input {
  csvUrl?: string;
  industryCodes?: string[];
  counties?: string[];
}

await Actor.init();

const { csvUrl, industryCodes = [], counties = [] } = (await Actor.getInput<Input>()) ?? {};

// TODO(§5.3): download the 稅籍 CSV, parse it, filter by 行業 + 縣市, and map each row to:
// { source: 'tax', unifiedBusinessNo, companyName, isActive, addressRaw, county, district }
const records: PartialRecord[] = [];

void csvUrl;
void industryCodes;
void counties;

if (records.length === 0) {
  log.warning('稅籍 ingest is a stub — implement the CSV download + parse (§5.3). 0 rows pushed.');
} else {
  await Actor.pushData(records);
}

await Actor.exit();
