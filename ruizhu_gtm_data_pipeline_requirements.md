# 睿築 GTM Lead Data Pipeline — Requirements & Implementation Spec

**Owner:** Kevin (CTO)  ·  **Status:** Draft v1 for implementation  ·  **Last updated:** 2026-06

---

## 0. TL;DR for the impatient

- **Do not build scrapers as the foundation.** ~80% of what you need is published by the Taiwan government as **official open-data APIs and bulk CSV**. Ingest those. Only ~20% (contact channels + a few association member lists) requires actual scraping.
- **Do not host this on AWS or Vercel to start.** Use **Apify** for the scraping pieces and a lightweight scheduled runner (Apify Actor or Trigger.dev job) for the API/CSV ingests. Reserve AWS for later, only if data-residency or scale demands it. Vercel is for an optional internal dashboard, never the scrapers.
- **`統一編號` (unified business number) is the primary key** that joins every source — company registry, tax registry, procurement awards. Design the whole pipeline around it.
- **The deliverable of this pipeline is rows in Airtable (free tier)**, which doubles as both the store of record and the CRM. Scoring is done with Airtable formula fields, not a paid enrichment tool. It is a data-ingestion pipeline, not a product.
- **Near-free by design.** We are a startup picking the path that produces leads and clients without incurring cost. Target run cost ≈ **$29/month** (one Apify Starter plan); everything else runs on free tiers. **No Clay, no paid enrichment, no AWS** in v1 — those are deferred until lead volume actually justifies them (see §12).

---

## 1. Objectives & scope

### 1.1 Goal
Build a maintainable pipeline that produces a continuously refreshed, deduplicated, scored list of **owner-operated Taiwanese construction subcontractors** (beachhead ICP), enriched with:
- Firmographics (name, 統編, 負責人/decision-maker, address, county/district, capital, industry codes, business status)
- Contact channels (phone, LINE, email, website)
- Intent signals (recent public-tender wins, active hiring)

…and lands them in **Airtable (free tier)**, which serves as both the store of record and the CRM. The merge/dedupe and fit-scoring are done by our own code + Airtable formulas — no paid enrichment or orchestration tool in v1.

### 1.2 Scale (this is small — design accordingly)
- Target universe: low tens of thousands of construction firms nationally; **working set ~100–500 well-fit firms** at a time.
- **The Airtable working set must stay ≤ 1,000 records** (free-tier cap, per base). Raw pulls (thousands of firms) stay in Apify; only qualified/working-set rows are pushed to Airtable. If you ever need more than 1,000 live rows, split by county into multiple bases or upgrade to Airtable Team (§12).
- Refresh cadence: firmographics weekly; intent signals daily.
- This is **not** a high-throughput system. Optimise for **low maintenance and correctness**, not scale.

### 1.3 Out of scope (for v1)
- Real-time enrichment, a custom UI/CRM, ML scoring, multi-country support, anything that isn't directly feeding the design-partner motion.

---

## 2. Guiding principles

1. **Open-data-first.** Prefer an official API/dataset over scraping every time. It's more stable, ToS-clean, and lower-maintenance.
2. **Scrape only for contact gaps.** Government registries give you firmographics and the decision-maker's name but **not** phone/LINE/email. That's the only thing you genuinely need to scrape (Google Maps + association lists).
3. **No bespoke infra until forced.** Every hour on infra is an hour not spent with a design partner. Use managed tooling (Apify) until you have a concrete reason not to.
4. **`統編`-centric.** One canonical record per 統編. All sources merge onto it. The merge/dedupe runs in our own "deliver" step (code), not in a paid tool — it upserts into Airtable keyed on 統編.
5. **Dogfood.** This pipeline is itself a live demo of 睿築's methodology ("we turn scattered data into an owned, queryable system without bespoke software"). Build it the way you'd build it for a client.
6. **Near-free until proven.** As an early-stage startup, spend nothing that isn't strictly required to generate leads. Run the whole pipeline on Apify Starter + free tiers (Airtable, GitHub, Gamma, Fathom). Add paid tools (Clay, enrichment, Airtable Team, AWS) only when a concrete limit or volume forces the upgrade — never preemptively.

---

## 3. Infrastructure decision: AWS vs Vercel vs Apify

| Option | Verdict | Why |
|---|---|---|
| **Vercel** | ❌ Not for scrapers | Serverless functions are time/memory-limited and ill-suited to headless-browser scraping or long-running jobs. Vercel is for a web frontend. (Fine *later* for an optional internal dashboard.) |
| **AWS** | ⏸ Later, only if forced | Most powerful, most ops overhead. Standing up Lambda/Fargate + EventBridge + proxies + storage is weeks of yak-shaving for volume Apify handles out of the box. Justified only by (a) Taiwan **data-residency** compliance, (b) cost at real scale, or (c) co-locating with your own DB. |
| **Apify** | ✅ Recommended | Purpose-built for this. Write each scraper/ingest as an **Actor** (Node/TS + Crawlee/Playwright). Get scheduling, proxy rotation (incl. residential TW), retries, storage (datasets/KV), and an API — for free. A small deliver step then upserts to Airtable via its REST API. Lowest ops burden for a 2-person team. One paid plan (Starter, $29/mo) covers our whole volume. |

### 3.1 Recommended architecture
- **Scraping/ingest runtime:** Apify Actors.
- **API/CSV ingests** (GCIS registry, PCC procurement, 稅籍 CSV): can run as simple Apify Actors *or* Trigger.dev scheduled jobs — both are fine; pick one for consistency. (These are just scheduled HTTP GET + parse; trivial compute that runs anywhere.)
- **Store of record + CRM:** **Airtable (Free plan)** — one base holds the canonical, deduped, scored working set, and the same base's views/Kanban serve as the CRM pipeline. No separate CRM, no database, no Clay in v1.
- **Merge + scoring:** the merge/dedupe runs in our own deliver step (code, keyed on 統編). Fit-scoring is done with **Airtable formula fields** (free); pain/power/will are entered manually after a conversation.
- **Orchestration:** Apify scheduler now; add Trigger.dev later when you want a single control plane and dependency ordering.

