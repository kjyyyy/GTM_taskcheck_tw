/**
 * PCC government-procurement award ingest (P0 — INTENT signal). STUB.
 * 資料來源：行政院公共工程委員會 (PCC) OpenData.
 *
 * Use the official OpenData, NOT the Cloudflare-protected web pages (§5.4). Extract
 * 得標廠商 統編 + 標案名稱 + 機關 + 決標金額 + 決標日期. A 統編 in a recent award
 * (last 30–90 days) → set signals.recentTenderWin = true. Run DAILY.
 *
 * Same fetch+paginate+push pattern as actors/gcis (Appendix A.2). Implement against the
 * exact OpenData endpoint/field names confirmed in the Phase-0 spike.
 */
import { Actor, log } from 'apify';
import type { PartialRecord } from '@ruizhu/lib';

interface Input {
  sinceDays?: number; // award window to flag as a fresh signal
  openDataUrl?: string;
}

await Actor.init();

const { sinceDays = 90, openDataUrl } = (await Actor.getInput<Input>()) ?? {};

// TODO(P3, §5.4): fetch the PCC award OpenData (getAtmOpenDataHis family), paginate with
// backoff, and map each award to a PartialRecord carrying the winner 統編 + signals.
const records: PartialRecord[] = [];

// Example shape the implementation should emit per winning award:
// records.push({
//   source: 'pcc',
//   unifiedBusinessNo: award.winnerTaxId,
//   signals: { recentTenderWin: true, lastAwardDate: award.date, lastAwardAmount: award.amount, hiringActive: false },
// });

void sinceDays;
void openDataUrl;

if (records.length === 0) {
  log.warning('PCC ingest is a stub — implement the OpenData fetch (§5.4). 0 rows pushed.');
} else {
  await Actor.pushData(records);
}

await Actor.exit();
