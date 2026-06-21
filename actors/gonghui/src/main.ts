/**
 * 公會 (trade-association) directory scraper (P1 — CONTACT channels).
 *
 * Static HTML member lists → {companyName, phone, email}. These rows have NO 統編, so
 * they are contact-only `PartialRecord`s resolved to a registry record later via
 * matchConfidence in the deliver step. Be polite: low concurrency, identify the UA,
 * respect robots.txt + per-site ToS (§5.6, §9).
 *
 * The selectors here are illustrative — one parser per association layout. Start with
 * 臺灣區綜合營造業同業公會 (treca.org.tw) and county associations from MOL's 各縣市業管工會名冊.
 */
import { Actor, log } from 'apify';
import { CheerioCrawler } from 'crawlee';
import type { PartialRecord } from '@ruizhu/lib';

interface Input {
  startUrls?: string[];
  contactEmail?: string; // included in the User-Agent so sites can reach us
}

await Actor.init();

const { startUrls = [], contactEmail = 'ops@ruizhu.example' } = (await Actor.getInput<Input>()) ?? {};

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
    const rows: PartialRecord[] = [];
    // Illustrative selector — adapt per association layout.
    $('table.member-row tr').each((_, el) => {
      const companyName = $(el).find('.company').text().trim();
      const phone = $(el).find('.phone').text().trim() || null;
      const email = $(el).find('a[href^="mailto:"]').attr('href')?.replace('mailto:', '') ?? null;
      if (!companyName) return;
      rows.push({
        source: 'gonghui',
        companyName,
        contact: { phone, lineId: null, email, website: null },
        provenance: {
          sources: ['gonghui'],
          sourceMatchConfidence: {},
          firstSeen: new Date().toISOString().slice(0, 10),
          lastRefreshed: new Date().toISOString().slice(0, 10),
        },
      });
    });
    if (rows.length) {
      await Actor.pushData(rows);
      total += rows.length;
    }
    reqLog.info(`parsed ${request.url} → ${rows.length} members`);
  },
});

await crawler.run(startUrls.map((url) => ({ url })));

if (total === 0) {
  log.warning('公會 scraper produced 0 rows — selectors likely need adapting to the site layout.');
} else {
  log.info(`公會 scraper complete: ${total} contact rows.`);
}

await Actor.exit();