### 3.2 Migration path (when/if you outgrow Apify)
The scraper code is portable because Crawlee/Playwright runs identically locally, on Apify, and in a container.
- Containerise the same Playwright actor (Docker) → run as a scheduled **AWS Fargate task** (or ECS scheduled task) triggered by **EventBridge**.
- Persist to your own **Postgres (RDS)** or DynamoDB, in `ap-northeast-1` (Tokyo) or the Taiwan region if compliance requires.
- **Vercel** hosts only a thin Next.js internal dashboard/API if you ever want one.
- Trigger this migration on a real signal (residency requirement, Apify cost, or scale), not preemptively.

**Paid-tool upgrade triggers (stay free until one of these actually bites):**
- **Airtable Free → Team ($20/editor/mo):** when the working set genuinely needs to exceed 1,000 live records or 1,000 API writes/month and county-split bases get annoying.
- **Add Clay ($185+/mo):** only when you want real multi-provider contact enrichment or AI opener-drafting at volume — i.e. when manual/scraped contact data and Airtable formulas stop being enough. Not in v1.
- **Add paid enrichment / cold-email infra:** only after a message is validated and you're scaling outbound. Not in v1.

> Note on your security narrative: your deck promises client data stays in Taiwan (AWS, DPO, etc.). That constraint applies to **client** data. This pipeline handles **public B2B registry data**, which is a much lighter compliance category — so it does **not** force you onto self-hosted AWS now. Keep the two concerns separate.

---

## 4. System architecture & data flow

```
                         ┌─────────────────────────────────────────────┐
   OFFICIAL OPEN DATA     │  INGEST (Apify Actors / Trigger.dev jobs)    │
   (APIs / CSV)           │                                             │
   ─ GCIS company reg ───▶│  source connectors → raw records            │
   ─ 財政部 稅籍 CSV ──────▶│  (one actor per source, writes to its       │
   ─ PCC procurement ────▶│   Apify dataset / KV store)                  │
                         │                                             │
   SCRAPED (contact gap)  │                                             │
   ─ Google Maps (Apify) ▶│                                             │
   ─ 公會 directories ────▶│                                             │
   ─ 104 hiring (opt) ───▶│                                             │
                         └───────────────┬─────────────────────────────┘
                                         │
                                         ▼
                         ┌─────────────────────────────────────────────┐
                         │  NORMALISE + MERGE  (our code, keyed on 統編) │
                         │  ─ canonical schema                          │
                         │  ─ dedupe, conflict resolution               │
                         │  ─ derive trade_category, signals            │
                         │  ─ filter to qualified working set (≤1,000)  │
                         └───────────────┬─────────────────────────────┘
                                         │  upsert via Airtable REST API
                                         │  (batch 10/req, performUpsert on 統編)
                                         ▼
                         ┌─────────────────────────────────────────────┐
                         │  AIRTABLE (Free)  =  store of record + CRM   │
                         │  ─ fit score via FORMULA fields (free)       │
                         │  ─ pain/power/will entered manually          │
                         │  ─ Kanban view = pipeline stages:            │
                         │    Sourced → Contacted → Diagnostic →        │
                         │    現況地圖 → Design partner                   │
                         └─────────────────────────────────────────────┘
```

The "merge keyed on 統編" runs in **our deliver step** (a small actor/script using `lib/merge.ts`), then upserts into Airtable. Airtable is the single home for the working set *and* the pipeline — no separate CRM, no Clay. Keep raw rows in Apify datasets; push only the qualified working set to Airtable so you stay under the 1,000-record free cap.

---

## 5. Data sources / connectors

### 5.1 Summary table

| # | Source | Type | Gives you | Method | Cadence | Priority |
|---|--------|------|-----------|--------|---------|----------|
| 1 | GCIS 公司登記 (經濟部商業發展署) | **Official API + CSV** | 統編, 公司名稱, **負責人**, 地址, 資本額, 狀態, 營業項目 | HTTP GET (JSON/XML) or bulk CSV | Weekly | **P0** |
| 2 | 財政部 全國營業(稅籍)登記資料集 | **Official CSV** | active businesses by 行業 + area, status | Bulk CSV download (daily) | Weekly | P1 (complement) |
| 3 | PCC 政府電子採購網 決標 (OpenData) | **Official OpenData** | tender **wins** by 統編 = intent | OpenData download/API | Daily | **P0** (signal) |
| 4 | Google Maps | **Scrape (Apify actor)** | **phone, LINE, website**, reviews | Apify actor or Places API | Weekly | **P0** (contact) |
| 5 | 公會 member directories | **Scrape (light)** | name, **phone, email** | Cheerio/Playwright | Monthly | P1 |
| 6 | 104 hiring | Scrape (JS, ToS-restricted) | hiring signal | Apify (careful) | Weekly | P3 (optional) |

### 5.2 Source 1 — GCIS company registry (PRIMARY firmographics) — P0

**Platform:** 經濟部商工行政資料開放平臺 (`data.gcis.nat.gov.tw`), surfaced on `data.gov.tw`.

**Two access modes:**
- **Bulk CSV download** — open to all, no application. Best for an initial full pull of construction firms. (資料目錄 → 公司登記資料 / 商業登記資料.)
- **System-integration API** (OAS/Swagger) — JSON/XML, query by 統編 or 營業項目代碼. **Requires** submitting a 使用告知書 (notification form) to `opendata.gcis@gmail.com` and **IP whitelisting** (provide your external/egress IP — relevant for the Apify proxy/static-IP setup), plus per-IP **rate limits**.

**Key endpoints (confirm exact dataset IDs in the Phase-0 spike — IDs rotate):**
- Swagger / OAS spec: `https://data.gcis.nat.gov.tw/resources/swagger/index.html` (machine spec at `/resources/swagger/swagger.json`)
- Query by **business-item code** (use this to pull all construction firms): `GET https://data.gcis.nat.gov.tw/od/data/api/FCB90AB1-E382-45CE-8D4F-394861851E28?$format=json&$filter=Business_Item eq {code}&$skip=0&$top=1000`
- Lookup basic record by **統編**: `GET https://data.gcis.nat.gov.tw/od/data/api/5F64D864-61CB-4D0D-8AD9-492047CC1EA6?$format=json&$filter=Business_Accounting_NO eq {統編}`
- Business-item code reference table: `https://gcis.nat.gov.tw/cod/browseAction.do?method=browse`

