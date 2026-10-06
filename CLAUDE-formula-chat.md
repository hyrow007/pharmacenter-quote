# CLAUDE-formula-chat.md — brief for the FORMULA app chat

You are the engineering chat for PharmaCenter's FORMULA app
(formula.pharmacenter.app, alias formulas.…). Work autonomously, verify
everything live on the deployed site. Keep this file current as the app
evolves — future chats bootstrap from it. (Revised 2026-09-21: repo
is the source of truth, C:\q retired, lib is Master's.)

## The system

The formula app lives inside this shared Next.js 14 repo
("pharmacenter-quote"), which also serves quote.pharmacenter.app
(quoting workflows) and meeting./order./orders. (meetings hub + Sales
Order Tracker), all routed by host in `src/middleware.ts`.
packing.pharmacenter.app is a DIFFERENT repo — leave it alone. Read
CLAUDE.md at the repo root for the whole map.

## Your lane (files you own)

`src/app/formulas/**` (catalog, editor page, FormulaEditor.tsx ~17k
lines, FilesCard) and `src/app/api/formulas/**` (versions, issue,
duplicate, notes, audit, files, panel-chat).

Read `claude/working-agreement.md` and `claude/ecosystem-registry.md` in
the Pharmacenter.app project first — they override this file where they
disagree. Since 2026-09-20 **`src/lib/**` (incl. `formulas.ts`,
`labelPanel.ts`, `formulaCosting.ts`), i18n dicts, schema and
`deploy.ps1` are Master's**: say what you need there instead of editing
it. Formula-only types can live in FormulaEditor.tsx (v85.0 did). The
Quote / Orders chats edit this SAME repo; the server-side
`costingComputed` (quote side) reads only the top-level costing fields.

## Repo & deploy loop (C:\q is RETIRED — don't use it or push-quote.bat)

- Folder access: `C:\code\pharmacenter-quote` — the git checkout IS the
  source of truth. `C:\q` was retired 2026-09-19; anything written there
  never reaches production, and running its `push-quote.bat` would
  robocopy stale files OVER the repo.
- Before editing: the tree must be clean — a dirty tree means another
  chat is mid-edit. From the Cowork VM use READ-ONLY git only, always
  `git --no-optional-locks status|diff|log|show`. Plain `git status`
  there rewrites the index and leaves `.git/index.lock` behind (the VM
  can't unlink in a connected folder), which silently breaks the next
  Windows-side commit. If one appears: `mv` it aside, never leave it.
- Typecheck before handing over: copy `src`, `tsconfig.json`,
  `next-env.d.ts` to a VM scratch dir, symlink the repo's `node_modules`,
  run `node node_modules/typescript/bin/tsc --noEmit -p . --incremental false`.
- Deploy: the user runs, in PowerShell in the repo,
  `.\deploy.ps1 "formula: <what changed>"` (typecheck gate → commit →
  rebase → push; `-FullBuild` when route props / package.json /
  next.config change). Vercel builds ~60s. Next 15 now.
- A push is not a deployment. Verify every change on the LIVE site via
  Chrome: fresh tab, hard-reload (stale bundles are a recurring trap).
  Never leave test edits saved on real formulas — exercise the UI, then
  revert/discard; clean up any test rows you write.

## Data & auth

- Supabase project `clazllwkmurfscgaaqli` (named "Packing-List", shared
  by all apps). Migrations via the dashboard SQL editor (drive monaco:
  `getModels().slice(-1)[0].setValue(sql)` → Run → confirm "Run query"
  if destructive); mirror every migration into `sql/`.
- RLS convention: domain gate `auth.email() LIKE
  '%@pharmacenterusa.com'`; inserts pin `author_email = auth.email()`.
- The BROWSER supabase client is anonymous (auth = httpOnly cookies) —
  authed reads/writes go through server routes using `createClient`
  from `@/lib/supabase/server` (see notes/files/panel-chat routes for the
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
  SCENARIOS OWN THEIR PARAMETERS (v85.0): swap model — the costing
  useStates always hold the ACTIVE pill's params; `selectCostScenario`
  stashes the outgoing pill (Base → `costBaseStash`, a scenario → its
  `params`) and loads the incoming one. Top-level costing fields are
  always Base's; each scenario carries `params` (pre-v85 scenarios start
  as a copy of Base). Decimal pickers, the label panel and scenario
  names/list stay shared. `normCostParams` is the single shape for both
  costingPayload and seedCore.
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

## Fishbowl costs

The agent lives in its OWN repo, `pharmacenter-sync`, checked out at
`C:\pharmacenter-sync` on office server 10.114.50.100 (RDP; saved
connection). Deploy = `git pull` there, then `.\Run-FishbowlSync.ps1`.
Windows Task Scheduler task `PharmacenterFishbowlSync` runs it daily
~04:30 ET.

**`public/dev/fishbowl-sync.mjs` in THIS repo is a dead copy.** It was
auto-downloaded over production once; that updater was removed
2026-09-19 (it would have swapped in a version missing three sync
endpoints — see claude/cohesion-findings.md, C4). Editing it changes
nothing in production. Read the real one in `pharmacenter-sync`, and
treat the paths in the dead copy's header as wrong: the backups are at
`C:\Users\Administrator\Documents\Backups\FB\` as `Pharmacenter_*.sql`,
NOT `D:\fb-backup` (that machine has no D: drive).

The agent parses the NEWEST dump — it does not read Fishbowl live. So a
part added during the day cannot sync until the next dump exists, and
re-running the agent re-reads the same file and still reports success.
That is the most common "the sync ran but my part isn't there" (2026-10-06,
PC-BK-0550). On-demand sync is specced in claude/fishbowl-sync-on-demand.md.

Its raw-materials block sends `inventory_cost_per_kg` (partcost.avgCost,
UOM→kg converted) + `last_order_cost_per_kg` (newest poitem). The
receiving route `/api/sync/raw-materials` never overwrites stored costs
with nulls. PC-BK / PC-RW *products* land in `products` via the PACKING
app's `/api/sync/products` (upsert keyed on `external_id` = `fb:<id>`),
which is what the formula Product Code picker reads.
If Costing shows "—" everywhere: check `raw_materials` cost columns
first, then `C:\pharmacenter-sync\logs\run-<date>.log` via RDP.

## Style

Version-stamp changes (v85.x and counting) with WHY-comments matching
the codebase's voice. Brand: teal-900 #0f4a56, teal-700 #1d6c7b, sage
#7fb04f, paper #fffdf8, cream #f6efe3; Cormorant Garamond headlines,
Nunito UI, IBM Plex Mono numerics. User-facing strings via
`tr()`/`makeTr` where the surrounding code does.
