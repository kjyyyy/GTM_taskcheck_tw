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
scripts/             # airtable-setup.mjs (idempotent schema) + run-taichung.mjs (local end-to-end run)
actors/
  gcis/              # P0  firmographics — GCIS county open-data CSV (default) or item-code API
  pcc/               # P0  intent — award OpenData (stub)
  gmaps/             # P0  contact — wraps Apify Google Maps actor (phone + rating/reviews/category)
  gonghui/           # P1  contact — static 公會 association scraper (config-driven parsers)
  i104/              # P2  size + hiring — 104 company profiles (low-volume, joins by 統編)
  tax/               # P1  active-status — 財政部 稅籍 CSV (stub)
  deliver/           # reads datasets → merge by 統編 → county/size filter → upsert to Airtable
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
公會 monthly, 104 monthly (low volume), `deliver` after each ingest.

## Airtable base setup (done via script)

The `Companies` table and its fields (including the `Fit` formula and the human-owned
`Pain`/`Power`/`Will`/`Tier`/`Stage`/`LostReason`) are created by
[`scripts/airtable-setup.mjs`](scripts/airtable-setup.mjs) against the base in `.env`
(`AIRTABLE_BASE_ID`). Re-run it only if you need to rebuild the table in a fresh base:

```bash
node scripts/airtable-setup.mjs    # reads AIRTABLE_API_KEY + AIRTABLE_BASE_ID from .env
```

The pipeline-owned fields include the firmographics/contact set plus the Google Maps signals
`Rating`, `ReviewsCount`, `MapsCategory`, `MapsUrl`, and the two record-type keys/flags
`UnifiedBusinessNo`, `LeadKey`, `Verified` (see below). Scoring lives in Airtable (`Fit` formula),
and the pipeline never writes the human-owned fields. One manual step remains (the API can't
create views):

- Add a **Kanban view** on `Stage`: Sourced → Contacted → Diagnostic → 現況地圖 → Design partner.

#### Two record types: verified firms vs. unverified Maps leads

Every row is one of two kinds, and `deliver` upserts them in **two passes** so their keys never collide:

- **Verified firm** (`Verified = true`) — backed by a 統一編號 from the GCIS registry, so it carries
  a 負責人, 資本額, and active status. Upserted by merging on **`UnifiedBusinessNo`**.
- **Unverified Maps lead** (`Verified = false`) — a phone-bearing Google Maps place that matched **no**
  registry firm (e.g. a 商業登記 sole-proprietor 水電行 not in the company CSV). It has **no 統編 and no
  負責人** (call the listed business line), and is kept so good leads aren't dropped. Keyed on
  **`LeadKey`** = `gm-<placeId>` (falling back to `gm-<phone digits>`), stable across re-runs.

Leads are scarce and high-value, so `deliver` reserves their budget first, then fills the rest of the
cap with verified firms (toggle with the `keepUnmatchedLeads` input, default `true`).

### ICP fit: "not tech-enabled" signal

Our beachhead ICP is owner-operated subcontractors who are **not tech-enabled** — exactly the
firms that need 睿築 to turn scattered data into an owned system. The Google Maps ingest
(`actors/gmaps`) gives us a cheap proxy for this: a firm that has a **phone but no website**
(`Website` is empty after the Maps merge) is reachable *and* digitally immature — a strong fit.

We deliberately do **not** pay for the Maps actor's Business-leads enrichment add-on: the
decision-maker (`ResponsiblePerson` / 負責人) already comes from GCIS for free.

#### Fit formula (0–7)

Owner-operated is partly a **size** statement; we get size two ways, in priority order:
`EmployeeCount` (員工人數, direct headcount from 104 for the subset that posts jobs) then
`CapitalAmount` (資本額, present for *every* GCIS firm). Scoring is an Airtable formula field
(scoring lives in Airtable, never in code) — managed by `scripts/airtable-setup.mjs`:

```
Fit =
  IF(AND({Phone} != "", {Website} = ""), 2, IF({Phone} != "", 1, 0))                              // contactable & not tech-enabled (0-2)
  + IF({RecentTenderWin}, 1, 0)                                                                    // active intent (0-1)
  + IF({EmployeeCount}, IF({EmployeeCount} <= 10, 2, IF({EmployeeCount} <= 30, 1, 0)),
      IF(AND({CapitalAmount} > 0, {CapitalAmount} <= 30000000), 1, 0))                             // owner-operated size (0-2)
  + IF({Verified}, 1, 0)                                                                           // registry-backed + has 負責人 (0-1)
  + IF(AND({Rating} >= 4.5, {ReviewsCount} >= 5), 1, 0)                                            // strong Google Maps reputation (0-1)
```