**Pagination:** `$skip` (0…500000), `$top` (1…1000). Loop `$skip` in steps of 1000.

**Fields returned (map straight to canonical schema):**
`Business_Accounting_NO` (統編), `Company_Name`, `Responsible_Name` (**負責人 = your decision-maker**), `Company_Location` (地址), `Capital_Stock_Amount` / `Paid_In_Capital_Amount`, `Company_Status` / `Company_Status_Desc`, `Company_Setup_Date`, `Change_Of_Approval_Data`, `Business_Item` / `Business_Item_Desc`.

**Construction filter:** select the relevant 營業項目代碼 from the code table. Construction/engineering codes are in the **`E` series (營造業)** plus related trades (civil, building, plumbing/electrical, etc.). **Action:** in Phase 0, browse the code table and lock the exact code set (e.g. the E-series subset matching 土木包工業 / 專業營造 / 水電 / 泥作 / 鋼構 / 模板 / 防水). Store this list in config — it drives the whole pull.

> The 統編 you get here is the join key for sources 2 and 3.

### 5.3 Source 2 — 財政部 全國營業(稅籍)登記資料集 (complement) — P1

- `data.gov.tw` dataset (BGMOPEN1 family), **daily-updated bulk CSV**.
- Use to (a) cross-check **active** operating status and (b) catch businesses registered for tax but not in the company registry (sole proprietors / 行號, common among small subcontractors).
- Filter by 行業 code + 縣市. Join to source 1 by 統編.
- Note: the API returns only currently-operating businesses; separate datasets exist for 停業/非營業中 if you need them.

### 5.4 Source 3 — PCC government procurement (INTENT signal) — P0

**Use the official OpenData, NOT the web pages.** `web.pcc.gov.tw` is now behind Cloudflare and **blocks bot/AI crawlers** (notice posted 2025-07-14). Scraping it is both blocked and against the grain.

- OpenData listing: `https://web.pcc.gov.tw/tps/tp/OpenData/showList`
- Award (決標) OpenData endpoint family: `https://web.pcc.gov.tw/tps/tp/OpenData/getAtmOpenDataHis` (confirm exact params/format in spike)
- Community-maintained structured API (optional, check terms + attribution): `openfunltd` / `g0v` PCC project (`github.com/openfunltd/pcc.g0v.ronny.tw`)

**What you extract:** 決標公告 → 得標廠商 (winning vendor) **統編** + 標案名稱 + 機關 + 決標金額 + 決標日期.
**Signal logic:** a 統編 appearing in a recent award (last 30–90 days) = fresh budget + active project → flag `recent_tender_win = true` with date/amount. This is your highest-value timing trigger; run it **daily** and let new wins bump a firm's priority in Airtable.

**Bonus PCC sources (firmographic/quality signals, same join key):**
- 廠商承攬公共工程履歷 (vendor public-works history)
- 國土署 營造業評鑑結果 (contractor evaluation grades)
- 拒絕往來廠商 / §101 停權 (exclude blacklisted vendors)

### 5.5 Source 4 — Google Maps (CONTACT channels) — P0

The registries give you firmographics + 負責人 name but **no phone/LINE/email**. Google Maps fills the contact gap and is where the small-firm long tail lives.

- **Preferred:** Apify's existing Google Maps Scraper actor (don't build your own). Search per 縣市/區 × trade term (水電工程, 泥作, 防水, 鋼構, 模板, 土木包工業).
- **Alternative (ToS-clean, paid):** Google Places API.
- **Extract:** name, address, **phone**, website, plus_code, rating, review_count; parse website/LINE from the listing where present.
- **Join:** fuzzy-match name + address + phone back to the 統編 record (no shared key, so this is a probabilistic merge — keep a confidence score; manual-confirm A-tier).

### 5.6 Source 5 — 公會 (trade association) directories — P1

County-level 營造業 / 水電 / 土木 公會 publish **member lists with names, phones, and emails** (the same open pattern seen across professional associations). These are high-trust contacts and a referral surface.

- Small **static HTML** → Cheerio + `got`/`fetch`. A handful of one-off parsers (one per association site).
- Examples to start: 臺灣區綜合營造業同業公會 (`treca.org.tw`) + the county associations linked from MOL's 各縣市業管工會名冊.
- Light load: a few hundred rows total. **Respect robots.txt + per-site ToS, low concurrency, identify your UA.**

### 5.7 Source 6 — 104 hiring (OPTIONAL) — P3

- JS-rendered (a plain HTTP fetch returns nothing — confirmed). Needs a headless browser.
- **ToS restricts scraping.** Treat as low-priority; if used, keep volume minimal and use only as a soft "actively hiring = growing" signal, not a core source. Consider skipping for v1.

---

## 6. Canonical data model

One record per **統一編號**. (For 行號/sole-proprietors without a company 統編, fall back to tax-registry 統編.)

```jsonc
{
  "id": "tw-<統編>",                       // primary key
  "unified_business_no": "12345678",       // 統一編號 — the join key
  "company_name": "○○營造有限公司",
  "responsible_person": "王小明",          // 負責人 = decision maker (from GCIS)
  "company_status": "01",                  // 核准設立 / 解散 etc.
  "is_active": true,
  "capital_amount": 5000000,
  "address_raw": "桃園市中壢區○○路123號",
  "county": "桃園市",
  "district": "中壢區",
  "industry_items": ["E601", "E603"],      // 營業項目代碼
  "trade_category": "水電",                 // derived
  "contact": {
    "phone": "03-1234567",                 // from Google Maps / 公會
    "line_id": null,
    "email": null,
    "website": "https://..."
  },
  "signals": {
    "recent_tender_win": true,
    "last_award_date": "2026-05-12",
    "last_award_amount": 3200000,
    "hiring_active": false
  },
  "scoring": {                             // fit via Airtable formula; pain/power/will manual
    "fit": null, "pain": null, "power": null, "will": null, "tier": null
  },
  "provenance": {
    "sources": ["gcis", "pcc", "gmaps"],
    "source_match_confidence": { "gmaps": 0.86 },
    "first_seen": "2026-06-10",
    "last_refreshed": "2026-06-20"
  }
}
```

