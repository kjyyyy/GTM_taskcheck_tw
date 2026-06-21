import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeRecord, matchConfidence, buildStandaloneLead } from './merge.js';
import type { CompanyRecord, PartialRecord } from './schema.js';

const NOW = '2026-06-20';

test('mergeRecord creates a record from a GCIS registry row', () => {
  const incoming: PartialRecord = {
    unifiedBusinessNo: '12345678',
    source: 'gcis',
    companyName: '○○營造有限公司',
    responsiblePerson: '王小明',
    isActive: true,
    county: '桃園市',
    district: '中壢區',
    industryItems: ['E601010'],
  };
  const r = mergeRecord(null, incoming, 'gcis', NOW);
  assert.equal(r.id, 'tw-12345678');
  assert.equal(r.companyName, '○○營造有限公司');
  assert.equal(r.responsiblePerson, '王小明');
  assert.equal(r.isActive, true);
  assert.deepEqual(r.industryItems, ['E601010']);
  assert.deepEqual(r.provenance.sources, ['gcis']);
  assert.equal(r.provenance.firstSeen, NOW);
});

test('contact source updates contact.* but never firmographics', () => {
  const existing = mergeRecord(
    null,
    { unifiedBusinessNo: '12345678', source: 'gcis', companyName: '甲公司', county: '桃園市' },
    'gcis',
    NOW,
  );
  const merged = mergeRecord(
    existing,
    { unifiedBusinessNo: '12345678', source: 'gmaps', companyName: 'WRONG NAME', contact: { phone: '03-1234567', lineId: null, email: null, website: 'https://x.tw' } },
    'gmaps',
    NOW,
  );
  assert.equal(merged.companyName, '甲公司'); // firmographic untouched by contact source
  assert.equal(merged.contact.phone, '03-1234567');
  assert.equal(merged.contact.website, 'https://x.tw');
  assert.deepEqual(merged.provenance.sources, ['gcis', 'gmaps']);
});

test('mergeRecord never overwrites human-owned scoring fields', () => {
  const seed = mergeRecord(null, { unifiedBusinessNo: '12345678', source: 'gcis', companyName: '甲' }, 'gcis', NOW);
  seed.scoring = { fit: 80, pain: 3, power: 2, will: 1, tier: 'A' };
  const merged = mergeRecord(seed, { unifiedBusinessNo: '12345678', source: 'gcis', companyName: '甲乙' }, 'gcis', NOW);
  assert.deepEqual(merged.scoring, { fit: 80, pain: 3, power: 2, will: 1, tier: 'A' });
});

test('PCC signals raise recentTenderWin', () => {
  const seed = mergeRecord(null, { unifiedBusinessNo: '12345678', source: 'gcis', companyName: '甲' }, 'gcis', NOW);
  const merged = mergeRecord(
    seed,
    { unifiedBusinessNo: '12345678', source: 'pcc', signals: { recentTenderWin: true, lastAwardDate: '2026-05-12', lastAwardAmount: 3200000, hiringActive: false } },
    'pcc',
    NOW,
  );
  assert.equal(merged.signals.recentTenderWin, true);
  assert.equal(merged.signals.lastAwardAmount, 3200000);
});

test('104 enhancement writes employeeCount + hiring without clobbering GCIS fields', () => {
  const seed = mergeRecord(
    null,
    { unifiedBusinessNo: '12345678', source: 'gcis', companyName: '甲營造', responsiblePerson: '王小明' },
    'gcis',
    NOW,
  );
  const merged = mergeRecord(
    seed,
    { unifiedBusinessNo: '12345678', source: 'i104', employeeCount: 8, signals: { recentTenderWin: false, lastAwardDate: null, lastAwardAmount: null, hiringActive: true } },
    'i104',
    NOW,
  );
  assert.equal(merged.employeeCount, 8);
  assert.equal(merged.signals.hiringActive, true);
  assert.equal(merged.companyName, '甲營造'); // GCIS firmographics preserved
  assert.equal(merged.responsiblePerson, '王小明');
  assert.deepEqual(merged.provenance.sources, ['gcis', 'i104']);
});

