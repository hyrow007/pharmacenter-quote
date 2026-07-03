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
// Ingredient row shape
// -----------------------------------------------------------------------------
//
// This is the same shape used by the legacy in-workflow GummyFormula so a
// migration from inline → catalog is trivial (copy `rows` verbatim into a
// new formula's first version).
export type GummyFormulaIngredient = {
  id: string;                              // stable client-generated row id
  rawMaterialId: string | null;            // FK into raw_materials; null = custom one-off
  customName: string | null;               // display name when rawMaterialId is null
  pctInFinished: number;                   // 0..100
  costPerKgOverride: number | null;        // dollars/kg; null = use raw material default
  solidsOverride: number | null;           // 0..1; null = use raw material default
  notes: string | null;
};

// -----------------------------------------------------------------------------
// Canonical shape picklist. Kept as a widened string on the record so we can
// grow this list without a DB migration. UI enforces the picklist client-side.
// -----------------------------------------------------------------------------
export const FORMULA_SHAPES = [
  "Bear",
  "Worm",
  "Ring",
  "Ball",
  "Cube",
  "Heart",
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
  notes: string | null;         // why this version was cut
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
  >,
  lookup: (rawMaterialId: string) => RawMaterialCostLookup | null,
): {
  dollarsPerGummy: number;     // before daily fixed-loss scaling
  effectiveDollarsPerGummy: number; // after daily fixed-loss scaling
  dailyEffectiveYield: number;      // 0..1
  hasCompleteCosts: boolean;        // false if any line's cost is null
} {
  let dollarsPerGramOfBlend = 0;
  let hasCompleteCosts = true;

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

    const pct = (line.pctInFinished || 0) / 100;
    // $/g of finished blend contributed by this line.
    dollarsPerGramOfBlend += (costPerKg / 1000) * pct * solids;
  }

  // Apply process yield (before the daily loss).
  const yieldFactor = Math.max(0.0001, (version.yieldPct || 100) / 100);
  dollarsPerGramOfBlend = dollarsPerGramOfBlend / yieldFactor;

  const dollarsPerGummy = dollarsPerGramOfBlend * version.gummyPieceWeightG;

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
    notes: row.notes,
    createdAt: row.created_at,
    createdByEmail: row.created_by_email,
  };
}