### 6.1 Identity & dedupe rules
- **Primary merge key:** `unified_business_no`. Exact match → same record.
- **Cross-source contact merge (Google Maps / 公會 → registry):** no shared key, so probabilistic. Match on normalised `company_name` + `phone` + `address` (county/district). Store `source_match_confidence`; only auto-merge ≥ 0.85, else queue for manual confirm. Never let a low-confidence merge overwrite a registry field.
- **Conflict resolution:** registry sources are authoritative for firmographics; scraped sources are authoritative only for contact channels. Last-write-wins **within** a field's authoritative source.

---

## 7. Pipeline stages

1. **Ingest** — one actor/job per source → writes raw rows to its own Apify dataset (immutable raw layer; keep for re-processing).
2. **Normalise** — map each source's fields to the canonical schema; clean addresses → county/district; map 營業項目 → `trade_category`.
3. **Merge/dedupe** — our deliver step upserts by 統編 and applies the identity rules above (uses `lib/merge.ts`).
4. **Signal derivation** — set `recent_tender_win`, `hiring_active`.
5. **Filter + deliver** — keep only qualified working-set rows (so Airtable stays ≤ 1,000), then upsert into **Airtable** via its REST API (batch 10 records/request, `performUpsert` keyed on 統編). Fit score is computed by an Airtable **formula field**; pain/power/will are filled manually after a call.
6. **Promote** — move a record's Stage field along the Airtable Kanban (Sourced → … → Design partner). No separate CRM hop.

Idempotency: every stage is keyed on 統編 and safe to re-run. Re-running a full refresh must not create duplicates or clobber post-conversation fields (pain/power/will, pipeline Stage) — those are owned in Airtable and must be **merge-protected**: the deliver step writes only firmographic/contact/signal fields and never overwrites human-entered ones.

---

## 8. Scheduling & orchestration

| Job | Cadence | Runtime |
|---|---|---|
| GCIS construction pull | Weekly | Apify actor / Trigger.dev |
| 稅籍 CSV refresh | Weekly | Apify actor / Trigger.dev |
| PCC award signal | **Daily** | Apify actor / Trigger.dev |
| Google Maps contact pull | Weekly (rolling by county) | Apify actor |
| 公會 directories | Monthly | Apify actor |
| Normalise + deliver to Airtable | After each ingest | Apify actor (deliver) → Airtable API |

- v1: Apify Scheduler per ingest actor; the `deliver` actor runs after ingests and upserts to Airtable. Chain with Apify's "run another actor on success" (no webhook/CRM tier needed).
- v2: move scheduling/dependency-ordering into **Trigger.dev** for one control plane, retries, and observability.

---

## 9. Non-functional requirements

- **Politeness / rate limiting:** respect each source's limits. GCIS API enforces per-IP usage caps → throttle and back off on 429. Google Maps via Apify → use the actor's built-in concurrency controls. 公會 sites → concurrency 1–2, 1–2 s delay, honour robots.txt, set a descriptive `User-Agent` with contact email.
- **Proxies:** Apify residential **TW** proxies only where anti-bot requires (Google Maps). Government open-data APIs do **not** need proxies (and GCIS API wants a **stable whitelisted IP** — so use a static egress, not rotating residential, for that one).
- **Retries / resilience:** exponential backoff, max 3 retries, dead-letter to a KV store; alert on repeated failure.
- **Idempotency:** all upserts keyed on 統編; merge-protect downstream-owned fields (§7).
- **Monitoring/alerting:** Apify run-failure webhooks → Slack/email. Track per-source: rows ingested, % with contact info, match-confidence distribution, last-success timestamp. A source going to 0 rows = silent-failure alert.
- **Airtable API limits (free tier):** ~1,000 API calls/month and a hard **5 requests/sec per base** on all tiers. So **batch writes** (up to 10 records/request) and use the **`performUpsert`** endpoint (find-create-update in one call) — that turns 1,000 monthly calls into up to ~10,000 record upserts. Do scoring with **formula fields**, not Airtable automations (Free allows only 100 automation runs/month).
- **Secrets:** store API keys (Apify token, Airtable PAT, 告知書-whitelisted creds) in Apify env vars (or a secrets manager later). **Never** hardcode. No credentials in the repo.
- **Freshness SLA:** firmographics ≤ 7 days; tender signals ≤ 24 h.
- **Data retention:** keep the raw layer in Apify; keep only the qualified working set (≤ 1,000) in Airtable.

---

## 10. Legal & compliance

- **Government open data:** GCIS and PCC publish under open-data terms permitting reuse, generally **with attribution** ("資料來源：經濟部商業發展署 / 行政院公共工程委員會"). Include attribution wherever you surface the data.
- **GCIS API access:** submit the 使用告知書 and complete IP whitelisting before using the system-integration API (CSV download needs no application).
- **PCC:** use OpenData, **do not crawl** the Cloudflare-protected web pages.
- **PDPA (個資法):** 負責人 name on the public company registry is **public company-registration information** (lower-risk). Treat any personal mobile / personal LINE / personal email obtained via 公會 or Maps as **personal data** — minimise, secure, and honour opt-outs in outreach. Don't compile or resell personal data; keep it to legitimate B2B outreach with self-identification.
- **104:** ToS restricts scraping — keep optional and minimal, or omit.
- **Don't republish** raw government datasets as your own; you're using them internally to target outreach.

---

## 11. Tech stack

