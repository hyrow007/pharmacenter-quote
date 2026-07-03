// Gummy-formula catalog types + helpers.
//
// The formula tool is decoupled from the pricing calculator — a formula
// is a first-class entity that lives in the `gummy_formulas` +
// `gummy_formula_versions` tables and can be reused across many quotes.
// Workflows pin an exact (formula_id, version_num) snapshot on
// state.gummyFormulaRef so historical quotes remain reproducible even
// after the catalog moves on.
//
// See:
//   sql/gummy_formulas.sql        — schema
//   /formulas                     — catalog page (list, search, filter)
//   /formulas/[id]                — three-tab editor
//   /workflow/[id]/gummy-formula  — picker + reference view

// -----------------------------------------------------------------------------
// Blend phases — the ordered stages of a gummy recipe as they appear on the
// physical formula sheet. Pre-cook goes in first, gets cooked (water boils
// off), then Secondary + Final blends fold in until the finished blend
// hits the target weight (bench_batch_g).
//
// Rendered in Bench top tab as one card per phase.
// -----------------------------------------------------------------------------
export const BLEND_PHASES = ["pre-cook", "secondary", "final"] as const;
export type BlendPhase = (typeof BLEND_PHASES)[number];

export const BLEND_PHASE_LABELS: Record<BlendPhase, string> = {
  "pre-cook": "Pre-cook blend",
  secondary: "Secondary blend",
  final: "Final blend",
};

export const BLEND_PHASE_HINTS: Record<BlendPhase, string> = {
  "pre-cook": "Ingredients weighed in before being cooked.",
  secondary: "Added after cooking is complete.",
  final: "Colors, flavors, and any last-step masking agents.",
};

// -----------------------------------------------------------------------------
// Default process notes per blend phase. Shown in the section's textarea on
// first render if the version has no process notes saved yet. Editable —
// once the rep types anything different, the placeholder notice (below)
// disappears and a "Reset to default" affordance appears.
// -----------------------------------------------------------------------------
export const DEFAULT_PROCESS_NOTES: Partial<Record<BlendPhase, string>> = {
  "pre-cook":
    "In a suitable container, pre-blend the pectin with half the sugar. Once well dry-blended, add warm water (100–110°F) to hydrate the pectin (about 30 min). Complete the addition of the remaining ingredients per the formula listed and mix to full dispersion — even if the sugar is not fully dissolved. Once fully mixed and the sugar is dissolved, check the pH and adjust to approximately 4.5 by adding either Sodium Citrate (25% sol) or Citric Acid (50% sol). Target pH range for the pre-cook blend: 4.0–5.0.",
};

// Banner text shown above the textarea whenever the current process note
// equals the default. Signals to the rep that R&D has since changed the
// procedure and the placeholder should be replaced before this version is
// treated as canonical.
export const PROCESS_NOTES_PLACEHOLDER_NOTICE =
  "This is place holder text the process has been modified";

// -----------------------------------------------------------------------------
// Label claims — the active-ingredient amounts printed on the finished
// product's label (e.g. "Vitamin D3 25 mcg"). Per-version because they
// often move when the recipe moves.
// -----------------------------------------------------------------------------
export const LABEL_CLAIM_UNITS = ["mcg", "mg", "g"] as const;
export type LabelClaimUnit = (typeof LABEL_CLAIM_UNITS)[number];

/** UI default for new label-claim rows — matches how the reg-affairs team
 *  most commonly authors claims. */
export const DEFAULT_LABEL_CLAIM_UNIT: LabelClaimUnit = "mg";

export type LabelClaim = {
  id: string;                            // stable client-generated row id
  rawMaterialId: string | null;          // curated raw_materials row uuid, when picked
  rawMaterialFpCode?: string | null;     // fp_code fallback for Fishbowl-only picks
  customName?: string | null;            // display name when the claim ingredient isn't in Fishbowl or raw_materials
  amount: number;                        // numeric label-claim quantity
  unit: LabelClaimUnit;                  // mcg / mg / g
};

export function newLabelClaimId(): string {
  return `lc_${Math.random().toString(36).slice(2, 10)}`;
}

export function emptyLabelClaim(): LabelClaim {
  return {
    id: newLabelClaimId(),
    rawMaterialId: null,
    rawMaterialFpCode: null,
    customName: null,
    amount: 0,
    unit: DEFAULT_LABEL_CLAIM_UNIT,
  };
}

