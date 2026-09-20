# CLAUDE.md — PharmaCenter Quote generator

> **Source of truth: this repo.** Edit `C:\code\pharmacenter-quote` and
> deploy with `.\deploy.ps1 "message"`. This app used to be edited in
> `C:\q`, with the checkout as a robocopy mirror of it — that mirror
> overwrote edits made in the checkout, never propagated deletions, and
> silently dropped excluded files. Retired 2026-09-19. **Anything written
> into `C:\q` now will not reach production.**

## Read this before writing code here — current as of 2026-09-20

This repo serves **four identities** behind host rewrites — Quote, Formula,
Orders, Meetings — plus the **Hub** at `pharmacenter.app`. Three separate
project chats (Quote Flows, Formulas, Sales Order tracker) all edit this one
repo, blind to each other. Ownership and the full map are in the project docs
`claude/working-agreement.md` and `claude/ecosystem-registry.md`.

1. **Next.js 15.5 + React 19.** `params` and `searchParams` are Promises —
   `await` them. `cookies()` and `headers()` are async.
2. **`tsc` is not a build.** The `deploy.ps1` typecheck cannot see Next's
   generated `PageProps`, so a wrongly-typed route prop passes it and fails on
   Vercel. Use `.\deploy.ps1 -FullBuild "msg"` when you touch route props,
   `package.json` or `next.config`.
3. **Supabase clients are in `src/lib/supabase/`:** `server.ts` for server
   components and routes, `client.ts` → `getBrowserClient()` for client
   components, `rows.ts` for row types. **There is no anon client.** The old
   `import { supabase } from "@/lib/supabase"` was deleted — do not recreate it.
   It ran every query as the anonymous role, which is how the customer list
   ended up readable by anyone holding the public key.
4. **Storage is private.** Never call `getPublicUrl`; never build an
   `/object/public/` URL by hand. Sign with `createSignedUrls()` (see
   `src/app/api/formulas/[id]/files/route.ts`), or on the server use the
   service role's `.download(path)` (see `src/app/api/monday/create-item`).
5. **Two files are byte-identical with `pharmacenter-packing-list`:**
   `src/app/app-chrome.css` and `src/lib/freshness.ts`. Change one, change the
   other, `diff` them. No shared package exists; this is the only link.
6. **Never name a font family literally in `app-chrome.css`.** Packing loads
   fonts via `next/font` under hashed names — a literal lookup silently falls
   back to Georgia. Use `var(--serif)`.
7. **No schema here.** Tables and policies live in `pharmacenter-db`. New table
   → migration there, a row in its `TABLES.md`, `.\Check-Tables.ps1` CLEAN.
8. **A push is not a deployment.** Vercel has silently skipped a push before.
   After deploying, check the change on the live page.
9. **A new tool gets a hub tile** — `TOOLS` in `src/app/hub/page.tsx`, plus a
   name and description key in both dictionaries.

Customer-facing quote generator for PharmaCenter sales. Architectural twin of the
Packing List generator: editor on the left, live 8.5×11 sheet on the right,
autosave to `localStorage`, Print/Save-PDF button.

## File layout

```
quote/
├─ Quote.html                              # entry — loads vendored React/Babel + jsx + css
├─ quote.css                               # tokens (PharmaCenter brand) + layout + print rules
├─ qg-sheet.jsx                            # data model + Sheet renderer (the printed page)
├─ qg-editor.jsx                           # left-pane editor: controlled inputs only
├─ qg-app.jsx                              # top-level App: load/save, print, sample/blank
├─ assets/
│  ├─ logo.png                             # PharmaCenter wordmark (copied from packing-list)
│  └─ vendor/                              # react.dev, react-dom.dev, babel.min, fonts.css + fonts/
├─ PharmaCenter Quote Generator.html       # single-file standalone for hosting (inlined)
├─ CLAUDE.md                               # this file
└─ README.md
```

## ⚠️  Storage key — DO NOT clobber the user's saved data

The Quote generator uses a **separate** `localStorage` key from the Packing List.
Under no circumstances may any code in this project read, write, or delete the
packing-list key.