- **Language:** Node.js + **TypeScript**.
- **Scraping framework:** **Crawlee** (+ Playwright for JS sites like Google Maps; Cheerio + `got-scraping` for static 公會 sites).
- **API/CSV ingest:** plain `fetch`/`undici` + `csv-parse`.
- **Runtime:** **Apify** (Actors + Scheduler + Proxy + Datasets/KV), one Starter plan.
- **Delivery client:** Airtable REST API via the official `airtable` npm client (batch + `performUpsert`).
- **Store of record + CRM:** **Airtable (Free plan)** — one base, formula-field scoring, Kanban pipeline.
- **Deferred (not v1):** Clay (enrichment/AI), Trigger.dev (orchestration), Next.js/Vercel (dashboard), AWS/Postgres (scale/residency).
- **Repo hygiene:** one actor per source under `/actors/<source>` plus an `/actors/deliver` step, shared `/lib` for the canonical schema + merge logic + address parsing + Airtable client, config for the 營業項目 code set and county list.

---

## 12. Cost (monthly) — the near-free build

We deliberately run this on **one paid plan + free tiers**. Prices are USD, verified mid-2026 — confirm live pages before subscribing.

| Tool | Role | Plan | Cost |
|---|---|---|---|
| GitHub | repo | Free (private repo) | **$0** |
| Apify | scrape + ingest runtime + raw storage | **Starter** | **$29** |
| Airtable | store of record **+ CRM** | **Free** (1,000 records/base) | **$0** |
| Gov open data (GCIS / 稅籍 / PCC) | firmographics + intent | open data | **$0** |
| Google Maps | contact channels | Apify actor (within Starter; pay-per-result is a few $) | **~$0–5** |
| Gamma | 現況地圖 collateral | Free | **$0** |
| Fathom (or tl;dv) | call-debrief transcription | Free | **$0** |
| LINE Official Account | outreach | Free tier | **$0** |
| **Total** | | | **≈ $29–35 / month** |

Why $29 and not $0: Apify's free plan ($5 credits) **blocks mid-month when credits run out**, which a scheduled pipeline can't tolerate — so the $29 Starter plan is the one unavoidable cost, and it covers far more volume than we need (~10–20k Maps records/month).

**Explicitly NOT in the budget (deferred until a real limit forces it):**
- **Clay** ($185–495/mo) — its value is paid enrichment + AI drafting, which we're avoiding. Add only when scraped/registry contacts + Airtable formulas stop being enough.
- Paid enrichment waterfalls (FullEnrich/Prospeo/Lusha), cold-email infra (Zapmail/Instantly/Smartlead), LinkedIn tools — $0 now; add only after a message is validated and you're scaling outbound.
- **Airtable Team** ($20/editor/mo) — only if the working set must exceed 1,000 live records and county-split bases get annoying.
- **AWS / Trigger.dev / Vercel** — $0 until residency or scale forces the move (§3.2).

> Bottom line: the pipeline that finds, scores, and tracks leads costs **about $29/month**. Everything beyond that is a deliberate upgrade you make only when paying customers or volume justify it.

---

## 13. Delivery milestones

| Phase | Outcome | Est. |
|---|---|---|
| **P0 — Spike (1–2 days)** | Confirm: exact GCIS dataset IDs + construction 營業項目 code set; GCIS CSV vs API decision; PCC OpenData award format; submit GCIS 告知書 if using API. Create the Airtable base (fields = canonical schema) + a free Airtable PAT. | 1–2 d |
| **P1 — Firmographics (week 1)** | GCIS construction pull → canonical records, keyed by 統編, with 負責人; deliver step upserts the qualified set into Airtable. ~1–5k firms pulled, ≤1,000 pushed. | 3–4 d |
| **P2 — Contacts (week 1–2)** | Apify Google Maps actor + 1–2 公會 parsers → merge phone/email onto records in the deliver step. | 3–4 d |
| **P3 — Intent signals (week 2)** | Daily PCC award job → `recent_tender_win` flags raising priority in Airtable. | 2–3 d |
| **P4 — Scoring + pipeline + monitoring (week 2–3)** | Airtable formula field for fit score; Kanban pipeline view; failure alerts; freshness tracking. | 2–3 d |
| **P5 — Later / optional** | Trigger.dev orchestration; 104 hiring; Clay/Airtable-Team/AWS *only if* a concrete limit demands it. | — |

**Definition of done for v1:** a weekly-refreshed, deduped, scored list of construction subcontractors **in Airtable (Free)** — each with 統編, 負責人, contact channel, and a tender-win flag — with a Kanban pipeline and failure alerts, running for ~$29/month. Nothing more.

---

## 14. Risks & mitigations

| Risk | Mitigation |
|---|---|
| GCIS API rate limits / whitelist friction | Start with **bulk CSV** (no application); add API only if you need per-統編 freshness. |
| Google Maps anti-bot / breakage | Use Apify's maintained actor (they fix breakage), not a hand-rolled scraper. |
| Maps↔registry merge is fuzzy | Confidence scoring + manual confirm on A-tier only; don't over-engineer auto-merge. |
| Over-building (the real risk) | Hard-cap v1 at the DoD above. No Clay, no DB, no UI, no AWS until a concrete trigger. |
| Airtable Free caps (1,000 records, 1,000 API writes/mo) | Keep raw in Apify; push only the qualified working set; batch + `performUpsert`; score via formula fields (not automations). County-split bases or Team upgrade only if you truly exceed it. |
| Source schema drift | Raw immutable layer + per-source normaliser isolates drift to one file; 0-row alerts catch silent breakage. |
| PDPA exposure | Keep personal contact data minimal, secured, opt-out-honouring; attribute gov sources. |

---

## 15. Repository scaffolding brief — for Cursor / coding agents

> **How to use this section:** Open the whole document in Cursor as context, then point the agent at this section. It is the build order and conventions; §3 (infra), §5 (sources), §6 (schema) and Appendix A (reference actors) are the detail. After scaffolding, also create an `AGENTS.md` at the repo root that restates §15.4 (conventions) and §15.5 (do-not list) so future agent sessions inherit them.

