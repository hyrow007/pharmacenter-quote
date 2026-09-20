# CLAUDE-formula-chat.md — brief for the FORMULA app chat

You are the engineering chat for PharmaCenter's FORMULA app
(formula.pharmacenter.app, alias formulas.…). Work autonomously, verify
everything live on the deployed site. Keep this file current as the app
evolves — future chats bootstrap from it.

## The system

The formula app lives inside this shared Next.js 14 repo
("pharmacenter-quote"), which also serves quote.pharmacenter.app
(quoting workflows) and meeting./order./orders. (meetings hub + Sales
Order Tracker), all routed by host in `src/middleware.ts`.
packing.pharmacenter.app is a DIFFERENT repo — leave it alone. Read
CLAUDE.md at the repo root for the whole map.

## Your lane (files you own)

`src/app/formulas/**` (catalog, editor page, FormulaEditor.tsx ~15k
lines, FilesCard), `src/app/api/formulas/**` (versions, issue,
duplicate, notes, audit, files, panel-chat), `src/lib/formulas.ts`,
`src/lib/labelPanel.ts`, `sql/gummy_formula_*.sql`, and the
raw-materials block of `public/dev/fishbowl-sync.mjs`.

A separate QUOTING chat owns everything else in the repo (quote
workflows, meetings/orders pages, most sync routes, i18n dict). Don't
edit its lane without relaying through the user; it consumes formulas
via `/api/formulas/[id]` (costingComputed).

## Working folder & deploy loop

- Ask for folder access to `C:\q`
  (→ C:\Users\jairo\Documents\packing-list\quote).
- Deploy: put `C:\q\push-quote.bat` on the clipboard and open the Run
  dialog; the user pastes+Enters and says "pushed". Robocopy →
  C:\code\pharmacenter-quote → git push → Vercel builds ~40-60s
  (project pharma-center-s-projects/pharmacenter-quote).
- TWO-WRITER HAZARD: the quoting chat edits the SAME folder and
  robocopy ships the whole tree. Check file mtimes before pushing;
  never push while the other chat is mid-edit (half-saved files have
  broken builds); if a build fails in a file outside your lane, suspect
  its in-flight work before "fixing" (a surgical one-line compile fix
  that preserves its intent is fine — comment it).
- Verify every change on the LIVE site afterward via Chrome: fresh tab,
  hard-reload (stale bundles are a recurring trap). Never leave test
  edits saved on real formulas — exercise the UI, then revert/discard;
  clean up any test rows you write.

## Data & auth

- Supabase project `clazllwkmurfscgaaqli` (named "Packing-List", shared
  by all apps). Migrations via the dashboard SQL editor (drive monaco:
  `getModels().slice(-1)[0].setValue(sql)` → Run → confirm "Run query"
  if destructive); mirror every migration into `sql/`.
- RLS convention: domain gate `auth.email() LIKE
  '%@pharmacenterusa.com'`; inserts pin `author_email = auth.email()`.
- The BROWSER supabase client is anonymous (auth = httpOnly cookies) —
  authed reads/writes go through server routes using `createClient`
  from `@/lib/auth/server` (see notes/files/panel-chat routes for the
  pattern). File uploads use signed upload URLs (sign → browser PUT →
  commit) to dodge the ~4.5MB serverless body cap; bucket
  "formula-files", metadata table `gummy_formula_files`.
- Driving React inputs from automation: native value setter + `input`
  event, commit via `new FocusEvent('focusout', {bubbles: true})`.

## The editor (tab order: Bench top, Scale up, Supplement Facts, Costing)

- **Label Claims**: drag-to-reorder actives (mirrored onto linked blend
  rows per phase); per-claim Blend selector — "cooked"/Secondary is the
  default, "pre-cook" moves the locked row to the Primary Blend;
  Overage % and Input DERIVE from the linked row's GRAMS (single source
  of truth, `claimBaseGramsForBench` baseline); Total Load row sums
  claim + input in mg.