// -----------------------------------------------------------------------------
// Ingredient row shape
// -----------------------------------------------------------------------------
//
// Backward-compat notes:
//   - `pctInFinished` (0..100) is the legacy % model. Still supported for
//     rows written before the blend-phase overhaul.
//   - `grams` is the new primary input. Matches how the physical formula
//     sheet is written and lets us handle the pre-cook total naturally
//     (which is larger than the finished 250g target thanks to water loss).
//   - When `grams` is set, cost math uses it directly. When only
//     `pctInFinished` is set, cost is derived via pct × bench_batch_g.
//   - `blendPhase` groups the row under a section header on the Bench top
//     tab. Legacy rows without a phase render under the shared table
//     labelled "Ungrouped" until they're assigned to a phase.
export type GummyFormulaIngredient = {
  id: string;                              // stable client-generated row id
  rawMaterialId: string | null;            // FK into raw_materials; null = Fishbowl-only or custom
  rawMaterialFpCode?: string | null;       // Fallback identifier when the pick lives only in Fishbowl products, not raw_materials
  customName: string | null;               // display name when rawMaterialId is null
  pctInFinished: number;                   // 0..100 (legacy)
  grams?: number | null;                   // input weight in the recipe; primary field for new rows
  blendPhase?: BlendPhase | null;          // groups the row under a section on Bench top
  costPerKgOverride: number | null;        // dollars/kg; null = use raw material default
  solidsOverride: number | null;           // 0..1; null = use raw material default
  notes: string | null;
};

// -----------------------------------------------------------------------------
// Canonical shape picklist. Kept as a widened string on the record so we can
// grow this list without a DB migration. UI enforces the picklist client-side.
// -----------------------------------------------------------------------------
// Ordering rule: TBD always first, Custom always last, everything in
// between sorted alphabetically. Keeps the picker predictable regardless
// of when a new shape is introduced.
export const FORMULA_SHAPES = [
  "TBD",
  "Bear",
  "Cube",
  "Dog bone",
  "Dome",
  "Heart",
  "Puck",
  "Custom",
] as const;

export type GummyFormulaShape = (typeof FORMULA_SHAPES)[number];

export function isKnownShape(s: string): s is GummyFormulaShape {
  return (FORMULA_SHAPES as readonly string[]).includes(s);
}

// -----------------------------------------------------------------------------
// Catalog row (public.gummy_formulas)
// -----------------------------------------------------------------------------
export type GummyFormulaRecord = {
  id: string;
  pcBkCode: string | null;      // null = TBD (R&D-stage design, no Fishbowl code yet)
  name: string;
  shape: string;                // canonical picklist enforced client-side
  flavor: string | null;
  active: boolean;
  latestVersionNum: number;     // 0 while the first version is being written
  createdAt: string;            // ISO
  updatedAt: string;            // ISO
  createdByEmail: string | null;
  updatedByEmail: string | null;
};

// -----------------------------------------------------------------------------
// Immutable version row (public.gummy_formula_versions)
// -----------------------------------------------------------------------------
//
// One recipe snapshot. Editing any of the batch params or the ingredient list
// creates a new version. The gummy_formulas row's latest_version_num pointer
// bumps automatically via DB trigger.
export type GummyFormulaVersion = {
  id: string;
  formulaId: string;
  versionNum: number;
  // Bench-top reference batch (grams) — all recipe percentages resolve
  // to gram amounts against this.
  benchBatchG: number;
  // Scale-up realism.
  batchKg: number;
  batchesPerDay: number;
  fixedLossKgPerDay: number;
  gummyPieceWeightG: number;
  yieldPct: number;             // 0..100 (before daily loss)
  ingredients: GummyFormulaIngredient[];
  // Per-blend-phase process notes (mixing instructions, pH targets,
  // hydration times, etc.). Keyed by blend phase so each section carries
  // its own free-text procedure. Optional for backward compat with
  // versions authored before the field existed.
  processNotes?: Partial<Record<BlendPhase, string>> | null;
  // Active-ingredient label claims (mcg / mg / g on the finished label).
  // Optional for backward compat with versions authored before the field
  // existed; read as [] when null/undefined.
  labelClaims?: LabelClaim[] | null;
  notes: string | null;         // why this version was cut (version-level)
  createdAt: string;            // ISO
  createdByEmail: string | null;
};

