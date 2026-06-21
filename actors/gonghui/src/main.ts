/**
 * 公會 (trade-association) directory scraper (P1 — CONTACT channels).
 *
 * Static HTML member lists → {companyName, phone, email, county}. These rows have NO 統編,
 * so the deliver step fuzzy-matches them onto registry records via matchConfidence (name +
 * phone + county). Be polite: low concurrency, identify the UA, respect robots.txt + ToS.
 *
 * Parsers are config-driven (one entry per association layout in config/gonghui-sites.json),
 * selected by hostname. The seed selectors there are placeholders to confirm per site.
 * 資料來源：各地營造/水電/土木公會公開會員名錄.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Actor, log } from 'apify';
import { CheerioCrawler } from 'crawlee';
import { parseAddress, type PartialRecord } from '@ruizhu/lib';

interface SiteParser {
  name: string;
  county: string | null;
  startUrls: string[];
  rowSelector: string;
  nameSelector: string;
  phoneSelector: string;
  emailSelector: string;
  /** Optional: capture the 負責人/board representative (often 董事長/總經理 = decision maker). */
  responsiblePersonSelector?: string;
  /** Optional: capture 通訊地址 so county/district are parsed per-row (overrides site.county). */
  addressSelector?: string;
  /** Skip rows whose first cell isn't a number (drops header/footer/layout rows like a 序號 table). */
  numericFirstCell?: boolean;
}

interface Input {
  startUrls?: string[]; // override: crawl only these URLs (uses each URL's matched site parser)
  contactEmail?: string;
}

function loadConfig<T>(file: string): T {
  return JSON.parse(readFileSync(resolve(process.cwd(), '../../config', file), 'utf8')) as T;
}

const today = () => new Date().toISOString().slice(0, 10);

await Actor.init();

const { startUrls = [], contactEmail = 'ops@ruizhu.example' } = (await Actor.getInput<Input>()) ?? {};

const { sites } = loadConfig<{ sites: SiteParser[] }>('gonghui-sites.json');
const { counties } = loadConfig<{ counties: string[] }>('counties.json');
// hostname -> parser, so each crawled URL uses its association's selectors.
const parserByHost = new Map<string, SiteParser>();
for (const site of sites) {
  for (const u of site.startUrls) {
    try {
      parserByHost.set(new URL(u).hostname, site);
    } catch {
      log.warning(`公會 config: invalid startUrl for ${site.name}: ${u}`);
    }
  }
}

// Default crawl set = all configured sites' startUrls; input.startUrls overrides.
const urlsToCrawl = startUrls.length ? startUrls : sites.flatMap((s) => s.startUrls);
if (urlsToCrawl.length === 0) {
  log.warning('公會 scraper: no startUrls configured. Fill config/gonghui-sites.json (gonghui-selectors step).');
}

let total = 0;

const crawler = new CheerioCrawler({
  maxConcurrency: 2,
  maxRequestRetries: 3,
  additionalMimeTypes: ['text/html'],
  preNavigationHooks: [
    async ({ request }) => {
      request.headers = {
        ...request.headers,
        'User-Agent': `ruizhu-gtm-pipeline (+contact: ${contactEmail})`,
      };
    },
  ],
  requestHandler: async ({ $, request, log: reqLog }) => {
    const host = new URL(request.url).hostname;
    const site = parserByHost.get(host);
    if (!site) {
      reqLog.warning(`公會: no parser configured for host ${host}; skipping.`);
      return;
    }

    const rows: PartialRecord[] = [];
    $(site.rowSelector).each((_, el) => {
      if (site.numericFirstCell && !/^\d+$/.test($(el).children().first().text().trim())) return;
      const companyName = $(el).find(site.nameSelector).text().trim();
      if (!companyName) return;
      const phone = $(el).find(site.phoneSelector).text().trim() || null;
      const email = $(el).find(site.emailSelector).attr('href')?.replace('mailto:', '').trim() ?? null;
      const responsiblePerson = site.responsiblePersonSelector
        ? $(el).find(site.responsiblePersonSelector).text().trim() || null
        : null;
      const addressRaw = site.addressSelector ? $(el).find(site.addressSelector).text().trim() || null : null;
      const parsed = addressRaw ? parseAddress(addressRaw, counties) : { county: null, district: null };
      rows.push({
        source: 'gonghui',
        companyName,
        responsiblePerson,
        addressRaw,
        county: parsed.county ?? site.county ?? null,
        district: parsed.district,
        contact: { phone, lineId: null, email, website: null },
        provenance: { sources: ['gonghui'], sourceMatchConfidence: {}, firstSeen: today(), lastRefreshed: today() },
      });
    });

    if (rows.length) {
      await Actor.pushData(rows);
      total += rows.length;
    }
    reqLog.info(`公會 [${site.name}] parsed ${request.url} → ${rows.length} members`);
  },
});

await crawler.run(urlsToCrawl.map((url) => ({ url })));

if (total === 0) {
  log.warning('公會 scraper produced 0 rows — confirm member-list URLs + selectors in config/gonghui-sites.json.');
} else {
  log.info(`公會 scraper complete: ${total} contact rows.`);
}

await Actor.exit();