- A small (≤10 staff), contactable, no-website **verified** firm with a recent tender win and strong
  reviews scores highest. `Pain/Power/Will` are layered in manually after a conversation.
- The `{CapitalAmount} > 0` guard matters: Airtable treats a blank number as 0, so without it every
  unverified lead (which has no 資本額) would get a free "small" point. With the guard, leads cap at 3
  (phone + no-website + reputation) and never outrank a comparable verified firm.
- Updating the formula later: just edit `FIT_FORMULA` in `scripts/airtable-setup.mjs` and re-run it —
  the script creates `Fit` if missing and otherwise PATCHes the existing field's formula in place
  (the Airtable Meta API can update formula options).

> Hard size gate (vs. soft score): the `deliver` actor also takes an optional `maxEmployees`
> input that **drops** firms whose headcount is *known* and above the ceiling. Unknown-size
> firms are kept (104 covers only a fraction), so this never silently discards GCIS-only leads.

### Beachhead recipe: penetrate Taichung (臺中市)

The fastest path to first design partners is to saturate **one metro** where decision-makers
are reachable. Taichung run, end to end:

1. **Firmographics** — `actors/gcis` for 台中 construction firms (統編, 負責人, 資本額, address).
2. **Contact** — `actors/gmaps` with `counties: ["臺中市"]` (phone + the no-website ICP signal).
3. **Decision-makers** — `actors/gonghui`: the confirmed 臺灣區綜合營造業同業公會臺中市辦事處
   roster (`config/gonghui-sites.json`) yields **公司名稱 + 負責人 (董事長/總經理) + 電話 + 地址**.
   These rows have no 統編, so `deliver` fuzzy-matches them onto the GCIS firm by name+phone+county.
4. **Size + intent** — `actors/i104` (low volume) adds 員工人數 + hiring; `actors/pcc` adds tender wins.
5. **Deliver** — run with `counties: ["臺中市"]` and (optionally) `maxEmployees: 30` to land a
   focused, owner-operated Taichung working set in Airtable.

**Decision-maker coverage**: the bulk Taichung CSV has 統編/名稱/地址/資本額 but **no 負責人**, so
`deliver` backfills 負責人 + active status per-統編 from the GCIS company-basic API
(`enrichDecisionMaker`, bounded to the capped working set). 公會 rosters already carry a verified
名+職稱 (often 董事長/總經理) for association members. The rest are reached via the Maps phone + a
quick call. We do not buy Western contact DBs (LinkedIn/email tools) — this ICP runs on **LINE + phone**.

### GTM flywheel & tooling verdict

The pipeline is only the *sourcing* half. The flywheel lives in Airtable:

**Sourced → Contacted → Diagnostic → 現況地圖 → Design partner**, with every touch logged on
the record. Track **hit rate** (Contacted→Diagnostic) and **win rate** (Diagnostic→Design partner)
as Airtable rollups, and tag *missed* opportunities with a `LostReason` so sourcing can be tuned
(e.g. if no-website + small + tender-win converts best, weight `Fit` toward it and pull more of that).

Tooling, from a cost-efficient standpoint for *this* ICP:

- **Keep (≈ free):** Apify (Maps + our actors), GCIS/PCC/稅籍 open data, 104, Airtable. This is the stack.
- **Skip for now:** Clay, Prospeo, Apollo/AI Ark, Lusha, FullEnrich, ZeroBounce, Lemlist, Instantly,
  Smartlead, HeyReach, PhantomBuster, BuiltWith, etc. They are built for **English-language,
  email/LinkedIn-led, SaaS** motions — Taiwanese owner-operated subcontractors are reached on
  **LINE and phone**, and their firmographics are already free from GCIS. Email-sequencing and
  contact-DB spend would burn budget on channels this ICP doesn't use.
- **Reconsider later, only if proven:** a LINE Official Account / broadcast tool once there's a
  repeatable message worth scaling — *after* manual outreach validates the pitch.

## Operational runbook (Taichung)

Run order for one Taichung working set. Each ingest writes to its own Apify dataset; copy each
run's dataset id into `deliver`'s `datasetIds`. `deliver` is the only Airtable writer.

| Step | Actor | Key input | Output |
|---|---|---|---|
| 1 | `gcis` | `mode: "taichung-csv"` (default) | ~22k 台中 firms: 統編, 名稱, 地址, 資本額 |
| 2 | `gmaps` | `counties: ["臺中市"]` | phone + the no-website ICP signal |
| 3 | `gonghui` | (uses `config/gonghui-sites.json`) | 公司名稱 + 負責人 + 電話 (公會 members) |
| 4 | `i104` *(optional)* | `counties: ["臺中市"]` | 員工人數 + hiring |
| 5 | `deliver` | `datasetIds: [...]`, `counties: ["臺中市"]`, `maxEmployees: 30`, `enrichDecisionMaker: true`, `keepUnmatchedLeads: true` | upserts verified firms + Maps leads, backfills 負責人 |