// -----------------------------------------------------------------------------
// Workflow-side pin: the exact (formula, version) a workflow's quote is
// grounded in. Small enough to store on `workflows.state.gummyFormulaRef`
// without bloating the row.
// -----------------------------------------------------------------------------
export type GummyFormulaReference = {
  formulaId: string;
  versionNum: number;
  snapshotAt: string;           // ISO — when the workflow pinned this version
  // Redundant identity fields cached for zero-network render on the
  // workflow detail page (so we can show "PC-BK-247 — Sour Green Apple"
  // without waiting for a /api/formulas/[id] fetch).
  pcBkCode: string | null;
  name: string;
  shape: string;
  flavor: string | null;
};

// -----------------------------------------------------------------------------
// Batch-param defaults (mirror sql/gummy_formulas.sql DEFAULT clauses).
// Used to seed a brand-new formula's version 1.
// -----------------------------------------------------------------------------
export const FORMULA_VERSION_DEFAULTS = {
  benchBatchG: 250,
  batchKg: 100,
  batchesPerDay: 6,
  fixedLossKgPerDay: 20,
  gummyPieceWeightG: 3.0,
  yieldPct: 100,
} as const;

// -----------------------------------------------------------------------------
// Cost math — pulled out of the old GummyFormulaBoard so both the editor
// and the pricing-side "Import material $" button can call the same code.
//
//   dollars_per_gram_of_finished_blend
//     = sum_over_ingredients(
//         cost_per_kg_effective / 1000
//         * pctInFinished / 100
//         * solids_effective
//       ) * (yieldPct / 100)
//
//   dollars_per_gummy
//     = dollars_per_gram_of_finished_blend * gummyPieceWeightG
//
// Then the daily fixed material loss stretches the cost:
//
//   effective_yield =
//     (batches_per_day * batch_kg - fixed_loss_kg_per_day)
//     / (batches_per_day * batch_kg)
//
//   effective_dollars_per_gummy = dollars_per_gummy / effective_yield
//
// The version supplies the batch params; the caller supplies a raw-material
// cost/solids lookup so this file has no DB dependency.
// -----------------------------------------------------------------------------
export type RawMaterialCostLookup = {
  costPerKg: number | null;    // dollars/kg from raw_materials.default_cost_per_kg
  solids: number;              // 0..1 from raw_materials.default_solids
};

export function computeMaterialCostPerGummy(
  version: Pick<
    GummyFormulaVersion,
    | "ingredients"
    | "gummyPieceWeightG"
    | "yieldPct"
    | "batchKg"
    | "batchesPerDay"
    | "fixedLossKgPerDay"
    | "benchBatchG"
  >,
  lookup: (rawMaterialId: string) => RawMaterialCostLookup | null,
): {
  dollarsPerGummy: number;     // before daily fixed-loss scaling
  effectiveDollarsPerGummy: number; // after daily fixed-loss scaling
  dailyEffectiveYield: number;      // 0..1
  hasCompleteCosts: boolean;        // false if any line's cost is null
} {
  let dollarsPerBench = 0;
  let hasCompleteCosts = true;
  const benchG = Math.max(0.0001, version.benchBatchG);

  for (const line of version.ingredients) {
    // Resolve cost/kg + solids: line overrides > raw-material defaults.
    let costPerKg: number | null = line.costPerKgOverride;
    let solids: number =
      line.solidsOverride !== null && line.solidsOverride !== undefined
        ? line.solidsOverride
        : 1;

    if (line.rawMaterialId) {
      const rm = lookup(line.rawMaterialId);
      if (rm) {
        if (costPerKg === null || costPerKg === undefined) {
          costPerKg = rm.costPerKg;
        }
        if (line.solidsOverride === null || line.solidsOverride === undefined) {
          solids = rm.solids;
        }
      }
    }

    if (costPerKg === null || costPerKg === undefined) {
      hasCompleteCosts = false;
      continue;
    }

    // Grams-first cost math: if grams is set, cost the row directly
    // (grams × $/kg / 1000). Falls back to pct × bench for legacy rows
    // authored before the grams field existed.
    //
    // Solids doesn't factor into $ (cost is per as-purchased kg) so it's
    // only used elsewhere for the audit trail / blend-composition view.
    void solids;
    let rowCost: number;
    if (line.grams !== null && line.grams !== undefined && Number.isFinite(line.grams)) {
      rowCost = (line.grams / 1000) * costPerKg;
    } else {
      const pct = (line.pctInFinished || 0) / 100;
      const gramsFromPct = pct * benchG;
      rowCost = (gramsFromPct / 1000) * costPerKg;
    }
    dollarsPerBench += rowCost;
  }

  // Apply process yield (before the daily loss).
  const yieldFactor = Math.max(0.0001, (version.yieldPct || 100) / 100);
  const yieldedDollarsPerBench = dollarsPerBench / yieldFactor;

  // Cost per gummy = bench cost / gummies per bench batch.
  const gummiesPerBench = benchG / Math.max(0.0001, version.gummyPieceWeightG);
  const dollarsPerGummy = gummiesPerBench > 0 ? yieldedDollarsPerBench / gummiesPerBench : 0;

  // Daily fixed-loss scaler.
  const totalKgPerDay = Math.max(
    0.0001,
    version.batchesPerDay * version.batchKg,
  );
  const dailyEffectiveYield =
    (totalKgPerDay - version.fixedLossKgPerDay) / totalKgPerDay;
  const safeDailyYield = Math.max(0.0001, dailyEffectiveYield);
  const effectiveDollarsPerGummy = dollarsPerGummy / safeDailyYield;

  return {
    dollarsPerGummy,
    effectiveDollarsPerGummy,
    dailyEffectiveYield,
    hasCompleteCosts,
  };
}

