/**
 * Google Maps contact ingest (P0 — CONTACT channels).
 *
 * Wraps Apify's maintained Google Maps Scraper actor (compass/crawler-google-places,
 * id nwua9Gu5YrADL7ZDj) — we don't build our own (§5.5). Searches per 縣市 × trade term
 * (water/electrical, plastering, waterproofing, steel, formwork, civil, etc.) through the
 * Apify residential TW proxy, then normalises each place into a CONTACT-ONLY PartialRecord.
 *
 * These rows have NO 統編, so the deliver step fuzzy-matches them onto GCIS registry records
 * via matchConfidence (name + phone + county/district).
 *
 * ICP note ("not tech enabled"): the decision-maker name comes from GCIS 負責人, so we do NOT
 * pay for the actor's Business-leads enrichment add-on. Maps gives us the phone plus a
 * digital-maturity proxy — a firm with a phone but NO website (contact.website === null) is a
 * strong fit for 睿築. Personal-data / reviews extraction is left OFF (PDPA + cost).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Actor, log } from 'apify';
import { parseAddress, type PartialRecord } from '@ruizhu/lib';

interface Input {
  searchTerms?: string[];
  counties?: string[];
  maxPlacesPerSearch?: number;
  language?: string;
  mapsActorId?: string;
  useResidentialProxy?: boolean;
}

/** Subset of the Google Maps Scraper output we consume. */
interface GooglePlace {
  title?: string;
  address?: string;
  city?: string;
  postalCode?: string;
  website?: string | null;
  phone?: string | null;
  phoneUnformatted?: string | null;
  permanentlyClosed?: boolean;
  temporarilyClosed?: boolean;
  placeId?: string | null;
  totalScore?: number | null; // rating 0–5
  reviewsCount?: number | null;
  categoryName?: string | null;
  url?: string | null; // Google Maps listing url
}

function loadConfig<T>(file: string): T {
  // `apify run` sets cwd to the actor dir; config lives at the repo root.
  return JSON.parse(readFileSync(resolve(process.cwd(), '../../config', file), 'utf8')) as T;
}

/** Collapse 台/臺 spelling variants so we don't run a Maps job twice per city. */
function canonicalCounties(counties: string[]): string[] {
  return [...new Set(counties.map((c) => c.replace(/台/g, '臺')))];
}

await Actor.init();

const input = (await Actor.getInput<Input>()) ?? {};
const language = input.language ?? 'zh-TW';
const maxPlacesPerSearch = input.maxPlacesPerSearch ?? 50;
const mapsActorId = input.mapsActorId ?? 'compass/crawler-google-places';
const useResidentialProxy = input.useResidentialProxy ?? true;

const searchTerms = input.searchTerms?.length
  ? input.searchTerms
  : loadConfig<{ searchTerms: string[] }>('gmaps-search-terms.json').searchTerms;

// Full county list (incl. 台/臺 variants) is what parseAddress matches against.
const allCounties = loadConfig<{ counties: string[] }>('counties.json').counties;
const targetCounties = canonicalCounties(input.counties?.length ? input.counties : allCounties);

const proxyConfig = {
  useApifyProxy: true,
  ...(useResidentialProxy ? { apifyProxyGroups: ['RESIDENTIAL'], apifyProxyCountry: 'TW' } : {}),
};

let total = 0;
for (const county of targetCounties) {
  const run = await Actor.call(mapsActorId, {
    searchStringsArray: searchTerms,
    locationQuery: `${county}, Taiwan`,
    language,
    maxCrawledPlacesPerSearch: maxPlacesPerSearch,
    skipClosedPlaces: true,
    maxReviews: 0, // no reviews / reviewer personal data (PDPA + cost)
    maxImages: 0,
    scrapeContacts: false, // skip paid company-contacts enrichment in v1
    proxyConfig,
  });

  // The Maps actor always runs on the Apify platform, so its dataset lives in the cloud.
  const dataset = await Actor.openDataset(run.defaultDatasetId, { forceCloud: true });
  const { items } = await dataset.getData();
  const places = items as unknown as GooglePlace[];

  const normalised: PartialRecord[] = places
    .filter((p) => p.title && !p.permanentlyClosed && !p.temporarilyClosed)
    .map((p) => {
      const { county: parsedCounty, district } = parseAddress(p.address, allCounties);
      const today = new Date().toISOString().slice(0, 10);
      return {
        source: 'gmaps',
        companyName: p.title!,
        addressRaw: p.address ?? null,
        county: parsedCounty ?? county,
        district,
        contact: {
          phone: p.phoneUnformatted ?? p.phone ?? null,
          lineId: null,
          email: null,
          website: p.website ?? null, // null = the "not tech enabled" ICP-fit signal
        },
        rating: p.totalScore ?? null,
        reviewCount: p.reviewsCount ?? null,
        mapsCategory: p.categoryName ?? null,
        mapsUrl: p.url ?? null,
        placeId: p.placeId ?? null,
        provenance: {
          sources: ['gmaps'],
          sourceMatchConfidence: {},
          firstSeen: today,
          lastRefreshed: today,
        },
      } satisfies PartialRecord;
    });

  if (normalised.length) {
    await Actor.pushData(normalised);
    total += normalised.length;
  }
  log.info(`Google Maps: ${county} → ${normalised.length} places (run ${run.id}).`);
}

if (total === 0) {
  log.warning('Google Maps ingest produced 0 rows — check search terms / counties / proxy.');
} else {
  log.info(`Google Maps ingest complete: ${total} contact rows across ${targetCounties.length} counties.`);
}

await Actor.exit();