`deliver` merges by 統編, fuzzy-matches the contact-only Maps/公會 rows onto GCIS firms, backfills
負責人 + active status for the capped set, then upserts ≤ `maxRecords` (default 1,000) rows.
Start cheap (steps 1, 3, 5 — no Maps cost) to validate Airtable writes, then add step 2.

### Local run (no Apify deploy)

For a one-shot Taichung run without deploying/scheduling actors, use the orchestrator
[`scripts/run-taichung.mjs`](scripts/run-taichung.mjs). It mirrors `gcis` (Taichung CSV) + `gonghui`
(+ optional `gmaps`), then reuses `@ruizhu/lib` for merge/match/enrich/upsert — same logic as
`deliver`, including the leads-first budgeting and two-pass upsert.

```bash
node scripts/run-taichung.mjs [maxRecords] [gmaps] [reuse=<runId>]
# examples:
node scripts/run-taichung.mjs 60                       # GCIS + 公會 only (no Maps cost)
node scripts/run-taichung.mjs 300 gmaps                # also run a fresh paid Maps scrape (~$1)
node scripts/run-taichung.mjs 300 gmaps reuse=<runId>  # reuse a prior Maps run's dataset (free)
```

- `maxRecords` — overall Airtable cap; unmatched Maps leads are reserved first, then verified firms fill the rest.
- `gmaps` — include the Google Maps phase (triggers an Apify run unless `reuse=` is given).
- `reuse=<runId>` — read a previous successful Maps run's dataset instead of paying for a new scrape.
- The gov endpoints (`data.gcis.nat.gov.tw`) have a slow TLS handshake that Node's fetch aborts, so
  the script shells out to `curl -4` for the CSV + per-統編 負責人 enrichment.

## Outreach playbook (phone + LINE)

The pipeline only sources leads; conversion is a manual, **phone-first then LINE** motion (this ICP
does not use cold email/LinkedIn). Work it out of the Airtable Kanban.

1. **Prioritise.** Sort the grid by `Fit` desc (verified, small, contactable, no-website, recent tender
   win, well-reviewed scores highest). Take the top ~10–15 per day from the **Sourced** column. Tip:
   group/filter by `Verified` — verified firms come with a named 負責人; unverified Maps leads (`Fit` ≤ 3)
   are a warmer-call list where you ask for the owner on the phone.
2. **Call the 負責人** (verified firms have one in `ResponsiblePerson`; for unverified leads, call the
   `Phone` and ask for 老闆/負責人). zh-TW opener:
   > 「您好，我是睿築的[名字]。我們專門幫像貴公司這樣的營造／工程廠商，把分散在 LINE、Excel、紙本的
   > 工地與請款資料，整理成一套自己的系統。看到貴公司最近有[標案/工程]，想跟您約 15 分鐘，免費幫您
   > 做一份『現況地圖』，看哪裡可以省時間。方便這週嗎？」
   - No website (`Website` empty) is your wedge — they feel the pain of scattered data daily.
   - If voicemail/gatekeeper: send the same intro on **LINE** (add via phone number) and retry once.
3. **Move the Stage** as you go: Sourced → **Contacted** (any first touch) → **Diagnostic** (agreed to
   the 15-min call) → **現況地圖** (delivered the map) → **Design partner** (committed to build).
4. **Log every outcome on the record** (see *Outreach tracking* below): set `LastContactedDate`,
   `ContactChannel` (Phone/LINE), bump `Attempts`, pick a `Disposition` (接通-有興趣 / 未接 / 守門員 …),
   set `NextFollowUpDate` for any callback, and append to `Notes`. After a real conversation also set
   `Pain`/`Power`/`Will` (0–3 each), and `LostReason` if it dies (e.g. 已有系統 / 沒空 / 規模太大 / 找不到人).
5. **Read the funnel weekly** from Stage counts: **hit rate** = Contacted→Diagnostic,
   **win rate** = Diagnostic→Design partner. Feed it back into sourcing — if a profile converts
   (e.g. no-website + ≤10 staff + tender win), bump its weight in the `Fit` formula and pull more.

**Compliance (個資法):** we only use **published business** contact info (company registry, public
公會 rosters, Google Maps business listings) for a **business** offer; honor any opt-out immediately
and don't message personal/residential numbers.

### Outreach tracking (Airtable as CRM)

Airtable *is* the CRM — every touch is logged inline on the company row (created by
`scripts/airtable-setup.mjs`, never written by the pipeline, so a refresh never clobbers your notes):