// -----------------------------------------------------------------------------
// Bench-top grams derivation. Given a version's percentages and a bench
// batch weight in grams, spit out the gram amount for each ingredient line.
// Used both in the editor's Bench top tab and in the printed spec sheet.
// -----------------------------------------------------------------------------
export function ingredientGramsForBench(
  version: Pick<GummyFormulaVersion, "ingredients" | "benchBatchG">,
): { id: string; grams: number }[] {
  return version.ingredients.map((line) => ({
    id: line.id,
    grams: (line.pctInFinished / 100) * version.benchBatchG,
  }));
}

// -----------------------------------------------------------------------------
// Same idea for the scale-up tab: kg per production batch.
// -----------------------------------------------------------------------------
export function ingredientKgForScaleUp(
  version: Pick<GummyFormulaVersion, "ingredients" | "batchKg">,
): { id: string; kg: number }[] {
  return version.ingredients.map((line) => ({
    id: line.id,
    kg: (line.pctInFinished / 100) * version.batchKg,
  }));
}

// -----------------------------------------------------------------------------
// Fresh-row helpers.
// -----------------------------------------------------------------------------
export function newFormulaIngredientId(): string {
  return `ing_${Math.random().toString(36).slice(2, 10)}`;
}

export function emptyIngredient(): GummyFormulaIngredient {
  return {
    id: newFormulaIngredientId(),
    rawMaterialId: null,
    customName: null,
    pctInFinished: 0,
    costPerKgOverride: null,
    solidsOverride: null,
    notes: null,
  };
}

// -----------------------------------------------------------------------------
// Snake-case row → camel-case record. Supabase returns the raw column names;
// this maps them into our TS types on the API boundary.
// -----------------------------------------------------------------------------
export function recordFromRow(row: {
  id: string;
  pc_bk_code: string | null;
  name: string;
  shape: string;
  flavor: string | null;
  active: boolean;
  latest_version_num: number;
  created_at: string;
  updated_at: string;
  created_by_email: string | null;
  updated_by_email: string | null;
}): GummyFormulaRecord {
  return {
    id: row.id,
    pcBkCode: row.pc_bk_code,
    name: row.name,
    shape: row.shape,
    flavor: row.flavor,
    active: row.active,
    latestVersionNum: row.latest_version_num,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    createdByEmail: row.created_by_email,
    updatedByEmail: row.updated_by_email,
  };
}

// -----------------------------------------------------------------------------
// Audit log types + diff helpers.
//
// One audit row per save event. Kinds:
//   'created'  — formula's initial row + v1 written
//   'identity' — name / pc_bk_code / shape / flavor edit (no version cut)
//   'version'  — new gummy_formula_versions row cut
// -----------------------------------------------------------------------------
export type GummyFormulaAuditKind = "created" | "identity" | "version";

export type GummyFormulaAuditRecord = {
  id: string;
  formulaId: string;
  at: string;              // ISO
  byEmail: string | null;
  byDisplay: string | null; // resolved from user_directory on read
  kind: GummyFormulaAuditKind;
  versionNum: number | null;
  summary: string;
  diff: unknown;           // shape varies by kind — see notes below
};