### 15.1 What you are building
A small **TypeScript + Apify** monorepo (plain **npm workspaces** — *not* Nx/Turborepo) that:
1. ingests Taiwan government **open data** (company registry, procurement awards, tax registry),
2. **scrapes only contact channels** (Google Maps via Apify's existing actor; a few static 公會 member lists),
3. **normalises everything to one canonical record keyed on `統一編號`** (see §6),
4. **merges/dedupes in a `deliver` actor and upserts the qualified working set into Airtable** (free tier) via its REST API — Airtable is both the store of record and the CRM. No Clay, no webhook tier.

This is a pre-PMF, two-person pipeline. **Optimise for simplicity and correctness, not scale or extensibility.**

### 15.2 Target folder structure
```
ruizhu-gtm-data-pipeline/
├─ README.md                  # what this is; links to the requirements doc; how to run
├─ AGENTS.md                  # conventions + do-not list (generate from §15.4–15.5)
├─ package.json               # npm workspaces root
├─ tsconfig.base.json
├─ .gitignore
├─ .env.example               # never commit a real .env
├─ packages/
│  └─ lib/                     # shared, no Apify dependency
│     ├─ package.json
│     ├─ tsconfig.json
│     └─ src/
│        ├─ schema.ts          # canonical CompanyRecord (from §6) — single source of truth
│        ├─ merge.ts           # mergeRecord() + matchConfidence() (rules in §6.1)
│        ├─ airtable.ts        # upsert client (batch 10/req, performUpsert on 統編)
│        ├─ address.ts         # parse 縣市/區 from addressRaw
│        ├─ trade.ts           # 營業項目代碼 → tradeCategory
│        └─ index.ts           # re-exports
├─ config/
│  ├─ industry-codes.json      # construction 營業項目 set — FILLED IN PHASE-0 SPIKE
│  └─ counties.json            # 縣市 / 區 reference list
└─ actors/                     # one Apify actor per source + a deliver step
   ├─ gcis/                    # P0  firmographics — open-data API/CSV  (Appendix A.2)
   ├─ pcc/                     # P0  intent — award OpenData
   ├─ gmaps/                   # P0  contact — wraps Apify Google Maps actor / Places API
   ├─ gonghui/                 # P1  contact — static association scraper (Appendix A.1)
   ├─ tax/                     # P1  active-status — 財政部 稅籍 CSV
   └─ deliver/                 # reads datasets → merge by 統編 → upsert to Airtable (Appendix A.3)
```
Each actor folder follows Apify's standard layout:
```
actors/<source>/
├─ .actor/
│  ├─ actor.json              # name, version, dockerfile path
│  └─ INPUT_SCHEMA.json       # typed inputs (e.g. itemCodes, counties, startUrls)
├─ src/main.ts                # entrypoint
├─ package.json               # depends on apify, crawlee, and workspace:lib
├─ tsconfig.json              # extends ../../tsconfig.base.json
└─ Dockerfile                 # apify/actor-node(-playwright) base — Apify standard, leave as template
```
> The `Dockerfile` here is **Apify's standard actor template**, not custom container infra — leave it as the generated default. This is unrelated to the "don't self-host on AWS/Docker yet" guidance in §3.

### 15.3 Boilerplate file contents

**`package.json` (root)**
```json
{
  "name": "ruizhu-gtm-data-pipeline",
  "private": true,
  "workspaces": ["packages/*", "actors/*"],
  "engines": { "node": ">=20" },
  "scripts": {
    "build": "tsc -b",
    "typecheck": "tsc -b --noEmit"
  },
  "devDependencies": {
    "typescript": "^5.5.0",
    "@types/node": "^20.0.0"
  }
}
```

**`tsconfig.base.json`**
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": true
  }
}
```

**`.gitignore`**
```
node_modules/
dist/
.env
storage/
apify_storage/
*.log
.DS_Store
```

**`.env.example`**
```
APIFY_TOKEN=
# Airtable — the store of record + CRM (free tier)
AIRTABLE_API_KEY=          # personal access token (scopes: data.records:write, schema read)
AIRTABLE_BASE_ID=
AIRTABLE_TABLE=Companies
GCIS_API_BASE=https://data.gcis.nat.gov.tw/od/data/api
# Google Maps via the Apify actor needs no key. Only if using Places API instead:
GOOGLE_PLACES_API_KEY=
```

**`packages/lib/src/schema.ts`** — the canonical type. Everything else imports from here.
```ts
export type SourceName = 'gcis' | 'tax' | 'pcc' | 'gmaps' | 'gonghui' | 'i104';

export interface CompanyRecord {
  id: string;                       // `tw-${unifiedBusinessNo}`
  unifiedBusinessNo: string;        // 統一編號 — the join key
  companyName: string;
  responsiblePerson: string | null; // 負責人 = decision maker (from GCIS)
  companyStatus: string | null;
  isActive: boolean;
  capitalAmount: number | null;
  addressRaw: string | null;
  county: string | null;
  district: string | null;
  industryItems: string[];          // 營業項目代碼
  tradeCategory: string | null;     // derived in trade.ts
  contact: {
    phone: string | null;
    lineId: string | null;
    email: string | null;
    website: string | null;
  };
  signals: {
    recentTenderWin: boolean;
    lastAwardDate: string | null;
    lastAwardAmount: number | null;
    hiringActive: boolean;
  };
  scoring: {                        // owned in Airtable (fit=formula, pain/power/will=manual) — ingest must never overwrite
    fit: number | null;
    pain: number | null;
    power: number | null;
    will: number | null;
    tier: 'A' | 'B' | 'C' | null;
  };
  provenance: {
    sources: SourceName[];
    sourceMatchConfidence: Record<string, number>;
    firstSeen: string;              // ISO date
    lastRefreshed: string;          // ISO date
  };
}

/** What each source emits after normalisation, before merge. */
export type PartialRecord = Partial<CompanyRecord> & { unifiedBusinessNo?: string };
```

**`packages/lib/src/merge.ts`** — scaffold the signatures and merge rules; leave bodies as `TODO` for the agent to implement against §6.1.
```ts
import type { CompanyRecord, PartialRecord, SourceName } from './schema';

const REGISTRY_SOURCES: SourceName[] = ['gcis', 'tax', 'pcc'];   // authoritative for firmographics
const CONTACT_SOURCES:  SourceName[] = ['gmaps', 'gonghui'];     // authoritative only for contact.*

/**
 * Upsert a normalised partial onto an existing record (or create one).
 * Rules (§6.1):
 *  - merge by unifiedBusinessNo
 *  - registry sources win on firmographics; contact sources win only on contact.*
 *  - NEVER overwrite scoring.* or any downstream-owned field
 *  - update provenance.sources / lastRefreshed
 */
