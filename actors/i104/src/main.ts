/**
 * 104 company ingest (P2 ENHANCEMENT — company size + hiring intent).
 *
 * Enriches firms with 員工人數 (headcount) and a hiring signal, and extracts the
 * 統一編號 so it joins to GCIS cleanly BY KEY (no fuzzy match). Size is used downstream
 * to gate/score the owner-operated ICP (deliver `maxEmployees`, Airtable Fit formula).
 *
 * ⚠️ 104's ToS restricts scraping (§5.7, §10). This actor is deliberately LOW VOLUME and
 * polite (concurrency 1, delays, capped `maxCompanies`, descriptive UA). Confirm robots/ToS
 * and keep volume minimal before scaling. The CSS/text selectors below are best-effort against
 * the JS-rendered pages and should be re-confirmed periodically.
 */
import { Actor, log } from 'apify';
import { PlaywrightCrawler } from 'crawlee';
import { parseAddress, type PartialRecord } from '@ruizhu/lib';

interface Input {
  indcat?: string; // 104 industry categories, comma-separated (construction set by default)
  keyword?: string;
  counties?: string[]; // emit only firms in these 縣市 (parsed from address); empty = all
  maxCompanies?: number;
  useResidentialProxy?: boolean;
}

const TAIWAN_COUNTIES = [
  '臺北市', '台北市', '新北市', '桃園市', '臺中市', '台中市', '臺南市', '台南市', '高雄市',
  '基隆市', '新竹市', '嘉義市', '新竹縣', '苗栗縣', '彰化縣', '南投縣', '雲林縣', '嘉義縣',
  '屏東縣', '宜蘭縣', '花蓮縣', '臺東縣', '台東縣', '澎湖縣', '金門縣', '連江縣',
];

const today = () => new Date().toISOString().slice(0, 10);
const normaliseCounty = (c: string) => c.replace(/台/g, '臺');
const toNumber = (s: string | undefined): number | null => {
  if (!s) return null;
  const n = Number(s.replace(/[,\s]/g, ''));
  return Number.isFinite(n) ? n : null;
};

/** Parse 員工人數 from page text. Handles "12人", "5~10人", "5-10人" (uses the lower bound). */
function parseEmployees(text: string): number | null {
  const range = text.match(/員工人數[^\d]{0,8}(\d[\d,]*)\s*[-~至]\s*(\d[\d,]*)\s*人/);
  if (range) return toNumber(range[1]);
  const single = text.match(/員工人數[^\d]{0,8}(\d[\d,]*)\s*人/);
  return single ? toNumber(single[1]) : null;
}

await Actor.init();

const {
  indcat = '1011001000,1011002000,1011003000',
  keyword = '承包商',
  counties = [],
  maxCompanies = 200,
  useResidentialProxy = true,
} = (await Actor.getInput<Input>()) ?? {};

const countyFocus = new Set(counties.map(normaliseCounty));
const proxyConfiguration = useResidentialProxy
  ? await Actor.createProxyConfiguration({ groups: ['RESIDENTIAL'], countryCode: 'TW' })
  : undefined;

let enqueuedDetails = 0;
let pushed = 0;
let skippedNoTongbian = 0;

const crawler = new PlaywrightCrawler({
  proxyConfiguration,
  maxConcurrency: 1, // polite — this is the ToS-grey source
  navigationTimeoutSecs: 60,
  maxRequestsPerCrawl: maxCompanies + Math.ceil(maxCompanies / 20) + 5, // details + list pages
  requestHandler: async ({ page, request, enqueueLinks, log: reqLog }) => {
    await page.waitForLoadState('networkidle').catch(() => {});

    if (request.label === 'DETAIL') {
      const body = await page.locator('body').innerText().catch(() => '');
      const tongbian = body.match(/統一編號[^\d]{0,8}(\d{8})/)?.[1];
      if (!tongbian) {
        skippedNoTongbian += 1;
        return; // can't join without 統編
      }
      const addressRaw = body.match(/(?:公司地址|地址)[^\u4e00-\u9fa5]{0,4}([^\n]{6,40})/)?.[1]?.trim() ?? null;
      const { county, district } = parseAddress(addressRaw, TAIWAN_COUNTIES);
      if (countyFocus.size > 0 && (!county || !countyFocus.has(normaliseCounty(county)))) return;

      const jobCount = toNumber(body.match(/工作機會[^\d]{0,6}(\d[\d,]*)/)?.[1]);
      const record: PartialRecord = {
        source: 'i104',
        unifiedBusinessNo: tongbian,
        companyName: (await page.title()).replace(/[|｜].*$/, '').trim() || undefined,
        employeeCount: parseEmployees(body),
        capitalAmount: toNumber(body.match(/資本額[^\d]{0,8}(\d[\d,]*)/)?.[1]),
        county,
        district,
        addressRaw,
        signals: {
          recentTenderWin: false,
          lastAwardDate: null,
          lastAwardAmount: null,
          hiringActive: (jobCount ?? 0) > 0,
        },
        provenance: { sources: ['i104'], sourceMatchConfidence: {}, firstSeen: today(), lastRefreshed: today() },
      };
      await Actor.pushData(record);
      pushed += 1;
      return;
    }

    // LIST page: collect company-profile links and paginate.
    const detailUrls: string[] = await page
      .$$eval('a[href*="/company/"]', (as) =>
        as
          .map((a) => (a as HTMLAnchorElement).href)
          .filter((h) => /\/company\/[^/]+/.test(h) && !h.includes('/company/search')),
      )
      .catch(() => []);
    const unique = [...new Set(detailUrls)];

    const room = maxCompanies - enqueuedDetails;
    if (room > 0 && unique.length) {
      const take = unique.slice(0, room);
      enqueuedDetails += take.length;
      await enqueueLinks({ urls: take, label: 'DETAIL' });
    }

    if (enqueuedDetails < maxCompanies && unique.length > 0) {
      const url = new URL(request.url);
      const nextPage = Number(url.searchParams.get('page') ?? '1') + 1;
      url.searchParams.set('page', String(nextPage));
      await enqueueLinks({ urls: [url.toString()], label: 'LIST' });
    }
    reqLog.info(`104 list ${request.url}: found ${unique.length} companies (enqueued ${enqueuedDetails}/${maxCompanies}).`);
  },
});

const startUrl = `https://www.104.com.tw/company/search/?indcat=${encodeURIComponent(indcat)}&keyword=${encodeURIComponent(keyword)}&page=1&jobsource=tab_job_to_cs`;
await crawler.run([{ url: startUrl, label: 'LIST' }]);

if (pushed === 0) {
  log.warning(`104 ingest produced 0 rows (skipped ${skippedNoTongbian} without 統編) — selectors may need re-confirming or volume was empty.`);
} else {
  log.info(`104 ingest complete: ${pushed} firms with size/hiring (skipped ${skippedNoTongbian} without 統編).`);
}

await Actor.exit();