// Structured diff shapes. `unknown` on the record so the timeline UI can
// coerce per kind.
export type IdentityDiff = {
  changes: Array<{
    field: "name" | "pcBkCode" | "shape" | "flavor" | "active";
    from: string | boolean | null;
    to: string | boolean | null;
  }>;
};

export type VersionDiff = {
  paramChanges: Array<{
    field:
      | "benchBatchG"
      | "batchKg"
      | "batchesPerDay"
      | "fixedLossKgPerDay"
      | "gummyPieceWeightG"
      | "yieldPct";
    from: number;
    to: number;
  }>;
  added: Array<{
    id: string;
    rawMaterialId: string | null;
    pctInFinished: number;
  }>;
  removed: Array<{
    id: string;
    rawMaterialId: string | null;
    pctInFinished: number;
  }>;
  modified: Array<{
    id: string;
    rawMaterialId: string | null;
    changes: Array<{
      field: keyof GummyFormulaIngredient;
      from: unknown;
      to: unknown;
    }>;
  }>;
};

// Row shape for a "created" event — the seed identity.
export type CreatedDiff = {
  seed: {
    name: string;
    shape: string;
    pcBkCode: string | null;
    flavor: string | null;
  };
};

// -----------------------------------------------------------------------------
// Diff computation. Callers on the API boundary use these to build the
// summary + diff before inserting an audit row.
// -----------------------------------------------------------------------------

// Field-label lookup used in identity summaries.
const IDENTITY_FIELD_LABELS: Record<
  keyof Omit<GummyFormulaRecord, "id" | "latestVersionNum" | "createdAt" | "updatedAt" | "createdByEmail" | "updatedByEmail">,
  string
> = {
  name: "name",
  pcBkCode: "Product Code",
  shape: "shape",
  flavor: "flavor",
  active: "active status",
};

export function diffIdentity(
  before: Pick<GummyFormulaRecord, "name" | "pcBkCode" | "shape" | "flavor" | "active">,
  after: Pick<GummyFormulaRecord, "name" | "pcBkCode" | "shape" | "flavor" | "active">,
): { diff: IdentityDiff; summary: string } {
  const changes: IdentityDiff["changes"] = [];
  (Object.keys(IDENTITY_FIELD_LABELS) as Array<keyof typeof IDENTITY_FIELD_LABELS>).forEach(
    (field) => {
      const b = before[field] as string | boolean | null;
      const a = after[field] as string | boolean | null;
      if (b !== a) {
        changes.push({ field, from: b, to: a });
      }
    },
  );
  if (changes.length === 0) {
    return { diff: { changes }, summary: "No changes" };
  }
  const parts = changes.map((c) => {
    const label = IDENTITY_FIELD_LABELS[c.field];
    const fmt = (v: string | boolean | null) =>
      v === null || v === undefined || v === "" ? "(empty)" : String(v);
    return `${label}: "${fmt(c.from)}" → "${fmt(c.to)}"`;
  });
  return {
    diff: { changes },
    summary: `Updated ${changes.length === 1 ? "identity" : `${changes.length} identity fields`} — ${parts.join(", ")}`,
  };
}