- **Blends**: claim-sourced rows are locked pills (identity from the
  claim, delete hidden, grams editable, two-way grams↔overage sync).
  Overage column (160px) shows in Secondary always, in Primary only
  when actives are present there.
- **Costing**: cost sources Fish Bowl (Inventory)/(Last Order)/Manual/
  Customer Supplied from `raw_materials` (synced nightly); labor with
  FRACTIONAL setup/cleaning shifts and `roundDays` = keep the fraction,
  snap UP at ≥ .80; overhead from Supabase `overhead_*` tables via
  `/api/overhead` (as-of today + 60d lead), lease shares 300=20% /
  400=100% / 500-600=40%; Lab Testing card (actives $120, Micro + Y&M
  $80, RM tests default = active count); scenario pills (right-click
  rename, hover ×, qty set on the Considerations card); crew defaults
  leaders 1/1/1, operators 4/5/5; batches/day default 3.
  PERSISTENCE RULE: the costing jsonb uses null = "use default rule";
  `costingPayload` and `seedCore` must keep IDENTICAL literal key order
  or formulas mount dirty. New CostTab props must be destructured
  (repeat build-breaker).
- **Supplement Facts tab**: FDA 101.36 panel generated from the claims;
  `labelPanel.ts` holds the FDA DV table + `LabelPanelState` (rides
  inside the costing jsonb as `labelPanel`, null = all defaults);
  nutrition rows auto-estimate from the blend (mass-UOM only,
  fiber/sodium name classifiers, FDA rounding, thresholds 1 g fiber /
  5 mg sodium) with per-gummy overrides; serving-size pills (+ button
  opens a 48px count input — `.pricing__input` has `flex: 1`, pin
  `flex: "0 0 auto"` on small inline inputs); names/%DV editable in
  place; hidden rows (`hideRow`) enable e.g. fiber-only labels;
  other-ingredients auto (full name resolution incl. Fishbowl fp_code
  picks) or override; allergens "Contains" line. Print = customer-facing
  document: centered logo, sage eyebrow, serif product name, 5-field
  meta card (no customer / no date), panel max 620 wide with wrapping
  names, "PharmaCenter LLC · Davie, FL" footer; PDF filename
  "code - name - <Tab>".
- **Panel Assistant** (`/api/formulas/[id]/panel-chat`): Claude
  claude-sonnet-4-5 via ANTHROPIC_API_KEY (Vercel env), returns
  {reply, ops}; panel-scoped ops ONLY, receives a read-only formula
  snapshot for real recipe math, has a full "match a reference panel"
  procedure and honesty rules (never claim an edit without emitting the
  op); attachments = images (canvas-downscaled) + PDFs ≤ 3 MB via
  📎 / paste / drag; history persists per formula
  (`gummy_formula_panel_chat_messages`, Clear button in the header).
- Also: Files card, Notes, Audit timeline, catalog Duplicate; saves
  create revisions but only the Issue button assigns issue numbers.

## Fishbowl costs (you own the RM block)

Office server 10.114.50.100 (RDP; saved connection) runs
`C:\pharmacenter-sync\Run-FishbowlSync.ps1` nightly ~04:00 ET; it
re-downloads the agent from
https://quote.pharmacenter.app/dev/fishbowl-sync.mjs — that file in
`public/dev/` IS the agent. Its raw-materials block sends
`inventory_cost_per_kg` (partcost.avgCost, UOM→kg converted) +
`last_order_cost_per_kg` (newest poitem). The receiving route
`/api/sync/raw-materials` never overwrites stored costs with nulls.
If Costing shows "—" everywhere: check `raw_materials` cost columns
first, then the agent log via RDP.

## Style

Version-stamp changes (v85.x and counting) with WHY-comments matching
the codebase's voice. Brand: teal-900 #0f4a56, teal-700 #1d6c7b, sage
#7fb04f, paper #fffdf8, cream #f6efe3; Cormorant Garamond headlines,
Nunito UI, IBM Plex Mono numerics. User-facing strings via
`tr()`/`makeTr` where the surrounding code does.
