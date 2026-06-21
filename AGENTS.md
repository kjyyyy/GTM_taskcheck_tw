# AGENTS.md — 睿築 GTM Lead Data Pipeline

Guidance for AI coding agents working in this repo. The full spec is
`ruizhu_gtm_data_pipeline_requirements.md` — read §15 before scaffolding, §3/§5/§6
and Appendix A for detail.

## What this is

A small **TypeScript + Apify** monorepo (plain **npm workspaces**) that:

1. ingests Taiwan government **open data** (company registry, procurement awards, tax registry),
2. **scrapes only contact channels** (Google Maps via Apify's existing actor; a few static 公會 member lists),
3. **normalises everything to one canonical record keyed on `統一編號`** (see §6),
4. **merges/dedupes in a `deliver` actor and upserts the qualified working set into Airtable** (free tier) via its REST API.

Airtable is both the store of record and the CRM. This is a pre-PMF, two-person pipeline.
**Optimise for simplicity and correctness, not scale or extensibility.**

## Conventions

- TypeScript **strict**; ESM (`NodeNext`); Node ≥ 20. Relative imports use explicit `.js` extensions.
- **`packages/lib/src/schema.ts` is the single source of truth** for the data shape. Every actor normalises its raw rows into `PartialRecord` before pushing; no actor invents its own field names.
- **`統一編號` (`unifiedBusinessNo`) is the primary key** everywhere. `id = ` + `` `tw-${unifiedBusinessNo}` ``.
- One actor per source under `actors/<source>`; shared logic lives **only** in `packages/lib`. Actors must not import from each other.
- Secrets come from **env vars** (`process.env`). Never hardcode tokens; never commit `.env`.
- Every actor: pagination with backoff on HTTP 429, max 3 retries, structured logs, and a 0-row warning.
- Attribute government sources in code comments and any surfaced output (`資料來源：經濟部商業發展署 / 公共工程委員會`).
- `config/industry-codes.json` and `config/counties.json` drive targeting — **no hardcoded codes inside actors.**
- **Airtable is the only delivery target.** All writes go through `lib/airtable.ts`: batch ≤ 10 records/request, use `performUpsert` keyed on `unifiedBusinessNo`, honour the 5 req/sec per-base limit, and write **only** firmographic/contact/signal fields — never the human-owned fields (`scoring.pain/power/will`, pipeline `Stage`). Fit score is an Airtable formula field, not written by code.

## Do NOT (scope guards)

- ❌ No CI/CD pipelines, no GitHub Actions, no Docker beyond Apify's template Dockerfile.
- ❌ No database, ORM, or migration tooling — Airtable + Apify datasets are the store for v1.
- ❌ No web framework, API server, or dashboard.
- ❌ No Clay, no paid enrichment, no cold-email infra in v1 — they are deferred (§12).
- ❌ No Nx/Turborepo/Lerna — plain npm workspaces only.
- ❌ No test framework setup beyond a couple of plain unit tests for `merge.ts`/`matchConfidence` (use `node --test`, no Jest).
- ❌ Do not build a generic "scraper framework" or plugin system. Five concrete actors, copy-paste-similar, is correct here.
- ❌ No AWS / Trigger.dev / Vercel until a concrete residency or scale trigger forces it (§3.2).