// Version diff — expects two full version blobs (previous + next). For a
// brand-new formula pass previous=null and it treats every ingredient as
// added and skips param comparisons.
export function diffVersion(
  previous: Pick<
    GummyFormulaVersion,
    | "benchBatchG"
    | "batchKg"
    | "batchesPerDay"
    | "fixedLossKgPerDay"
    | "gummyPieceWeightG"
    | "yieldPct"
    | "ingredients"
  > | null,
  next: Pick<
    GummyFormulaVersion,
    | "benchBatchG"
    | "batchKg"
    | "batchesPerDay"
    | "fixedLossKgPerDay"
    | "gummyPieceWeightG"
    | "yieldPct"
    | "ingredients"
  >,
): { diff: VersionDiff; summary: string } {
  const paramChanges: VersionDiff["paramChanges"] = [];
  if (previous) {
    const paramFields: VersionDiff["paramChanges"][number]["field"][] = [
      "benchBatchG",
      "batchKg",
      "batchesPerDay",
      "fixedLossKgPerDay",
      "gummyPieceWeightG",
      "yieldPct",
    ];
    for (const f of paramFields) {
      if (Number(previous[f]) !== Number(next[f])) {
        paramChanges.push({ field: f, from: Number(previous[f]), to: Number(next[f]) });
      }
    }
  }

  const prevById = new Map<string, GummyFormulaIngredient>();
  const nextById = new Map<string, GummyFormulaIngredient>();
  (previous?.ingredients ?? []).forEach((r) => prevById.set(r.id, r));
  next.ingredients.forEach((r) => nextById.set(r.id, r));

  const added: VersionDiff["added"] = [];
  const removed: VersionDiff["removed"] = [];
  const modified: VersionDiff["modified"] = [];

  for (const [id, n] of nextById) {
    const p = prevById.get(id);
    if (!p) {
      added.push({ id, rawMaterialId: n.rawMaterialId, pctInFinished: n.pctInFinished });
    } else {
      const rowChanges: VersionDiff["modified"][number]["changes"] = [];
      (Object.keys(n) as Array<keyof GummyFormulaIngredient>).forEach((k) => {
        if (k === "id") return;
        if (JSON.stringify(p[k]) !== JSON.stringify(n[k])) {
          rowChanges.push({ field: k, from: p[k], to: n[k] });
        }
      });
      if (rowChanges.length > 0) {
        modified.push({ id, rawMaterialId: n.rawMaterialId, changes: rowChanges });
      }
    }
  }
  for (const [id, p] of prevById) {
    if (!nextById.has(id)) {
      removed.push({ id, rawMaterialId: p.rawMaterialId, pctInFinished: p.pctInFinished });
    }
  }

  const parts: string[] = [];
  if (paramChanges.length > 0)
    parts.push(`${paramChanges.length} batch param${paramChanges.length === 1 ? "" : "s"}`);
  if (added.length > 0) parts.push(`${added.length} ingredient${added.length === 1 ? "" : "s"} added`);
  if (removed.length > 0)
    parts.push(`${removed.length} ingredient${removed.length === 1 ? "" : "s"} removed`);
  if (modified.length > 0)
    parts.push(`${modified.length} ingredient${modified.length === 1 ? "" : "s"} modified`);
  const summary =
    parts.length === 0 ? "New version (no delta)" : `New version — ${parts.join(", ")}`;

  return {
    diff: { paramChanges, added, removed, modified },
    summary,
  };
}

// -----------------------------------------------------------------------------
// Snake-case row → camel-case record for audit rows. Callers on the API
// boundary use this to shape the response.
// -----------------------------------------------------------------------------
export function auditFromRow(row: {
  id: string;
  formula_id: string;
  at: string;
  by_email: string | null;
  kind: GummyFormulaAuditKind;
  version_num: number | null;
  summary: string;
  diff: unknown;
}, byDisplay: string | null = null): GummyFormulaAuditRecord {
  return {
    id: row.id,
    formulaId: row.formula_id,
    at: row.at,
    byEmail: row.by_email,
    byDisplay,
    kind: row.kind,
    versionNum: row.version_num,
    summary: row.summary,
    diff: row.diff,
  };
}

export function versionFromRow(row: {
  id: string;
  formula_id: string;
  version_num: number;
  bench_batch_g: number | string;
  batch_kg: number | string;
  batches_per_day: number | string;
  fixed_loss_kg_per_day: number | string;
  gummy_piece_weight_g: number | string;
  yield_pct: number | string;
  ingredients: GummyFormulaIngredient[] | null;
  // Optional so pre-migration rows don't blow up TS. Reader coerces
  // null/undefined into empty {}.
  process_notes?: Partial<Record<BlendPhase, string>> | null;
  label_claims?: LabelClaim[] | null;
  notes: string | null;
  created_at: string;
  created_by_email: string | null;
}): GummyFormulaVersion {
  // Supabase returns numerics as strings via postgrest for large-precision
  // safety — coerce here so downstream math is number-typed.
  const n = (v: number | string): number => (typeof v === "string" ? Number(v) : v);
  return {
    id: row.id,
    formulaId: row.formula_id,
    versionNum: row.version_num,
    benchBatchG: n(row.bench_batch_g),
    batchKg: n(row.batch_kg),
    batchesPerDay: n(row.batches_per_day),
    fixedLossKgPerDay: n(row.fixed_loss_kg_per_day),
    gummyPieceWeightG: n(row.gummy_piece_weight_g),
    yieldPct: n(row.yield_pct),
    ingredients: Array.isArray(row.ingredients) ? row.ingredients : [],
    processNotes:
      row.process_notes && typeof row.process_notes === "object"
        ? row.process_notes
        : {},
    labelClaims: Array.isArray(row.label_claims) ? row.label_claims : [],
    notes: row.notes,
    createdAt: row.created_at,
    createdByEmail: row.created_by_email,
  };
}