export function mergeRecord(
  existing: CompanyRecord | null,
  incoming: PartialRecord,
  source: SourceName,
): CompanyRecord {
  // TODO: implement per §6.1
  throw new Error('not implemented');
}

/**
 * Probabilistic match for contact sources lacking 統編 (gmaps/gonghui).
 * Returns 0–1 from normalised name + phone + address similarity.
 * Auto-merge only when >= 0.85; otherwise queue for manual confirm.
 */
export function matchConfidence(candidate: PartialRecord, target: CompanyRecord): number {
  // TODO: implement
  return 0;
}
```

### 15.4 Conventions (put these in `AGENTS.md` too)
- TypeScript **strict**; ESM (`NodeNext`); Node ≥ 20.
- **`schema.ts` is the single source of truth** for the data shape. Every actor normalises its raw rows into `PartialRecord` before pushing; no actor invents its own field names.
- **`統一編號` (`unifiedBusinessNo`) is the primary key** everywhere. `id = ` + "`tw-${unifiedBusinessNo}`".
- One actor per source under `actors/<source>`; shared logic lives **only** in `packages/lib`. Actors must not import from each other.
- Secrets come from **env vars** (`process.env`). Never hardcode tokens; never commit `.env`.
- Every actor: pagination with backoff on HTTP 429, max 3 retries, structured logs, and a 0-row warning.
- Attribute government sources in code comments and any surfaced output (`資料來源：經濟部商業發展署 / 公共工程委員會`).
- `config/industry-codes.json` and `config/counties.json` drive targeting — **no hardcoded codes inside actors.**
- **Airtable is the only delivery target.** All writes go through `lib/airtable.ts`: batch ≤ 10 records/request, use `performUpsert` keyed on `unifiedBusinessNo`, honour the 5 req/sec per-base limit, and write **only** firmographic/contact/signal fields — never the human-owned fields (`scoring.pain/power/will`, pipeline `Stage`). Fit score is an Airtable formula field, not written by code.

### 15.5 Do NOT (scope guards)
- ❌ No CI/CD pipelines, no GitHub Actions, no Docker beyond Apify's template Dockerfile.
- ❌ No database, ORM, or migration tooling — Airtable + Apify datasets are the store for v1.
- ❌ No web framework, API server, or dashboard.
- ❌ No Clay, no paid enrichment, no cold-email infra in v1 — they are deferred (§12).
- ❌ No Nx/Turborepo/Lerna — plain npm workspaces only.
- ❌ No test framework setup beyond a couple of plain unit tests for `merge.ts`/`matchConfidence` (use `node --test`, no Jest).
- ❌ Do not build a generic "scraper framework" or plugin system. Five concrete actors, copy-paste-similar, is correct here.

### 15.6 Ordered scaffolding tasks (for the agent to execute)
1. Create the folder structure in §15.2 and all boilerplate files in §15.3.
2. Implement `packages/lib`: finish `schema.ts` (done above), implement `address.ts` (縣市/區 split), `trade.ts` (code→category map using `config/industry-codes.json`), the `merge.ts` bodies per §6.1, and `airtable.ts` (the batched `performUpsert` client — Appendix A.3). Add `node --test` unit tests for `mergeRecord` and `matchConfidence`.
3. Scaffold `actors/gcis` from **Appendix A.2** (open-data API ingest). Wire it to read `config/industry-codes.json`, normalise rows to `PartialRecord`, and `pushData`. This is the P0 deliverable.
4. Scaffold `actors/deliver` from **Appendix A.3**: read the source datasets, merge by 統編 via `lib/merge.ts`, filter to the qualified working set, and upsert into Airtable via `lib/airtable.ts`.
5. Scaffold `actors/gonghui` from **Appendix A.1** (static scraper) with `startUrls` from `INPUT_SCHEMA.json`.
6. Scaffold `actors/pcc`, `actors/gmaps`, `actors/tax` as stubs with correct inputs, `main.ts` skeleton, and TODOs referencing §5.3–5.5.
7. Write `README.md` (what it is, link to `ruizhu_gtm_data_pipeline_requirements.md`, local-run + Apify-deploy + Airtable-base-setup instructions) and `AGENTS.md` (from §15.4–15.5).
8. Ensure `npm install` + `npm run typecheck` pass clean.

### 15.7 Acceptance criteria
- Repo compiles: `npm run typecheck` passes with zero errors.
- `packages/lib` exports a complete `CompanyRecord`, working `mergeRecord`/`matchConfidence`, and passing unit tests.
- `actors/gcis` runs locally (`apify run`) against a single 營業項目 code and writes normalised `PartialRecord` rows to its dataset.
- `actors/deliver` upserts a sample batch into Airtable by 統編 (idempotent — re-running does not duplicate rows or overwrite human-owned fields).
- `actors/gonghui` parses one real association page into `{companyName, phone, email}` rows.
- `.env.example` (with Airtable vars), `.gitignore`, `README.md`, `AGENTS.md` present; no secrets committed.
- The remaining actors exist as typed stubs that compile.

---

## Appendix A — Reference Apify Actor skeleton (TypeScript)

**A.1 Static directory scraper (公會) — Cheerio**
```ts
import { Actor } from 'apify';
import { CheerioCrawler } from 'crawlee';

await Actor.init();
const { startUrls } = await Actor.getInput<{ startUrls: string[] }>() ?? { startUrls: [] };

const crawler = new CheerioCrawler({
  maxConcurrency: 2,
  requestHandler: async ({ $, request, log }) => {
    // One parser per association layout; selector below is illustrative.
    $('table.member-row tr').each((_, el) => {
      const name = $(el).find('.company').text().trim();
      const phone = $(el).find('.phone').text().trim();
      const email = $(el).find('a[href^="mailto:"]').attr('href')?.replace('mailto:', '') ?? null;
      if (name) Actor.pushData({ source: 'gonghui', source_url: request.url, company_name: name, phone, email });
    });
    log.info(`parsed ${request.url}`);
  },
});