| Key                              | Used by         | Touched by Quote app?           |
| -------------------------------- | --------------- | ------------------------------- |
| `pharmacenter-quote`             | Quote (data)    | **yes — primary storage**       |
| `pharmacenter-quote-counter`     | Quote (QT####)  | **yes — sequential doc number** |
| `pharmacenter-quote-users`       | Quote (reps)    | **yes — saved sales reps**      |
| `pharmacenter-quote-meetings-…`  | Meetings hub    | **yes — namespaced UI settings**|
| `pharmacenter-packing-list`      | Packing List    | **NEVER — leave it alone**      |
| `pharmacenter-pl-counter`        | Packing List    | **NEVER — leave it alone**      |
| `pharmacenter-pl-users`          | Packing List    | **NEVER — leave it alone**      |

If you add a new persisted setting to the Quote generator, namespace it under
`pharmacenter-quote-…`. Never reuse a `pharmacenter-pl-…` or
`pharmacenter-packing-list…` name, even temporarily during a migration.

## Brand tokens

Defined in `quote.css` `:root` — identical to the Packing List so the two
documents look like one set when printed together.

| Token        | Value      | Notes                                   |
| ------------ | ---------- | --------------------------------------- |
| `--teal-900` | `#0f4a56`  | primary ink (titles, footer band)       |
| `--teal-700` | `#1d6c7b`  | primary accent (rules, labels)          |
| `--sage-500` | `#7fb04f`  | micro-accent (save dot, valid pill)     |
| `--sage-300` | `#bcd596`  | soft accent (valid pill border)         |
| `--paper`    | `#fffdf8`  | sheet background                        |
| `--bg`       | `#e7ddc8`  | stage backdrop (warm)                   |

Letterhead wordmark: `assets/logo.png` rendered at `52px` tall. Headline serif:
Cormorant Garamond. UI sans: Nunito. Monospace for numeric: IBM Plex Mono.

## Data shape

The single object persisted at `pharmacenter-quote`:

```ts
{
  docNo: number,            // 1-indexed; rendered as QT0001, QT0002…
  date: "YYYY-MM-DD",       // issued
  dateTouched: boolean,     // true once user edits, else gets bumped to today on load
  validThrough: "YYYY-MM-DD",

  billTo: string,           // multi-line; first line shown bold
  shipTo: string,
  shipSame: boolean,        // when true, ship-to box says "Same as Bill To"

  customerPo: string,
  preparedBy: string,
  direct: string,
  directExt: string,
  email: string,

  paymentTerms: string,
  shippingTerms: string,

  items: Array<{
    sku: string,
    name: string,
    detail: string,         // optional sub-line shown small under the name
    qty: number,
    unit: string,           // ea, btl, case, …
    price: number           // unit price USD
  }>,

  discountOn: boolean,
  discountIsPct: boolean,   // true = percent, false = flat USD
  discountValue: number,
  taxOn: boolean,
  taxRate: number,          // % applied after discount
  shippingOn: boolean,
  shippingValue: number,    // flat USD

  notes: string             // multi-line; shown at the bottom of the quote
}
```

`qg-sheet.jsx` exports `quoteTotals(data)` which returns
`{ subtotal, discount, tax, shipping, total, itemCount }`. Subtotal = sum of
`qty * price`; discount applies to subtotal; tax applies to
`subtotal - discount`; shipping is a flat add-on.

## Running

Open `Quote.html` directly in a browser (no build step). The single-file
`PharmaCenter Quote Generator.html` is a self-contained standalone for hosting
— same app, same brand, everything inlined.

## Printing

A Print/Save PDF button calls `window.print()`. CSS hides the editor pane and
the stage chrome; only the `.sheet` is visible. `@page { size: letter; margin: 0; }`
matches the on-screen 8.5×11 layout 1-to-1.

## Costing-board feature baseline (applies to EVERY quoting/costing tool)

Any new pricing calculator or costing board built for this app (bottles,
blisters, and whatever comes next — sachets, pouches, kitting…) must ship
with ALL of the following from day one. These were retrofitted between the
bottle and blister boards once; do not make a third board that lacks them:

1. **Drag-and-drop row reordering** on Material Costs — ⋮⋮ handle only
   (never the whole row), teal drop indicator, order persists in the saved
   BOM array. Handle hidden on print (`bc-noprint`).
2. **Comma-formatted number fields** — text input (`inputMode="decimal"`),
   draft-string while focused, `toLocaleString` on blur. Values always show
   thousands separators when blurred.
3. **Part search by product number** — the picker API keeps hyphens so
   "PC-PK-0135" matches fp_code (already in /api/packaging-components).
4. **Typed-in (custom) parts are editable in place** — reopening the picker
   pre-fills the current name, and a rename preserves the manual cost.
5. **Bulk is always a visible row option** — even when customer-supplied
   (shown as an explicit $0), with a doses-per-unit count box and Manual
   pricing (bulk is a product, not a packaging component).
6. **Quantity boxes where counts matter** — safety seals per unit, doses
   per unit, units per inner pack / master box — seeded from the packaging
   spec but always editable on the board.
7. **Real customer + product names** resolved server-side (customers /
   products tables) on the board header and print sheet — never IDs or
   generic placeholders.
8. **Scenario tabs** — pills above Considerations (gummy-Costing-tab UX):
   Base + named scenarios, right-click to rename, hover × to delete,
   "+ Scenario" duplicates the current tab. Each scenario is a COMPLETE
   board snapshot (BOM, speeds, crew, margin — everything), never
   qty-only: edits on one tab must not bleed into another. Base persists
   in the top-level saved fields, scenarios in `scenarios[].state`;
   Save from any tab persists all tabs. Selection is screen-local.
   Strip hidden on print. **The Base pill is renamable too** (right-click,
   same UX as scenario pills); the name persists in a `baseName` field
   that is GLOBAL like the scenarios list — tab switches must carry the
   live working copy's `baseName`, never roll it back from a snapshot
   or the Base stash. **Multi-product workflows get ONE BASE TAB PER
   PRODUCT**, each with its own scenarios (variants of that base) and its
   own spec/qty seeding: the strip shows every product's Base pill
   (default-named after the product when there is more than one, thin
   divider between product groups) and "+ Scenario" adds under the ACTIVE
   base. Persistence: the historical single key (`bottleCosting` /
   `blisterCosting`) stays the FIRST product's bundle so old readers keep
   working; products 2..n save to `bottleCostingMore` /
   `blisterCostingMore`, index-aligned with `state.products[1..]`. Save
   from any tab persists every product's bundle.
9. **Gross margin (materials) readout** with hover explainers (ⓘ) on both
   margin metrics in the Margin & Price card.

## Meetings hub — meeting.pharmacenter.app

The meeting subdomain is a sibling of the formula subdomain: same Next.js
app, host-based rewrite in `middleware.ts` fronts it at `/meetings`.
Sales Orders is the first meeting type; more (production, leadership,
etc.) drop in as rows in `public.meeting_types` without a code change to
the hub itself.

**Routes:**

| Path                                             | Purpose                                                       |
| ------------------------------------------------ | ------------------------------------------------------------- |
| `/meetings`                                      | Hub — one card per active meeting type                        |
| `/meetings/sales-orders`                         | Sales Orders landing — session history + "Open orders" link   |
| `/meetings/sales-orders/all`                     | Working open-orders table for the weekly meeting              |
| `/meetings/sales-orders/orders/[so]`             | One SO — live Fishbowl state + every meeting note about it    |
| `/meetings/sales-orders/sessions/[session]`      | One weekly session — SOs discussed with at-meeting-vs-now diffs |

**Tables** (schema lives in the `pharmacenter-db` repo — see below):

- `meeting_types` — hub tiles (slug, name, tagline, cadence, active).
- `meeting_sessions` — one row per meeting held (type, date, source, plaud_recording_id, summary, attendees, other_business).
- `meeting_sessions.other_business jsonb` — cross-cutting topics that don't tie to a single SO (Shandong load status, Line 2 sequence, film/cash question, etc.). Populated by the Plaud webhook via `extractOtherBusinessFromSummary()`. Shape: `[{ title, note_md, action_items[] }]`. Rendered as its own "Other business" section on the session page below "Sales orders discussed".
- `meeting_so_notes` — per-SO commentary from a session; carries a
  `fishbowl_snapshot` jsonb of the SO's state at ingest time. Views diff
  that snapshot against the current `fishbowl_sales_orders` row to
  surface deltas (status moved, ship date slipped, closed since).

**Data rules:**

- Read-only against `fishbowl_sales_orders`; never touch the office
  server or Fishbowl directly, and never confuse it with the Packing
  List app's `public.sales_orders`.
- Freshness: every meetings screen shows "Synced &lt;relative time&gt;"
  from `max(synced_at)`. Age &gt; 26 h renders a red banner
  ("last night's Fishbowl sync did not run"). Never imply real-time.
- Closed-order history begins Sep 15, 2026 (the day the sync first
  ran). Include-closed toggle exists but its list will be sparse at
  launch and fills in nightly — the empty state says so.

**Ops (one-time, when ready):**

- Add `meeting.pharmacenter.app` as a domain on the Vercel project.
- CNAME `meeting` → `cname.vercel-dns.com` at Wix.
- Add `https://meeting.pharmacenter.app/auth/callback` to the Supabase
  Auth Redirect URLs allowlist.
- Schema changes go through the `pharmacenter-db` repo as a Supabase
  migration, never by pasting SQL into the Supabase editor.

  This line used to read "Run `sql/meetings.sql` in the shared Supabase
  project SQL editor." That is how finding C1 happened: the live schema was
  edited by hand, no repo held it, and nothing could be rebuilt or reviewed.
  The full schema is now captured as a baseline migration in
  `pharmacenter-db/supabase/migrations/`. Following the old instruction would
  recreate the problem, which is why it is called out rather than deleted.

**Plaud ingest — `POST /api/plaud/webhook`:**

Bearer-authenticated with `PLAUD_WEBHOOK_SECRET`. (It accepted the shared
`PLAUD_SYNC_SECRET` until the H4 split; that fallback is on its way out —
see `src/lib/sync-auth-core.ts`.)
Mirrors `/api/sync/sales-orders`. Handler at
`src/app/api/plaud/webhook/route.ts`; extraction library at
`src/lib/plaud/extract.ts`.

Two request shapes:

1. **Auto-extract from the Plaud AI summary** — the caller sends
   `{ meeting_type_slug, recording: { id, session_date, attendees,
   summary_md, transcript_url } }` and the extractor walks the summary
   markdown, pulls every SO reference (`SO 14693`, `SO M-14221`,
   `SO M14381-4`, `Sales Order 14733`, and neighboring bare numbers),
   resolves each against `fishbowl_sales_orders`, snapshots the current
   row into `fishbowl_snapshot`, and upserts `meeting_so_notes` on
   `(session_id, so_number)`.

2. **Pre-extracted mentions** — the caller sends its own `so_mentions`
   array. Useful for Zapier + Code steps or a Cowork agent. The
   receiver still cross-references every SO against Fishbowl even when
   the notes come pre-authored.

**Fishbowl cross-referencing is mandatory on every ingest.** Fishbowl
is the source of truth for customer_name and product. The extractor
(and the pre-extracted-mentions hydration path) call
`resolveSoAgainstFishbowl()` — which tries `M-`/no-`M` variants and
master-order fallbacks — then `detectCustomerMismatch()` compares the
Plaud-said customer against Fishbowl's. When they clearly disagree
(Peter Chu vs Purechews, Beatomex vs VitaMex, Renays vs Rene's,
Inova Gel vs InnovaGel, Fine Buenes vs InnovaGel Unicardio, Agency
Commercial vs Agencia Comercial Wan Tung), the note body gets a
`⚠ Plaud text and Fishbowl customer disagree — likely "X" per
Fishbowl.` warning and `status_flag` is bumped to `at_risk`. Add new
known-mangling patterns to `KNOWN_PLAUD_MISMATCHES` in `extract.ts`.

Session upserts are idempotent on `(meeting_type_id,
plaud_recording_id)` — the same recording ingested twice refreshes
notes instead of duplicating.

**AI key-points synthesis — `so_synthesis` + `POST /api/sync/so-synthesis`:**

Every SO gets a Claude-generated 3-5 bullet summary that combines
Fishbowl live state + Monday activity + Plaud meeting notes. Rendered
as a green-tinted "Key points" callout at the top of each SO card in
the session view and above the order-summary on `/orders/[so]`.

- **Table:** `so_synthesis` (so_number PK, headline text, points jsonb,
  based_on jsonb, generated_at). Authenticated read via RLS.
- **Read endpoint:** `GET /api/sync/so-synthesis/inputs` (bearer auth
  via `SO_SYNTHESIS_SECRET`, or `CRON_SECRET` from the daily cron) returns a pre-joined blob per SO: Fishbowl
  fields + sale items, Monday status + last 5 updates, all meeting
  notes across sessions, and the existing synthesis stamp so the
  generator can skip fresh ones. Only SOs with meeting notes OR Monday
  activity are returned.
- **Write endpoint:** `POST /api/sync/so-synthesis` (same bearer)
  accepts a batch `{ items: [{ so_number, headline, points, based_on }] }`
  and upserts on so_number.
- **Generator: NOT CURRENTLY SCHEDULED.** The design was a Cowork
  scheduled task that pulls inputs, sends each SO to Claude for
  "3-5 bullets a meeting reviewer needs", and POSTs the batch back,
  keeping LLM cost inside Cowork rather than putting an Anthropic key in
  the Vercel app. That task was never created, and as written it cannot
  run: Claude's egress allowlist blocks `*.pharmacenter.app`. Options,
  undecided as of 2026-09-19:
    1. Get `*.pharmacenter.app` allowlisted for the Claude org, then
       build the Cowork task as originally designed.
    2. A second Vercel Cron entry with `ANTHROPIC_API_KEY` in Vercel env.
       Note Hobby allows only 2 crons, once-daily -- this would be the
       second and last.
  Until one is picked, "Key points" callouts show only hand-generated
  content.

**Monday cross-reference — `so_monday_activity` + `POST /api/sync/monday`:**

Monday.com's "Open Sales Orders" board (id 18389208010, workspace
13384272) is the day-to-day activity log — item name is the SO number,
each item's Updates tab holds free-text posts/comments (FedEx tracking,
@-mentions, port dates, "8/25 weekly review" posts). The meetings hub
brings this in as a third source alongside Fishbowl and Plaud.

