/**
 * Google Maps contact ingest (P0 — CONTACT channels). STUB.
 *
 * Don't build your own Maps scraper — wrap Apify's maintained Google Maps Scraper actor
 * (they fix breakage), or use the Places API (§5.5). Search per 縣市/區 × trade term
 * (水電工程, 泥作, 防水, 鋼構, 模板, 土木包工業). Use Apify residential TW proxy.
 *
 * Output rows are CONTACT-ONLY (no 統編): emit name + phone + website + county/district so
 * the deliver step can fuzzy-match them onto registry records via matchConfidence.
 */
import { Actor, log } from 'apify';
import type { PartialRecord } from '@ruizhu/lib';

interface Input {
  searchTerms?: string[];
  counties?: string[];
  maxPlacesPerSearch?: number;
}

await Actor.init();

const { searchTerms = [], counties = [], maxPlacesPerSearch = 100 } = (await Actor.getInput<Input>()) ?? {};

// TODO(§5.5): call the Apify Google Maps Scraper actor and collect its dataset, e.g.
//   const run = await Actor.call('compass/crawler-google-places', { searchStringsArray, maxCrawledPlacesPerSearch, language: 'zh-TW' });
//   const { items } = await Actor.openDataset(run.defaultDatasetId).getData();
// then normalise each place into the contact-only PartialRecord below.
const records: PartialRecord[] = [];

// Example shape per place:
// records.push({
//   source: 'gmaps',
//   companyName: place.title,
//   addressRaw: place.address,
//   county, district,
//   contact: { phone: place.phone ?? null, lineId: null, email: null, website: place.website ?? null },
// });

void searchTerms;
void counties;
void maxPlacesPerSearch;

if (records.length === 0) {
  log.warning('Google Maps ingest is a stub — wire up the Apify Maps actor (§5.5). 0 rows pushed.');
} else {
  await Actor.pushData(records);
}

await Actor.exit();