| Field | Use |
|---|---|
| `LastContactedDate` | date of the most recent touch |
| `NextFollowUpDate` | when to call back (drives the follow-up view) |
| `ContactChannel` | Phone / LINE / In-person / Other |
| `Attempts` | running count of touches |
| `Disposition` | outcome: 接通-有興趣 / 接通-暫不需要 / 接通-不適合 / 未接 / 守門員 / 約回電 / 婉拒勿擾 |
| `Owner` | who is working the lead (2-person team) |
| `Notes` | running free-text log |
| `FollowUpDue` | formula: `1` when `NextFollowUpDate` is today or overdue |

Two views to add manually (the API can't create views):

- **Today's call list** — filter `LastContactedDate` is empty **OR** `FollowUpDue = 1`, and `Stage` is
  not `Design partner`; sort by `Fit` desc. This is your daily queue.
- **Follow-ups due** — filter `FollowUpDue = 1`; sort by `NextFollowUpDate`.

Daily SOP: work *Today's call list* top-down; after each call set `LastContactedDate` +
`ContactChannel`, bump `Attempts`, set `Disposition`, and either advance `Stage` or set
`NextFollowUpDate`; weekly, read hit/win-rate from the `Stage` counts and tune sourcing.

### CRM tooling verdict

Tool choice follows the **channel**, and ours is **phone + personal LINE** to owner-operated firms that
often have no website/email (recall "no website" is a `+2` Fit signal). So Airtable stays the single
source of truth — lead + `Fit` + flywheel + call log, free, no per-seat fees, no double entry.

Tools evaluated and skipped (channel mismatch, not quality):

- **lemlist** — email/LinkedIn cold-sequence tool (deliverability, inbox warmup, drip sequences). Few
  addresses to sequence here, and it can't dial a phone or touch LINE. Paying for an empty pipe.
- **Close.com** — the one phone-native option (built-in dialer + SMS), but US-centric (weak for TW
  numbers), ~US$99/seat/mo, and no LINE. Worth knowing it exists; not worth buying.
- **Folk / Attio** — slick modern CRMs, but email/LinkedIn-centric, per-seat, no dialer or LINE. Neat
  UI, wrong motion.
- **HubSpot / Zoho / Pipedrive / the "Zero" CRMs** — email/pipeline-centric, heavier, double data-entry
  for a 2-person team on a channel this ICP doesn't use.

**Defer** a Taiwan LINE CRM until you have a repeatable broadcast message and volume — when that day
comes, RallyLine (~NT$499/mo) is the cheap entry point, with BotBonnie/Super8 mid-tier and
漸強 (MAAC) / Omnichat the heavier, annual-contract options. Manual personal-LINE + Airtable first.

### Analytics & tracking

How a touch is captured depends on the channel — there is no tool that silently tracks personal-LINE
or phone for you:

| Channel | Tracking | Why |
|---|---|---|
| **Phone** | **Manual** — log `Disposition` + bump `Attempts` | a call has no open/reply signal |
| **Personal LINE** (your own app) | **Manual** — log per touch | personal LINE accounts have **no API**; 已讀 isn't exportable |
| **LINE Official Account** | **Semi-auto** — webhook for inbound replies + broadcast delivered/click stats | OA can only message users who **added you** (opt-in), so it nurtures, it doesn't cold-open |
| **Email** | **Auto** — opens / clicks / replies / bounces | standard, but a minority channel here (most leads have no email by design) |

So for the channels you'll actually use (phone + personal LINE), **manual updates in Airtable are the
system** — appropriate at 2 people. Read the funnel **inside Airtable**, no extra tools, using the 0/1
helper fields (`Touched`, `Connected`, `Interested`, `Won`, created by `scripts/airtable-setup.mjs`):

- **Rates from the summary bar:** in any grid, set a 0/1 column's summary to **Average** — the average
  of a 0/1 field *is* that rate (avg of `Connected` = connect rate; avg of `Won` = win rate). **Sum** =
  the raw count.
- **Change the denominator with a filter:** filter the view to `Connected = 1`, then the **Average of
  `Interested`** is interest-rate-among-connected (not among all leads).
- **Counts by stage/outcome:** group a grid by `Stage` (Sourced → … → Design partner) and by
  `Disposition` to see counts per group in the summary bar — that's your funnel.
- Hide these four helper fields in day-to-day call views to cut clutter; they're for the weekly read.

**When to automate later** (same trigger as paid tooling): wire **email** reply/open webhooks → Airtable
once email volume is non-trivial, and a **LINE OA** inbound webhook → Airtable once you have an OA, an
opted-in audience, and a repeatable broadcast. Until then, manual capture is enough.

---

*Data sources: 經濟部商業發展署 (GCIS), 財政部財政資訊中心, 行政院公共工程委員會 (PCC) open data. Attribute on use.*
