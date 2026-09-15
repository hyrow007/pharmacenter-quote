# CLAUDE.md — PharmaCenter Quote generator

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

**Tables (see `sql/meetings.sql`):**

- `meeting_types` — hub tiles (slug, name, tagline, cadence, active).
- `meeting_sessions` — one row per meeting held (type, date, source, plaud_recording_id, summary, attendees).
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
- Run `sql/meetings.sql` in the shared Supabase project SQL editor.

**Plaud ingest — `POST /api/plaud/webhook`:**

Bearer-authenticated with `PLAUD_SYNC_SECRET` (add to Vercel env).
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

**Wiring the ingest.** Plaud's own webhook (with `Plaud-Signature`
verification) can post directly here, or route via Zapier ("New Plaud
file" → HTTP POST to `https://meeting.pharmacenter.app/api/plaud/webhook`
with `Authorization: Bearer $PLAUD_SYNC_SECRET`). Plaud's OAuth-only
"list files" REST is private-beta — until it's live, weekly ingestion
runs either through Plaud's own webhook, Zapier, or a Cowork agent
that pushes the pre-extracted payload.