test('mergeRecord is idempotent on re-run', () => {
  const row: PartialRecord = { unifiedBusinessNo: '12345678', source: 'gcis', companyName: '甲', industryItems: ['E601010'] };
  const once = mergeRecord(null, row, 'gcis', NOW);
  const twice = mergeRecord(once, row, 'gcis', NOW);
  assert.deepEqual(twice.provenance.sources, ['gcis']);
  assert.deepEqual(twice.industryItems, ['E601010']);
});

test('mergeRecord throws without a 統編', () => {
  assert.throws(() => mergeRecord(null, { source: 'gmaps', companyName: '甲' }, 'gmaps', NOW));
});

test('gmaps signals (rating/reviews/category/url) attach to a matched registry firm', () => {
  const seed = mergeRecord(null, { unifiedBusinessNo: '12345678', source: 'gcis', companyName: '甲營造', county: '臺中市' }, 'gcis', NOW);
  const merged = mergeRecord(
    seed,
    {
      source: 'gmaps',
      companyName: 'WRONG',
      contact: { phone: '04-12345678', lineId: null, email: null, website: null },
      rating: 4.7,
      reviewCount: 25,
      mapsCategory: '水電承辦商',
      mapsUrl: 'https://maps.google.com/?cid=1',
      placeId: 'ChIJabc',
    },
    'gmaps',
    NOW,
  );
  assert.equal(merged.companyName, '甲營造'); // firmographic untouched
  assert.equal(merged.contact.phone, '04-12345678');
  assert.equal(merged.rating, 4.7);
  assert.equal(merged.reviewCount, 25);
  assert.equal(merged.mapsCategory, '水電承辦商');
  assert.equal(merged.placeId, 'ChIJabc');
});

test('buildStandaloneLead keys an unmatched Maps lead by placeId and stays unverified', () => {
  const lead = buildStandaloneLead(
    {
      source: 'gmaps',
      companyName: '新偉水電工程',
      county: '臺中市',
      district: '神岡區',
      contact: { phone: '+886 975 673 512', lineId: null, email: null, website: null },
      rating: 4.7,
      reviewCount: 25,
      mapsCategory: '水電承辦商',
      placeId: 'ChIJxyz',
    },
    NOW,
  );
  assert.equal(lead.id, 'gm-ChIJxyz');
  assert.equal(lead.unifiedBusinessNo, '');
  assert.equal(lead.verified, false);
  assert.equal(lead.companyName, '新偉水電工程');
  assert.equal(lead.contact.phone, '+886 975 673 512');
  assert.equal(lead.isActive, true);
  assert.deepEqual(lead.provenance.sources, ['gmaps']);
});

test('buildStandaloneLead falls back to phone digits when no placeId, and throws when neither', () => {
  const lead = buildStandaloneLead({ source: 'gmaps', companyName: 'X', contact: { phone: '(04) 2256-2257', lineId: null, email: null, website: null } }, NOW);
  assert.equal(lead.id, 'gm-0422562257');
  assert.throws(() => buildStandaloneLead({ source: 'gmaps', companyName: 'X', contact: { phone: null, lineId: null, email: null, website: null } }, NOW));
});

const target: CompanyRecord = mergeRecord(
  null,
  {
    unifiedBusinessNo: '12345678',
    source: 'gcis',
    companyName: '大同水電工程有限公司',
    county: '桃園市',
    district: '中壢區',
  },
  'gcis',
  NOW,
);

test('matchConfidence: exact phone + name yields a high score', () => {
  target.contact.phone = '03-1234567';
  const candidate: PartialRecord = {
    source: 'gmaps',
    companyName: '大同水電工程',
    county: '桃園市',
    district: '中壢區',
    contact: { phone: '(03) 123-4567', lineId: null, email: null, website: null },
  };
  assert.ok(matchConfidence(candidate, target) >= 0.85);
});

test('matchConfidence: different firm yields a low score', () => {
  const candidate: PartialRecord = {
    source: 'gmaps',
    companyName: '全然無關的早餐店',
    county: '臺北市',
    district: '大安區',
    contact: { phone: '02-99999999', lineId: null, email: null, website: null },
  };
  assert.ok(matchConfidence(candidate, target) < 0.85);
});