await crawler.run(startUrls.map((url) => ({ url })));
await Actor.exit();
```

**A.2 Open-data API ingest (GCIS by business-item) — fetch + paginate**
```ts
import { Actor } from 'apify';

await Actor.init();
const { itemCodes } = await Actor.getInput<{ itemCodes: string[] }>() ?? { itemCodes: [] };
const API = 'https://data.gcis.nat.gov.tw/od/data/api/FCB90AB1-E382-45CE-8D4F-394861851E28';

for (const code of itemCodes) {
  for (let skip = 0; ; skip += 1000) {
    const url = `${API}?$format=json&$filter=Business_Item eq ${code}&$skip=${skip}&$top=1000`;
    const res = await fetch(url);
    if (!res.ok) { await new Promise(r => setTimeout(r, 2000)); continue; } // backoff on 429
    const rows = await res.json() as any[];
    if (!rows.length) break;
    await Actor.pushData(rows.map((r) => ({
      source: 'gcis',
      unified_business_no: r.Business_Accounting_NO,
      company_name: r.Company_Name,
      responsible_person: r.Responsible_Name,
      address_raw: r.Company_Location,
      capital_amount: Number(r.Capital_Stock_Amount) || null,
      company_status: r.Company_Status,
      industry_item: code,
    })));
  }
}
await Actor.exit();
```
> Swap the dataset UUID/params for the exact ones confirmed in the Phase-0 spike. Same pattern (fetch + paginate + push) works for the PCC award OpenData job.

**A.3 Deliver step — merge by 統編 + upsert to Airtable**
```ts
// packages/lib/src/airtable.ts — batched upsert client (no Clay, no webhooks)
import Airtable from 'airtable';
import type { CompanyRecord } from './schema';

const base = new Airtable({ apiKey: process.env.AIRTABLE_API_KEY })
  .base(process.env.AIRTABLE_BASE_ID!);
const TABLE = process.env.AIRTABLE_TABLE ?? 'Companies';

// Fields the pipeline owns. Human-owned fields (Pain/Power/Will/Stage) are
// intentionally excluded so upserts never overwrite them. Fit is a formula field.
function toFields(r: CompanyRecord) {
  return {
    UnifiedBusinessNo: r.unifiedBusinessNo,
    CompanyName: r.companyName,
    ResponsiblePerson: r.responsiblePerson,
    County: r.county, District: r.district,
    Phone: r.contact.phone, Email: r.contact.email, Website: r.contact.website,
    TradeCategory: r.tradeCategory,
    RecentTenderWin: r.signals.recentTenderWin,
    LastAwardDate: r.signals.lastAwardDate,
    LastRefreshed: r.provenance.lastRefreshed,
  };
}

/** Upsert in batches of 10, matching on UnifiedBusinessNo (Airtable performUpsert). */
export async function upsertCompanies(records: CompanyRecord[]) {
  for (let i = 0; i < records.length; i += 10) {
    const batch = records.slice(i, i + 10).map((r) => ({ fields: toFields(r) }));
    await base(TABLE).update(batch, {           // update() with upsert semantics
      performUpsert: { fieldsToMergeOn: ['UnifiedBusinessNo'] },
      typecast: true,
    });
    await new Promise((res) => setTimeout(res, 250)); // stay under 5 req/s per base
  }
}
```
```ts
// actors/deliver/src/main.ts — read datasets → merge → filter → upsert
import { Actor } from 'apify';
import { mergeRecord, upsertCompanies, type CompanyRecord, type PartialRecord } from '@ruizhu/lib';

await Actor.init();
const { datasetIds } = await Actor.getInput<{ datasetIds: string[] }>() ?? { datasetIds: [] };

const byTongbian = new Map<string, CompanyRecord>();
for (const id of datasetIds) {
  const { items } = await Actor.apifyClient.dataset(id).listItems();
  for (const row of items as PartialRecord[]) {
    const key = row.unifiedBusinessNo;
    if (!key) continue;                          // contact-only rows resolved via matchConfidence (TODO)
    byTongbian.set(key, mergeRecord(byTongbian.get(key) ?? null, row, row.source!));
  }
}

// Keep Airtable under the 1,000-record free cap: push only qualified working set.
const working = [...byTongbian.values()].filter((r) => r.isActive /* && fit gate */).slice(0, 1000);
await upsertCompanies(working);
await Actor.exit();
```

## Appendix B — Source endpoint quick reference

| Source | URL |
|---|---|
| GCIS open-data platform | `https://data.gcis.nat.gov.tw/` |
| GCIS Swagger/OAS | `https://data.gcis.nat.gov.tw/resources/swagger/index.html` |
| GCIS 營業項目代碼表 | `https://gcis.nat.gov.tw/cod/browseAction.do?method=browse` |
| GCIS API access rules / 告知書 | `https://data.gcis.nat.gov.tw/od/rule` (contact `opendata.gcis@gmail.com`) |
| 財政部 稅籍 dataset | `https://data.gov.tw/dataset/9400` |
| PCC OpenData list | `https://web.pcc.gov.tw/tps/tp/OpenData/showList` |
| PCC community API (g0v) | `https://github.com/openfunltd/pcc.g0v.ronny.tw` |
| MOL 各縣市業管工會名冊 | (search "各縣市政府業管工會名冊" on mol.gov.tw) |
| 綜合營造業公會 | `https://www.treca.org.tw/` |

## Appendix C — Phase-0 spike checklist

- [ ] Browse GCIS 營業項目代碼表; lock the construction code set; store in config.
- [ ] Decide GCIS **CSV vs API** (default: CSV first).
- [ ] If API: submit 使用告知書, get static egress IP whitelisted.
- [ ] Confirm PCC award OpenData file format + the field carrying winner 統編.
- [ ] Pull 50 sample firms end-to-end (GCIS → Maps merge → Airtable) and eyeball match quality before scaling.
- [ ] Create the Airtable base (fields = canonical schema, fit-score formula field) + a free personal access token; confirm the Apify `deliver` → Airtable upsert path.

---

*Data sources: 經濟部商業發展署 (GCIS), 財政部財政資訊中心, 行政院公共工程委員會 (PCC) open data. Attribute on use.*