- **Table:** `so_monday_activity` (so_number PK, monday_item_id,
  monday_url, status, updates jsonb, last_synced_at). Populated by
  service-role writes only; authenticated read via RLS.
- **Sync route:** `POST /api/sync/monday` (bearer auth via
  `MONDAY_SYNC_SECRET`, or `CRON_SECRET` from Vercel Cron; env var
  `MONDAY_API_TOKEN` for the GraphQL call).
  Pages the whole Open Sales Orders board, upserts one row per SO with
  the last 5 updates. Idempotent on `so_number`.
- **Schedule:** **Vercel Cron**, once daily at 11:00 UTC / 7am ET
  (`vercel.json` -> `crons`, path `/api/sync/monday`, `0 11 * * *`).
  NOT every two hours: this Vercel account is on the **Hobby** plan,
  which permits at most 2 cron jobs on **once-daily** schedules only. A
  `0 */2 * * *` expression is rejected outright and Vercel creates no
  deployment at all -- no failed-build row, nothing to notice. Raise the
  frequency only after moving to Pro. The route exports a `GET` beside
  `POST` because Vercel Cron only issues GET, and its auth accepts either
  `MONDAY_SYNC_SECRET` or Vercel's `CRON_SECRET` (set that in Vercel env).
  Still callable on demand via curl with the bearer.
  (This previously read "Cowork scheduled task every couple hours." No
  such task was ever created, and it could not have worked: Claude's
  egress allowlist blocks both `*.pharmacenter.app` and `api.monday.com`.
  Monday activity sat 24 days stale until this moved to Vercel Cron.)
- **UI:** Session detail page shows a compact "Monday activity" strip
  per SO card under the line-items table; SO detail page (`/orders/[so]`)
  renders full-width "Monday activity" cards between the line items and
  the meeting history.

**Wiring the ingest.** Plaud's own webhook (with `Plaud-Signature`
verification) can post directly here, or route via Zapier ("New Plaud
file" → HTTP POST to `https://meeting.pharmacenter.app/api/plaud/webhook`
with `Authorization: Bearer $PLAUD_WEBHOOK_SECRET`). Plaud's OAuth-only
"list files" REST is private-beta — until it's live, weekly ingestion runs
through Plaud's own webhook, Zapier, or a **chat session** using the Plaud
MCP to fetch the recording and post it.

Not a Cowork *scheduled task*, which an earlier version of this line
suggested. A scheduled task cannot make an authenticated HTTP call at all:
its sandbox has no outbound network, its shell is Linux, its web fetch
cannot set headers, and the browser route is refused by a credential
classifier. This is the one job still without an unattended home; see
`claude/automation.md`.
