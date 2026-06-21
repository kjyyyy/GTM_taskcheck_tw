# 睿築 GTM Lead Data Pipeline

A small **TypeScript + Apify** monorepo that builds a continuously refreshed, deduplicated,
scored list of **owner-operated Taiwanese construction subcontractors** and lands them in
**Airtable (free tier)**, which serves as both the store of record and the CRM.

It ingests Taiwan government **open data** (company registry, procurement awards, tax registry),
**scrapes only contact channels** (Google Maps via Apify's actor; a few static 公會 member lists),
normalises everything to one canonical record keyed on **`統一編號`**, then merges/dedupes in a
`deliver` actor that upserts the qualified working set into Airtable.

> Full requirements & implementation spec: [`ruizhu_gtm_data_pipeline_requirements.md`](./ruizhu_gtm_data_pipeline_requirements.md).
> Agent conventions: [`AGENTS.md`](./AGENTS.md). This is a pre-PMF, two-person pipeline —
> optimise for simplicity and correctness, not scale.

## Layout

```
packages/lib/        # shared, no Apify dependency — schema, merge, airtable, address, trade
config/              # industry-codes.json (P0 spike) + counties.json — drive targeting
actors/
  gcis/              # P0  firmographics — GCIS open-data API/CSV
  pcc/               # P0  intent — award OpenData (stub)
  gmaps/             # P0  contact — wraps Apify Google Maps actor (stub)
  gonghui/           # P1  contact — static 公會 association scraper
  tax/               # P1  active-status — 財政部 稅籍 CSV (stub)
  deliver/           # reads datasets → merge by 統編 → upsert to Airtable
```

## Prerequisites

- Node ≥ 20, npm ≥ 9 (workspaces).
- An [Apify](https://apify.com) account (Starter plan, ~$29/mo) + `APIFY_TOKEN`.
- An [Airtable](https://airtable.com) base (free tier) + a personal access token.
- (Optional) [Apify CLI](https://docs.apify.com/cli): `npm i -g apify-cli`.

## Local development

```bash
npm install            # install all workspaces
npm run typecheck      # tsc -b --noEmit, zero errors expected
npm run build          # compile all packages/actors
npm test               # node --test unit tests for the merge logic
```

Copy env vars before running anything that talks to a live service:

```bash
cp .env.example .env   # then fill in APIFY_TOKEN, AIRTABLE_API_KEY, AIRTABLE_BASE_ID
```

## Running an actor locally

```bash
cd actors/gcis
apify run               # uses .actor/INPUT_SCHEMA.json + local ./storage
```

Each actor writes normalised `PartialRecord` rows to its own Apify dataset. The `deliver`
actor reads those datasets, merges by `統一編號`, filters to the qualified working set
(≤ 1,000 rows — the Airtable free-tier cap), and upserts via the Airtable REST API.

## Deploying to Apify

```bash
cd actors/<source>
apify push              # builds + deploys the actor; schedule it in the Apify console
```

Schedules (see §8): GCIS weekly, 稅籍 weekly, PCC **daily**, Google Maps weekly,
公會 monthly, `deliver` after each ingest.

## Airtable base setup (P0)

Create one base with a `Companies` table whose fields match the canonical schema
(`packages/lib/src/schema.ts`). Add:

- `UnifiedBusinessNo` (single line text) — the upsert merge key.
- `CompanyName`, `ResponsiblePerson`, `County`, `District`, `Phone`, `Email`, `Website`,
  `TradeCategory`, `RecentTenderWin`, `LastAwardDate`, `LastRefreshed`.
- `Fit` as a **formula field** (scoring is computed in Airtable, not written by code).
- `Pain`, `Power`, `Will`, `Stage` — **human-owned**; the pipeline never writes these.

Add a Kanban view on `Stage`: Sourced → Contacted → Diagnostic → 現況地圖 → Design partner.

---

*Data sources: 經濟部商業發展署 (GCIS), 財政部財政資訊中心, 行政院公共工程委員會 (PCC) open data. Attribute on use.*
