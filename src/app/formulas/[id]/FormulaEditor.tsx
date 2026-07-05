"use client";

// FormulaEditor — the three-tab spec authoring surface for a single
// gummy formula.
//
// Identity header (Name / PC-BK / Shape / Flavor) floats above all three
// tabs. The tabs are three lenses on the same underlying recipe:
//
//   Bench top      — 250g reference batch, ingredient % + derived grams
//   Scale up       — production batch params + scaled kg amounts, with
//                    the daily-fixed-loss yield surfaced
//   Material cost  — same table plus $/kg and $/gummy contribution; a
//                    "Copy $/gummy" affordance for pricing hand-off
//
// Saves split by intent:
//   - Identity-only changes (name, PC-BK, shape, flavor) → PUT
//     /api/formulas/[id]. No new version created — presentation metadata.
//   - Recipe / batch param changes → POST /api/formulas/[id]/versions.
//     Immutable snapshot, so historical workflow pins stay reproducible.
//
// The Save button figures out which of the two calls to make (or both)
// by comparing the current state to the loaded snapshot.

import React, { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase";
import {
  BLEND_PHASE_HINTS,
  BLEND_PHASE_LABELS,
  DEFAULT_PROCESS_NOTES,
  FORMULA_SHAPES,
  FORMULA_VERSION_DEFAULTS,
  LABEL_CLAIM_UNITS,
  PROCESS_NOTES_PLACEHOLDER_NOTICE,
  claimBaseGramsForBench,
  computeMaterialCostPerGummy,
  emptyIngredient,
  emptyLabelClaim,
  emptySolutionComponent,
  emptySolutionIngredient,
  ingredientFromSavedSolution,
  ingredientGramsForBench,
  ingredientKgForScaleUp,
  isSolutionRow,
  type BlendPhase,
  type GummyFormulaAuditRecord,
  type GummyFormulaIngredient,
  type GummyFormulaRecord,
  type GummyFormulaVersion,
  type IdentityDiff,
  type LabelClaim,
  type LabelClaimUnit,
  type SavedSolution,
  type SolutionComponent,
  type VersionDiff,
  type RawMaterialCostLookup,
} from "@/lib/formulas";

// Raw-material catalog option surfaced to the editor. Serialised from
// server so the client doesn't need a separate fetch.
//
// `source` distinguishes rows that live in the curated raw_materials
// table (which have full data — cost, solids, category, notes) from
// rows that only exist as Fishbowl products (fp_code + name, cost null
// until a raw_materials row is created). Fishbowl-only rows use
// `id: "fb:PC-RW-XXXX"` — the fp_code is the durable identifier and
// gets stored on the ingredient row's rawMaterialFpCode field.
export type RawMaterialOption = {
  id: string;
  fpCode: string | null;
  name: string;
  defaultUnit: string | null;
  defaultCostPerKg: number | null;
  defaultSolids: number;
  category: "primary" | "secondary" | "final" | "other" | null;
  source?: "raw_material" | "fishbowl" | "builtin";
};

// Built-in ingredients that should always appear in the picker regardless
// of Fishbowl / raw_materials state. Currently: Water — used constantly
// in solutions and pre-cook hydration but not tracked in Fishbowl as a
// raw material.
const BUILTIN_INGREDIENTS: RawMaterialOption[] = [
  {
    id: "builtin:water",
    fpCode: null,
    name: "Water",
    defaultUnit: "kg",
    defaultCostPerKg: 0,
    defaultSolids: 0,
    category: "primary",
    source: "builtin",
  },
];

// Default moisture-loss % for known ingredients / solutions in the
// Cooked card's "Primary Blend Carry Over" subsection. Shared by both
// the carry-over UI rendering and the Bench Top card's Primary Blend
// (cooked) total so they always agree. Water is intentionally NOT
// included here — its behavior is defined by a separate rule.
function carryOverDefaultMoisturePct(r: GummyFormulaIngredient): number {
  const fp = (r.rawMaterialFpCode ?? "").toUpperCase();
  if (fp === "PC-RW-0010") return 0; // Pectin Classic CS 502
  if (fp === "PC-RW-0012") return 0; // Regular white granulated sugar
  if (fp === "PC-RW-0108") return 20; // Corn Syrup (NON GMO)
  const name = (r.customName ?? "").trim().toLowerCase();
  if (name.startsWith("citric acid + water solution")) return 50;
  if (name.startsWith("sodium citrate + water solution")) return 75;
  return 0;
}

// Drag-and-drop reorder helper. Rebuilds the flat ingredients array by
// walking it once and, on each row that belongs to `phase`, emitting the
// next id from the newly-ordered phase list. Non-`phase` rows keep their
// original slots so unrelated blends don't shift when the operator drags
// a Primary Blend row.
//
// - `fromId` and `toId` must both belong to `phase`. If either doesn't,
//   the input array is returned unchanged (the caller — reorderRow — also
//   guards against cross-phase drops, but this helper is defensive too).
// - `fromId === toId` returns the input unchanged (no-op self-drop).
// - Dropping onto `toId` places the source row where the target currently
//   sits, shifting the target and everything after it down by one slot.
function reorderIngredientsInPhase(
  ingredients: GummyFormulaIngredient[],
  phase: BlendPhase,
  fromId: string,
  toId: string,
): GummyFormulaIngredient[] {
  if (fromId === toId) return ingredients;
  const phaseRows = ingredients.filter((r) => r.blendPhase === phase);
  const fromIdx = phaseRows.findIndex((r) => r.id === fromId);
  const toIdx = phaseRows.findIndex((r) => r.id === toId);
  if (fromIdx === -1 || toIdx === -1) return ingredients;
  const reorderedPhase = phaseRows.slice();
  const [moved] = reorderedPhase.splice(fromIdx, 1);
  reorderedPhase.splice(toIdx, 0, moved);
  // Walk the original array and emit the next reordered phase id whenever
  // we hit a row that belongs to `phase`. Other rows stay in place.
  let cursor = 0;
  return ingredients.map((r) => {
    if (r.blendPhase === phase) {
      const next = reorderedPhase[cursor++];
      return next;
    }
    return r;
  });
}

// Water rows in the Primary Blend Carry Over subsection have a special
// rule: the moisture-loss % is auto-computed so the recipe balances —
// Primary Blend (cooked, net of loss) + Secondary Blend + Final Blend
// = Bench top batch size. This lets the operator dial the recipe and
// the water automatically absorbs the imbalance.
//
// Detection is dual-path: real formulas set rawMaterialId to the
// BUILTIN_INGREDIENTS "builtin:water" sentinel, but we also fall back
// to name matching so legacy rows without a rawMaterialId still get
// picked up correctly.
function isWaterRow(r: GummyFormulaIngredient): boolean {
  if (r.rawMaterialId === "builtin:water") return true;
  const name = (r.customName ?? "").trim().toLowerCase();
  return name === "water";
}

// Fraction of a row's mass that is water — powers the "Residual Moisture %"
// column on every Cooked blend subsection. Water ingredient → 1. Solution
// row → sum of its water-component percentages divided by 100 (clamped to
// [0, 100] first, since operators may enter solutions whose components
// don't sum exactly to 100 while they're still authoring). Everything
// else → 0, which renders as a blank cell downstream. Component-level
// detection mirrors isWaterRow: builtin:water id OR a customName that
// trims/lowercases to "water".
function waterFractionFor(r: GummyFormulaIngredient): number {
  if (isWaterRow(r)) return 1;
  const comps = r.solutionComponents ?? [];
  if (comps.length === 0) return 0;
  let waterPct = 0;
  for (const c of comps) {
    const cName = (c.customName ?? "").trim().toLowerCase();
    if (c.rawMaterialId === "builtin:water" || cName === "water") {
      waterPct += Number(c.pct) || 0;
    }
  }
  return Math.max(0, Math.min(100, waterPct)) / 100;
}

// Compute the auto moisture-loss % (0..100, clamped) that must be
// applied to every water row in the carry-over subsection so the
// recipe balances to the bench-top batch size. Non-water rows use the
// per-row explicit moistureLossPct OR carryOverDefaultMoisturePct as a
// fallback. Returns 0 when there's no water row to absorb the delta.
function computeCarryOverWaterPct(params: {
  preCookRows: GummyFormulaIngredient[];
  benchBatchG: number;
  secondaryG: number;
  finalG: number;
}): number {
  const { preCookRows, benchBatchG, secondaryG, finalG } = params;
  let P = 0;
  let waterGrams = 0;
  let nonWaterLossG = 0;
  for (const r of preCookRows) {
    const g = Number(r.grams) || 0;
    P += g;
    if (isWaterRow(r)) {
      waterGrams += g;
    } else {
      const raw = Number(r.moistureLossPct);
      const pct = Number.isFinite(raw)
        ? raw
        : carryOverDefaultMoisturePct(r);
      const frac = Math.max(0, Math.min(100, pct)) / 100;
      nonWaterLossG += g * frac;
    }
  }
  if (waterGrams <= 0) return 0;
  const targetLossG = P - benchBatchG + secondaryG + finalG;
  const pct = ((targetLossG - nonWaterLossG) / waterGrams) * 100;
  if (!Number.isFinite(pct)) return 0;
  return Math.max(0, Math.min(100, pct));
}

// Compute the Primary Blend (cooked) NET grams for the Bench Top card
// — i.e., the pre-cook rows summed after moisture loss, using the same
// water-auto-balance rule as the carry-over subsection. Shared with
// the UI rendering so the summary card and the carry-over "Tot" row
// always agree, including when water auto-computes.
function computeCarryOverPrimaryNetG(params: {
  preCookRows: GummyFormulaIngredient[];
  benchBatchG: number;
  secondaryG: number;
  finalG: number;
}): number {
  const { preCookRows } = params;
  const waterPct = computeCarryOverWaterPct(params);
  const waterFrac = waterPct / 100;
  return preCookRows.reduce((s, r) => {
    const g = Number(r.grams) || 0;
    if (isWaterRow(r)) {
      return s + g * (1 - waterFrac);
    }
    const raw = Number(r.moistureLossPct);
    const pct = Number.isFinite(raw)
      ? raw
      : carryOverDefaultMoisturePct(r);
    const frac = Math.max(0, Math.min(100, pct)) / 100;
    return s + g * (1 - frac);
  }, 0);
}

// Compute the grand-total Residual Moisture % across the whole Cooked
// blend card — Primary Blend Carry Over (only non-solution rows, water +
// water-defaults contribute), Secondary Blend (only non-solutions), and
// Final Blend (solutions + water rows). Mirrors the exact math used by
// the Grand Total Cooked Blend footer so the Bench Top card's readout
// always matches what's rendered inside the Cooked card itself.
function computeGrandResidualPct(params: {
  preCookRows: GummyFormulaIngredient[];
  secondaryRows: GummyFormulaIngredient[];
  finalRows: GummyFormulaIngredient[];
  benchBatchG: number;
}): number {
  const { preCookRows, secondaryRows, finalRows, benchBatchG } = params;
  const secondaryG = secondaryRows.reduce(
    (s, r) => s + (Number(r.grams) || 0),
    0,
  );
  const finalG = finalRows.reduce((s, r) => s + (Number(r.grams) || 0), 0);
  const primaryNetG = computeCarryOverPrimaryNetG({
    preCookRows,
    benchBatchG,
    secondaryG,
    finalG,
  });
  const grandTotalG = primaryNetG + secondaryG + finalG;
  if (grandTotalG <= 0) return 0;
  const carryWaterPct = computeCarryOverWaterPct({
    preCookRows,
    benchBatchG,
    secondaryG,
    finalG,
  });
  let residualPct = 0;
  // Primary Blend Carry Over — skip solutions, use per-row NET grams.
  for (const r of preCookRows) {
    if (isSolutionRow(r)) continue;
    const wf = waterFractionFor(r);
    if (wf === 0) continue;
    let lossFrac: number;
    if (isWaterRow(r)) {
      lossFrac = carryWaterPct / 100;
    } else {
      const raw = Number(r.moistureLossPct);
      const pct = Number.isFinite(raw) ? raw : carryOverDefaultMoisturePct(r);
      lossFrac = pct <= 0 ? 0 : pct >= 100 ? 1 : pct / 100;
    }
    const netG = (Number(r.grams) || 0) * (1 - lossFrac);
    residualPct += wf * ((netG / grandTotalG) * 100);
  }
  // Secondary Blend — skip solutions.
  for (const r of secondaryRows) {
    if (isSolutionRow(r)) continue;
    const wf = waterFractionFor(r);
    if (wf === 0) continue;
    residualPct += wf * (((Number(r.grams) || 0) / grandTotalG) * 100);
  }
  // Final Blend — solutions AND water rows contribute.
  for (const r of finalRows) {
    const wf = waterFractionFor(r);
    if (wf === 0) continue;
    residualPct += wf * (((Number(r.grams) || 0) / grandTotalG) * 100);
  }
  return residualPct;
}

// Resolve a row's display name: prefer customName, fall back to the
// raw-material's canonical name via rmById. Empty string when neither
// is set. Used by name-based classifiers (sugar/syrup, tapioca, etc.)
// that need the human-readable name regardless of whether the row was
// picked from the raw_materials list or hand-typed as a custom.
function resolveRowName(
  r: GummyFormulaIngredient,
  rmById: Map<string, RawMaterialOption>,
): string {
  const custom = (r.customName ?? "").trim();
  if (custom) return custom;
  if (r.rawMaterialId) {
    const hit = rmById.get(r.rawMaterialId);
    if (hit) return (hit.name ?? "").trim();
  }
  return "";
}

// Classify a Primary Blend Carry Over row as sugar vs syrup by name.
// - Syrup: name contains "syrup" OR "tapioca" (case-insensitive) —
//   covers Corn Syrup, Rice Syrup, Tapioca Syrup, Tapioca Solids, etc.
// - Sugar: name contains "sugar" and does NOT match the syrup rule
//   (so "Sugar Syrup" is classified as syrup, not sugar).
// Returns null for rows that are neither.
function classifySugarSyrup(
  r: GummyFormulaIngredient,
  rmById: Map<string, RawMaterialOption>,
): "sugar" | "syrup" | null {
  const lower = resolveRowName(r, rmById).toLowerCase();
  if (!lower) return null;
  if (lower.includes("syrup") || lower.includes("tapioca")) return "syrup";
  if (lower.includes("sugar")) return "sugar";
  return null;
}

// Compute the Sugar to Syrup Ratio (dry/dry) shown in the Key Indicators
// card. Mirrors the Excel formula on the source sheet:
//     G14 = D14 / (D14 + D15) * 100   (sugar share)
//     G15 = D15 / (D14 + D15) * 100   (syrup share)
// D14/D15 in the sheet are already the DRY contributions of sugar and
// syrup (column C multiplies by solids% before D divides by C29). Here
// we replicate that by computing per-row NET grams = grams × (1 −
// moistureLossPct/100), which is the same value the Primary Blend
// Carry Over subsection shows.
//
// Returns null when either ingredient class is missing from the pre-cook
// rows, so the UI can fall back to "—" placeholders.
function computeSugarSyrupRatio(params: {
  preCookRows: GummyFormulaIngredient[];
  rmById: Map<string, RawMaterialOption>;
}): { sugarPct: number; syrupPct: number } | null {
  const { preCookRows, rmById } = params;
  let sugarDry = 0;
  let syrupDry = 0;
  let sawSugar = false;
  let sawSyrup = false;
  for (const r of preCookRows) {
    const kind = classifySugarSyrup(r, rmById);
    if (!kind) continue;
    const g = Number(r.grams) || 0;
    const raw = Number(r.moistureLossPct);
    const pct = Number.isFinite(raw) ? raw : carryOverDefaultMoisturePct(r);
    const frac = Math.max(0, Math.min(100, pct)) / 100;
    const netG = g * (1 - frac);
    if (kind === "sugar") {
      sugarDry += netG;
      sawSugar = true;
    } else {
      syrupDry += netG;
      sawSyrup = true;
    }
  }
  if (!sawSugar || !sawSyrup) return null;
  const denom = sugarDry + syrupDry;
  if (denom <= 0) return null;
  return {
    sugarPct: (sugarDry / denom) * 100,
    syrupPct: (syrupDry / denom) * 100,
  };
}

// PC-BK Fishbowl product option, powering the "Existing" branch of the
// identity header's PC-BK code picker. Selecting one auto-fills Name.
export type PcBkProductOption = {
  id: string;
  fpCode: string;   // always "PC-BK-{n}" — filtered server-side
  name: string;
};

// Lightweight shape for the Customer picker's search results + picked
// pill. Mirrors the row selected in /start's customer section — we only
// need name + default_ship_to for the display, and the id for the FK.
type CustomerRow = { id: string; name: string; default_ship_to: string | null };

type Props = {
  initialFormula: GummyFormulaRecord;
  initialVersion: GummyFormulaVersion | null;
  rawMaterials: RawMaterialOption[];
  pcBkProducts: PcBkProductOption[];
  initialSavedSolutions?: SavedSolution[];
};

type Tab = "bench" | "scale" | "cost";

const usd = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 4,
  maximumFractionDigits: 4,
});
const usdShort = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

export default function FormulaEditor({
  initialFormula,
  initialVersion,
  rawMaterials: rawMaterialsProp,
  pcBkProducts,
  initialSavedSolutions = [],
}: Props) {
  const router = useRouter();

  // Saved-solutions library — client state so newly-saved entries appear
  // in the "load from library" list without a full page refresh.
  const [savedSolutions, setSavedSolutions] = useState<SavedSolution[]>(
    initialSavedSolutions,
  );

  // Prepend BUILTIN_INGREDIENTS (currently just Water) to whatever the
  // server sent so the picker always has them regardless of Fishbowl or
  // raw_materials state. Deduped by fp_code just in case a real "Water"
  // ever gets loaded into Fishbowl.
  const rawMaterials = useMemo(() => {
    const seenIds = new Set(rawMaterialsProp.map((r) => r.id));
    const seenNames = new Set(
      rawMaterialsProp.map((r) => r.name.trim().toLowerCase()),
    );
    const builtins = BUILTIN_INGREDIENTS.filter(
      (b) => !seenIds.has(b.id) && !seenNames.has(b.name.trim().toLowerCase()),
    );
    return [...builtins, ...rawMaterialsProp];
  }, [rawMaterialsProp]);

  // -- Identity state ---------------------------------------------------------
  const [name, setName] = useState(initialFormula.name);
  const [pcBkCode, setPcBkCode] = useState<string>(initialFormula.pcBkCode ?? "");
  // PC-BK mode: 'tbd' means the code isn't known yet (R&D-stage formula);
  // 'existing' means it maps to a Fishbowl product (fp_code starting with
  // 'PC-BK-'). When mode is 'existing', pcBkCode holds the fp_code and the
  // Name field auto-fills from the picked product on selection.
  const [pcBkMode, setPcBkMode] = useState<"tbd" | "existing">(
    initialFormula.pcBkCode == null ? "tbd" : "existing",
  );
  const [shape, setShape] = useState(initialFormula.shape);
  const [flavor, setFlavor] = useState(initialFormula.flavor ?? "");

  // -- Customer picker state ---------------------------------------------------
  // Mirrors /start's customer section: Existing (default) vs New customer
  // tabs; when Existing is picked and a customer is bound we render a
  // read-only pill with a Change button; otherwise a search input + list
  // of matching customers. New-customer form fields are captured but not
  // wired to a DB write yet — see TODO on the New-customer flow below.
  const [customerId, setCustomerId] = useState<string | null>(
    initialFormula.customerId ?? null,
  );
  const [customerMode, setCustomerMode] = useState<"existing" | "new">(
    "existing",
  );
  // Display state resolved from the customers table when the formula
  // loads with a saved customer_id (or when the operator picks one).
  const [customerName, setCustomerName] = useState<string | null>(null);
  const [customerShipTo, setCustomerShipTo] = useState<string | null>(null);
  // "Am I currently searching?" flag — collapses to the picked pill once
  // a customer is bound, mirrors /start's editingCustomer.
  const [editingCustomer, setEditingCustomer] = useState<boolean>(
    initialFormula.customerId == null,
  );
  const [customerSearch, setCustomerSearch] = useState<string>("");
  const [customerResults, setCustomerResults] = useState<CustomerRow[]>([]);
  // New-customer form fields — kept in state so the form doesn't reset
  // when the operator toggles between Existing / New. Not yet wired to a
  // DB write; see the TODO below the Save-selection flow.
  const [newCustomer, setNewCustomer] = useState<{
    name: string;
    contact: string;
    email: string;
  }>({ name: "", contact: "", email: "" });

  // Product Code search state — mirrors the "search vendors" pattern on
  // PricingCalculator. pcBkSearch is the query string; pcBkEditing is the
  // "am I currently searching?" flag which collapses the input into a
  // picked-pill once a product has been chosen.
  const [pcBkSearch, setPcBkSearch] = useState("");
  const [pcBkEditing, setPcBkEditing] = useState<boolean>(
    initialFormula.pcBkCode == null,
  );

  // -- Version state ----------------------------------------------------------
  // Fall back to defaults if the formula somehow has no version yet
  // (shouldn't happen — POST /formulas creates v1 atomically).
  const seedVersion = initialVersion ?? {
    id: "",
    formulaId: initialFormula.id,
    versionNum: 0,
    benchBatchG: FORMULA_VERSION_DEFAULTS.benchBatchG,
    batchKg: FORMULA_VERSION_DEFAULTS.batchKg,
    batchesPerDay: FORMULA_VERSION_DEFAULTS.batchesPerDay,
    fixedLossKgPerDay: FORMULA_VERSION_DEFAULTS.fixedLossKgPerDay,
    gummyPieceWeightG: FORMULA_VERSION_DEFAULTS.gummyPieceWeightG,
    wetCastPieceWeightG: FORMULA_VERSION_DEFAULTS.wetCastPieceWeightG,
    yieldPct: FORMULA_VERSION_DEFAULTS.yieldPct,
    ingredients: [emptyIngredient()],
    notes: null,
    createdAt: new Date().toISOString(),
    createdByEmail: null,
  };

  const [benchBatchG, setBenchBatchG] = useState<number>(seedVersion.benchBatchG);
  const [batchKg, setBatchKg] = useState<number>(seedVersion.batchKg);
  const [batchesPerDay, setBatchesPerDay] = useState<number>(seedVersion.batchesPerDay);
  const [fixedLossKgPerDay, setFixedLossKgPerDay] = useState<number>(
    seedVersion.fixedLossKgPerDay,
  );
  const [gummyPieceWeightG, setGummyPieceWeightG] = useState<number>(
    seedVersion.gummyPieceWeightG,
  );
  // Wet cast piece weight — mass of one gummy right out of the depositor,
  // before drying. Used by claimBaseGramsForBench to convert the wet-
  // measured bench batch into pieces per batch. Seeded from the version
  // or from the code default when the version predates the field.
  const [wetCastPieceWeightG, setWetCastPieceWeightG] = useState<number>(
    seedVersion.wetCastPieceWeightG ?? FORMULA_VERSION_DEFAULTS.wetCastPieceWeightG,
  );
  const [yieldPct, setYieldPct] = useState<number>(seedVersion.yieldPct);
  const [ingredients, setIngredients] = useState<GummyFormulaIngredient[]>(
    seedVersion.ingredients.length > 0
      ? seedVersion.ingredients
      : [emptyIngredient()],
  );
  const [versionNotes, setVersionNotes] = useState<string>("");
  // Process notes are per-blend-phase free text (mixing steps, pH targets,
  // hydration times). Stored on the version alongside ingredients. Keyed
  // by BlendPhase string.
  //
  // On first render, any phase without a saved note gets seeded with the
  // canonical default from DEFAULT_PROCESS_NOTES so the textarea is never
  // blank. A "This is placeholder text…" banner + Reset-to-default link
  // are rendered inside BlendSectionCard to signal that the shown text is
  // the default and hasn't been reviewed for this specific formula.
  const [processNotes, setProcessNotes] = useState<Partial<Record<BlendPhase, string>>>(
    () => {
      const saved = seedVersion.processNotes ?? {};
      const merged: Partial<Record<BlendPhase, string>> = { ...saved };
      (Object.keys(DEFAULT_PROCESS_NOTES) as BlendPhase[]).forEach((phase) => {
        if (!merged[phase]) merged[phase] = DEFAULT_PROCESS_NOTES[phase];
      });
      return merged;
    },
  );
  function setPhaseProcessNote(phase: BlendPhase, text: string) {
    setProcessNotes((prev) => ({ ...prev, [phase]: text }));
  }

  // Label claims — active-ingredient claim rows displayed in the Product
  // Details card. Each row pins to a raw material (curated or Fishbowl)
  // and carries an amount + unit. Stored on the version alongside
  // ingredients so claim changes participate in version history.
  const [labelClaims, setLabelClaims] = useState<LabelClaim[]>(
    seedVersion.labelClaims ?? [],
  );
  function addLabelClaim() {
    setLabelClaims((prev) => [...prev, emptyLabelClaim()]);
  }
  function updateLabelClaim(id: string, patch: Partial<LabelClaim>) {
    setLabelClaims((prev) =>
      prev.map((c) => (c.id === id ? { ...c, ...patch } : c)),
    );
  }
  function removeLabelClaim(id: string) {
    setLabelClaims((prev) => prev.filter((c) => c.id !== id));
  }

  // Loaded snapshot — used to compute whether version fields actually
  // changed vs. the currently-pinned version. This is what decides
  // whether Save writes a new version row.
  //
  // Important: we also hydrate the seed's processNotes with the defaults
  // (same as the useState init below) so opening a formula that has no
  // saved process notes doesn't immediately mark it dirty just because
  // the textarea now displays the default text.
  const loadedSnapshot = useMemo(
    () => {
      const hydratedProcessNotes: Partial<Record<BlendPhase, string>> = {
        ...(seedVersion.processNotes ?? {}),
      };
      (Object.keys(DEFAULT_PROCESS_NOTES) as BlendPhase[]).forEach((phase) => {
        if (!hydratedProcessNotes[phase]) {
          hydratedProcessNotes[phase] = DEFAULT_PROCESS_NOTES[phase];
        }
      });
      return JSON.stringify({
        ...seedVersion,
        processNotes: hydratedProcessNotes,
        labelClaims: seedVersion.labelClaims ?? [],
      });
    },
    // Snapshot is fixed once mounted; ignoring reactive drift.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  // Dirty flags derived from state.
  const identityDirty =
    name.trim() !== initialFormula.name ||
    (pcBkMode === "tbd"
      ? initialFormula.pcBkCode !== null
      : pcBkCode.trim() !== (initialFormula.pcBkCode ?? "")) ||
    shape !== initialFormula.shape ||
    (flavor.trim() || null) !== (initialFormula.flavor ?? null) ||
    // customerId is part of identity — Save must enable when the operator
    // changes the picked customer (or clears it) so it can flush the
    // change even if pickCustomer's inline PUT was skipped or failed.
    (customerId ?? null) !== (initialFormula.customerId ?? null);

  const versionDirty = useMemo(() => {
    // Build a version-shape blob and compare against the loaded snapshot.
    const current = {
      benchBatchG,
      batchKg,
      batchesPerDay,
      fixedLossKgPerDay,
      gummyPieceWeightG,
      wetCastPieceWeightG,
      yieldPct,
      ingredients,
      processNotes,
      labelClaims,
    };
    try {
      const seed = JSON.parse(loadedSnapshot);
      const seedCore = {
        benchBatchG: seed.benchBatchG,
        batchKg: seed.batchKg,
        batchesPerDay: seed.batchesPerDay,
        fixedLossKgPerDay: seed.fixedLossKgPerDay,
        gummyPieceWeightG: seed.gummyPieceWeightG,
        // Seed may pre-date the wet cast field — fall back to the code
        // default so an untouched-since-load formula stays clean.
        wetCastPieceWeightG:
          seed.wetCastPieceWeightG ??
          FORMULA_VERSION_DEFAULTS.wetCastPieceWeightG,
        yieldPct: seed.yieldPct,
        ingredients: seed.ingredients,
        processNotes: seed.processNotes ?? {},
        labelClaims: seed.labelClaims ?? [],
      };
      return JSON.stringify(current) !== JSON.stringify(seedCore);
    } catch {
      return true;
    }
  }, [
    benchBatchG,
    batchKg,
    batchesPerDay,
    fixedLossKgPerDay,
    gummyPieceWeightG,
    wetCastPieceWeightG,
    yieldPct,
    ingredients,
    processNotes,
    labelClaims,
    loadedSnapshot,
  ]);

  const anyDirty = identityDirty || versionDirty;

  // Warn on tab close if unsaved. Standard beforeunload.
  useEffect(() => {
    if (!anyDirty) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [anyDirty]);

  // -- Tabs -------------------------------------------------------------------
  const [tab, setTab] = useState<Tab>("bench");

  // Pre-cook blend section unit — lifted from BlendSectionCard so the
  // Cooked card's "Primary Blend Carry Over" subsection can mirror the
  // unit currently shown on the Pre-cook card. When the operator changes
  // the Pre-cook card's Grams/Milligrams/Micrograms picker, the carry-over
  // rows update automatically. The Cooked card keeps its own local
  // sectionUnit state for its Secondary/Final subsections.
  const [preCookUnit, setPreCookUnit] = useState<LabelClaimUnit>("g");

  // -- Raw material lookup (for cost math) ------------------------------------
  const rmById = useMemo(() => {
    const m = new Map<string, RawMaterialOption>();
    for (const r of rawMaterials) m.set(r.id, r);
    return m;
  }, [rawMaterials]);

  const costLookup = useMemo(
    () =>
      (rawMaterialId: string): RawMaterialCostLookup | null => {
        const r = rmById.get(rawMaterialId);
        if (!r) return null;
        return { costPerKg: r.defaultCostPerKg, solids: r.defaultSolids };
      },
    [rmById],
  );

  // -- Derived math -----------------------------------------------------------
  // Legacy `totalPct` (sum of pctInFinished across rows) was removed —
  // Bench Top now shows blend-phase totals + % of bench batch instead of
  // the old ingredients-total percentage.

  const benchGrams = useMemo(
    () => ingredientGramsForBench({ ingredients, benchBatchG }),
    [ingredients, benchBatchG],
  );
  const benchGramById = useMemo(() => {
    const m = new Map<string, number>();
    benchGrams.forEach((row) => m.set(row.id, row.grams));
    return m;
  }, [benchGrams]);

  const scaleKg = useMemo(
    () => ingredientKgForScaleUp({ ingredients, batchKg }),
    [ingredients, batchKg],
  );
  const scaleKgById = useMemo(() => {
    const m = new Map<string, number>();
    scaleKg.forEach((row) => m.set(row.id, row.kg));
    return m;
  }, [scaleKg]);

  const cost = useMemo(
    () =>
      computeMaterialCostPerGummy(
        {
          ingredients,
          gummyPieceWeightG,
          yieldPct,
          batchKg,
          batchesPerDay,
          fixedLossKgPerDay,
          benchBatchG,
        },
        costLookup,
      ),
    [
      ingredients,
      benchBatchG,
      gummyPieceWeightG,
      yieldPct,
      batchKg,
      batchesPerDay,
      fixedLossKgPerDay,
      costLookup,
    ],
  );

  // -- Product Code typeahead ------------------------------------------------
  // Filter is case-insensitive across fpCode + name. Empty query returns [].
  // Capped at 8 results to keep the dropdown compact.
  const pcBkResults = useMemo(() => {
    const q = pcBkSearch.trim().toLowerCase();
    if (!q) return [];
    return pcBkProducts
      .filter(
        (p) =>
          p.fpCode.toLowerCase().includes(q) ||
          p.name.toLowerCase().includes(q),
      )
      .slice(0, 8);
  }, [pcBkSearch, pcBkProducts]);

  // Resolve the currently-picked product record (if any) so the collapsed
  // pill can render "PC-BK-247 · Product Name".
  const pickedPcBkProduct = useMemo(
    () => pcBkProducts.find((p) => p.fpCode === pcBkCode) ?? null,
    [pcBkCode, pcBkProducts],
  );

  function pickPcBkProduct(p: PcBkProductOption) {
    setPcBkCode(p.fpCode);
    setPcBkEditing(false);
    setPcBkSearch("");
    // Auto-fill Name if it's blank or still the default. Don't clobber a
    // rep-typed override.
    if (!name.trim() || name === "Untitled gummy") {
      setName(p.name);
    }
  }

  // -- Customer picker: hydrate + search -------------------------------------
  // Hydrate the display name / ship-to whenever we hold a customerId but
  // haven't resolved the customer row yet. Mirrors /start's approach —
  // one maybeSingle() to fetch the paired display fields off the row.
  useEffect(() => {
    if (!customerId || customerName) return;
    const sb = supabase;
    if (!sb) return;
    let cancelled = false;
    sb.from("customers")
      .select("id, name, default_ship_to")
      .eq("id", customerId)
      .maybeSingle()
      .then(({ data }) => {
        if (cancelled || !data) return;
        setCustomerName(data.name);
        setCustomerShipTo(data.default_ship_to);
      });
    return () => {
      cancelled = true;
    };
  }, [customerId, customerName]);

  // Debounced customer search — same shape as /start's customer effect
  // (180ms setTimeout, active-only rows, name ilike, capped at 50).
  useEffect(() => {
    const sb = supabase;
    if (!sb) return;
    const term = customerSearch.trim();
    if (term.length === 0) {
      setCustomerResults([]);
      return;
    }
    const handle = setTimeout(async () => {
      const { data } = await sb
        .from("customers")
        .select("id, name, default_ship_to")
        .eq("active", true)
        .ilike("name", `%${term}%`)
        .order("name")
        .limit(50);
      setCustomerResults((data ?? []) as CustomerRow[]);
    }, 180);
    return () => clearTimeout(handle);
  }, [customerSearch]);

  // Pick + save a customer. Fires an immediate identity PUT (same pattern
  // as name / pcBkCode / shape / flavor saves) so the FK persists without
  // waiting for the operator to hit the top Save button.
  async function pickCustomer(c: CustomerRow) {
    setCustomerId(c.id);
    setCustomerName(c.name);
    setCustomerShipTo(c.default_ship_to);
    setEditingCustomer(false);
    setCustomerSearch("");
    setCustomerResults([]);
    // Fire the PUT — pass only the customerId so we don't accidentally
    // stomp on other identity fields the operator may be editing.
    try {
      await fetch(`/api/formulas/${initialFormula.id}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ customerId: c.id }),
      });
      // Refresh audit so the "customer" identity diff appears immediately.
      refetchAudit();
    } catch {
      // Silent — the top Save button will retry the PUT if this fails.
    }
  }

  // Clear the picked customer + write the null through immediately.
  async function clearCustomer() {
    setCustomerId(null);
    setCustomerName(null);
    setCustomerShipTo(null);
    setEditingCustomer(true);
    try {
      await fetch(`/api/formulas/${initialFormula.id}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ customerId: null }),
      });
      refetchAudit();
    } catch {
      // Silent — see pickCustomer.
    }
  }

  // -- Audit timeline --------------------------------------------------------
  const [auditEvents, setAuditEvents] = useState<GummyFormulaAuditRecord[]>([]);
  const [auditLoading, setAuditLoading] = useState(true);

  async function refetchAudit() {
    setAuditLoading(true);
    try {
      const res = await fetch(`/api/formulas/${initialFormula.id}/audit`, {
        headers: { accept: "application/json" },
      });
      const json = await res.json();
      if (res.ok && json.ok) {
        setAuditEvents(Array.isArray(json.events) ? json.events : []);
      }
    } catch {
      // Silent — timeline is auxiliary; a failure shouldn't disrupt the editor.
    } finally {
      setAuditLoading(false);
    }
  }

  // Fetch once on mount.
  useEffect(() => {
    refetchAudit();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // -- Save -------------------------------------------------------------------
  const [saving, setSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState<
    | { kind: "ok"; text: string }
    | { kind: "err"; text: string }
    | null
  >(null);

  async function handleSave() {
    setSaving(true);
    setSaveStatus(null);
    try {
      // 1. Identity PUT (if identity dirty).
      if (identityDirty) {
        const res = await fetch(`/api/formulas/${initialFormula.id}`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            name: name.trim(),
            pcBkCode: pcBkMode === "tbd" ? null : pcBkCode.trim() || null,
            shape,
            flavor: flavor.trim() || null,
            customerId: customerId ?? null,
          }),
        });
        const json = await res.json();
        if (!res.ok || !json.ok) {
          setSaveStatus({
            kind: "err",
            text: json.error || `identity_save_failed_${res.status}`,
          });
          setSaving(false);
          return;
        }
      }
      // 2. Version POST (if version dirty).
      if (versionDirty) {
        const res = await fetch(
          `/api/formulas/${initialFormula.id}/versions`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              benchBatchG,
              batchKg,
              batchesPerDay,
              fixedLossKgPerDay,
              gummyPieceWeightG,
              wetCastPieceWeightG,
              yieldPct,
              ingredients,
              processNotes,
              labelClaims,
              notes: versionNotes.trim() || null,
            }),
          },
        );
        const json = await res.json();
        if (!res.ok || !json.ok) {
          setSaveStatus({
            kind: "err",
            text: json.error || `version_save_failed_${res.status}`,
          });
          setSaving(false);
          return;
        }
      }
      setSaveStatus({ kind: "ok", text: "Saved" });
      // Server-render is now stale — refresh so the loaded snapshot
      // resets and dirty flags clear. Also refetch the audit log so the
      // new event appears at the top of the timeline immediately.
      router.refresh();
      refetchAudit();
    } catch (err) {
      setSaveStatus({
        kind: "err",
        text: err instanceof Error ? err.message : "save_failed",
      });
    } finally {
      setSaving(false);
    }
  }

  // -- Row helpers ------------------------------------------------------------
  function updateRow(id: string, patch: Partial<GummyFormulaIngredient>) {
    setIngredients((prev) =>
      prev.map((r) => (r.id === id ? { ...r, ...patch } : r)),
    );
  }
  function addRow() {
    setIngredients((prev) => [...prev, emptyIngredient()]);
  }
  function addRowForPhase(phase: BlendPhase) {
    setIngredients((prev) => [
      ...prev,
      { ...emptyIngredient(), blendPhase: phase, grams: 0 },
    ]);
  }
  function addSolutionForPhase(phase: BlendPhase) {
    setIngredients((prev) => [
      ...prev,
      { ...emptySolutionIngredient(), blendPhase: phase },
    ]);
  }
  function addSavedSolutionForPhase(phase: BlendPhase, s: SavedSolution) {
    setIngredients((prev) => [
      ...prev,
      ingredientFromSavedSolution(s, phase),
    ]);
  }
  // Persist a solution row's current name + components back to the
  // library. Upserts by name — a second save with the same name
  // overwrites the components. Returns the saved solution so the caller
  // can flash a success message.
  async function saveSolutionToLibrary(
    row: GummyFormulaIngredient,
  ): Promise<{ ok: true; solution: SavedSolution } | { ok: false; error: string }> {
    const name = (row.customName ?? "").trim();
    if (!name) return { ok: false, error: "Solution needs a name before saving." };
    const components = row.solutionComponents ?? [];
    if (components.length === 0) {
      return { ok: false, error: "Add at least one component before saving." };
    }
    try {
      const res = await fetch("/api/solutions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, components }),
      });
      const json = await res.json();
      if (!res.ok || !json.ok) {
        return { ok: false, error: json?.error || `save_failed_${res.status}` };
      }
      // Merge into local list (upsert by id).
      setSavedSolutions((prev) => {
        const idx = prev.findIndex((p) => p.id === json.solution.id);
        if (idx === -1) {
          return [...prev, json.solution].sort((a, b) =>
            a.name.localeCompare(b.name),
          );
        }
        const next = [...prev];
        next[idx] = json.solution;
        return next;
      });
      return { ok: true, solution: json.solution as SavedSolution };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : "save_failed",
      };
    }
  }
  function removeRow(id: string) {
    // Removing the last-ever ingredient row would leave the shared table
    // stuck, so keep at least one row unless there are phase-scoped rows
    // to fall back on.
    setIngredients((prev) => {
      if (prev.length <= 1) return prev;
      return prev.filter((r) => r.id !== id);
    });
  }
  // Drag-and-drop row reorder. Fired by BlendSectionCard when the operator
  // drops one blend row onto another. No-ops when the two rows are in
  // different phases (drag from Primary Blend, drop on Secondary Blend
  // isn't a supported gesture — the operator would have to explicitly move
  // the row's phase first). See reorderIngredientsInPhase for the
  // rebuild-in-place logic.
  function reorderRow(fromId: string, toId: string) {
    if (fromId === toId) return;
    setIngredients((prev) => {
      const fromRow = prev.find((r) => r.id === fromId);
      const toRow = prev.find((r) => r.id === toId);
      if (!fromRow || !toRow) return prev;
      // Ingredient rows without a blendPhase (legacy or unassigned) live
      // in the shared bottom table which doesn't render a drag handle,
      // so drag events can't reach us with a null phase — but bail
      // defensively so the strict BlendPhase type below holds.
      if (!fromRow.blendPhase || !toRow.blendPhase) return prev;
      if (fromRow.blendPhase !== toRow.blendPhase) return prev;
      return reorderIngredientsInPhase(prev, fromRow.blendPhase, fromId, toId);
    });
  }

  // Label-claim → Secondary Blend auto-sync (identity-only). Keeps the
  // cooked-phase rows in lock-step with the current labelClaims list:
  //   - For each claim, ensure exactly one ingredient row exists with
  //     sourceLabelClaimId === claim.id and blendPhase === "cooked". If
  //     missing, INSERT it at the end of the cooked-phase run with
  //     grams = 0 (operator fills it in). The row's
  //     rawMaterialId/rawMaterialFpCode/customName mirror the claim's
  //     identity.
  //   - For each existing cooked row with sourceLabelClaimId set:
  //       * If the claim still exists, REFRESH the identity fields from
  //         the claim (name / rawMaterialId). GRAMS IS NOT TOUCHED —
  //         the operator owns it. overagePct is no longer used and is
  //         intentionally left alone (any legacy value stays on the row
  //         but the UI reads/writes only `grams`).
  //       * If the claim is gone, REMOVE the row.
  //   - Cooked rows WITHOUT sourceLabelClaimId are untouched (hand-authored).
  //
  // Idempotent — the functional setState returns `prev` unchanged when
  // nothing changed so React doesn't re-render in a loop. The compare
  // set excludes `grams` and `overagePct` for claim-sourced rows so
  // typing a new gram value doesn't trip this effect into a fight.
  useEffect(() => {
    setIngredients((prev) => {
      const claimById = new Map<string, LabelClaim>();
      for (const c of labelClaims) claimById.set(c.id, c);
      // Walk once, transforming existing rows with sourceLabelClaimId in
      // place (removing when the claim is gone) and tracking which claim
      // ids already have a row so we can append missing ones after the
      // last cooked row.
      const seenClaimIds = new Set<string>();
      const transformed: (GummyFormulaIngredient | null)[] = prev.map((r) => {
        if (r.sourceLabelClaimId == null) return r;
        const claim = claimById.get(r.sourceLabelClaimId);
        if (!claim) return null; // claim removed → drop row
        seenClaimIds.add(claim.id);
        const nextRow: GummyFormulaIngredient = {
          ...r,
          rawMaterialId: claim.rawMaterialId,
          rawMaterialFpCode: claim.rawMaterialFpCode ?? null,
          customName: claim.customName ?? null,
          blendPhase: "cooked",
          // grams intentionally NOT overwritten — operator owns it.
          // overagePct intentionally NOT overwritten — no longer read.
        };
        return nextRow;
      });
      // Filter out removed rows.
      const kept = transformed.filter(
        (r): r is GummyFormulaIngredient => r !== null,
      );
      // Determine which claims need a fresh row appended.
      const missingClaims = labelClaims.filter(
        (c) => !seenClaimIds.has(c.id),
      );
      let next: GummyFormulaIngredient[];
      if (missingClaims.length === 0) {
        next = kept;
      } else {
        // Insert new rows at the end of the cooked-phase run. If no
        // cooked rows exist yet, append at the end of the whole list.
        let lastCookedIdx = -1;
        for (let i = 0; i < kept.length; i++) {
          if (kept[i].blendPhase === "cooked") lastCookedIdx = i;
        }
        const newRows: GummyFormulaIngredient[] = missingClaims.map((c) => ({
          id: `ing_${Math.random().toString(36).slice(2, 10)}`,
          rawMaterialId: c.rawMaterialId,
          rawMaterialFpCode: c.rawMaterialFpCode ?? null,
          customName: c.customName ?? null,
          pctInFinished: 0,
          // Seed grams at 0 so the operator sees an empty starting
          // cell — the row is a scaffold; they type the target grams
          // (or reference the derived overage % as guidance).
          grams: 0,
          blendPhase: "cooked" as BlendPhase,
          costPerKgOverride: null,
          solidsOverride: null,
          notes: null,
          sourceLabelClaimId: c.id,
        }));
        if (lastCookedIdx === -1) {
          next = [...kept, ...newRows];
        } else {
          next = [
            ...kept.slice(0, lastCookedIdx + 1),
            ...newRows,
            ...kept.slice(lastCookedIdx + 1),
          ];
        }
      }
      // Compare-then-set — bail out with `prev` if the effect produced
      // an identical array so React doesn't re-render / re-fire this
      // effect (prevents render loops when nothing actually changed).
      // Grams + overagePct are EXCLUDED from the claim-sourced compare
      // because this effect doesn't touch them anymore — leaving them
      // in would flag every operator-driven grams edit as a diff and
      // fight the input.
      if (next.length !== prev.length) return next;
      for (let i = 0; i < next.length; i++) {
        const a = next[i];
        const b = prev[i];
        if (a === b) continue;
        const claimSourced =
          (a.sourceLabelClaimId ?? null) !== null ||
          (b.sourceLabelClaimId ?? null) !== null;
        // Identity-only comparison for claim-sourced rows.
        if (
          a.id !== b.id ||
          a.rawMaterialId !== b.rawMaterialId ||
          (a.rawMaterialFpCode ?? null) !== (b.rawMaterialFpCode ?? null) ||
          (a.customName ?? null) !== (b.customName ?? null) ||
          a.blendPhase !== b.blendPhase ||
          (a.sourceLabelClaimId ?? null) !== (b.sourceLabelClaimId ?? null) ||
          // Non-claim rows still compare grams so a hand-authored row
          // reference change (e.g. after a splice) is caught.
          (!claimSourced && (a.grams ?? null) !== (b.grams ?? null))
        ) {
          return next;
        }
      }
      return prev;
    });
    // Only labelClaims drives this effect now — grams derivation used
    // to depend on benchBatchG + gummyPieceWeightG, but with grams
    // manual the sync no longer reads them.
  }, [labelClaims]);

  // Group ingredients by blendPhase for the sectioned bench-top view. Rows
  // without a phase (legacy or explicitly unassigned) stay in the shared
  // table at the bottom.
  const phaseIngredients = useMemo(() => {
    const groups: Record<BlendPhase, GummyFormulaIngredient[]> = {
      "pre-cook": [],
      cooking: [],
      cooked: [],
      secondary: [],
      final: [],
    };
    const unassigned: GummyFormulaIngredient[] = [];
    for (const row of ingredients) {
      if (row.blendPhase && groups[row.blendPhase]) {
        groups[row.blendPhase].push(row);
      } else {
        unassigned.push(row);
      }
    }
    return { groups, unassigned };
  }, [ingredients]);

  return (
    <div>
      {/* ============ Identity header (sticky top) ============ */}
      <div
        style={{
          position: "sticky",
          top: 0,
          zIndex: 5,
          background: "var(--cream-soft, #fbf6ec)",
          border: "1px solid var(--line, #e3dcc9)",
          borderRadius: 10,
          padding: "14px 16px",
          marginBottom: 14,
          boxShadow: "0 2px 6px rgba(15,74,86,0.06)",
        }}
      >
        {/* Card title — bold, teal, with a thin teal underline to
            anchor it inside the card without a separate tab shape. */}
        <div
          style={{
            fontSize: 20,
            fontWeight: 800,
            color: "var(--teal-900, #0f4a56)",
            letterSpacing: "-0.01em",
            lineHeight: 1.15,
            paddingBottom: 8,
            marginBottom: 12,
            borderBottom: "2px solid var(--teal-700, #1d6c7b)",
          }}
        >
          Product Details
        </div>
        {/* Identity row.
            Uses flex-wrap so every column keeps its natural min width and
            the entire row wraps to a second line rather than pushing
            Flavor off the right edge of the card. Fixed pixel widths on
            the small columns; the two long-text columns (Name, Flavor)
            grow to fill remaining space. */}
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: 12,
            alignItems: "flex-end",
          }}
        >
          {/* Product Code — leftmost column. TBD/Existing radio buttons on
              top, either the typeahead product picker or a disabled
              placeholder below. Both branches render an input of the SAME
              height so switching modes doesn't jiggle the row. */}
          <Field label="Product Code" width={260}>
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <div style={{ display: "flex", gap: 10, fontSize: 11, fontWeight: 700 }}>
                <label
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 4,
                    color:
                      pcBkMode === "tbd"
                        ? "var(--teal-900, #0f4a56)"
                        : "var(--ink-3, #8a9498)",
                    cursor: "pointer",
                  }}
                >
                  <input
                    type="radio"
                    name="pc-bk-mode"
                    checked={pcBkMode === "tbd"}
                    onChange={() => {
                      setPcBkMode("tbd");
                      setPcBkCode("");
                      setPcBkSearch("");
                      setPcBkEditing(true);
                    }}
                    style={{ margin: 0 }}
                  />
                  TBD
                </label>
                <label
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 4,
                    color:
                      pcBkMode === "existing"
                        ? "var(--teal-900, #0f4a56)"
                        : "var(--ink-3, #8a9498)",
                    cursor: "pointer",
                  }}
                >
                  <input
                    type="radio"
                    name="pc-bk-mode"
                    checked={pcBkMode === "existing"}
                    onChange={() => {
                      setPcBkMode("existing");
                      // Start in search mode unless a code is already
                      // pinned from a previous save.
                      setPcBkEditing(pcBkCode === "");
                    }}
                    style={{ margin: 0 }}
                  />
                  Existing
                </label>
              </div>
              {pcBkMode === "existing" ? (
                pickedPcBkProduct && !pcBkEditing ? (
                  // Picked: render as a read-only input styled exactly
                  // like Name / Shape / Flavor so it lines up in the row.
                  // Clicking anywhere on the field reopens the typeahead;
                  // a tiny right-aligned Change link disambiguates the
                  // affordance so the rep knows the value is editable.
                  <div
                    role="button"
                    tabIndex={0}
                    onClick={() => {
                      setPcBkEditing(true);
                      setPcBkSearch("");
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        setPcBkEditing(true);
                        setPcBkSearch("");
                      }
                    }}
                    className="pricing__input"
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 6,
                      cursor: "pointer",
                    }}
                    title={pickedPcBkProduct.name}
                  >
                    <span
                      style={{
                        flex: 1,
                        minWidth: 0,
                        whiteSpace: "nowrap",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                      }}
                    >
                      {pickedPcBkProduct.fpCode}
                    </span>
                    <span
                      style={{
                        fontSize: 10.5,
                        fontWeight: 700,
                        letterSpacing: "0.08em",
                        textTransform: "uppercase",
                        color: "var(--teal-700, #1d6c7b)",
                      }}
                    >
                      Change
                    </span>
                  </div>
                ) : (
                  // Searching: text input + dropdown of filtered results
                  // that only appears when the query is non-empty. Mirrors
                  // the pricing calc's vendor search pattern.
                  <div style={{ position: "relative" }}>
                    <input
                      type="text"
                      value={pcBkSearch}
                      onChange={(e) => {
                        setPcBkSearch(e.target.value);
                        // Any change to the search field means the
                        // previously picked value is no longer active
                        // until a fresh pick happens.
                        if (pcBkCode) setPcBkCode("");
                      }}
                      placeholder="Type to search…"
                      className="pricing__input"
                      autoComplete="off"
                      autoFocus
                    />
                    {pcBkSearch.trim().length > 0 && pcBkResults.length > 0 ? (
                      <ul
                        style={{
                          position: "absolute",
                          top: "calc(100% + 2px)",
                          left: 0,
                          right: 0,
                          zIndex: 20,
                          margin: 0,
                          padding: 0,
                          listStyle: "none",
                          background: "#fff",
                          border: "1px solid var(--line, #e3dcc9)",
                          borderRadius: 6,
                          boxShadow: "0 4px 12px rgba(15,74,86,0.12)",
                          maxHeight: 240,
                          overflow: "auto",
                        }}
                      >
                        {pcBkResults.map((p) => (
                          <li key={p.id}>
                            <button
                              type="button"
                              onClick={() => pickPcBkProduct(p)}
                              style={{
                                display: "block",
                                width: "100%",
                                textAlign: "left",
                                padding: "8px 10px",
                                background: "transparent",
                                border: "none",
                                borderBottom: "1px solid var(--line-2, #efe9da)",
                                cursor: "pointer",
                                fontSize: 12,
                              }}
                              onMouseEnter={(e) =>
                                (e.currentTarget.style.background = "var(--cream-soft, #fbf6ec)")
                              }
                              onMouseLeave={(e) =>
                                (e.currentTarget.style.background = "transparent")
                              }
                            >
                              <div
                                style={{
                                  fontWeight: 700,
                                  color: "var(--teal-900, #0f4a56)",
                                  fontFamily: "ui-monospace, SFMono-Regular, monospace",
                                }}
                              >
                                {p.fpCode}
                              </div>
                              <div style={{ color: "var(--ink-2, #415056)" }}>
                                {p.name}
                              </div>
                            </button>
                          </li>
                        ))}
                      </ul>
                    ) : pcBkSearch.trim().length > 0 ? (
                      <div
                        style={{
                          position: "absolute",
                          top: "calc(100% + 2px)",
                          left: 0,
                          right: 0,
                          zIndex: 20,
                          padding: "8px 10px",
                          background: "#fff",
                          border: "1px solid var(--line, #e3dcc9)",
                          borderRadius: 6,
                          fontSize: 11,
                          color: "var(--ink-3, #8a9498)",
                        }}
                      >
                        No PC-BK products matched &ldquo;{pcBkSearch.trim()}&rdquo;.
                      </div>
                    ) : null}
                  </div>
                )
              ) : (
                <input
                  type="text"
                  value=""
                  disabled
                  placeholder="Assigned later"
                  className="pricing__input"
                />
              )}
            </div>
          </Field>

          {/* Name — second column, grows. Auto-fills from Product Code
              picker when Existing mode is active, but always remains
              editable. */}
          <Field label="Name / description" grow>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="pricing__input"
              placeholder="e.g. Nuro-Brocc Bear Gummy"
              autoComplete="off"
            />
          </Field>

          {/* Piece weight and Cast weight (wet) were moved from here to
              the Bench Top Batch Size card — see BenchTopTab. They're
              per-batch physical properties, so grouping them with the
              batch size reads better than keeping them beside the
              identity fields. */}

          <Field label="Shape" width={130}>
            <select
              value={shape}
              onChange={(e) => setShape(e.target.value)}
              className="pricing__input"
            >
              {FORMULA_SHAPES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Flavor" grow>
            <input
              type="text"
              value={flavor}
              onChange={(e) => setFlavor(e.target.value)}
              className="pricing__input"
              placeholder="e.g. Sour Green Apple"
              autoComplete="off"
            />
          </Field>

          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <button
              type="button"
              onClick={handleSave}
              disabled={saving || !anyDirty}
              style={{
                padding: "10px 18px",
                background: anyDirty ? "var(--teal-700, #1d6c7b)" : "#c7d2d6",
                color: "#fff",
                border: "1px solid",
                borderColor: anyDirty ? "var(--teal-900, #0f4a56)" : "#b6c1c5",
                borderRadius: 8,
                fontSize: 13,
                fontWeight: 700,
                cursor: saving ? "wait" : anyDirty ? "pointer" : "not-allowed",
                whiteSpace: "nowrap",
              }}
            >
              {saving
                ? "Saving…"
                : versionDirty
                  ? `Save (v${(initialFormula.latestVersionNum || 0) + 1})`
                  : identityDirty
                    ? "Save"
                    : "Saved"}
            </button>
            {saveStatus ? (
              <span
                style={{
                  fontSize: 11,
                  fontWeight: 700,
                  color: saveStatus.kind === "ok" ? "var(--teal-700, #1d6c7b)" : "#8b2f2f",
                  textAlign: "right",
                }}
              >
                {saveStatus.text}
              </span>
            ) : null}
          </div>
        </div>

        {/* Customer — pinned below the identity row. Mirrors the picker
            on /start (Existing / New customer tabs, search input, picked
            pill with Change button, new-customer form fields). Selecting
            an existing customer immediately fires an identity PUT so the
            customer_id persists without waiting for Save. New-customer
            creation is form-only for now — see the TODO below. */}
        <CustomerSection
          customerId={customerId}
          customerName={customerName}
          customerShipTo={customerShipTo}
          customerMode={customerMode}
          editing={editingCustomer}
          search={customerSearch}
          results={customerResults}
          newCustomer={newCustomer}
          onSetMode={setCustomerMode}
          onSearchChange={setCustomerSearch}
          onPick={pickCustomer}
          onClear={clearCustomer}
          onStartEdit={() => setEditingCustomer(true)}
          onNewCustomerChange={(patch) =>
            setNewCustomer((prev) => ({ ...prev, ...patch }))
          }
        />

        {/* Label claims — active-ingredient claim rows under the identity
            row. Each claim pins to a raw material and carries an amount +
            unit (mcg / mg / g, defaulting to mg). Stored on the version so
            claim edits participate in version history. */}
        <LabelClaimsSection
          claims={labelClaims}
          rawMaterials={rawMaterials}
          onAdd={addLabelClaim}
          onUpdate={updateLabelClaim}
          onRemove={removeLabelClaim}
        />

        {/* Version / Updated / by meta strip now lives above the identity
            card, inside /formulas/[id]/page.tsx — it renders identically
            regardless of the tab you're on and doesn't scroll with the
            sticky header. */}
      </div>

      {/* ============ Tab bar ============ */}
      <div
        role="tablist"
        style={{
          display: "flex",
          gap: 4,
          borderBottom: "2px solid var(--line, #e3dcc9)",
          marginBottom: 16,
        }}
      >
        <TabButton active={tab === "bench"} onClick={() => setTab("bench")}>
          Bench top
        </TabButton>
        <TabButton active={tab === "scale"} onClick={() => setTab("scale")}>
          Scale up
        </TabButton>
        <TabButton active={tab === "cost"} onClick={() => setTab("cost")}>
          Material costing
        </TabButton>
      </div>

      {/* ============ Tab content ============ */}
      {tab === "bench" && (
        <>
          <BenchTopTab
            benchBatchG={benchBatchG}
            setBenchBatchG={setBenchBatchG}
            gummyPieceWeightG={gummyPieceWeightG}
            setGummyPieceWeightG={setGummyPieceWeightG}
            wetCastPieceWeightG={wetCastPieceWeightG}
            setWetCastPieceWeightG={setWetCastPieceWeightG}
            primaryBlendG={computeCarryOverPrimaryNetG({
              // Primary blend (cooked) = pre-cook rows net of moisture
              // loss. Mirrors the "Primary Blend Carry Over" total on
              // the Cooked card so the summary card and the carry-over
              // subsection always agree — including per-ingredient
              // default moisture-loss values (see carryOverDefaultMoisturePct)
              // AND the water auto-balance rule (see computeCarryOverWaterPct).
              preCookRows: phaseIngredients.groups["pre-cook"],
              benchBatchG,
              secondaryG: phaseIngredients.groups["cooked"].reduce(
                (s, r) => s + (Number(r.grams) || 0),
                0,
              ),
              finalG: phaseIngredients.groups["final"].reduce(
                (s, r) => s + (Number(r.grams) || 0),
                0,
              ),
            })}
            secondaryBlendG={phaseIngredients.groups["cooked"].reduce(
              (s, r) => s + (Number(r.grams) || 0),
              0,
            )}
            finalBlendG={phaseIngredients.groups["final"].reduce(
              (s, r) => s + (Number(r.grams) || 0),
              0,
            )}
            residualMoistureTotalPct={computeGrandResidualPct({
              preCookRows: phaseIngredients.groups["pre-cook"],
              secondaryRows: phaseIngredients.groups["cooked"],
              finalRows: phaseIngredients.groups["final"],
              benchBatchG,
            })}
            sugarSyrupRatio={computeSugarSyrupRatio({
              // Match Excel column G: dry/dry ratio computed off the
              // Primary Blend Carry Over rows. Sugar row = name contains
              // "sugar"; Syrup row = name contains "syrup" or "tapioca".
              preCookRows: phaseIngredients.groups["pre-cook"],
              rmById,
            })}
          />
          {/* Blend-phase sections. Currently only Pre-cook is rendered;
              Secondary + Final will drop in the same way as the recipe
              modeling continues. Order matches the physical sheet. */}
          <BlendSectionCard
            phase="pre-cook"
            rows={phaseIngredients.groups["pre-cook"]}
            rawMaterials={rawMaterials}
            rmById={rmById}
            savedSolutions={savedSolutions}
            onUpdate={updateRow}
            onAddRow={() => addRowForPhase("pre-cook")}
            onAddSolution={() => addSolutionForPhase("pre-cook")}
            onAddSavedSolution={(s) => addSavedSolutionForPhase("pre-cook", s)}
            onSaveSolutionToLibrary={saveSolutionToLibrary}
            onRemoveRow={removeRow}
            onReorderRow={reorderRow}
            processNote={processNotes["pre-cook"] ?? ""}
            defaultProcessNote={DEFAULT_PROCESS_NOTES["pre-cook"] ?? ""}
            onProcessNoteChange={(text) => setPhaseProcessNote("pre-cook", text)}
            sectionUnitValue={preCookUnit}
            onSectionUnitChange={setPreCookUnit}
          />
          <BlendSectionCard
            phase="cooked"
            rows={phaseIngredients.groups["cooked"]}
            rawMaterials={rawMaterials}
            rmById={rmById}
            savedSolutions={savedSolutions}
            onUpdate={updateRow}
            onAddRow={() => addRowForPhase("cooked")}
            onAddSolution={() => addSolutionForPhase("cooked")}
            onAddSavedSolution={(s) => addSavedSolutionForPhase("cooked", s)}
            onSaveSolutionToLibrary={saveSolutionToLibrary}
            onRemoveRow={removeRow}
            onReorderRow={reorderRow}
            processNote={processNotes["cooked"] ?? ""}
            defaultProcessNote={DEFAULT_PROCESS_NOTES["cooked"] ?? ""}
            onProcessNoteChange={(text) => setPhaseProcessNote("cooked", text)}
            cookingProcessNote={processNotes["cooking"] ?? ""}
            defaultCookingProcessNote={DEFAULT_PROCESS_NOTES["cooking"] ?? ""}
            onCookingProcessNoteChange={(text) => setPhaseProcessNote("cooking", text)}
            finalRows={phaseIngredients.groups["final"]}
            onAddFinalRow={() => addRowForPhase("final")}
            onAddFinalSolution={() => addSolutionForPhase("final")}
            onAddSavedFinalSolution={(s) => addSavedSolutionForPhase("final", s)}
            finalProcessNote={processNotes["final"] ?? ""}
            defaultFinalProcessNote={DEFAULT_PROCESS_NOTES["final"] ?? ""}
            onFinalProcessNoteChange={(text) => setPhaseProcessNote("final", text)}
            carryOverRows={phaseIngredients.groups["pre-cook"]}
            carryOverUnit={preCookUnit}
            benchBatchG={benchBatchG}
            labelClaims={labelClaims}
            gummyPieceWeightG={gummyPieceWeightG}
            wetCastPieceWeightG={wetCastPieceWeightG}
          />
        </>
      )}
      {tab === "scale" && (
        <ScaleUpTab
          batchKg={batchKg}
          setBatchKg={setBatchKg}
          batchesPerDay={batchesPerDay}
          setBatchesPerDay={setBatchesPerDay}
          fixedLossKgPerDay={fixedLossKgPerDay}
          setFixedLossKgPerDay={setFixedLossKgPerDay}
          gummyPieceWeightG={gummyPieceWeightG}
          setGummyPieceWeightG={setGummyPieceWeightG}
          yieldPct={yieldPct}
          setYieldPct={setYieldPct}
          effectiveYield={cost.dailyEffectiveYield}
        />
      )}
      {tab === "cost" && (
        <CostTab
          cost={cost}
          gummyPieceWeightG={gummyPieceWeightG}
          batchKg={batchKg}
          batchesPerDay={batchesPerDay}
        />
      )}

      {/* ============ Ingredient table (shared) ============
          Bench top no longer renders the shared/legacy ingredient table —
          per-blend cards cover ingredients fully. On Scale up + Material
          costing tabs the flat table still shows EVERY row so the rep
          sees production-side totals across all phases in one place. */}
      {tab === "bench" ? null : (
        <IngredientTable
          tab={tab}
          ingredients={ingredients}
          rawMaterials={rawMaterials}
          benchGramById={benchGramById}
          scaleKgById={scaleKgById}
          onUpdate={updateRow}
          onAdd={addRow}
          onRemove={removeRow}
          rmById={rmById}
          yieldPct={yieldPct}
          gummyPieceWeightG={gummyPieceWeightG}
        />
      )}

      {/* Activity timeline (audit log). Renders below the ingredient
          table on every tab so users can always see history without
          leaving what they were editing. */}
      <AuditTimeline events={auditEvents} loading={auditLoading} />

      {/* Version notes (only relevant when writing a new version) */}
      {versionDirty ? (
        <div style={{ marginTop: 18 }}>
          <label style={{ display: "block", marginBottom: 6 }}>
            <span
              style={{
                fontSize: 11,
                fontWeight: 700,
                letterSpacing: "0.08em",
                textTransform: "uppercase",
                color: "var(--ink-3, #8a9498)",
              }}
            >
              What changed in this version? <em style={{ fontWeight: 400 }}>(optional)</em>
            </span>
            <textarea
              rows={2}
              value={versionNotes}
              onChange={(e) => setVersionNotes(e.target.value)}
              className="pricing__input"
              style={{ resize: "vertical", width: "100%", marginTop: 4 }}
              placeholder="e.g. Bumped pectin from 1.9% to 2.1% to improve set."
            />
          </label>
        </div>
      ) : null}
    </div>
  );
}

// -----------------------------------------------------------------------------
// Sub-components
// -----------------------------------------------------------------------------

function Field({
  label,
  children,
  width,
  grow,
}: {
  label: string;
  children: React.ReactNode;
  /** Fixed width in px. Ignored when grow is true. */
  width?: number;
  /** When true, the field expands to fill remaining row space. Used for
   *  long-text fields (Name, Flavor) so short-text fields (Piece weight,
   *  Shape) can hold their compact width. */
  grow?: boolean;
}) {
  // Grow columns share leftover row space with each other. maxWidth caps
  // them so if one wraps to the next line the survivors don't stretch to
  // fill the whole row (which left a big empty gap between Name and Piece
  // Weight before this cap was in place).
  const flexBasis = grow
    ? { flex: "1 1 240px", minWidth: 180, maxWidth: 340 }
    : { flex: `0 0 ${width ?? 160}px` };
  return (
    <label
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 4,
        ...flexBasis,
      }}
    >
      <span
        style={{
          fontSize: 10.5,
          fontWeight: 700,
          letterSpacing: "0.1em",
          textTransform: "uppercase",
          color: "var(--ink-3, #8a9498)",
        }}
      >
        {label}
      </span>
      {children}
    </label>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      style={{
        padding: "10px 20px",
        background: active ? "var(--paper, #fffdf8)" : "transparent",
        color: active ? "var(--teal-900, #0f4a56)" : "var(--ink-3, #8a9498)",
        border: "1px solid var(--line, #e3dcc9)",
        borderBottom: active ? "2px solid var(--paper, #fffdf8)" : "1px solid var(--line, #e3dcc9)",
        borderRadius: "8px 8px 0 0",
        marginBottom: -2,
        fontSize: 13,
        fontWeight: 700,
        cursor: "pointer",
      }}
    >
      {children}
    </button>
  );
}

function NumberInput({
  value,
  onChange,
  suffix,
  step,
  min,
}: {
  value: number;
  onChange: (n: number) => void;
  suffix?: string;
  step?: string;
  min?: number;
}) {
  return (
    <div style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
      <input
        type="number"
                onFocus={(e) => {
                  // Chrome's <input type="number"> doesn't select on
                  // focus synchronously — defer one frame so the
                  // digits are highlighted and any keystroke replaces
                  // the placeholder 0 instead of prepending to it.
                  const el = e.currentTarget;
                  setTimeout(() => {
                    try { el.select(); } catch {}
                  }, 0);
                }}
        value={Number.isFinite(value) ? value : 0}
        onChange={(e) => {
          const n = Number(e.target.value);
          onChange(Number.isFinite(n) ? n : 0);
        }}
        step={step ?? "any"}
        min={min}
        className="pricing__input"
        style={{ width: 100, textAlign: "right", fontVariantNumeric: "tabular-nums" }}
      />
      {suffix ? (
        <span style={{ fontSize: 12, color: "var(--ink-3, #8a9498)" }}>{suffix}</span>
      ) : null}
    </div>
  );
}

// --- BenchTop tab ------------------------------------------------------------

// Compact labelled weight input used by the Bench Top Batch Size card.
// Renders an uppercase label, a number input with a "g" suffix, and an
// optional hint line beneath. `emphasize` bumps the value's font size
// (used for the primary Bench top batch size field so it reads as the
// heading of the card).
function BenchTopWeightInput({
  label,
  value,
  onChange,
  hint,
  min = 0.1,
  step = 1,
  emphasize = false,
}: {
  label: string;
  value: number;
  onChange: (n: number) => void;
  hint?: string;
  min?: number;
  step?: number;
  emphasize?: boolean;
}) {
  return (
    <div>
      <div
        style={{
          fontSize: 10.5,
          fontWeight: 700,
          letterSpacing: "0.1em",
          textTransform: "uppercase",
          color: "var(--ink-3, #8a9498)",
          marginBottom: 4,
        }}
      >
        {label}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
        <input
          type="number"
          value={Number.isFinite(value) ? value : 0}
          onFocus={(e) => {
            // Same Chrome-workaround pattern used by every other
            // numeric input on this page — defer .select() one tick
            // so the digits highlight and a keystroke replaces them.
            const el = e.currentTarget;
            setTimeout(() => {
              try { el.select(); } catch {}
            }, 0);
          }}
          onChange={(e) => {
            const n = Number(e.target.value);
            onChange(Number.isFinite(n) ? n : 0);
          }}
          step={step}
          min={min}
          className="pricing__input"
          style={{
            width: 90,
            textAlign: "right",
            fontVariantNumeric: "tabular-nums",
            fontSize: emphasize ? 20 : 14,
            fontWeight: emphasize ? 700 : 500,
          }}
        />
        <span style={{ fontSize: 12, color: "var(--ink-3, #8a9498)" }}>g</span>
      </div>
      {hint ? (
        <div style={{ fontSize: 11, color: "var(--ink-3, #8a9498)", marginTop: 4 }}>
          {hint}
        </div>
      ) : null}
    </div>
  );
}

// Read-only counterpart to BenchTopWeightInput — same visual pattern
// (uppercase label + value + unit) but the value is a computed string
// instead of a live number input. Used for Theoretical Yield in the
// Bench Top Batch Size card so the derived piece count reads as part
// of the same stacked list.
function BenchTopReadout({
  label,
  valueText,
  suffix,
}: {
  label: string;
  valueText: string;
  suffix: string;
}) {
  return (
    <div>
      <div
        style={{
          fontSize: 10.5,
          fontWeight: 700,
          letterSpacing: "0.1em",
          textTransform: "uppercase",
          color: "var(--ink-3, #8a9498)",
          marginBottom: 4,
        }}
      >
        {label}
      </div>
      {/* Mirror the *exact* horizontal structure of BenchTopWeightInput
          so the digits right-align with the numeric inputs above:
          - outer: flex row with the same alignItems/gap as the input row
          - value column: flex:1 (matches the `flex: 1` on .pricing__input)
            containing the number stacked over the unit caption
          - hidden "g" placeholder: preserves the same right-edge offset
            the input row loses to its visible "g" suffix, so the
            readout's number ends at the same X as the input's digits. */}
      <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
        <div
          style={{
            flex: 1,
            display: "flex",
            flexDirection: "column",
            alignItems: "flex-end",
          }}
        >
          <div
            style={{
              fontSize: 14,
              fontWeight: 500,
              color: "var(--teal-900, #0f4a56)",
              fontVariantNumeric: "tabular-nums",
              lineHeight: 1.15,
            }}
          >
            {valueText}
          </div>
          <span style={{ fontSize: 11, color: "var(--ink-3, #8a9498)", lineHeight: 1.1 }}>
            {suffix}
          </span>
        </div>
        <span
          aria-hidden="true"
          style={{ fontSize: 12, color: "transparent", visibility: "hidden" }}
        >
          g
        </span>
      </div>
    </div>
  );
}

function BenchTopTab({
  benchBatchG,
  setBenchBatchG,
  gummyPieceWeightG,
  setGummyPieceWeightG,
  wetCastPieceWeightG,
  setWetCastPieceWeightG,
  primaryBlendG,
  secondaryBlendG,
  finalBlendG,
  residualMoistureTotalPct,
  sugarSyrupRatio,
}: {
  benchBatchG: number;
  setBenchBatchG: (n: number) => void;
  /** Finished (dried) per-piece weight in g. Moved from Product Details
   *  to this card because it's a per-piece physical property used by
   *  the bench-top math (piecesPerBatch, cost/gummy, scale-up yields). */
  gummyPieceWeightG: number;
  setGummyPieceWeightG: (n: number) => void;
  /** Wet cast per-piece weight in g. Used with benchBatchG to compute
   *  piecesPerBatch = benchBatchG ÷ wetCastPieceWeightG for the label-
   *  claim → Secondary Blend overage math. */
  wetCastPieceWeightG: number;
  setWetCastPieceWeightG: (n: number) => void;
  /** Sum of pre-cook grams AFTER moisture loss. Matches the total on the
   *  Cooked card's "Primary Blend Carry Over" subsection. */
  primaryBlendG: number;
  /** Sum of "cooked" phase grams — displayed as "Secondary Blend" in the
   *  Cooked card's second subsection. */
  secondaryBlendG: number;
  /** Sum of "final" phase grams — displayed in the Cooked card's Final
   *  Blend subsection. */
  finalBlendG: number;
  /** Grand-total Residual Moisture % across the whole Cooked blend card.
   *  Mirrors the value in the Grand Total Cooked Blend footer row. */
  residualMoistureTotalPct: number;
  /** Sugar/Syrup ratio (dry/dry) computed from Primary Blend Carry Over
   *  rows. null when either a sugar row or a syrup/tapioca row is
   *  missing — the UI shows "—" placeholders in that case. */
  sugarSyrupRatio: { sugarPct: number; syrupPct: number } | null;
}) {
  // Combined batch weight across all three blends. Compared against the
  // bench top batch so the rep can see at a glance how close the recipe
  // sums to the target reference size.
  const totalBlendsG = primaryBlendG + secondaryBlendG + finalBlendG;
  const pctOfBench =
    benchBatchG > 0 ? (totalBlendsG / benchBatchG) * 100 : 0;
  const totalOk = Math.abs(pctOfBench - 100) < 0.01;
  // Shared card chrome — extracted so the two cards below share the
  // same border/background/radius without repeating the style props.
  const cardStyle: React.CSSProperties = {
    padding: 14,
    border: "1px solid var(--line, #e3dcc9)",
    borderRadius: 8,
    background: "var(--paper, #fffdf8)",
  };
  return (
    // Two side-by-side cards separated by a small gap. Wraps to two
    // rows on narrow viewports so the batch input stays reachable
    // even when the equation can't fit on one line.
    <div
      style={{
        marginBottom: 14,
        display: "flex",
        gap: 12,
        alignItems: "stretch",
        flexWrap: "wrap",
      }}
    >
      {/* Left card — Bench top batch size plus per-piece physical
          weights plus the derived theoretical yield. All four rows
          stack vertically inside a single card because they describe
          "how the batch is measured and what it produces": the total
          wet blend weight, the finished (dry) piece weight, the wet
          cast weight, and the piece count the batch yields.
          Sized to its content so the right (Key Indicators) card
          gets the remaining width for the equation. */}
      <div style={{ ...cardStyle, display: "flex", alignItems: "center" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <BenchTopWeightInput
            label="Bench top batch size"
            value={benchBatchG}
            onChange={setBenchBatchG}
            min={1}
            emphasize
          />
          <BenchTopWeightInput
            label="Finished piece weight (Dry)"
            value={gummyPieceWeightG}
            onChange={setGummyPieceWeightG}
            min={0.1}
            step={0.1}
          />
          <BenchTopWeightInput
            label="Cast weight (wet)"
            value={wetCastPieceWeightG}
            onChange={setWetCastPieceWeightG}
            min={0.1}
            step={0.1}
          />
          {/* Theoretical yield — batchSize ÷ castWeight, in gummies.
              Read-only display in the same visual pattern as the input
              rows above so the four values read as a stack. Rounded
              to 1 decimal so operators see e.g. 86.2 gummies without
              too much precision noise. Falls back to "—" when either
              side is 0/missing. */}
          <BenchTopReadout
            label="Theoretical Yield"
            valueText={
              wetCastPieceWeightG > 0 && benchBatchG > 0
                ? (benchBatchG / wetCastPieceWeightG).toFixed(1)
                : "—"
            }
            suffix="gummies"
          />
        </div>
      </div>
      {/* Right card — Key Indicators equation + % of bench batch.
          Grows to fill remaining space so the equation stays readable
          without cramping on wider viewports. */}
      <div style={{ ...cardStyle, flex: 1, minWidth: 0 }}>
        {/* Key Indicators — per-phase blend totals wired together as a
            visible equation: Primary + Secondary + Final = Total. The
            block is laid out on a CSS grid with two rows so each label
            (row 1) always sits directly above its value (row 2), and the
            +/= operator glyphs (row 2 only) land on the digit baseline. */}
        <div>
          <div
            style={{
              fontSize: 13,
              fontWeight: 800,
              letterSpacing: "0.06em",
              textTransform: "uppercase",
              color: "var(--teal-900, #0f4a56)",
              marginBottom: 8,
              paddingBottom: 4,
              borderBottom: "1px solid var(--line, #e3dcc9)",
            }}
          >
            Key Indicators
          </div>
          {/* Row 1: the blend equation (Primary + Secondary + Final = Total)
              on the left, % of bench batch pushed to the right edge via
              marginLeft: auto on the group wrapper. Nested flex keeps
              the equation itself compact so operators sit tight against
              their operands even when the card is wide. flexWrap: nowrap
              keeps % of bench on the same line as the equation instead
              of dropping to its own row when the card is narrow. */}
          <div
            style={{
              display: "flex",
              alignItems: "flex-end",
              gap: 16,
              flexWrap: "nowrap",
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "flex-end",
                gap: 16,
              }}
            >
              <KeyIndicatorStat
                label="Primary Blend (cooked)"
                value={primaryBlendG}
              />
              <KeyIndicatorOp glyph="+" />
              <KeyIndicatorStat
                label="Secondary Blend"
                value={secondaryBlendG}
              />
              <KeyIndicatorOp glyph="+" />
              <KeyIndicatorStat
                label="Final Blend"
                value={finalBlendG}
              />
              <KeyIndicatorOp glyph="=" />
              <KeyIndicatorStat
                label="Total (Sum of all blends)"
                value={totalBlendsG}
              />
            </div>
            {/* marginLeft: auto flushes % of bench to the far right of
                the row so it stays visually anchored to the card edge,
                mirroring the Sugar/Syrup ratio's right-anchor on row 2. */}
            <div style={{ marginLeft: "auto" }}>
              <KeyIndicatorPctStat
                label="% of bench batch"
                value={pctOfBench}
                ok={totalOk}
              />
            </div>
          </div>
          {/* Row 2: supporting indicators. Residual Moisture Total on
              the left balances the equation group above; the Sugar to
              Syrup ratio sits on the right under the % of bench. A thin
              dashed rule separates it from the equation so it reads as
              a distinct "supporting metrics" band. */}
          <div
            style={{
              display: "flex",
              alignItems: "flex-end",
              gap: 16,
              flexWrap: "wrap",
              justifyContent: "space-between",
              marginTop: 14,
              paddingTop: 12,
              borderTop: "1px dashed var(--line, #e3dcc9)",
            }}
          >
            <KeyIndicatorPctStat
              label="Residual Moisture Total"
              value={residualMoistureTotalPct}
              ok
            />
            <KeyIndicatorRatioStat
              label="Sugar to Syrup Ratio (dry)"
              sugarText={
                sugarSyrupRatio
                  ? `${sugarSyrupRatio.sugarPct.toFixed(2)}%`
                  : "—"
              }
              syrupText={
                sugarSyrupRatio
                  ? `${sugarSyrupRatio.syrupPct.toFixed(2)}%`
                  : "—"
              }
            />
          </div>
        </div>
      </div>
    </div>
  );
}

// ---- Key Indicators stat cell ----
// Each cell is a fixed-width column with the label centered above the
// value. All four stat cells share the same width (min-width) so the
// equation lays out as evenly-sized boxes with operators between —
// giving each + / = an equal amount of space on both sides.
function KeyIndicatorStat({
  label,
  value,
}: {
  label: string;
  value: number;
}) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 4,
        // Fixed min-width sized to comfortably fit the widest label
        // ("TOTAL (SUM OF ALL BLENDS)"). All four cells share this so
        // the operators land equidistant between them. 155 keeps the
        // whole equation + % of bench on a single row for typical card
        // widths without truncating any label.
        minWidth: 155,
      }}
    >
      <div
        style={{
          fontSize: 10.5,
          fontWeight: 700,
          letterSpacing: "0.1em",
          textTransform: "uppercase",
          color: "var(--ink-3, #8a9498)",
          whiteSpace: "nowrap",
          textAlign: "center",
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontSize: 20,
          fontWeight: 700,
          color: "var(--teal-900, #0f4a56)",
          fontVariantNumeric: "tabular-nums",
          lineHeight: 1,
          whiteSpace: "nowrap",
          textAlign: "center",
        }}
      >
        {value.toFixed(2)}
        <span
          style={{
            fontSize: 12,
            fontWeight: 500,
            color: "var(--ink-3, #8a9498)",
            marginLeft: 4,
          }}
        >
          g
        </span>
      </div>
    </div>
  );
}

// Percentage variant of KeyIndicatorStat used for the "% of bench batch"
// slot at the end of the Key Indicators row. Same visual box as the
// gram-value stats so the whole row stays aligned; renders a % instead
// of grams and turns red when the recipe doesn't balance to bench batch.
function KeyIndicatorPctStat({
  label,
  value,
  ok,
}: {
  label: string;
  value: number;
  ok: boolean;
}) {
  // Drop trailing ".00" so 100% reads as "100%" not "100.00%".
  const s = value.toFixed(2);
  const display = s.endsWith(".00") ? s.slice(0, -3) : s;
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 4,
        // Same 155 min-width as KeyIndicatorStat so this pill lines up
        // with the equation cells on row 1 and stays on the same line.
        minWidth: 155,
      }}
    >
      <div
        style={{
          fontSize: 10.5,
          fontWeight: 700,
          letterSpacing: "0.1em",
          textTransform: "uppercase",
          color: "var(--ink-3, #8a9498)",
          whiteSpace: "nowrap",
          textAlign: "center",
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontSize: 20,
          fontWeight: 700,
          color: ok ? "var(--teal-700, #1d6c7b)" : "#8b2f2f",
          fontVariantNumeric: "tabular-nums",
          lineHeight: 1,
          whiteSpace: "nowrap",
          textAlign: "center",
        }}
      >
        {display}%
      </div>
    </div>
  );
}

// Two-value ratio stat used for "Sugar to Syrup Ratio (dry)" in the
// Key Indicators card. Shows a single label above two labelled sub-
// values (Sugar / Syrup) side by side. Same 190px fixed cell width so
// it aligns with the other Key Indicator stats.
function KeyIndicatorRatioStat({
  label,
  sugarText,
  syrupText,
}: {
  label: string;
  sugarText: string;
  syrupText: string;
}) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 4,
        minWidth: 190,
      }}
    >
      <div
        style={{
          fontSize: 10.5,
          fontWeight: 700,
          letterSpacing: "0.1em",
          textTransform: "uppercase",
          color: "var(--ink-3, #8a9498)",
          whiteSpace: "nowrap",
          textAlign: "center",
        }}
      >
        {label}
      </div>
      {/* Two labelled sub-values side by side. Kept as separate stacks
          so each has its own "SUGAR" / "SYRUP" caption above the digit. */}
      <div style={{ display: "flex", gap: 18, alignItems: "flex-end" }}>
        <RatioSubValue caption="Sugar" text={sugarText} />
        <RatioSubValue caption="Syrup" text={syrupText} />
      </div>
    </div>
  );
}

// A single value under a small "SUGAR" / "SYRUP" caption. Used by
// KeyIndicatorRatioStat.
function RatioSubValue({ caption, text }: { caption: string; text: string }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
      <div
        style={{
          fontSize: 9,
          fontWeight: 700,
          letterSpacing: "0.1em",
          textTransform: "uppercase",
          color: "var(--ink-3, #8a9498)",
          lineHeight: 1,
          marginBottom: 3,
        }}
      >
        {caption}
      </div>
      <div
        style={{
          fontSize: 20,
          fontWeight: 700,
          color: "var(--teal-900, #0f4a56)",
          fontVariantNumeric: "tabular-nums",
          lineHeight: 1,
          whiteSpace: "nowrap",
        }}
      >
        {text}
      </div>
    </div>
  );
}

// Operator glyph (+, =) between KeyIndicatorStat cells. Aligns to the
// value baseline (not the label above) so the equation reads across.
function KeyIndicatorOp({ glyph }: { glyph: string }) {
  return (
    <div
      aria-hidden="true"
      style={{
        // Nudge down so the glyph sits at the digit baseline, not the
        // top of the cell. The parent's alignItems: "flex-end" bottoms
        // the operator; a tiny paddingBottom fine-tunes to the digit
        // baseline for visual symmetry with the values.
        paddingBottom: 2,
        fontSize: 22,
        fontWeight: 700,
        color: "var(--ink-3, #8a9498)",
        lineHeight: 1,
      }}
    >
      {glyph}
    </div>
  );
}

// --- Scale up tab ------------------------------------------------------------

function ScaleUpTab({
  batchKg,
  setBatchKg,
  batchesPerDay,
  setBatchesPerDay,
  fixedLossKgPerDay,
  setFixedLossKgPerDay,
  gummyPieceWeightG,
  setGummyPieceWeightG,
  yieldPct,
  setYieldPct,
  effectiveYield,
}: {
  batchKg: number;
  setBatchKg: (n: number) => void;
  batchesPerDay: number;
  setBatchesPerDay: (n: number) => void;
  fixedLossKgPerDay: number;
  setFixedLossKgPerDay: (n: number) => void;
  gummyPieceWeightG: number;
  setGummyPieceWeightG: (n: number) => void;
  yieldPct: number;
  setYieldPct: (n: number) => void;
  effectiveYield: number;
}) {
  const totalDailyKg = batchKg * batchesPerDay;
  const gummiesPerBatch = gummyPieceWeightG > 0 ? (batchKg * 1000) / gummyPieceWeightG : 0;

  return (
    <div
      style={{
        marginBottom: 14,
        padding: 14,
        border: "1px solid var(--line, #e3dcc9)",
        borderRadius: 8,
        background: "var(--paper, #fffdf8)",
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
        gap: 14,
      }}
    >
      <ParamBlock label="Batch size">
        <NumberInput value={batchKg} onChange={setBatchKg} suffix="kg" min={1} />
      </ParamBlock>
      <ParamBlock label="Batches / day">
        <NumberInput value={batchesPerDay} onChange={setBatchesPerDay} min={1} />
      </ParamBlock>
      <ParamBlock label="Fixed loss / day">
        <NumberInput
          value={fixedLossKgPerDay}
          onChange={setFixedLossKgPerDay}
          suffix="kg"
          min={0}
        />
      </ParamBlock>
      <ParamBlock label="Piece weight">
        <NumberInput
          value={gummyPieceWeightG}
          onChange={setGummyPieceWeightG}
          suffix="g"
          step="0.1"
          min={0.1}
        />
      </ParamBlock>
      <ParamBlock label="Process yield">
        <NumberInput value={yieldPct} onChange={setYieldPct} suffix="%" min={1} />
      </ParamBlock>
      <ParamBlock label="Total daily kg">
        <ReadOnly>{totalDailyKg.toLocaleString("en-US", { maximumFractionDigits: 1 })} kg</ReadOnly>
      </ParamBlock>
      <ParamBlock label="Effective daily yield">
        <ReadOnly>{(effectiveYield * 100).toFixed(2)}%</ReadOnly>
      </ParamBlock>
      <ParamBlock label="Gummies / batch">
        <ReadOnly>
          {gummiesPerBatch.toLocaleString("en-US", { maximumFractionDigits: 0 })}
        </ReadOnly>
      </ParamBlock>
    </div>
  );
}

function ParamBlock({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div
        style={{
          fontSize: 10.5,
          fontWeight: 700,
          letterSpacing: "0.1em",
          textTransform: "uppercase",
          color: "var(--ink-3, #8a9498)",
          marginBottom: 4,
        }}
      >
        {label}
      </div>
      {children}
    </div>
  );
}

function ReadOnly({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        fontSize: 16,
        fontWeight: 700,
        color: "var(--teal-900, #0f4a56)",
        fontVariantNumeric: "tabular-nums",
      }}
    >
      {children}
    </div>
  );
}

// --- Cost tab ----------------------------------------------------------------

function CostTab({
  cost,
  gummyPieceWeightG,
  batchKg,
  batchesPerDay,
}: {
  cost: {
    dollarsPerGummy: number;
    effectiveDollarsPerGummy: number;
    dailyEffectiveYield: number;
    hasCompleteCosts: boolean;
  };
  gummyPieceWeightG: number;
  batchKg: number;
  batchesPerDay: number;
}) {
  const dailyGummies =
    gummyPieceWeightG > 0 ? (batchKg * batchesPerDay * 1000) / gummyPieceWeightG : 0;
  const dailyEffectiveCost = cost.effectiveDollarsPerGummy * dailyGummies;

  const [copying, setCopying] = useState(false);
  async function copyToClipboard(text: string) {
    setCopying(true);
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // clipboard blocked — quietly ignore, user can still read the number
    } finally {
      setTimeout(() => setCopying(false), 600);
    }
  }

  return (
    <div
      style={{
        marginBottom: 14,
        padding: 14,
        border: "1px solid var(--line, #e3dcc9)",
        borderRadius: 8,
        background: "var(--paper, #fffdf8)",
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
        gap: 14,
      }}
    >
      <ParamBlock label="$ / gummy (raw)">
        <ReadOnly>{usd.format(cost.dollarsPerGummy)}</ReadOnly>
      </ParamBlock>
      <ParamBlock label="$ / gummy (w/ daily loss)">
        <ReadOnly>{usd.format(cost.effectiveDollarsPerGummy)}</ReadOnly>
      </ParamBlock>
      <ParamBlock label="Daily material $">
        <ReadOnly>{usdShort.format(dailyEffectiveCost)}</ReadOnly>
      </ParamBlock>
      <ParamBlock label="Complete costs?">
        <ReadOnly>
          {cost.hasCompleteCosts ? (
            <span style={{ color: "var(--teal-700, #1d6c7b)" }}>Yes</span>
          ) : (
            <span style={{ color: "#8b2f2f" }}>Missing $/kg</span>
          )}
        </ReadOnly>
      </ParamBlock>
      <div style={{ gridColumn: "1 / -1", display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button
          type="button"
          onClick={() => copyToClipboard(cost.effectiveDollarsPerGummy.toFixed(4))}
          disabled={!cost.hasCompleteCosts}
          style={{
            padding: "8px 14px",
            background: "var(--sage-700, #5f8e3a)",
            color: "#fff",
            border: "1px solid var(--sage-700, #5f8e3a)",
            borderRadius: 6,
            fontSize: 12,
            fontWeight: 700,
            cursor: cost.hasCompleteCosts ? "pointer" : "not-allowed",
            opacity: cost.hasCompleteCosts ? 1 : 0.5,
          }}
        >
          {copying ? "Copied" : "Copy $/gummy for pricing"}
        </button>
        <div style={{ fontSize: 11, color: "var(--ink-3, #8a9498)", alignSelf: "center" }}>
          Paste into the Unit cost field on /pricing for this workflow&apos;s gummy
          line item.
        </div>
      </div>
    </div>
  );
}

// --- Ingredient table (shared across all three tabs) -------------------------

function IngredientTable({
  tab,
  ingredients,
  rawMaterials,
  benchGramById,
  scaleKgById,
  onUpdate,
  onAdd,
  onRemove,
  rmById,
  yieldPct,
  gummyPieceWeightG,
}: {
  tab: Tab;
  ingredients: GummyFormulaIngredient[];
  rawMaterials: RawMaterialOption[];
  benchGramById: Map<string, number>;
  scaleKgById: Map<string, number>;
  onUpdate: (id: string, patch: Partial<GummyFormulaIngredient>) => void;
  onAdd: () => void;
  onRemove: (id: string) => void;
  rmById: Map<string, RawMaterialOption>;
  yieldPct: number;
  gummyPieceWeightG: number;
}) {
  return (
    <div>
      <table
        style={{
          width: "100%",
          borderCollapse: "collapse",
          background: "var(--paper, #fffdf8)",
          border: "1px solid var(--line, #e3dcc9)",
          borderRadius: 8,
          overflow: "hidden",
          fontSize: 12.5,
        }}
      >
        <thead>
          <tr style={{ background: "var(--cream, #f6efe3)" }}>
            <ITh>Ingredient</ITh>
            <ITh style={{ textAlign: "right", width: 90 }}>%</ITh>
            {tab === "bench" ? <ITh style={{ textAlign: "right", width: 110 }}>Grams</ITh> : null}
            {tab === "scale" ? <ITh style={{ textAlign: "right", width: 110 }}>Kg / batch</ITh> : null}
            {tab === "cost" ? <ITh style={{ textAlign: "right", width: 110 }}>$ / kg</ITh> : null}
            {tab === "cost" ? <ITh style={{ textAlign: "right", width: 90 }}>Solids</ITh> : null}
            {tab === "cost" ? <ITh style={{ textAlign: "right", width: 110 }}>$ / gummy</ITh> : null}
            <ITh style={{ width: 44 }}></ITh>
          </tr>
        </thead>
        <tbody>
          {ingredients.map((row) => {
            const rm = row.rawMaterialId ? rmById.get(row.rawMaterialId) ?? null : null;
            const effCostPerKg =
              row.costPerKgOverride !== null
                ? row.costPerKgOverride
                : rm?.defaultCostPerKg ?? null;
            const effSolids =
              row.solidsOverride !== null && row.solidsOverride !== undefined
                ? row.solidsOverride
                : rm?.defaultSolids ?? 1;

            // Contribution: this row's $/gummy piece.
            let dollarsPerGummyLine = 0;
            if (effCostPerKg !== null) {
              const yFactor = Math.max(0.0001, yieldPct / 100);
              const dollarsPerGramBlend =
                (effCostPerKg / 1000) * (row.pctInFinished / 100) * effSolids / yFactor;
              dollarsPerGummyLine = dollarsPerGramBlend * gummyPieceWeightG;
            }

            return (
              <tr
                key={row.id}
                style={{ borderTop: "1px solid var(--line-2, #efe9da)" }}
              >
                <ITd>
                  <select
                    value={row.rawMaterialId ?? ""}
                    onChange={(e) =>
                      onUpdate(row.id, {
                        rawMaterialId: e.target.value || null,
                        // Wipe overrides when switching to a fresh raw material
                        // so defaults take effect. Rep can re-set overrides
                        // deliberately if they need to.
                        costPerKgOverride: null,
                        solidsOverride: null,
                      })
                    }
                    className="pricing__input"
                    style={{ width: "100%" }}
                  >
                    <option value="">— pick a raw material —</option>
                    {rawMaterials.map((rm) => (
                      <option key={rm.id} value={rm.id}>
                        {rm.fpCode ? `${rm.fpCode} · ` : ""}
                        {rm.name}
                      </option>
                    ))}
                  </select>
                </ITd>
                <ITd style={{ textAlign: "right" }}>
                  <NumberInput
                    value={row.pctInFinished}
                    onChange={(n) => onUpdate(row.id, { pctInFinished: n })}
                    step="0.01"
                    min={0}
                  />
                </ITd>
                {tab === "bench" ? (
                  <ITd style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                    {(benchGramById.get(row.id) ?? 0).toFixed(2)} g
                  </ITd>
                ) : null}
                {tab === "scale" ? (
                  <ITd style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                    {(scaleKgById.get(row.id) ?? 0).toFixed(3)} kg
                  </ITd>
                ) : null}
                {tab === "cost" ? (
                  <ITd style={{ textAlign: "right" }}>
                    <NumberInput
                      value={effCostPerKg ?? 0}
                      onChange={(n) =>
                        onUpdate(row.id, { costPerKgOverride: n === 0 ? null : n })
                      }
                      suffix="$"
                      step="0.01"
                      min={0}
                    />
                  </ITd>
                ) : null}
                {tab === "cost" ? (
                  <ITd style={{ textAlign: "right" }}>
                    <NumberInput
                      value={effSolids}
                      onChange={(n) => onUpdate(row.id, { solidsOverride: n })}
                      step="0.01"
                      min={0}
                    />
                  </ITd>
                ) : null}
                {tab === "cost" ? (
                  <ITd style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                    {effCostPerKg === null ? "—" : usd.format(dollarsPerGummyLine)}
                  </ITd>
                ) : null}
                <ITd>
                  <button
                    type="button"
                    onClick={() => onRemove(row.id)}
                    disabled={ingredients.length <= 1}
                    title="Remove row"
                    style={{
                      background: "transparent",
                      border: "none",
                      color: "var(--ink-3, #8a9498)",
                      cursor: ingredients.length <= 1 ? "not-allowed" : "pointer",
                      fontSize: 16,
                    }}
                  >
                    ×
                  </button>
                </ITd>
              </tr>
            );
          })}
        </tbody>
      </table>

      <div style={{ marginTop: 10 }}>
        <button
          type="button"
          onClick={onAdd}
          style={{
            padding: "8px 14px",
            background: "transparent",
            color: "var(--teal-900, #0f4a56)",
            border: "1px dashed var(--line, #e3dcc9)",
            borderRadius: 6,
            fontSize: 12.5,
            fontWeight: 700,
            cursor: "pointer",
          }}
        >
          + Add ingredient
        </button>
      </div>
    </div>
  );
}

function ITh({ children, style }: { children?: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <th
      style={{
        textAlign: "left",
        padding: "8px 10px",
        fontSize: 10.5,
        fontWeight: 700,
        letterSpacing: "0.1em",
        textTransform: "uppercase",
        color: "var(--ink-3, #8a9498)",
        borderBottom: "1.5px solid var(--teal-700, #1d6c7b)",
        ...style,
      }}
    >
      {children}
    </th>
  );
}
function ITd({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <td
      style={{
        padding: "6px 10px",
        verticalAlign: "middle",
        ...style,
      }}
    >
      {children}
    </td>
  );
}

// -----------------------------------------------------------------------------
// BlendSectionCard — one card per blend phase (Pre-cook / Secondary / Final).
// Contains the phase's ingredient table (ingredient picker + grams + cost),
// a subtotal row, and its own "+ Add ingredient" button. Independent from
// the other phases' cards.
// -----------------------------------------------------------------------------
function BlendSectionCard({
  phase,
  rows,
  rawMaterials,
  rmById,
  savedSolutions,
  onUpdate,
  onAddRow,
  onAddSolution,
  onAddSavedSolution,
  onSaveSolutionToLibrary,
  onRemoveRow,
  onReorderRow,
  processNote,
  defaultProcessNote,
  onProcessNoteChange,
  cookingProcessNote,
  defaultCookingProcessNote,
  onCookingProcessNoteChange,
  finalRows,
  onAddFinalRow,
  onAddFinalSolution,
  onAddSavedFinalSolution,
  finalProcessNote,
  defaultFinalProcessNote,
  onFinalProcessNoteChange,
  carryOverRows,
  carryOverUnit,
  benchBatchG,
  sectionUnitValue,
  onSectionUnitChange,
  labelClaims,
  gummyPieceWeightG,
  wetCastPieceWeightG,
}: {
  phase: BlendPhase;
  rows: GummyFormulaIngredient[];
  rawMaterials: RawMaterialOption[];
  rmById: Map<string, RawMaterialOption>;
  savedSolutions: SavedSolution[];
  onUpdate: (id: string, patch: Partial<GummyFormulaIngredient>) => void;
  onAddRow: () => void;
  onAddSolution: () => void;
  onAddSavedSolution: (s: SavedSolution) => void;
  onSaveSolutionToLibrary: (
    row: GummyFormulaIngredient,
  ) => Promise<{ ok: true; solution: SavedSolution } | { ok: false; error: string }>;
  onRemoveRow: (id: string) => void;
  /** Drag-and-drop reorder. Fired when the operator drops one row (fromId)
   *  onto another (toId) in ANY subsection of this card — including the
   *  Primary Blend Carry Over subsection, which reorders the same
   *  pre-cook rows that the pre-cook card renders. Rows in different
   *  phases can't be cross-dropped; the parent handler ignores the call
   *  in that case. */
  onReorderRow: (fromId: string, toId: string) => void;
  processNote: string;
  /** Canonical default text for this phase. Used to detect whether the
   *  current process note is unmodified (banner + Reset link) and as the
   *  target when Reset is clicked. */
  defaultProcessNote: string;
  onProcessNoteChange: (text: string) => void;
  /** Cooked-only: top-level "Cooking" Process notes block rendered right
   *  under the card header, above the Secondary and Final subsections.
   *  Independent default/reset/edit state from the two subsections. */
  cookingProcessNote?: string;
  defaultCookingProcessNote?: string;
  onCookingProcessNoteChange?: (text: string) => void;
  /** Cooked-only: rows/handlers for the Final Blend subsection that lives
   *  inside the same card, right under Secondary Blend. Optional so the
   *  pre-cook card doesn't need to pass them. */
  finalRows?: GummyFormulaIngredient[];
  onAddFinalRow?: () => void;
  onAddFinalSolution?: () => void;
  onAddSavedFinalSolution?: (s: SavedSolution) => void;
  /** Cooked-only: Process notes for the Final Blend subsection. When the
   *  cooked card renders, Secondary Blend and Final Blend each get their
   *  own Process notes block with independent default/reset/edit state. */
  finalProcessNote?: string;
  defaultFinalProcessNote?: string;
  onFinalProcessNoteChange?: (text: string) => void;
  /** Cooked-only: read-only display of the pre-cook blend's ingredient
   *  rows so the cook operator can see what's carrying into the pot.
   *  Rendered as a subsection at the very top of the cooked card, above
   *  the "Cooking" process notes and the Secondary/Final subsections.
   *  Optional — when undefined or empty, the subsection is not rendered. */
  carryOverRows?: GummyFormulaIngredient[];
  /** Cooked-only: unit to render the carry-over subsection in. When
   *  provided, the Primary Blend Carry Over rows display in this unit
   *  instead of the cooked card's own sectionUnit — so operators can see
   *  the same unit as the Pre-cook card. Falls back to the effective
   *  section unit when undefined. */
  carryOverUnit?: LabelClaimUnit;
  /** Cooked-only: bench-top batch size in grams, used to auto-compute
   *  the moisture-loss % on water rows in the Primary Blend Carry Over
   *  subsection so the recipe balances (Primary net + Secondary + Final
   *  = benchBatchG). Optional so the pre-cook card doesn't need it. */
  benchBatchG?: number;
  /** When provided, makes the section unit controlled by the parent
   *  (used for the pre-cook card so the Cooked card's carry-over
   *  subsection can mirror it). When undefined, the card manages its
   *  own local sectionUnit state. */
  sectionUnitValue?: LabelClaimUnit;
  onSectionUnitChange?: (u: LabelClaimUnit) => void;
  /** Cooked-only: current label claims for the version. Passed through
   *  so the Secondary Blend subsection can look up the claim for a
   *  claim-sourced row and drive the Overage % column's grams
   *  recomputation. Undefined for cards that don't need it (pre-cook). */
  labelClaims?: LabelClaim[];
  /** Cooked-only: finished (dried) per-gummy piece weight in grams. Used
   *  as the fallback when wetCastPieceWeightG is missing / <= 0. Paired
   *  with benchBatchG + a label claim's amount inside
   *  claimBaseGramsForBench. */
  gummyPieceWeightG?: number;
  /** Cooked-only: wet cast per-gummy piece weight in grams. Primary input
   *  to claimBaseGramsForBench — the bench batch is measured wet, so
   *  pieces-per-batch = benchBatchG / wetCastPieceWeightG. Active mass
   *  survives drying so the per-piece claim amount stays the same. Falls
   *  back to gummyPieceWeightG inside the helper when undefined / <= 0. */
  wetCastPieceWeightG?: number;
}) {
  // Solution menu: "+ Add solution ▾" opens a popover with "Empty" +
  // every saved-library entry.
  const [solutionMenuOpen, setSolutionMenuOpen] = useState(false);
  // Independent menu state for the Final Blend subsection so opening
  // that one doesn't close/toggle the Secondary Blend one.
  const [finalSolutionMenuOpen, setFinalSolutionMenuOpen] = useState(false);
  // Process text starts read-only. The rep has to click Edit to modify it,
  // which prevents accidental changes and makes edits deliberate. Each
  // subsection (Secondary + Final on cooked) has its own edit-mode toggle so
  // toggling one doesn't affect the other.
  const [processEditing, setProcessEditing] = useState(false);
  const [finalProcessEditing, setFinalProcessEditing] = useState(false);
  // Top-level "Cooking" Process notes edit toggle (cooked card only). Kept
  // independent of the Secondary/Final subsection toggles so opening one
  // doesn't affect the others.
  const [cookingProcessEditing, setCookingProcessEditing] = useState(false);
  const label = BLEND_PHASE_LABELS[phase];
  const hint = BLEND_PHASE_HINTS[phase];
  // Number of decimal places to show in this section's Total row. Kept
  // per-section so pre-cook can show 3 dp while other sections stay at 2
  // (or vice versa). 0..4 covered by the inline picker.
  const [totalDecimals, setTotalDecimals] = useState<number>(3);
  // Independent decimal-places picker for the Primary Blend Carry Over
  // subsection on the cooked card. Kept separate from `totalDecimals` so
  // the operator can dial in a different precision on the carry-over
  // display vs. the Secondary/Final totals below it. 0..4 range, default 2.
  const [carryOverDecimals, setCarryOverDecimals] = useState<number>(2);
  // Section-level unit picker — mirrors the mcg/mg/g options on Label
  // claims. Every ingredient row + total is displayed and entered in the
  // selected unit; internally the values are still stored as grams so
  // percentages, scale-up, and cost math don't have to know about the
  // display unit. Default "g" for the bench-scale author.
  const [sectionUnit, setSectionUnit] = useState<LabelClaimUnit>("g");
  // Drag-and-drop reorder state — shared across every subsection in this
  // card (Primary/Secondary/Final/Carry Over) so a drop into any table
  // triggers the same reorder handler on the parent. `draggingId` styles
  // the source row (opacity 0.4) so the operator can see what's picked
  // up; `dropTargetId` styles the hover-over row with a bold top border
  // as a drop-hint. Both are cleared on drop or dragEnd.
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);
  const unitFactor: Record<LabelClaimUnit, number> = {
    g: 1,
    mg: 1000,
    mcg: 1_000_000,
  };
  // When the parent controls the section unit (pre-cook card), use its
  // value/setter; otherwise fall back to local state. This lets the
  // Cooked card mirror the Pre-cook card's unit in the carry-over
  // subsection while keeping its own Secondary/Final subsections on
  // their own local unit.
  const effectiveSectionUnit: LabelClaimUnit = sectionUnitValue ?? sectionUnit;
  const effectiveSetSectionUnit: (u: LabelClaimUnit) => void =
    onSectionUnitChange ?? setSectionUnit;
  const factor = unitFactor[effectiveSectionUnit];
  // Carry-over subsection unit — parent (FormulaEditor) passes the
  // pre-cook card's unit so this card's Primary Blend Carry Over rows
  // display in the same unit as the Pre-cook card. Falls back to the
  // effective section unit when not provided.
  const carryOverEffectiveUnit: LabelClaimUnit =
    carryOverUnit ?? effectiveSectionUnit;
  const carryOverFactor = unitFactor[carryOverEffectiveUnit];
  const carryOverUnitLabel =
    carryOverEffectiveUnit === "g"
      ? "Grams"
      : carryOverEffectiveUnit === "mg"
        ? "Milligrams"
        : "Micrograms";

  // Shared grand-total-cooked-blend math — used by the new "% of finished
  // product" column that appears in every subsection of the cooked card
  // (Primary Blend Carry Over, Secondary Blend, Final Blend). Each row's
  // percentage is (row grams / grandTotalCookedBlendG) * 100. Guarded by
  // phase === "cooked" so the pre-cook card's rendering stays unchanged.
  const secondaryTotalG =
    phase === "cooked"
      ? rows.reduce((s, r) => s + (Number(r.grams) || 0), 0)
      : 0;
  const finalTotalG =
    phase === "cooked"
      ? (finalRows ?? []).reduce((s, r) => s + (Number(r.grams) || 0), 0)
      : 0;
  const primaryNetTotalG =
    phase === "cooked" && carryOverRows && carryOverRows.length > 0
      ? computeCarryOverPrimaryNetG({
          preCookRows: carryOverRows,
          benchBatchG: benchBatchG ?? 0,
          secondaryG: secondaryTotalG,
          finalG: finalTotalG,
        })
      : 0;
  const grandTotalCookedBlendG =
    primaryNetTotalG + secondaryTotalG + finalTotalG;
  // Formatter for the "% of finished product" cell — mirrors the pctOfBench
  // pattern (2 dp, drop trailing .00 so 12.00% renders as 12%). Returns
  // "0%" when the base is 0 to avoid divide-by-zero.
  const formatPctOfFinished = (grams: number): string => {
    if (grandTotalCookedBlendG <= 0) return "0";
    const pct = (grams / grandTotalCookedBlendG) * 100;
    const s = pct.toFixed(2);
    return s.endsWith(".00") ? s.slice(0, -3) : s;
  };
  // Formatter for the "Residual Moisture %" column — takes the residual
  // pct directly (already multiplied through waterFraction × pctOfFinished)
  // and mirrors the ".00" trim pattern used by formatPctOfFinished. Used
  // by both the carry-over subsection and renderIngredientsBlock below so
  // every subsection's residual cell formats identically.
  const formatResidualPct = (residualPct: number): string => {
    const s = residualPct.toFixed(2);
    return s.endsWith(".00") ? s.slice(0, -3) : s;
  };

  // Drag-and-drop wiring for a single blend row. Returns the set of
  // <tr>-level HTML5 DnD props plus a JSX drag-handle to render inside
  // the row's first cell. The handle sits as an absolutely-positioned
  // ⋮⋮ glyph at the far left of the ingredient/name cell with a small
  // negative margin so it doesn't shift the column widths — every
  // subsection in this card uses different colspans (pre-cook 3 cols,
  // cooked 4/5 cols, carry-over 6 cols) so adding a real column would
  // have required editing every thead + total row. Absolute-positioning
  // sidesteps that entirely.
  //
  // The tr keeps `draggable` on the row (native HTML5 DnD is happy with
  // inputs inside a draggable tr — text-selection + typing still works
  // in Chrome), and the handle itself is also draggable so the row is
  // easy to grab even when the operator's cursor is over an input.
  const rowDndBaseStyle = (rowId: string): React.CSSProperties => ({
    opacity: draggingId === rowId ? 0.4 : 1,
    borderTop:
      dropTargetId === rowId
        ? "2px solid var(--teal-700, #1d6c7b)"
        : undefined,
  });
  const rowDndTrProps = (rowId: string) => ({
    draggable: true,
    onDragStart: (e: React.DragEvent<HTMLTableRowElement>) => {
      e.dataTransfer.setData("text/plain", rowId);
      e.dataTransfer.effectAllowed = "move";
      setDraggingId(rowId);
    },
    onDragOver: (e: React.DragEvent<HTMLTableRowElement>) => {
      // Prevent-default is what tells the browser this is a valid drop
      // target. Without it, onDrop never fires.
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      if (dropTargetId !== rowId) setDropTargetId(rowId);
    },
    onDragLeave: (e: React.DragEvent<HTMLTableRowElement>) => {
      // Only clear the drop hint when the pointer actually leaves this
      // row (not just moves to a child element). relatedTarget is the
      // element the pointer entered — if it's still inside currentTarget,
      // we're just moving between cells.
      const next = e.relatedTarget as Node | null;
      if (next && e.currentTarget.contains(next)) return;
      if (dropTargetId === rowId) setDropTargetId(null);
    },
    onDrop: (e: React.DragEvent<HTMLTableRowElement>) => {
      e.preventDefault();
      const fromId = e.dataTransfer.getData("text/plain");
      setDraggingId(null);
      setDropTargetId(null);
      if (fromId && fromId !== rowId) onReorderRow(fromId, rowId);
    },
    onDragEnd: () => {
      setDraggingId(null);
      setDropTargetId(null);
    },
  });
  // Small ⋮⋮ handle rendered inside the first cell of every blend row.
  // Absolute-positioned so it sits in the gutter without a real column;
  // mirrors the delete-× opacity-on-hover pattern below.
  const renderDragHandle = (rowId: string, hover: boolean) => (
    <span
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData("text/plain", rowId);
        e.dataTransfer.effectAllowed = "move";
        setDraggingId(rowId);
      }}
      onDragEnd={() => {
        setDraggingId(null);
        setDropTargetId(null);
      }}
      title="Drag to reorder"
      aria-label="Drag to reorder"
      style={{
        position: "absolute",
        left: -4,
        top: "50%",
        transform: "translateY(-50%)",
        fontSize: 13,
        lineHeight: 1,
        color: "var(--ink-3, #8a9498)",
        cursor: "grab",
        userSelect: "none",
        // Match the delete-× opacity ramp so the affordance only fully
        // reveals on row hover, keeping the resting state clean.
        opacity: hover || draggingId === rowId ? 0.9 : 0.25,
        transition: "opacity 80ms ease",
      }}
    >
      ⋮⋮
    </span>
  );

  return (
    <section
      style={{
        marginBottom: 14,
        border: "1px solid var(--line, #e3dcc9)",
        borderRadius: 8,
        background: "var(--paper, #fffdf8)",
        // overflow: visible so the ingredient-picker's absolute-positioned
        // results dropdown can extend below the section boundary. The
        // header's border-radius is handled per-corner instead of relying
        // on the parent's overflow clip.
        overflow: "visible",
      }}
    >
      {/* Card header — cream band across the top of the card with a
          teal divider underneath. The bold title reads as the card's
          identity without introducing a floating tab shape. */}
      <header
        style={{
          padding: "14px 18px 12px",
          background: "var(--cream, #f6efe3)",
          borderBottom: "2px solid var(--teal-700, #1d6c7b)",
          borderTopLeftRadius: 8,
          borderTopRightRadius: 8,
        }}
      >
        <div
          style={{
            fontSize: 20,
            fontWeight: 800,
            color: "var(--teal-900, #0f4a56)",
            letterSpacing: "-0.01em",
            lineHeight: 1.15,
          }}
        >
          {label}
        </div>
        <div
          style={{
            fontSize: 12,
            color: "var(--ink-3, #8a9498)",
            marginTop: 4,
          }}
        >
          {hint}
        </div>
      </header>

      {/* Cooked-only: Primary Blend Carry Over — read-only display of
          every ingredient row from the pre-cook blend so the cook
          operator can see what's carrying into the pot. Rendered
          BEFORE the Cooking notes and the Secondary/Final subsections.
          No inputs, no add/delete buttons — just names + amounts scaled
          to the Pre-cook card's current unit (carryOverEffectiveUnit).
          The unit follows the Pre-cook card's picker so operators see
          amounts in the same unit they authored the pre-cook blend in. */}
      {phase === "cooked" && carryOverRows && carryOverRows.length > 0 ? (() => {
        // Water rows in the carry-over auto-balance: their moisture-loss
        // % is computed so Primary (net) + Secondary + Final = benchBatchG.
        // Compute once here and reuse for both the water row display and
        // the total. Non-water rows use the per-row explicit
        // moistureLossPct OR carryOverDefaultMoisturePct as a fallback.
        // Reuses the shared secondaryTotalG/finalTotalG (computed above the
        // return) so the water auto-balance and the "% of finished product"
        // column agree by construction.
        const waterPct = computeCarryOverWaterPct({
          preCookRows: carryOverRows,
          benchBatchG: benchBatchG ?? 0,
          secondaryG: secondaryTotalG,
          finalG: finalTotalG,
        });
        // Per-row moisture-loss fraction, clamped to [0, 1]. Water rows
        // always use the auto waterPct — any stored moistureLossPct on a
        // water row is ignored so the balance rule is inviolable. Every
        // other row falls back to its default (see carryOverDefaultMoisturePct
        // at module scope) when moistureLossPct is null/NaN.
        const lossFracFor = (r: GummyFormulaIngredient): number => {
          if (isWaterRow(r)) return waterPct / 100;
          const raw = Number(r.moistureLossPct);
          const pct = Number.isFinite(raw)
            ? raw
            : carryOverDefaultMoisturePct(r);
          if (pct <= 0) return 0;
          if (pct >= 100) return 1;
          return pct / 100;
        };
        // For the input's displayed value — water rows show the auto
        // waterPct; other rows show the explicit value the user typed,
        // otherwise the ingredient's default.
        const moisturePctFor = (r: GummyFormulaIngredient): number => {
          if (isWaterRow(r)) return waterPct;
          const raw = Number(r.moistureLossPct);
          return Number.isFinite(raw) ? raw : carryOverDefaultMoisturePct(r);
        };
        // Sum of NET grams (post-moisture-loss) across every carry-over
        // row — this is what the operator actually sees carrying into
        // the pot after the water boils off. Reuses the shared
        // primaryNetTotalG (computed above the return) so it stays
        // perfectly in sync with the Bench Top card's Primary Blend
        // total and the "% of finished product" column below.
        const totalNetGrams = primaryNetTotalG;
        // Sum of Residual Moisture % across every carry-over row —
        // matches per-row computation exactly (waterFraction × NET
        // grams / grandTotal * 100) so the total ties out with the
        // column above by construction.
        // SOLUTION rows in Primary Blend Carry Over do NOT contribute
        // residual (only Final Blend does). Water ingredient rows and
        // other non-solution rows continue to contribute via
        // waterFractionFor.
        const totalResidualPct = carryOverRows.reduce((s, r) => {
          if (isSolutionRow(r)) return s;
          const wf = waterFractionFor(r);
          if (wf === 0) return s;
          const netG = (Number(r.grams) || 0) * (1 - lossFracFor(r));
          const pctOfFinished =
            grandTotalCookedBlendG > 0
              ? (netG / grandTotalCookedBlendG) * 100
              : 0;
          return s + wf * pctOfFinished;
        }, 0);
        return (
          <>
            {/* Subheading — mirrors the "Secondary Blend" / "Final Blend"
                subheading styling from renderIngredientsBlock. */}
            <div
              style={{
                padding: "10px 14px 4px",
                borderTop: "1px solid var(--line-2, #efe9da)",
                fontSize: 13,
                fontWeight: 700,
                color: "var(--teal-900, #0f4a56)",
                letterSpacing: "-0.005em",
              }}
            >
              Primary Blend Carry Over
            </div>
            <div
              style={{
                padding: "0 14px 8px",
                fontSize: 11,
                color: "var(--ink-3, #8a9498)",
              }}
            >
              From the pre-cook blend — carried over into the pot.
            </div>
            <table
              style={{
                width: "100%",
                borderCollapse: "collapse",
                fontSize: 12.5,
                tableLayout: "fixed",
              }}
            >
              <thead>
                <tr style={{ background: "var(--cream-soft, #fbf6ec)" }}>
                  <BTh>Ingredient</BTh>
                  {/* Moisture Loss — per-row percentage of the ingredient's
                      mass expected to boil off during cooking. Sits BEFORE
                      the grams column so the reduced grams (grams × (1 −
                      pct/100)) is what's shown in the next cell over. */}
                  <BTh style={{ textAlign: "right", width: 110 }}>
                    Moisture Loss
                  </BTh>
                  {/* Read-only label — the unit is driven by the Pre-cook
                      card's picker, so this header shows the spelled-out
                      unit but isn't interactive from here. */}
                  <BTh style={{ textAlign: "right", width: 120 }}>
                    {carryOverUnitLabel}
                  </BTh>
                  {/* % of finished product — each row's NET grams as a
                      share of the Grand Total Cooked Blend. Sits BETWEEN
                      the grams column and the chevron/delete column. */}
                  <BTh style={{ textAlign: "right", width: 120 }}>
                    % of finished product
                  </BTh>
                  {/* Residual Moisture % — the water contribution of each
                      row, expressed as a share of the Grand Total Cooked
                      Blend (waterFraction × % of finished product). Blank
                      for rows with no water. */}
                  <BTh style={{ textAlign: "right", width: 120 }}>
                    Residual Moisture %
                  </BTh>
                  <BTh style={{ width: 40 }} />
                </tr>
              </thead>
              <tbody>
                {carryOverRows.map((row) => {
                  // Drag-and-drop wiring — mirrors the primary/secondary/
                  // final subsections below. Reordering a Primary Blend
                  // Carry Over row rewrites the same underlying pre-cook
                  // rows the Pre-cook card renders, since both point at
                  // the same phase="pre-cook" slice of ingredients.
                  const rowDnd = {
                    trProps: rowDndTrProps(row.id),
                    trStyle: rowDndBaseStyle(row.id),
                    renderHandle: (hover: boolean) =>
                      renderDragHandle(row.id, hover),
                  };
                  // Solutions: show the solution's custom name with a small
                  // SOLUTION label — no component expansion here since this
                  // is a read-only carry-over view.
                  if (isSolutionRow(row)) {
                    const solLossFrac = lossFracFor(row);
                    const solNetGrams = (Number(row.grams) || 0) * (1 - solLossFrac);
                    // Show the explicit value the user set, or the
                    // ingredient's default (see moisturePctFor above).
                    const solMoisturePctValue = moisturePctFor(row);
                    // Solutions can technically be a Water "solution" (rare
                    // but possible via customName), so mirror the same
                    // auto-water treatment as the ingredient rows below.
                    const solIsWater = isWaterRow(row);
                    return (
                      <tr
                        key={row.id}
                        style={{
                          borderBottom: "1px solid var(--line-2, #efe9da)",
                          transition: "opacity 80ms ease",
                          ...rowDnd.trStyle,
                        }}
                        {...rowDnd.trProps}
                      >
                        <BTd style={{ position: "relative" }}>
                          {rowDnd.renderHandle(false)}
                          <div style={{ fontWeight: 700, color: "var(--ink, #1f2a2d)" }}>
                            {row.customName || "Solution"}
                          </div>
                          <div
                            style={{
                              fontSize: 10,
                              fontWeight: 700,
                              letterSpacing: "0.1em",
                              textTransform: "uppercase",
                              color: "var(--ink-3, #8a9498)",
                              marginTop: 2,
                            }}
                          >
                            Solution
                          </div>
                        </BTd>
                        <BTd
                          style={{
                            textAlign: "right",
                            fontVariantNumeric: "tabular-nums",
                            whiteSpace: "nowrap",
                          }}
                        >
                          <div
                            style={{
                              display: "inline-flex",
                              alignItems: "center",
                              gap: 4,
                            }}
                          >
                            <input
                              type="number"
                              min={0}
                              max={100}
                              step="0.1"
                              value={
                                solIsWater
                                  ? Number(solMoisturePctValue.toFixed(2))
                                  : solMoisturePctValue
                              }
                              disabled={solIsWater}
                              title={
                                solIsWater
                                  ? "Auto-calculated so the recipe balances to bench top batch"
                                  : undefined
                              }
                              onFocus={(e) => {
                                // Chrome's <input type="number"> doesn't select
                                // on focus synchronously — defer one frame so the
                                // digits are highlighted and any keystroke
                                // replaces the value instead of prepending to it.
                                const el = e.currentTarget;
                                setTimeout(() => {
                                  try { el.select(); } catch {}
                                }, 0);
                              }}
                              onChange={
                                solIsWater
                                  ? undefined
                                  : (e) => {
                                      const n = Number(e.target.value);
                                      const clamped = !Number.isFinite(n)
                                        ? 0
                                        : Math.max(0, Math.min(100, n));
                                      onUpdate(row.id, {
                                        moistureLossPct: clamped,
                                      });
                                    }
                              }
                              className="pricing__input"
                              style={{
                                width: 60,
                                // Override .pricing__input's `flex: 1` so the
                                // 60px width sticks inside the inline-flex
                                // parent (same pattern as the grams input in
                                // the primary blend tables).
                                flex: "0 0 60px",
                                textAlign: "right",
                                fontVariantNumeric: "tabular-nums",
                                // Muted color hints that the value is
                                // auto-calculated, not user-editable.
                                ...(solIsWater
                                  ? { color: "var(--ink-3, #8a9498)" }
                                  : null),
                              }}
                            />
                            <span
                              style={{
                                fontSize: 12,
                                color: "var(--ink-3, #8a9498)",
                              }}
                            >
                              %
                            </span>
                          </div>
                        </BTd>
                        <BTd
                          style={{
                            textAlign: "right",
                            fontVariantNumeric: "tabular-nums",
                            whiteSpace: "nowrap",
                          }}
                        >
                          <span>
                            {(solNetGrams * carryOverFactor).toFixed(carryOverDecimals)}
                          </span>{" "}
                          <span
                            style={{
                              fontSize: 12,
                              color: "var(--ink-3, #8a9498)",
                            }}
                          >
                            {carryOverEffectiveUnit}
                          </span>
                        </BTd>
                        {/* % of finished product — solution's NET grams
                            as a share of the Grand Total Cooked Blend. */}
                        <BTd
                          style={{
                            textAlign: "right",
                            fontVariantNumeric: "tabular-nums",
                            whiteSpace: "nowrap",
                          }}
                        >
                          <span>{formatPctOfFinished(solNetGrams)}</span>
                          <span
                            style={{
                              fontSize: 12,
                              color: "var(--ink-3, #8a9498)",
                            }}
                          >
                            %
                          </span>
                        </BTd>
                        {/* Residual Moisture % — solutions in Primary Blend
                            Carry Over do NOT contribute residual (only
                            Final Blend does). Render a blank cell so the
                            column width holds; the total row sums only
                            non-solution rows below. */}
                        <BTd
                          style={{
                            textAlign: "right",
                            fontVariantNumeric: "tabular-nums",
                            whiteSpace: "nowrap",
                          }}
                        />
                        <BTd />
                      </tr>
                    );
                  }
                  // Non-solution rows: resolve display name in the order
                  // customName → curated → Fishbowl fp_code → fallback.
                  const resolved =
                    (row.rawMaterialId && rmById.get(row.rawMaterialId)) ||
                    (row.rawMaterialFpCode
                      ? rawMaterials.find(
                          (r) =>
                            (r.fpCode ?? "").toUpperCase() ===
                            (row.rawMaterialFpCode ?? "").toUpperCase(),
                        ) ?? null
                      : null);
                  let displayName: string;
                  if (row.customName) {
                    displayName = row.customName;
                  } else if (resolved) {
                    displayName = resolved.fpCode
                      ? `${resolved.fpCode} · ${resolved.name}`
                      : resolved.name;
                  } else if (row.rawMaterialFpCode) {
                    displayName = row.rawMaterialFpCode;
                  } else {
                    displayName = "Unnamed";
                  }
                  const rowLossFrac = lossFracFor(row);
                  const rowNetGrams = (Number(row.grams) || 0) * (1 - rowLossFrac);
                  // Show the explicit value the user set, or the
                  // ingredient's default (see moisturePctFor above).
                  const rowMoisturePctValue = moisturePctFor(row);
                  // Water rows are auto-computed so the recipe balances
                  // (see computeCarryOverWaterPct). The input is disabled
                  // and shows the calculated value; any stored
                  // moistureLossPct is ignored.
                  const rowIsWater = isWaterRow(row);
                  return (
                    <tr
                      key={row.id}
                      style={{
                        borderBottom: "1px solid var(--line-2, #efe9da)",
                        transition: "opacity 80ms ease",
                        ...rowDnd.trStyle,
                      }}
                      {...rowDnd.trProps}
                    >
                      <BTd style={{ position: "relative" }}>
                        {rowDnd.renderHandle(false)}
                        <div style={{ fontWeight: 600, color: "var(--ink, #1f2a2d)" }}>
                          {displayName}
                        </div>
                        {resolved?.category ? (
                          <div
                            style={{
                              fontSize: 10.5,
                              color: "var(--ink-3, #8a9498)",
                              marginTop: 2,
                              textTransform: "capitalize",
                            }}
                          >
                            {resolved.category} blend material
                          </div>
                        ) : null}
                      </BTd>
                      <BTd
                        style={{
                          textAlign: "right",
                          fontVariantNumeric: "tabular-nums",
                          whiteSpace: "nowrap",
                        }}
                      >
                        <div
                          style={{
                            display: "inline-flex",
                            alignItems: "center",
                            gap: 4,
                          }}
                        >
                          <input
                            type="number"
                            min={0}
                            max={100}
                            step="0.1"
                            value={
                              rowIsWater
                                ? Number(rowMoisturePctValue.toFixed(2))
                                : rowMoisturePctValue
                            }
                            disabled={rowIsWater}
                            title={
                              rowIsWater
                                ? "Auto-calculated so the recipe balances to bench top batch"
                                : undefined
                            }
                            onFocus={(e) => {
                              // Chrome's <input type="number"> doesn't select
                              // on focus synchronously — defer one frame so
                              // the digits are highlighted and any keystroke
                              // replaces the value instead of prepending to it.
                              const el = e.currentTarget;
                              setTimeout(() => {
                                try { el.select(); } catch {}
                              }, 0);
                            }}
                            onChange={
                              rowIsWater
                                ? undefined
                                : (e) => {
                                    const n = Number(e.target.value);
                                    const clamped = !Number.isFinite(n)
                                      ? 0
                                      : Math.max(0, Math.min(100, n));
                                    onUpdate(row.id, {
                                      moistureLossPct: clamped,
                                    });
                                  }
                            }
                            className="pricing__input"
                            style={{
                              width: 60,
                              // Override .pricing__input's `flex: 1` so the
                              // 60px width sticks inside the inline-flex parent.
                              flex: "0 0 60px",
                              textAlign: "right",
                              fontVariantNumeric: "tabular-nums",
                              // Muted color hints that the value is
                              // auto-calculated, not user-editable.
                              ...(rowIsWater
                                ? { color: "var(--ink-3, #8a9498)" }
                                : null),
                            }}
                          />
                          <span
                            style={{
                              fontSize: 12,
                              color: "var(--ink-3, #8a9498)",
                            }}
                          >
                            %
                          </span>
                        </div>
                      </BTd>
                      <BTd
                        style={{
                          textAlign: "right",
                          fontVariantNumeric: "tabular-nums",
                          whiteSpace: "nowrap",
                        }}
                      >
                        <span>
                          {(rowNetGrams * carryOverFactor).toFixed(carryOverDecimals)}
                        </span>{" "}
                        <span
                          style={{
                            fontSize: 12,
                            color: "var(--ink-3, #8a9498)",
                          }}
                        >
                          {carryOverEffectiveUnit}
                        </span>
                      </BTd>
                      {/* % of finished product — this row's NET grams
                          as a share of the Grand Total Cooked Blend. */}
                      <BTd
                        style={{
                          textAlign: "right",
                          fontVariantNumeric: "tabular-nums",
                          whiteSpace: "nowrap",
                        }}
                      >
                        <span>{formatPctOfFinished(rowNetGrams)}</span>
                        <span
                          style={{
                            fontSize: 12,
                            color: "var(--ink-3, #8a9498)",
                          }}
                        >
                          %
                        </span>
                      </BTd>
                      {/* Residual Moisture % — waterFraction × % of
                          finished. Non-water ingredients render blank. */}
                      {(() => {
                        const rowWaterFrac = waterFractionFor(row);
                        if (rowWaterFrac === 0) {
                          return (
                            <BTd
                              style={{
                                textAlign: "right",
                                fontVariantNumeric: "tabular-nums",
                                whiteSpace: "nowrap",
                              }}
                            />
                          );
                        }
                        const rowPctOfFinished =
                          grandTotalCookedBlendG > 0
                            ? (rowNetGrams / grandTotalCookedBlendG) * 100
                            : 0;
                        const rowResidual = rowWaterFrac * rowPctOfFinished;
                        return (
                          <BTd
                            style={{
                              textAlign: "right",
                              fontVariantNumeric: "tabular-nums",
                              whiteSpace: "nowrap",
                            }}
                          >
                            <span>{formatResidualPct(rowResidual)}</span>
                            <span
                              style={{
                                fontSize: 12,
                                color: "var(--ink-3, #8a9498)",
                              }}
                            >
                              %
                            </span>
                          </BTd>
                        );
                      })()}
                      <BTd />
                    </tr>
                  );
                })}
                {/* Read-only total row — same visual treatment as the
                    Tot rows in renderIngredientsBlock, but without the
                    decimal-chevron controls (this is display-only, so
                    the operator's precision preference on the primary
                    subsection isn't relevant here). */}
                <tr
                  style={{
                    borderTop: "1.5px solid var(--teal-700, #1d6c7b)",
                    background: "var(--cream-soft, #fbf6ec)",
                  }}
                >
                  <BTd>
                    <strong
                      style={{
                        fontSize: 11,
                        fontWeight: 700,
                        letterSpacing: "0.1em",
                        textTransform: "uppercase",
                        color: "var(--teal-900, #0f4a56)",
                      }}
                    >
                      Tot primary blend carry over
                    </strong>
                  </BTd>
                  {/* Total-row moisture-loss placeholder — no aggregate
                      percentage makes sense here (each row has its own
                      loss), so just show a small em-dash. */}
                  <BTd
                    style={{
                      textAlign: "right",
                      color: "var(--ink-3, #8a9498)",
                      fontWeight: 400,
                    }}
                  >
                    —
                  </BTd>
                  <BTd
                    style={{
                      textAlign: "right",
                      fontVariantNumeric: "tabular-nums",
                      fontWeight: 700,
                      color: "var(--teal-900, #0f4a56)",
                      whiteSpace: "nowrap",
                    }}
                  >
                    <span
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 4,
                      }}
                    >
                      <span>{(totalNetGrams * carryOverFactor).toFixed(carryOverDecimals)}</span>
                      <span
                        style={{
                          color: "var(--ink-3, #8a9498)",
                          fontWeight: 400,
                        }}
                      >
                        {carryOverEffectiveUnit}
                      </span>
                    </span>
                  </BTd>
                  {/* % of finished product — Primary Blend Carry Over's
                      NET total as a share of the Grand Total Cooked Blend. */}
                  <BTd
                    style={{
                      textAlign: "right",
                      fontVariantNumeric: "tabular-nums",
                      fontWeight: 700,
                      color: "var(--teal-900, #0f4a56)",
                      whiteSpace: "nowrap",
                    }}
                  >
                    <span>{formatPctOfFinished(totalNetGrams)}</span>
                    <span
                      style={{
                        color: "var(--ink-3, #8a9498)",
                        fontWeight: 400,
                      }}
                    >
                      %
                    </span>
                  </BTd>
                  {/* Residual Moisture % — Primary Blend Carry Over's
                      total water contribution as a share of the Grand
                      Total Cooked Blend. */}
                  <BTd
                    style={{
                      textAlign: "right",
                      fontVariantNumeric: "tabular-nums",
                      fontWeight: 700,
                      color: "var(--teal-900, #0f4a56)",
                      whiteSpace: "nowrap",
                    }}
                  >
                    <span>{formatResidualPct(totalResidualPct)}</span>
                    <span
                      style={{
                        color: "var(--ink-3, #8a9498)",
                        fontWeight: 400,
                      }}
                    >
                      %
                    </span>
                  </BTd>
                  <BTd style={{ padding: "8px 6px" }}>
                    {/* Two chevron buttons — mirrors the Secondary/Final
                        total-row picker in renderIngredientsBlock. < drops
                        one decimal (min 0), > adds one (max 4). Bound to
                        `carryOverDecimals` so the carry-over precision is
                        independent of the Secondary/Final totalDecimals. */}
                    <span
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 2,
                      }}
                    >
                      <button
                        type="button"
                        onClick={() =>
                          setCarryOverDecimals((d) => Math.max(0, d - 1))
                        }
                        disabled={carryOverDecimals <= 0}
                        title="Fewer decimal places"
                        aria-label="Fewer decimal places"
                        style={{
                          width: 16,
                          height: 18,
                          display: "inline-flex",
                          alignItems: "center",
                          justifyContent: "center",
                          fontSize: 11,
                          fontWeight: 700,
                          color:
                            carryOverDecimals <= 0
                              ? "var(--ink-4, #c7cccf)"
                              : "var(--ink-3, #8a9498)",
                          background: "transparent",
                          border: "1px solid var(--line, #e3dcc9)",
                          borderRadius: 3,
                          padding: 0,
                          cursor:
                            carryOverDecimals <= 0 ? "default" : "pointer",
                        }}
                      >
                        &lt;
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          setCarryOverDecimals((d) => Math.min(4, d + 1))
                        }
                        disabled={carryOverDecimals >= 4}
                        title="More decimal places"
                        aria-label="More decimal places"
                        style={{
                          width: 16,
                          height: 18,
                          display: "inline-flex",
                          alignItems: "center",
                          justifyContent: "center",
                          fontSize: 11,
                          fontWeight: 700,
                          color:
                            carryOverDecimals >= 4
                              ? "var(--ink-4, #c7cccf)"
                              : "var(--ink-3, #8a9498)",
                          background: "transparent",
                          border: "1px solid var(--line, #e3dcc9)",
                          borderRadius: 3,
                          padding: 0,
                          cursor:
                            carryOverDecimals >= 4 ? "default" : "pointer",
                        }}
                      >
                        &gt;
                      </button>
                    </span>
                  </BTd>
                </tr>
              </tbody>
            </table>
          </>
        );
      })() : null}

      {/* Cooked-only: top-level "Cooking" Process notes block. Rendered
          right below the card header, above the Secondary Blend and
          Final Blend subsections. Same visual/behaviour as the
          per-subsection Process notes blocks inside renderIngredientsBlock,
          just labelled "Cooking:" instead of "Process:" and wired to
          independent cooking* state. */}
      {phase === "cooked" && onCookingProcessNoteChange ? (() => {
        const currentCookingNote = cookingProcessNote ?? "";
        const currentDefaultCookingNote = defaultCookingProcessNote ?? "";
        const cookingIsAtDefault =
          currentDefaultCookingNote.length > 0 &&
          currentCookingNote.trim() === currentDefaultCookingNote.trim();
        return (
          <div
            style={{
              padding: "10px 14px 14px",
              borderBottom: "1px solid var(--line-2, #efe9da)",
              background: "var(--cream-soft, #fbf6ec)",
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                marginBottom: 6,
                gap: 8,
                flexWrap: "wrap",
              }}
            >
              <span
                style={{
                  fontSize: 13,
                  fontWeight: 700,
                  color: "var(--teal-900, #0f4a56)",
                }}
              >
                Cooking:
              </span>
              <div style={{ display: "inline-flex", alignItems: "center", gap: 12 }}>
                {currentDefaultCookingNote && !cookingIsAtDefault ? (
                  <button
                    type="button"
                    onClick={() => onCookingProcessNoteChange(currentDefaultCookingNote)}
                    style={{
                      background: "transparent",
                      border: "none",
                      padding: 0,
                      fontSize: 10.5,
                      fontWeight: 700,
                      letterSpacing: "0.08em",
                      textTransform: "uppercase",
                      color: "var(--teal-700, #1d6c7b)",
                      cursor: "pointer",
                    }}
                  >
                    Reset to default
                  </button>
                ) : null}
                <button
                  type="button"
                  onClick={() => setCookingProcessEditing((v) => !v)}
                  style={{
                    padding: "4px 10px",
                    background: cookingProcessEditing ? "var(--teal-700, #1d6c7b)" : "transparent",
                    color: cookingProcessEditing ? "#fff" : "var(--teal-900, #0f4a56)",
                    border: "1px solid var(--teal-700, #1d6c7b)",
                    borderRadius: 6,
                    fontSize: 10.5,
                    fontWeight: 700,
                    letterSpacing: "0.08em",
                    textTransform: "uppercase",
                    cursor: "pointer",
                  }}
                >
                  {cookingProcessEditing ? "Done editing" : "Edit"}
                </button>
              </div>
            </div>
            {cookingIsAtDefault ? (
              <div
                role="alert"
                style={{
                  marginBottom: 6,
                  fontSize: 12,
                  fontWeight: 700,
                  color: "#b91c1c",
                }}
              >
                {PROCESS_NOTES_PLACEHOLDER_NOTICE}
              </div>
            ) : null}
            {cookingProcessEditing ? (
              <textarea
                value={currentCookingNote}
                onChange={(e) => onCookingProcessNoteChange(e.target.value)}
                rows={6}
                placeholder="Describe the cooking steps, target temperature, solids, pH, etc."
                className="pricing__input"
                style={{
                  width: "100%",
                  resize: "vertical",
                  fontFamily: "inherit",
                  fontSize: 12.5,
                  lineHeight: 1.5,
                }}
                autoFocus
              />
            ) : (
              <div
                style={{
                  width: "100%",
                  padding: "10px 12px",
                  background: "#fff",
                  border: "1px solid var(--line, #e3dcc9)",
                  borderRadius: 6,
                  fontSize: 12.5,
                  lineHeight: 1.5,
                  color: currentCookingNote.trim() ? "var(--ink, #1f2a2d)" : "var(--ink-3, #8a9498)",
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-word",
                  minHeight: 60,
                }}
              >
                {currentCookingNote.trim() || "No cooking notes yet — click Edit to add."}
              </div>
            )}
          </div>
        );
      })() : null}

      {(() => {
        // Renders one subsection block: optional subheading + ingredients
        // table (or empty state) + Add ingredient / Add solution row. The
        // section-wide UOM picker and decimal chevrons deliberately share
        // state (sectionUnit / totalDecimals) across every block rendered
        // in this card, since they represent the same card-level display
        // choice. Only the solution-menu open flag is per-subsection so
        // opening one dropdown doesn't affect the other.
        const renderIngredientsBlock = ({
          subHeading,
          blockRows,
          blockOnAddRow,
          blockOnAddSolution,
          blockOnAddSavedSolution,
          blockSolutionMenuOpen,
          setBlockSolutionMenuOpen,
          blockProcessNote,
          blockDefaultProcessNote,
          blockOnProcessNoteChange,
          blockProcessEditing,
          setBlockProcessEditing,
          pctBaseG,
          includeSolutionsInResidual,
          showOverageColumn,
        }: {
          subHeading: string | null;
          blockRows: GummyFormulaIngredient[];
          blockOnAddRow: () => void;
          blockOnAddSolution: () => void;
          blockOnAddSavedSolution: (s: SavedSolution) => void;
          blockSolutionMenuOpen: boolean;
          setBlockSolutionMenuOpen: React.Dispatch<React.SetStateAction<boolean>>;
          blockProcessNote: string;
          blockDefaultProcessNote: string;
          blockOnProcessNoteChange: (text: string) => void;
          blockProcessEditing: boolean;
          setBlockProcessEditing: React.Dispatch<React.SetStateAction<boolean>>;
          /** Cooked-only: when > 0, renders an EXTRA "% of finished product"
           *  column to the right of the Grams column. Each row's cell shows
           *  (row.grams / pctBaseG) * 100. Pre-cook passes undefined so the
           *  extra column is skipped and its rendering stays unchanged. */
          pctBaseG?: number;
          /** When true, SOLUTION rows in this block contribute to the
           *  Residual Moisture % column (Final Blend behaviour). When false
           *  or undefined, solutions show a blank residual cell and do NOT
           *  add to the subsection's total residual (Secondary Blend
           *  behaviour). Water ingredient rows (isWaterRow) continue to
           *  contribute regardless — this flag only gates SOLUTION rows. */
          includeSolutionsInResidual?: boolean;
          /** Secondary-Blend-only: when true, renders an extra "Overage %"
           *  column to the LEFT of the Grams column. Claim-sourced rows
           *  (sourceLabelClaimId set) show an editable % input driving the
           *  row's overagePct; non-claim rows show an em-dash. Claim-sourced
           *  rows also lose their inline picker (read-only identity) and
           *  their delete button (removal happens via Label Claims). */
          showOverageColumn?: boolean;
        }) => {
          const totalG = blockRows.reduce(
            (s, r) => s + (Number(r.grams) || 0),
            0,
          );
          // Show the extra % column only when the caller passes a
          // non-zero base. Pre-cook omits pctBaseG so this stays false
          // and the layout is unchanged. When true, the row cell is
          // (grams / pctBaseG) * 100 formatted to 2dp with the ".00"
          // trimmed (matches the pctOfBench pattern used elsewhere).
          const showPctColumn = (pctBaseG ?? 0) > 0;
          const formatBlockPct = (grams: number): string => {
            if (!showPctColumn) return "0";
            const pct = (grams / (pctBaseG ?? 1)) * 100;
            const s = pct.toFixed(2);
            return s.endsWith(".00") ? s.slice(0, -3) : s;
          };
          // Effective water fraction for residual calculation. SOLUTION rows
          // are gated by includeSolutionsInResidual — when false (Secondary
          // Blend behaviour) solutions contribute 0 residual regardless of
          // their water-component content. Water ingredient rows (isWaterRow)
          // and other ingredient rows continue to use waterFractionFor
          // directly — this flag only gates SOLUTION rows.
          const effectiveWaterFracFor = (r: GummyFormulaIngredient): number => {
            if (isSolutionRow(r) && !includeSolutionsInResidual) return 0;
            return waterFractionFor(r);
          };
          // Residual Moisture % for a row: effectiveWaterFrac × (grams / pctBaseG × 100).
          // Returns 0 when the base is 0 or the row has no water (or is a
          // solution excluded by includeSolutionsInResidual). Callers check
          // effectiveWaterFracFor === 0 separately to render a blank cell.
          const residualPctFor = (r: GummyFormulaIngredient): number => {
            if (!showPctColumn) return 0;
            const wf = effectiveWaterFracFor(r);
            if (wf === 0) return 0;
            const pctOfFinished =
              (Number(r.grams) || 0) / (pctBaseG ?? 1) * 100;
            return wf * pctOfFinished;
          };
          const formatBlockResidualPct = (residualPct: number): string => {
            const s = residualPct.toFixed(2);
            return s.endsWith(".00") ? s.slice(0, -3) : s;
          };
          // Subsection's total residual — the sum of the per-row residual
          // pct across every row. Mirrors the total-row grams computation
          // so the total ties out with the column above by construction.
          const totalResidualPct = blockRows.reduce(
            (s, r) => s + residualPctFor(r),
            0,
          );
          // Per-subsection default-detection so Secondary and Final each
          // decide independently whether to show the red placeholder-notice
          // banner and the Reset link.
          const blockIsAtDefault =
            blockDefaultProcessNote.length > 0 &&
            blockProcessNote.trim() === blockDefaultProcessNote.trim();
          return (
            <>
              {/* Optional sub-heading — e.g. "Secondary Blend" or
                  "Final Blend" on the cooked card. Other subsections pass
                  null so nothing renders. */}
              {subHeading ? (
                <div
                  style={{
                    padding: "10px 14px 4px",
                    borderTop: "1px solid var(--line-2, #efe9da)",
                    fontSize: 13,
                    fontWeight: 700,
                    color: "var(--teal-900, #0f4a56)",
                    letterSpacing: "-0.005em",
                  }}
                >
                  {subHeading}
                </div>
              ) : null}

              {/* Process notes — one block per subsection so Secondary and
                  Final each own their default text, Reset link, Edit
                  toggle, and placeholder banner. Free-text mixing
                  instructions for this subsection (pre-blend pectin,
                  hydration times, pH targets, etc.). Persisted on the
                  version's process_notes JSONB column keyed by phase.
                  - On first render the textarea is seeded with the canonical
                    DEFAULT_PROCESS_NOTES[phase] via FormulaEditor state init.
                  - If the current text still equals the default, a red
                    placeholder-notice banner is shown so the rep knows this
                    hasn't been reviewed for this specific formula yet.
                  - Once edited, a "Reset to default" link appears to bring
                    it back to the canonical text. */}
              <div
                style={{
                  padding: "10px 14px 14px",
                  borderBottom: "1px solid var(--line-2, #efe9da)",
                  background: "var(--cream-soft, #fbf6ec)",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    marginBottom: 6,
                    gap: 8,
                    flexWrap: "wrap",
                  }}
                >
                  <span
                    style={{
                      fontSize: 13,
                      fontWeight: 700,
                      color: "var(--teal-900, #0f4a56)",
                    }}
                  >
                    Process:
                  </span>
                  <div style={{ display: "inline-flex", alignItems: "center", gap: 12 }}>
                    {blockDefaultProcessNote && !blockIsAtDefault ? (
                      <button
                        type="button"
                        onClick={() => blockOnProcessNoteChange(blockDefaultProcessNote)}
                        style={{
                          background: "transparent",
                          border: "none",
                          padding: 0,
                          fontSize: 10.5,
                          fontWeight: 700,
                          letterSpacing: "0.08em",
                          textTransform: "uppercase",
                          color: "var(--teal-700, #1d6c7b)",
                          cursor: "pointer",
                        }}
                      >
                        Reset to default
                      </button>
                    ) : null}
                    <button
                      type="button"
                      onClick={() => setBlockProcessEditing((v) => !v)}
                      style={{
                        padding: "4px 10px",
                        background: blockProcessEditing ? "var(--teal-700, #1d6c7b)" : "transparent",
                        color: blockProcessEditing ? "#fff" : "var(--teal-900, #0f4a56)",
                        border: "1px solid var(--teal-700, #1d6c7b)",
                        borderRadius: 6,
                        fontSize: 10.5,
                        fontWeight: 700,
                        letterSpacing: "0.08em",
                        textTransform: "uppercase",
                        cursor: "pointer",
                      }}
                    >
                      {blockProcessEditing ? "Done editing" : "Edit"}
                    </button>
                  </div>
                </div>
                {blockIsAtDefault ? (
                  <div
                    role="alert"
                    style={{
                      marginBottom: 6,
                      fontSize: 12,
                      fontWeight: 700,
                      color: "#b91c1c",
                    }}
                  >
                    {PROCESS_NOTES_PLACEHOLDER_NOTICE}
                  </div>
                ) : null}
                {blockProcessEditing ? (
                  <textarea
                    value={blockProcessNote}
                    onChange={(e) => blockOnProcessNoteChange(e.target.value)}
                    rows={6}
                    placeholder="Describe the mixing steps, hydration times, pH targets, etc."
                    className="pricing__input"
                    style={{
                      width: "100%",
                      resize: "vertical",
                      fontFamily: "inherit",
                      fontSize: 12.5,
                      lineHeight: 1.5,
                    }}
                    autoFocus
                  />
                ) : (
                  // Read-only view. Whitespace: pre-wrap keeps whatever newlines
                  // the rep typed in edit mode. Empty state gets a placeholder
                  // hint since we know the default gets seeded on mount.
                  <div
                    style={{
                      width: "100%",
                      padding: "10px 12px",
                      background: "#fff",
                      border: "1px solid var(--line, #e3dcc9)",
                      borderRadius: 6,
                      fontSize: 12.5,
                      lineHeight: 1.5,
                      color: blockProcessNote.trim() ? "var(--ink, #1f2a2d)" : "var(--ink-3, #8a9498)",
                      whiteSpace: "pre-wrap",
                      wordBreak: "break-word",
                      minHeight: 60,
                    }}
                  >
                    {blockProcessNote.trim() || "No process notes yet — click Edit to add."}
                  </div>
                )}
              </div>

              {blockRows.length === 0 ? (
                <div
                  style={{
                    padding: "18px 14px",
                    textAlign: "center",
                    color: "var(--ink-3, #8a9498)",
                    fontSize: 12,
                    background: "var(--cream-soft, #fbf6ec)",
                  }}
                >
                  No ingredients yet. Add the first one below.
                </div>
              ) : (
                <table
                  style={{
                    width: "100%",
                    borderCollapse: "collapse",
                    fontSize: 12.5,
                    // Fixed layout so the 120px grams column and 40px delete
                    // column are respected exactly. Without this, auto layout
                    // fudges column widths based on content, causing the
                    // solution rows' internal grid (which uses hard-coded
                    // 120/40) to misalign with the ingredient rows above.
                    tableLayout: "fixed",
                  }}
                >
                  <thead>
                    <tr style={{ background: "var(--cream-soft, #fbf6ec)" }}>
                      <BTh>Ingredient</BTh>
                      {/* Secondary-Blend-only: Overage % — inserted to the
                          LEFT of the Grams column so it visually reads as
                          "add X% on top of the label-claim base". Only
                          renders in the Secondary Blend subsection; other
                          subsections keep their existing layout. */}
                      {showOverageColumn ? (
                        <BTh style={{ textAlign: "right", width: 90 }}>
                          Overage %
                        </BTh>
                      ) : null}
                      <BTh style={{ textAlign: "right", width: 120 }}>
                        {/* The column header itself picks the unit for the
                            column. Options spell out the unit (Grams, Milligrams,
                            Micrograms) so the header reads naturally as a
                            column label. Internally we always store grams — the
                            ingredient/total display just rescales when this
                            switches. Every subsection in this card shares the
                            same sectionUnit state, so the picker on either
                            table drives both. When the parent controls the
                            unit (pre-cook card), this write goes through
                            effectiveSetSectionUnit — which propagates to the
                            Cooked card's carry-over subsection. */}
                        <select
                          value={effectiveSectionUnit}
                          onChange={(e) =>
                            effectiveSetSectionUnit(e.target.value as LabelClaimUnit)
                          }
                          aria-label="Unit for this blend section"
                          title="Unit for this blend section"
                          style={{
                            background: "transparent",
                            border: "none",
                            padding: 0,
                            margin: 0,
                            fontSize: "inherit",
                            fontWeight: "inherit",
                            letterSpacing: "inherit",
                            textTransform: "inherit",
                            color: "inherit",
                            cursor: "pointer",
                            textAlign: "right",
                            // Small caret hint via appearance:auto (native
                            // browser look) — keeps the header compact.
                            appearance: "auto",
                          }}
                        >
                          <option value="g">Grams</option>
                          <option value="mg">Milligrams</option>
                          <option value="mcg">Micrograms</option>
                        </select>
                      </BTh>
                      {/* Cooked-only: % of finished product — each row's
                          grams as a share of the Grand Total Cooked Blend.
                          Only renders when the caller passes pctBaseG > 0
                          (Secondary/Final on the cooked card). */}
                      {showPctColumn ? (
                        <BTh style={{ textAlign: "right", width: 120 }}>
                          % of finished product
                        </BTh>
                      ) : null}
                      {/* Cooked-only: Residual Moisture % — waterFraction ×
                          the row's % of finished. Blank for non-water. */}
                      {showPctColumn ? (
                        <BTh style={{ textAlign: "right", width: 120 }}>
                          Residual Moisture %
                        </BTh>
                      ) : null}
                      <BTh style={{ width: 40 }} />
                    </tr>
                  </thead>
                  <tbody>
                    {blockRows.map((row) => {
                      // Drag-and-drop wiring — built once per row and
                      // passed to whichever component renders this row.
                      // See dndRowProps / renderDragHandle above for the
                      // handlers + handle glyph.
                      const rowDnd = {
                        trProps: rowDndTrProps(row.id),
                        trStyle: rowDndBaseStyle(row.id),
                        renderHandle: (hover: boolean) =>
                          renderDragHandle(row.id, hover),
                      };
                      // Solution rows have their own layout — a name field, a
                      // total-weight input, and an inline list of component
                      // ingredients with %s that sum to 100.
                      if (isSolutionRow(row)) {
                        return (
                          <SolutionRow
                            key={row.id}
                            row={row}
                            rawMaterials={rawMaterials}
                            savedSolutions={savedSolutions}
                            sectionUnit={effectiveSectionUnit}
                            unitFactor={factor}
                            onUpdate={(patch) => onUpdate(row.id, patch)}
                            onSaveToLibrary={() => onSaveSolutionToLibrary(row)}
                            onRemove={() => onRemoveRow(row.id)}
                            // Cooked-only: text shown in the extra
                            // "% of finished product" column so it lines
                            // up with the ingredient rows above. undefined
                            // on pre-cook where the column doesn't exist.
                            pctOfFinishedText={
                              showPctColumn
                                ? formatBlockPct(Number(row.grams) || 0)
                                : undefined
                            }
                            // Cooked-only: text shown in the extra
                            // "Residual Moisture %" column. Empty string
                            // for solutions with no water content, AND for
                            // solutions in subsections that don't include
                            // solutions in residual (Secondary Blend, Primary
                            // Blend Carry Over — gated via
                            // includeSolutionsInResidual). Column width holds
                            // but no digits render.
                            residualMoistureText={
                              showPctColumn
                                ? effectiveWaterFracFor(row) === 0
                                  ? ""
                                  : formatBlockResidualPct(residualPctFor(row))
                                : undefined
                            }
                            // Secondary-Blend-only: solutions can't be
                            // claim-sourced (a claim always seeds an
                            // ingredient row, not a solution), so the
                            // Overage cell is a fixed em-dash. Undefined
                            // in other subsections so no cell renders.
                            showOverageColumn={showOverageColumn}
                            dnd={rowDnd}
                          />
                        );
                      }
                      // Resolve the row to a picker option: try rawMaterialId
                      // first (curated), then fp_code (Fishbowl-only rows use
                      // "fb:CODE" as their id).
                      const resolved =
                        (row.rawMaterialId && rmById.get(row.rawMaterialId)) ||
                        (row.rawMaterialFpCode
                          ? rawMaterials.find(
                              (r) =>
                                (r.fpCode ?? "").toUpperCase() ===
                                (row.rawMaterialFpCode ?? "").toUpperCase(),
                            ) ?? null
                          : null);
                      // Claim-sourced row detection — only meaningful in
                      // the Secondary Blend subsection (Overage column
                      // exists). When true, the picker locks to a
                      // read-only pill, Grams becomes read-only, delete
                      // is hidden, and the Overage input drives grams.
                      const claimForRow =
                        showOverageColumn && row.sourceLabelClaimId
                          ? (labelClaims ?? []).find(
                              (c) => c.id === row.sourceLabelClaimId,
                            ) ?? null
                          : null;
                      const isClaimSourced = claimForRow != null;
                      // Display name for a claim-sourced row's read-only
                      // picker cell. Prefer the resolved raw-material
                      // record (fp_code + name) so the styling matches
                      // the picker's picked-pill; fall back to the
                      // claim's customName if the raw material isn't
                      // resolved (custom claim ingredient).
                      const claimDisplayName = isClaimSourced
                        ? resolved
                          ? resolved.name
                          : (claimForRow?.customName ?? "").trim() ||
                            (claimForRow?.rawMaterialFpCode ?? "")
                        : "";
                      return (
                        <BlendIngredientRow
                          key={row.id}
                          onRemove={() => onRemoveRow(row.id)}
                          dnd={rowDnd}
                          hideDelete={isClaimSourced}
                        >
                          <BTd>
                            {isClaimSourced ? (
                              // Read-only picker cell — same visual
                              // language as the IngredientPicker's
                              // picked-pill state (pricing__input frame,
                              // fp_code · name) minus the Change/Clear
                              // affordances. Ingredient identity is
                              // dictated by the label claim; edits
                              // happen in the Product Details card.
                              <div
                                className="pricing__input"
                                style={{
                                  display: "flex",
                                  alignItems: "center",
                                  gap: 6,
                                }}
                                title={claimDisplayName}
                              >
                                <span
                                  style={{
                                    flex: 1,
                                    minWidth: 0,
                                    whiteSpace: "nowrap",
                                    overflow: "hidden",
                                    textOverflow: "ellipsis",
                                  }}
                                >
                                  {resolved && resolved.fpCode ? (
                                    <>
                                      <code
                                        style={{
                                          fontWeight: 700,
                                          color: "var(--teal-900, #0f4a56)",
                                        }}
                                      >
                                        {resolved.fpCode}
                                      </code>{" "}
                                      <span style={{ color: "var(--ink-2, #415056)" }}>
                                        · {resolved.name}
                                      </span>
                                    </>
                                  ) : (
                                    <span style={{ color: "var(--ink-2, #415056)" }}>
                                      {claimDisplayName}
                                    </span>
                                  )}
                                </span>
                              </div>
                            ) : (
                              <IngredientPicker
                                row={row}
                                resolved={resolved ?? null}
                                rawMaterials={rawMaterials}
                                onPick={(opt) => {
                                  // Curated pick: store rawMaterialId. Fishbowl
                                  // pick: store rawMaterialFpCode. Either way we
                                  // reset the override fields so defaults apply.
                                  if (opt.source === "fishbowl") {
                                    onUpdate(row.id, {
                                      rawMaterialId: null,
                                      rawMaterialFpCode: opt.fpCode,
                                      customName: null,
                                      costPerKgOverride: null,
                                      solidsOverride: null,
                                    });
                                  } else {
                                    onUpdate(row.id, {
                                      rawMaterialId: opt.id,
                                      rawMaterialFpCode: opt.fpCode,
                                      customName: null,
                                      costPerKgOverride: null,
                                      solidsOverride: null,
                                    });
                                  }
                                }}
                                onPickCustom={(name) =>
                                  onUpdate(row.id, {
                                    rawMaterialId: null,
                                    rawMaterialFpCode: null,
                                    customName: name,
                                    costPerKgOverride: null,
                                    solidsOverride: null,
                                  })
                                }
                                onClear={() =>
                                  onUpdate(row.id, {
                                    rawMaterialId: null,
                                    rawMaterialFpCode: null,
                                    customName: null,
                                  })
                                }
                              />
                            )}
                            {isClaimSourced ? (
                              // Tiny caption below the read-only pill so
                              // it's obvious this row is claim-driven.
                              // Mirrors the "primary blend material"
                              // subtitle styling used elsewhere.
                              <div
                                style={{
                                  fontSize: 10.5,
                                  color: "var(--ink-3, #8a9498)",
                                  marginTop: 2,
                                }}
                              >
                                from label claim
                              </div>
                            ) : resolved?.category ? (
                              <div
                                style={{
                                  fontSize: 10.5,
                                  color: "var(--ink-3, #8a9498)",
                                  marginTop: 2,
                                  textTransform: "capitalize",
                                }}
                              >
                                {resolved.category} blend material
                              </div>
                            ) : null}
                          </BTd>
                          {/* Overage % — Secondary Blend only. Now a
                              read-only DERIVED display: grams is the
                              manual input (see next cell) and this cell
                              shows how far above/below the label-claim
                              target the operator's grams sits.
                                overage% = (actualG / baseG - 1) × 100
                              baseG comes from claimBaseGramsForBench
                              against the wet cast weight. Non-claim rows
                              show a grey em-dash so the column width
                              still holds. */}
                          {showOverageColumn ? (
                            <BTd
                              style={{
                                textAlign: "right",
                                fontVariantNumeric: "tabular-nums",
                                whiteSpace: "nowrap",
                              }}
                            >
                              {isClaimSourced ? (() => {
                                const baseG = claimBaseGramsForBench(
                                  claimForRow!,
                                  benchBatchG ?? 0,
                                  wetCastPieceWeightG ?? 0,
                                  gummyPieceWeightG ?? 0,
                                );
                                const actualG = Number(row.grams) || 0;
                                // Dash guard: no meaningful overage %
                                // when either side is zero (avoids
                                // divide-by-zero and hides a spurious
                                // "-100.00%" on a fresh row).
                                const showDash =
                                  !(baseG > 0) || !(actualG > 0);
                                const rawPct = showDash
                                  ? 0
                                  : (actualG / baseG - 1) * 100;
                                // Soft color band — near-zero stays neutral;
                                // >0 goes teal; <0 goes muted red.
                                const near = Math.abs(rawPct) < 0.005;
                                const color = showDash || near
                                  ? "var(--ink-2, #415056)"
                                  : rawPct > 0
                                    ? "var(--teal-700, #1d6c7b)"
                                    : "#8b2f2f";
                                const label = showDash
                                  ? "—"
                                  : (rawPct >= 0 ? "+" : "") +
                                    rawPct.toFixed(2) +
                                    "%";
                                return (
                                  <div
                                    style={{
                                      display: "inline-flex",
                                      flexDirection: "column",
                                      alignItems: "flex-end",
                                      gap: 2,
                                      lineHeight: 1.15,
                                    }}
                                  >
                                    <span
                                      style={{
                                        fontWeight: 700,
                                        color,
                                        fontVariantNumeric: "tabular-nums",
                                      }}
                                    >
                                      {label}
                                    </span>
                                    <span
                                      style={{
                                        fontSize: 10.5,
                                        color: "var(--ink-3, #8a9498)",
                                        fontWeight: 400,
                                      }}
                                    >
                                      Claim Baseline: {baseG.toFixed(2)} g
                                    </span>
                                  </div>
                                );
                              })() : (
                                <span
                                  style={{
                                    color: "var(--ink-3, #8a9498)",
                                  }}
                                >
                                  —
                                </span>
                              )}
                            </BTd>
                          ) : null}
                          <BTd style={{ textAlign: "right" }}>
                            <div style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                              {/* Grams is now the manual input for every
                                  row — including claim-sourced ones. The
                                  Overage % cell (above) derives from this
                                  vs. the claim's target base grams. */}
                              <input
                                type="number"
                                onFocus={(e) => {
                                  // Chrome's <input type="number"> doesn't select on
                                  // focus synchronously — defer one frame so the
                                  // digits are highlighted and any keystroke replaces
                                  // the placeholder 0 instead of prepending to it.
                                  const el = e.currentTarget;
                                  setTimeout(() => {
                                    try { el.select(); } catch {}
                                  }, 0);
                                }}
                                value={
                                  row.grams !== null && row.grams !== undefined
                                    ? row.grams * factor
                                    : 0
                                }
                                onChange={(e) => {
                                  const n = Number(e.target.value);
                                  // Convert the displayed unit back to grams for
                                  // storage so downstream math stays in one base.
                                  onUpdate(row.id, {
                                    grams: Number.isFinite(n) ? n / factor : 0,
                                  });
                                }}
                                step="0.1"
                                min={0}
                                className="pricing__input"
                                style={{
                                  width: 80,
                                  // Override .pricing__input's `flex: 1` — with
                                  // that default, the width setting was being
                                  // ignored inside the inline-flex parent, so the
                                  // number position drifted from the solution
                                  // rows' identical input below.
                                  // 80 (not 90) so input + gap + unit glyph
                                  // (~92px total) fits inside the 96px cell
                                  // content area and right-aligns properly.
                                  flex: "0 0 80px",
                                  textAlign: "right",
                                  fontVariantNumeric: "tabular-nums",
                                }}
                              />
                              <span
                                style={{
                                  fontSize: 12,
                                  color: "var(--ink-3, #8a9498)",
                                }}
                              >
                                {effectiveSectionUnit}
                              </span>
                            </div>
                          </BTd>
                          {/* % of finished product — this row's grams
                              as a share of the Grand Total Cooked Blend.
                              Only renders on the cooked card (pctBaseG > 0). */}
                          {showPctColumn ? (
                            <BTd
                              style={{
                                textAlign: "right",
                                fontVariantNumeric: "tabular-nums",
                                whiteSpace: "nowrap",
                              }}
                            >
                              <span>
                                {formatBlockPct(Number(row.grams) || 0)}
                              </span>
                              <span
                                style={{
                                  fontSize: 12,
                                  color: "var(--ink-3, #8a9498)",
                                }}
                              >
                                %
                              </span>
                            </BTd>
                          ) : null}
                          {/* Residual Moisture % — effectiveWaterFrac × the
                              row's % of finished. Blank for non-water
                              ingredients so only water contributions
                              show up in the column. (Ingredient rows are
                              non-solution rows, so effectiveWaterFracFor
                              matches waterFractionFor here — this branch is
                              untouched by includeSolutionsInResidual.) */}
                          {showPctColumn ? (
                            effectiveWaterFracFor(row) === 0 ? (
                              <BTd
                                style={{
                                  textAlign: "right",
                                  fontVariantNumeric: "tabular-nums",
                                  whiteSpace: "nowrap",
                                }}
                              />
                            ) : (
                              <BTd
                                style={{
                                  textAlign: "right",
                                  fontVariantNumeric: "tabular-nums",
                                  whiteSpace: "nowrap",
                                }}
                              >
                                <span>
                                  {formatBlockResidualPct(residualPctFor(row))}
                                </span>
                                <span
                                  style={{
                                    fontSize: 12,
                                    color: "var(--ink-3, #8a9498)",
                                  }}
                                >
                                  %
                                </span>
                              </BTd>
                            )
                          ) : null}
                        </BlendIngredientRow>
                      );
                    })}
                    <tr
                      style={{
                        borderTop: "1.5px solid var(--teal-700, #1d6c7b)",
                        background: "var(--cream-soft, #fbf6ec)",
                      }}
                    >
                      <BTd>
                        <strong
                          style={{
                            fontSize: 11,
                            fontWeight: 700,
                            letterSpacing: "0.1em",
                            textTransform: "uppercase",
                            color: "var(--teal-900, #0f4a56)",
                          }}
                        >
                          {/* When a subsection heading is provided, the
                              Total row labels this specific subsection
                              (e.g. "Tot secondary blend" / "Tot final
                              blend"). Otherwise fall back to the outer
                              phase label (pre-cook card). */}
                          Tot {subHeading?.toLowerCase() ?? label.toLowerCase()}
                        </strong>
                      </BTd>
                      {/* Empty Overage cell in the Total row so column
                          widths line up with the Overage % header in
                          Secondary Blend. No overall subtotal makes
                          sense for a "per-row scaler" so we deliberately
                          leave the cell blank. */}
                      {showOverageColumn ? (
                        <BTd style={{ textAlign: "right" }} />
                      ) : null}
                      <BTd
                        style={{
                          textAlign: "right",
                          fontVariantNumeric: "tabular-nums",
                          fontWeight: 700,
                          color: "var(--teal-900, #0f4a56)",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {/* Mirror the ingredient rows' inline-flex layout so the
                            unit glyph sits at the exact same X-position as the
                            unit spans above. Total is scaled to the section unit
                            (grams × factor) so switching mid-authoring feels
                            consistent between rows and totals. */}
                        <span
                          style={{
                            display: "inline-flex",
                            alignItems: "center",
                            gap: 4,
                          }}
                        >
                          <span>{(totalG * factor).toFixed(totalDecimals)}</span>
                          <span
                            style={{
                              color: "var(--ink-3, #8a9498)",
                              fontWeight: 400,
                            }}
                          >
                            {effectiveSectionUnit}
                          </span>
                        </span>
                      </BTd>
                      {/* % of finished product — this subsection's total
                          grams as a share of the Grand Total Cooked Blend.
                          Only renders on the cooked card (pctBaseG > 0). */}
                      {showPctColumn ? (
                        <BTd
                          style={{
                            textAlign: "right",
                            fontVariantNumeric: "tabular-nums",
                            fontWeight: 700,
                            color: "var(--teal-900, #0f4a56)",
                            whiteSpace: "nowrap",
                          }}
                        >
                          <span>{formatBlockPct(totalG)}</span>
                          <span
                            style={{
                              color: "var(--ink-3, #8a9498)",
                              fontWeight: 400,
                            }}
                          >
                            %
                          </span>
                        </BTd>
                      ) : null}
                      {/* Residual Moisture % — this subsection's total
                          water contribution as a share of the Grand
                          Total Cooked Blend. */}
                      {showPctColumn ? (
                        <BTd
                          style={{
                            textAlign: "right",
                            fontVariantNumeric: "tabular-nums",
                            fontWeight: 700,
                            color: "var(--teal-900, #0f4a56)",
                            whiteSpace: "nowrap",
                          }}
                        >
                          <span>{formatBlockResidualPct(totalResidualPct)}</span>
                          <span
                            style={{
                              color: "var(--ink-3, #8a9498)",
                              fontWeight: 400,
                            }}
                          >
                            %
                          </span>
                        </BTd>
                      ) : null}
                      <BTd style={{ padding: "8px 6px" }}>
                        {/* Two chevron buttons — tighter than a dropdown pill.
                            < decreases decimal places (min 0), > increases (max 4).
                            Kept small so the delete-x column stays narrow. */}
                        <span
                          style={{
                            display: "inline-flex",
                            alignItems: "center",
                            gap: 2,
                          }}
                        >
                          <button
                            type="button"
                            onClick={() =>
                              setTotalDecimals((d) => Math.max(0, d - 1))
                            }
                            disabled={totalDecimals <= 0}
                            title="Fewer decimal places"
                            aria-label="Fewer decimal places"
                            style={{
                              width: 16,
                              height: 18,
                              display: "inline-flex",
                              alignItems: "center",
                              justifyContent: "center",
                              fontSize: 11,
                              fontWeight: 700,
                              color:
                                totalDecimals <= 0
                                  ? "var(--ink-4, #c7cccf)"
                                  : "var(--ink-3, #8a9498)",
                              background: "transparent",
                              border: "1px solid var(--line, #e3dcc9)",
                              borderRadius: 3,
                              padding: 0,
                              cursor: totalDecimals <= 0 ? "default" : "pointer",
                            }}
                          >
                            &lt;
                          </button>
                          <button
                            type="button"
                            onClick={() =>
                              setTotalDecimals((d) => Math.min(4, d + 1))
                            }
                            disabled={totalDecimals >= 4}
                            title="More decimal places"
                            aria-label="More decimal places"
                            style={{
                              width: 16,
                              height: 18,
                              display: "inline-flex",
                              alignItems: "center",
                              justifyContent: "center",
                              fontSize: 11,
                              fontWeight: 700,
                              color:
                                totalDecimals >= 4
                                  ? "var(--ink-4, #c7cccf)"
                                  : "var(--ink-3, #8a9498)",
                              background: "transparent",
                              border: "1px solid var(--line, #e3dcc9)",
                              borderRadius: 3,
                              padding: 0,
                              cursor: totalDecimals >= 4 ? "default" : "pointer",
                            }}
                          >
                            &gt;
                          </button>
                        </span>
                      </BTd>
                    </tr>
                  </tbody>
                </table>
              )}
              <div
                style={{
                  padding: "10px 14px",
                  borderTop: "1px solid var(--line-2, #efe9da)",
                }}
              >
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <button
                    type="button"
                    onClick={blockOnAddRow}
                    style={{
                      padding: "6px 12px",
                      background: "transparent",
                      color: "var(--teal-900, #0f4a56)",
                      border: "1px dashed var(--line, #e3dcc9)",
                      borderRadius: 6,
                      fontSize: 12.5,
                      fontWeight: 700,
                      cursor: "pointer",
                    }}
                  >
                    + Add ingredient
                  </button>
                  <div style={{ position: "relative" }}>
                    <button
                      type="button"
                      onClick={() => setBlockSolutionMenuOpen((s) => !s)}
                      title="Add a pre-mixed solution (multiple ingredients at fixed percentages)"
                      aria-haspopup="menu"
                      aria-expanded={blockSolutionMenuOpen}
                      style={{
                        padding: "6px 12px",
                        background: "transparent",
                        color: "var(--teal-900, #0f4a56)",
                        border: "1px dashed var(--line, #e3dcc9)",
                        borderRadius: 6,
                        fontSize: 12.5,
                        fontWeight: 700,
                        cursor: "pointer",
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 4,
                      }}
                    >
                      + Add solution
                      <span
                        aria-hidden="true"
                        style={{ fontSize: 9, color: "var(--ink-3, #8a9498)" }}
                      >
                        ▼
                      </span>
                    </button>
                    {blockSolutionMenuOpen ? (
                      <>
                        {/* Backdrop that closes the menu on any outside click. */}
                        <div
                          onClick={() => setBlockSolutionMenuOpen(false)}
                          style={{
                            position: "fixed",
                            inset: 0,
                            zIndex: 30,
                            background: "transparent",
                          }}
                        />
                        <ul
                          role="menu"
                          style={{
                            position: "absolute",
                            top: "calc(100% + 4px)",
                            left: 0,
                            zIndex: 40,
                            margin: 0,
                            padding: 4,
                            listStyle: "none",
                            background: "#fff",
                            border: "1px solid var(--line, #e3dcc9)",
                            borderRadius: 6,
                            boxShadow: "0 4px 12px rgba(15,74,86,0.12)",
                            minWidth: 240,
                            maxHeight: 320,
                            overflow: "auto",
                          }}
                        >
                          <li>
                            <button
                              type="button"
                              role="menuitem"
                              onClick={() => {
                                blockOnAddSolution();
                                setBlockSolutionMenuOpen(false);
                              }}
                              style={{
                                display: "block",
                                width: "100%",
                                textAlign: "left",
                                padding: "8px 10px",
                                background: "transparent",
                                border: "none",
                                cursor: "pointer",
                                fontSize: 12.5,
                                fontWeight: 700,
                                color: "var(--teal-900, #0f4a56)",
                              }}
                              onMouseEnter={(e) =>
                                (e.currentTarget.style.background = "var(--cream-soft, #fbf6ec)")
                              }
                              onMouseLeave={(e) =>
                                (e.currentTarget.style.background = "transparent")
                              }
                            >
                              New empty solution
                            </button>
                          </li>
                          {savedSolutions.length > 0 ? (
                            <li
                              style={{
                                borderTop: "1px solid var(--line-2, #efe9da)",
                                margin: "4px 0",
                                padding: "6px 10px 2px",
                                fontSize: 10,
                                fontWeight: 700,
                                letterSpacing: "0.1em",
                                textTransform: "uppercase",
                                color: "var(--ink-3, #8a9498)",
                              }}
                            >
                              From library
                            </li>
                          ) : (
                            <li
                              style={{
                                padding: "6px 10px",
                                borderTop: "1px solid var(--line-2, #efe9da)",
                                marginTop: 4,
                                fontSize: 11,
                                color: "var(--ink-3, #8a9498)",
                              }}
                            >
                              No saved solutions yet. Save one from a solution
                              row to make it show up here.
                            </li>
                          )}
                          {savedSolutions.map((s) => (
                            <li key={s.id}>
                              <button
                                type="button"
                                role="menuitem"
                                onClick={() => {
                                  blockOnAddSavedSolution(s);
                                  setBlockSolutionMenuOpen(false);
                                }}
                                style={{
                                  display: "block",
                                  width: "100%",
                                  textAlign: "left",
                                  padding: "6px 10px",
                                  background: "transparent",
                                  border: "none",
                                  cursor: "pointer",
                                  fontSize: 12,
                                  color: "var(--ink, #1f2a2d)",
                                }}
                                onMouseEnter={(e) =>
                                  (e.currentTarget.style.background = "var(--cream-soft, #fbf6ec)")
                                }
                                onMouseLeave={(e) =>
                                  (e.currentTarget.style.background = "transparent")
                                }
                              >
                                <div style={{ fontWeight: 700 }}>{s.name}</div>
                                <div
                                  style={{
                                    fontSize: 10.5,
                                    color: "var(--ink-3, #8a9498)",
                                    marginTop: 1,
                                  }}
                                >
                                  {s.components.length} component
                                  {s.components.length === 1 ? "" : "s"}
                                </div>
                              </button>
                            </li>
                          ))}
                        </ul>
                      </>
                    ) : null}
                  </div>
                </div>
              </div>
            </>
          );
        };

        return (
          <>
            {/* Primary subsection — this is the ONLY block on pre-cook,
                and the "Secondary Blend" block on cooked. */}
            {renderIngredientsBlock({
              subHeading:
                phase === "cooked"
                  ? "Secondary Blend"
                  : phase === "pre-cook"
                    ? "Primary Blend"
                    : null,
              blockRows: rows,
              blockOnAddRow: onAddRow,
              blockOnAddSolution: onAddSolution,
              blockOnAddSavedSolution: onAddSavedSolution,
              blockSolutionMenuOpen: solutionMenuOpen,
              setBlockSolutionMenuOpen: setSolutionMenuOpen,
              blockProcessNote: processNote,
              blockDefaultProcessNote: defaultProcessNote,
              blockOnProcessNoteChange: onProcessNoteChange,
              blockProcessEditing: processEditing,
              setBlockProcessEditing: setProcessEditing,
              // Cooked-only: base for the "% of finished product"
              // column. Pre-cook passes undefined so the column is
              // skipped and pre-cook rendering stays unchanged.
              pctBaseG:
                phase === "cooked" ? grandTotalCookedBlendG : undefined,
              // Secondary-Blend-only: render the "Overage %" column
              // (claim-sourced rows only). Every other subsection —
              // Primary Blend on the pre-cook card, Primary Blend Carry
              // Over + Final Blend on the cooked card — keeps its
              // existing layout unchanged.
              showOverageColumn: phase === "cooked",
            })}
            {/* Cooked-only Final Blend subsection — same structure as
                Secondary but wired to phase="final" state on the parent.
                Only rendered when the parent passes all four final-*
                props (which FormulaEditor does for the cooked card). */}
            {phase === "cooked" &&
            finalRows &&
            onAddFinalRow &&
            onAddFinalSolution &&
            onAddSavedFinalSolution
              ? renderIngredientsBlock({
                  subHeading: "Final Blend",
                  blockRows: finalRows,
                  blockOnAddRow: onAddFinalRow,
                  blockOnAddSolution: onAddFinalSolution,
                  blockOnAddSavedSolution: onAddSavedFinalSolution,
                  blockSolutionMenuOpen: finalSolutionMenuOpen,
                  setBlockSolutionMenuOpen: setFinalSolutionMenuOpen,
                  blockProcessNote: finalProcessNote ?? "",
                  blockDefaultProcessNote: defaultFinalProcessNote ?? "",
                  blockOnProcessNoteChange: onFinalProcessNoteChange ?? (() => {}),
                  blockProcessEditing: finalProcessEditing,
                  setBlockProcessEditing: setFinalProcessEditing,
                  // Cooked-only: base for the "% of finished product"
                  // column. This branch only ever runs on the cooked
                  // card, so no phase guard is needed here.
                  pctBaseG: grandTotalCookedBlendG,
                  // Final Blend is the only subsection where SOLUTION rows
                  // contribute to Residual Moisture %. Secondary Blend and
                  // Primary Blend Carry Over exclude solutions (default).
                  includeSolutionsInResidual: true,
                })
              : null}
            {/* Grand Total Cooked Blend — full-width footer that sums the
                three cooked-card subsections (Primary Blend Carry Over net
                + Secondary Blend + Final Blend). Only rendered on the
                cooked card when a carry-over section is present, so the
                pre-cook card and cooked cards without a carry-over don't
                get a grand total row. */}
            {phase === "cooked" && carryOverRows && carryOverRows.length > 0
              ? (() => {
                  // Reuse the shared grandTotalCookedBlendG computed at the
                  // top of the render body so the footer and the new "% of
                  // finished product" column agree by construction.
                  const s = (grandTotalCookedBlendG * factor).toFixed(2);
                  // Mirror the pctOfBench trick — drop a trailing ".00" so a
                  // whole number renders cleanly without visual noise.
                  const gramsDisplay = s.endsWith(".00") ? s.slice(0, -3) : s;
                  // % of finished product — by construction the Grand Total
                  // is 100% of itself. Guard against a degenerate 0/0 case
                  // (nothing entered anywhere) by rendering an empty string.
                  const pctDisplay = grandTotalCookedBlendG > 0 ? "100" : "";
                  // Residual Moisture % — sum across all three subsections.
                  // Primary Blend Carry Over: only non-solution rows
                  //   contribute; uses each row's NET grams (post moisture
                  //   loss) so it matches the carry-over table's own total.
                  // Secondary Blend: only non-solution rows contribute; uses
                  //   raw row.grams.
                  // Final Blend: water rows AND solution rows contribute;
                  //   uses raw row.grams.
                  // Divide by grandTotalCookedBlendG (guarded) so each row's
                  // contribution is expressed as a share of the finished
                  // product, mirroring the per-row residual math in each
                  // subsection.
                  let grandResidualPct = 0;
                  if (grandTotalCookedBlendG > 0) {
                    // Primary Blend Carry Over — recompute the same
                    // per-row NET grams the carry-over table uses. This
                    // mirrors the water-auto-balance / per-row loss-fraction
                    // math from the carry-over IIFE above so the footer
                    // ties out with the subsection totals exactly.
                    const carryWaterPct = computeCarryOverWaterPct({
                      preCookRows: carryOverRows,
                      benchBatchG: benchBatchG ?? 0,
                      secondaryG: secondaryTotalG,
                      finalG: finalTotalG,
                    });
                    for (const r of carryOverRows) {
                      if (isSolutionRow(r)) continue;
                      const wf = waterFractionFor(r);
                      if (wf === 0) continue;
                      let lossFrac: number;
                      if (isWaterRow(r)) {
                        lossFrac = carryWaterPct / 100;
                      } else {
                        const raw = Number(r.moistureLossPct);
                        const pct = Number.isFinite(raw)
                          ? raw
                          : carryOverDefaultMoisturePct(r);
                        lossFrac = pct <= 0 ? 0 : pct >= 100 ? 1 : pct / 100;
                      }
                      const netG = (Number(r.grams) || 0) * (1 - lossFrac);
                      grandResidualPct +=
                        wf * ((netG / grandTotalCookedBlendG) * 100);
                    }
                    // Secondary Blend — skip solutions, use raw grams.
                    for (const r of rows) {
                      if (isSolutionRow(r)) continue;
                      const wf = waterFractionFor(r);
                      if (wf === 0) continue;
                      grandResidualPct +=
                        wf *
                        (((Number(r.grams) || 0) / grandTotalCookedBlendG) *
                          100);
                    }
                    // Final Blend — solutions AND water rows contribute.
                    for (const r of finalRows ?? []) {
                      const wf = waterFractionFor(r);
                      if (wf === 0) continue;
                      grandResidualPct +=
                        wf *
                        (((Number(r.grams) || 0) / grandTotalCookedBlendG) *
                          100);
                    }
                  }
                  const residualStr = grandResidualPct.toFixed(2);
                  const residualDisplay = residualStr.endsWith(".00")
                    ? residualStr.slice(0, -3)
                    : residualStr;
                  return (
                    <div
                      style={{
                        borderTop: "2px solid var(--teal-700, #1d6c7b)",
                        background: "var(--cream-soft, #fbf6ec)",
                      }}
                    >
                      <table
                        style={{
                          width: "100%",
                          borderCollapse: "collapse",
                          fontSize: 12.5,
                          tableLayout: "fixed",
                        }}
                      >
                        <colgroup>
                          {/* Ingredient — auto width to match the
                              Secondary/Final tables above. */}
                          <col />
                          {/* Overage % — Secondary Blend introduced this
                              column, so the Grand Total footer needs to
                              hold the same slot for column alignment.
                              Always renders empty in the footer (there's
                              no meaningful grand-total overage %). */}
                          <col style={{ width: 90 }} />
                          {/* Grams */}
                          <col style={{ width: 120 }} />
                          {/* % of finished product */}
                          <col style={{ width: 120 }} />
                          {/* Residual Moisture % */}
                          <col style={{ width: 120 }} />
                          {/* Chevron / empty */}
                          <col style={{ width: 40 }} />
                        </colgroup>
                        <tbody>
                          <tr>
                            <BTd style={{ padding: "10px 14px" }}>
                              <strong
                                style={{
                                  fontSize: 11,
                                  fontWeight: 700,
                                  letterSpacing: "0.1em",
                                  textTransform: "uppercase",
                                  color: "var(--teal-900, #0f4a56)",
                                }}
                              >
                                Grand Total Cooked Blend
                              </strong>
                            </BTd>
                            {/* Empty Overage % cell for column
                                alignment (see colgroup above). */}
                            <BTd style={{ padding: "10px 14px" }} />
                            <BTd
                              style={{
                                padding: "10px 14px",
                                textAlign: "right",
                                fontVariantNumeric: "tabular-nums",
                                fontWeight: 700,
                                color: "var(--teal-900, #0f4a56)",
                                whiteSpace: "nowrap",
                              }}
                            >
                              <span
                                style={{
                                  display: "inline-flex",
                                  alignItems: "center",
                                  gap: 4,
                                }}
                              >
                                <span>{gramsDisplay}</span>
                                <span
                                  style={{
                                    color: "var(--ink-3, #8a9498)",
                                    fontWeight: 400,
                                  }}
                                >
                                  {effectiveSectionUnit}
                                </span>
                              </span>
                            </BTd>
                            <BTd
                              style={{
                                padding: "10px 14px",
                                textAlign: "right",
                                fontVariantNumeric: "tabular-nums",
                                fontWeight: 700,
                                color: "var(--teal-900, #0f4a56)",
                                whiteSpace: "nowrap",
                              }}
                            >
                              {pctDisplay ? (
                                <>
                                  <span>{pctDisplay}</span>
                                  <span
                                    style={{
                                      color: "var(--ink-3, #8a9498)",
                                      fontWeight: 400,
                                    }}
                                  >
                                    %
                                  </span>
                                </>
                              ) : null}
                            </BTd>
                            <BTd
                              style={{
                                padding: "10px 14px",
                                textAlign: "right",
                                fontVariantNumeric: "tabular-nums",
                                fontWeight: 700,
                                color: "var(--teal-900, #0f4a56)",
                                whiteSpace: "nowrap",
                              }}
                            >
                              <span>{residualDisplay}</span>
                              <span
                                style={{
                                  color: "var(--ink-3, #8a9498)",
                                  fontWeight: 400,
                                }}
                              >
                                %
                              </span>
                            </BTd>
                            <BTd style={{ padding: "10px 14px" }} />
                          </tr>
                        </tbody>
                      </table>
                    </div>
                  );
                })()
              : null}
          </>
        );
      })()}

    </section>
  );
}

function BTh({ children, style }: { children?: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <th
      style={{
        textAlign: "left",
        padding: "8px 12px",
        fontSize: 10.5,
        fontWeight: 700,
        letterSpacing: "0.1em",
        textTransform: "uppercase",
        color: "var(--ink-3, #8a9498)",
        borderBottom: "1.5px solid var(--teal-700, #1d6c7b)",
        ...style,
      }}
    >
      {children}
    </th>
  );
}
function BTd({ children, style }: { children?: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <td style={{ padding: "8px 12px", verticalAlign: "middle", ...style }}>
      {children}
    </td>
  );
}

// -----------------------------------------------------------------------------
// CustomerSection — customer picker for the Product Details card.
// Ports the visual pattern from /start's Customer section: Existing / New
// customer tabs, search input with debounced typeahead, a picked pill
// with a Change affordance, and a New-customer form. Reuses the same
// tab / pill / input styles /start already established (redefined here
// as local CSSProperties objects because /start's styles module isn't
// exported).
//
// TODO: the New-customer form currently only captures the fields — it
// does NOT write a new customers row. The plan is to wire it through a
// dedicated POST /api/customers endpoint (or reuse the /start flow's
// insert path) so the operator can create + immediately pin a customer
// from the formula editor. Until then, the form only serves as a
// placeholder for the eventual UX.
// -----------------------------------------------------------------------------
function CustomerSection(props: {
  customerId: string | null;
  customerName: string | null;
  customerShipTo: string | null;
  customerMode: "existing" | "new";
  editing: boolean;
  search: string;
  results: CustomerRow[];
  newCustomer: { name: string; contact: string; email: string };
  onSetMode: (m: "existing" | "new") => void;
  onSearchChange: (v: string) => void;
  onPick: (c: CustomerRow) => void;
  onClear: () => void;
  onStartEdit: () => void;
  onNewCustomerChange: (
    patch: Partial<{ name: string; contact: string; email: string }>,
  ) => void;
}) {
  const {
    customerId,
    customerName,
    customerShipTo,
    customerMode,
    editing,
    search,
    results,
    newCustomer,
    onSetMode,
    onSearchChange,
    onPick,
    onClear,
    onStartEdit,
    onNewCustomerChange,
  } = props;

  // Section styles — mirror /start's approach so the picker reads as an
  // obvious sibling of the identity row. Small uppercase label, tab
  // pills, teal-on-cream inputs.
  const sectionLabel: React.CSSProperties = {
    fontSize: 11,
    fontWeight: 700,
    letterSpacing: "0.08em",
    textTransform: "uppercase",
    color: "var(--ink-3, #8a9498)",
    marginBottom: 10,
  };
  const inputStyle: React.CSSProperties = {
    width: "100%",
    padding: "10px 14px",
    border: "1.5px solid #e3dcc9",
    borderRadius: 8,
    fontSize: 14,
    background: "#fff",
    color: "var(--ink-1)",
    boxSizing: "border-box",
    fontFamily: "inherit",
  };
  const tabsStyle: React.CSSProperties = {
    display: "inline-flex",
    gap: 0,
    marginBottom: 12,
    border: "1.5px solid #e3dcc9",
    borderRadius: 10,
    padding: 4,
    background: "#fffdf8",
  };
  const tabBtn = (active: boolean): React.CSSProperties => ({
    padding: "6px 16px",
    border: "none",
    borderRadius: 6,
    background: active ? "var(--teal-900, #0f4a56)" : "transparent",
    color: active ? "#fff" : "var(--teal-700, #1d6c7b)",
    fontWeight: 700,
    fontSize: 12,
    cursor: "pointer",
    fontFamily: "inherit",
  });
  const selectedRow: React.CSSProperties = {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "flex-start",
    padding: "12px 14px",
    background: "#fff",
    border: "1.5px solid #e3dcc9",
    borderRadius: 8,
    gap: 12,
  };
  const changeBtn: React.CSSProperties = {
    background: "transparent",
    border: "none",
    color: "var(--teal-700, #1d6c7b)",
    fontWeight: 700,
    fontSize: 12,
    cursor: "pointer",
    padding: "2px 6px",
    fontFamily: "inherit",
  };
  const labelText: React.CSSProperties = {
    fontSize: 11,
    fontWeight: 700,
    letterSpacing: "0.08em",
    textTransform: "uppercase",
    color: "var(--ink-3, #8a9498)",
  };

  const showPicked =
    customerMode === "existing" && !!customerId && !!customerName && !editing;

  return (
    <div
      style={{
        marginTop: 14,
        paddingTop: 12,
        borderTop: "1px dashed var(--line, #e3dcc9)",
      }}
    >
      <p style={sectionLabel}>Customer</p>
      {showPicked ? (
        <div style={selectedRow}>
          <div>
            <div
              style={{
                fontSize: 15,
                fontWeight: 700,
                color: "var(--ink-1)",
              }}
            >
              {customerName}
            </div>
            {customerShipTo ? (
              <div
                style={{
                  fontSize: 13,
                  color: "var(--ink-3, #8a9498)",
                  marginTop: 2,
                }}
              >
                {customerShipTo}
              </div>
            ) : null}
          </div>
          <button type="button" style={changeBtn} onClick={onStartEdit}>
            Change
          </button>
        </div>
      ) : (
        <>
          <div style={tabsStyle}>
            <button
              type="button"
              style={tabBtn(customerMode === "existing")}
              onClick={() => onSetMode("existing")}
            >
              Existing
            </button>
            <button
              type="button"
              style={tabBtn(customerMode === "new")}
              onClick={() => onSetMode("new")}
            >
              New customer
            </button>
          </div>
          {customerMode === "existing" ? (
            <>
              <input
                type="text"
                placeholder="Search customers…"
                value={search}
                onChange={(e) => onSearchChange(e.target.value)}
                style={inputStyle}
              />
              <div
                style={{
                  marginTop: 10,
                  display: "flex",
                  flexDirection: "column",
                  gap: 6,
                }}
              >
                {results.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => onPick(c)}
                    style={{
                      textAlign: "left",
                      padding: "10px 12px",
                      background: "#fff",
                      border: "1px solid #e3dcc9",
                      borderRadius: 8,
                      cursor: "pointer",
                      fontFamily: "inherit",
                    }}
                  >
                    <div
                      style={{
                        fontSize: 14,
                        fontWeight: 700,
                        color: "var(--ink-1)",
                      }}
                    >
                      {c.name}
                    </div>
                    {c.default_ship_to ? (
                      <div
                        style={{
                          fontSize: 12,
                          color: "var(--ink-3, #8a9498)",
                          marginTop: 2,
                        }}
                      >
                        {c.default_ship_to}
                      </div>
                    ) : null}
                  </button>
                ))}
              </div>
              {/* Give the operator an explicit "unassign" affordance when
                  they're re-editing but still hold a saved customerId.
                  Fires the identity PUT with customerId: null. */}
              {customerId ? (
                <button
                  type="button"
                  onClick={onClear}
                  style={{
                    marginTop: 10,
                    background: "transparent",
                    border: "none",
                    color: "var(--ink-3, #8a9498)",
                    fontSize: 11,
                    fontWeight: 700,
                    letterSpacing: "0.06em",
                    textTransform: "uppercase",
                    cursor: "pointer",
                    padding: 0,
                  }}
                >
                  Clear customer
                </button>
              ) : null}
            </>
          ) : (
            // TODO: wire this form to an actual create-customer POST so
            // the operator can create + pin a new customers row without
            // leaving the formula editor. Right now the fields are
            // captured locally but never persisted — matches the visual
            // requirement in the spec while leaving the DB write for a
            // follow-up.
            <div
              style={{ display: "flex", flexDirection: "column", gap: 10 }}
            >
              <label
                style={{ display: "flex", flexDirection: "column", gap: 4 }}
              >
                <span style={labelText}>Company name *</span>
                <input
                  type="text"
                  value={newCustomer.name}
                  onChange={(e) =>
                    onNewCustomerChange({ name: e.target.value })
                  }
                  style={inputStyle}
                />
              </label>
              <label
                style={{ display: "flex", flexDirection: "column", gap: 4 }}
              >
                <span style={labelText}>Primary contact</span>
                <input
                  type="text"
                  value={newCustomer.contact}
                  onChange={(e) =>
                    onNewCustomerChange({ contact: e.target.value })
                  }
                  style={inputStyle}
                />
              </label>
              <label
                style={{ display: "flex", flexDirection: "column", gap: 4 }}
              >
                <span style={labelText}>Email</span>
                <input
                  type="email"
                  value={newCustomer.email}
                  onChange={(e) =>
                    onNewCustomerChange({ email: e.target.value })
                  }
                  style={inputStyle}
                />
              </label>
              <p
                style={{
                  fontSize: 11,
                  color: "var(--ink-3, #8a9498)",
                  margin: "2px 0 0",
                  fontStyle: "italic",
                }}
              >
                New customer creation coming soon — for now, add the
                customer via /start, then pick it here.
              </p>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// -----------------------------------------------------------------------------
// LabelClaimsSection — active-ingredient label claims for the Product
// Details card. Each row is: [ingredient picker] · [amount] · [unit] · [x].
// Ingredient picker reuses IngredientPicker so it behaves the same as the
// per-blend picker (type-to-search, PC-RW + curated raw_materials, picked
// state collapses to a pill).
// -----------------------------------------------------------------------------
function LabelClaimsSection({
  claims,
  rawMaterials,
  onAdd,
  onUpdate,
  onRemove,
}: {
  claims: LabelClaim[];
  rawMaterials: RawMaterialOption[];
  onAdd: () => void;
  onUpdate: (id: string, patch: Partial<LabelClaim>) => void;
  onRemove: (id: string) => void;
}) {
  // Build the same lookup the parent uses so we can resolve a claim's
  // rawMaterialId or rawMaterialFpCode back to a RawMaterialOption without
  // threading another prop.
  const rmById = useMemo(() => {
    const m = new Map<string, RawMaterialOption>();
    for (const r of rawMaterials) m.set(r.id, r);
    return m;
  }, [rawMaterials]);
  const rmByFpCode = useMemo(() => {
    const m = new Map<string, RawMaterialOption>();
    for (const r of rawMaterials) {
      if (r.fpCode) m.set(r.fpCode.toUpperCase(), r);
    }
    return m;
  }, [rawMaterials]);

  function resolveClaim(c: LabelClaim): RawMaterialOption | null {
    if (c.rawMaterialId) {
      const hit = rmById.get(c.rawMaterialId);
      if (hit) return hit;
    }
    if (c.rawMaterialFpCode) {
      const hit = rmByFpCode.get(c.rawMaterialFpCode.toUpperCase());
      if (hit) return hit;
    }
    return null;
  }

  return (
    <div
      style={{
        marginTop: 14,
        paddingTop: 12,
        borderTop: "1px dashed var(--line, #e3dcc9)",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          marginBottom: 8,
        }}
      >
        <div>
          <div
            style={{
              fontSize: 18,
              fontWeight: 800,
              color: "var(--teal-900, #0f4a56)",
              letterSpacing: "-0.005em",
              lineHeight: 1.15,
            }}
          >
            Label claims{" "}
            <span
              style={{
                fontSize: 13,
                fontWeight: 500,
                color: "var(--ink-3, #8a9498)",
              }}
            >
              (active ingredients only)
            </span>
          </div>
          <div
            style={{
              fontSize: 11,
              color: "var(--ink-3, #8a9498)",
              marginTop: 2,
            }}
          >
            Per-gummy amount as printed on the finished label.{" "}
            <strong style={{ color: "var(--ink-2, #415056)" }}>
              Values are for one (1) gummy.
            </strong>
          </div>
        </div>
        <button
          type="button"
          onClick={onAdd}
          style={{
            padding: "6px 12px",
            background: "var(--paper, #fffdf8)",
            border: "1px solid var(--teal-700, #1d6c7b)",
            borderRadius: 6,
            fontSize: 11,
            fontWeight: 700,
            letterSpacing: "0.06em",
            textTransform: "uppercase",
            color: "var(--teal-900, #0f4a56)",
            cursor: "pointer",
            whiteSpace: "nowrap",
          }}
        >
          + Add ingredient
        </button>
      </div>

      {claims.length === 0 ? (
        <div
          style={{
            padding: "10px 12px",
            fontSize: 12,
            color: "var(--ink-3, #8a9498)",
            background: "var(--paper, #fffdf8)",
            border: "1px dashed var(--line, #e3dcc9)",
            borderRadius: 6,
          }}
        >
          No label claims yet. Click <strong>Add ingredient</strong> to
          declare an active.
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {claims.map((c) => {
            const resolved = resolveClaim(c);
            return (
              <LabelClaimRow key={c.id} onRemove={() => onRemove(c.id)}>
                <IngredientPicker
                  row={{
                    rawMaterialId: c.rawMaterialId,
                    rawMaterialFpCode: c.rawMaterialFpCode ?? null,
                    customName: c.customName ?? null,
                  }}
                  resolved={resolved}
                  rawMaterials={rawMaterials}
                  onPick={(opt) =>
                    onUpdate(c.id, {
                      rawMaterialId:
                        opt.source === "fishbowl" ? null : opt.id,
                      rawMaterialFpCode:
                        opt.source === "fishbowl" ? opt.fpCode : null,
                      customName: null,
                    })
                  }
                  onPickCustom={(name) =>
                    onUpdate(c.id, {
                      rawMaterialId: null,
                      rawMaterialFpCode: null,
                      customName: name,
                    })
                  }
                  onClear={() =>
                    onUpdate(c.id, {
                      rawMaterialId: null,
                      rawMaterialFpCode: null,
                      customName: null,
                    })
                  }
                />
                <input
                  type="number"
                onFocus={(e) => {
                  // Chrome's <input type="number"> doesn't select on
                  // focus synchronously — defer one frame so the
                  // digits are highlighted and any keystroke replaces
                  // the placeholder 0 instead of prepending to it.
                  const el = e.currentTarget;
                  setTimeout(() => {
                    try { el.select(); } catch {}
                  }, 0);
                }}
                  value={Number.isFinite(c.amount) ? c.amount : 0}
                  onChange={(e) => {
                    const n = Number(e.target.value);
                    onUpdate(c.id, { amount: Number.isFinite(n) ? n : 0 });
                  }}
                  step="0.01"
                  min={0}
                  className="pricing__input"
                  style={{
                    textAlign: "right",
                    fontVariantNumeric: "tabular-nums",
                  }}
                  placeholder="Amount"
                />
                <select
                  value={c.unit}
                  onChange={(e) =>
                    onUpdate(c.id, { unit: e.target.value as LabelClaimUnit })
                  }
                  className="pricing__input"
                >
                  {LABEL_CLAIM_UNITS.map((u) => (
                    <option key={u} value={u}>
                      {u}
                    </option>
                  ))}
                </select>
              </LabelClaimRow>
            );
          })}
        </div>
      )}
    </div>
  );
}

// -----------------------------------------------------------------------------
// BlendIngredientRow — wraps a blend-section table row so the delete
// affordance stays hidden until the rep hovers the row. Reveals a small
// × on hover that clears the entire ingredient line.
// -----------------------------------------------------------------------------
function BlendIngredientRow({
  onRemove,
  dnd,
  hideDelete,
  children,
}: {
  onRemove: () => void;
  /** Drag-and-drop wiring, produced by BlendSectionCard. When present,
   *  the row becomes draggable and renders a ⋮⋮ handle in the gutter of
   *  its first cell. Optional so any callers that don't need DnD (none
   *  today, but future variants like a read-only view) can skip it. */
  dnd?: {
    trProps: React.HTMLAttributes<HTMLTableRowElement> & { draggable: boolean };
    trStyle?: React.CSSProperties;
    renderHandle: (hover: boolean) => React.ReactNode;
  };
  /** When true, the trailing delete-× cell renders an empty placeholder
   *  instead of a removal button. Used by claim-sourced Secondary Blend
   *  rows — deletion happens by removing the label claim in Product
   *  Details, not by clicking × on the row. */
  hideDelete?: boolean;
  children: React.ReactNode;
}) {
  const [hover, setHover] = useState(false);
  // Splice the drag handle into the first child cell as an
  // absolutely-positioned overlay. Callers always pass a leading <BTd>
  // as the first child (the Ingredient cell), so cloneElement wraps its
  // children with the handle + gives it `position: relative` so the
  // handle can absolute-position inside it. This avoids adding a real
  // column, which would misalign with the shared thead's colgroup.
  const decoratedChildren = React.useMemo(() => {
    if (!dnd) return children;
    const arr = React.Children.toArray(children);
    if (arr.length === 0) return children;
    const [first, ...rest] = arr;
    const firstEl = first as React.ReactElement<{
      children?: React.ReactNode;
      style?: React.CSSProperties;
    }>;
    const injected = React.cloneElement(firstEl, {
      style: { position: "relative", ...(firstEl.props.style ?? null) },
      children: (
        <>
          {dnd.renderHandle(hover)}
          {firstEl.props.children}
        </>
      ),
    });
    return (
      <>
        {injected}
        {rest}
      </>
    );
  }, [dnd, children, hover]);
  return (
    <tr
      style={{
        borderTop: "1px solid var(--line-2, #efe9da)",
        background: hover ? "var(--cream-soft, #fbf6ec)" : "transparent",
        transition: "background 80ms ease, opacity 80ms ease",
        ...(dnd?.trStyle ?? null),
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      {...(dnd?.trProps ?? {})}
    >
      {decoratedChildren}
      <BTd style={{ textAlign: "center", width: 40 }}>
        {hideDelete ? null : (
          <button
            type="button"
            onClick={onRemove}
            title="Remove ingredient"
            aria-label="Remove ingredient"
            style={{
              background: "transparent",
              border: "none",
              color: "var(--ink-3, #8a9498)",
              cursor: "pointer",
              fontSize: 16,
              lineHeight: 1,
              padding: 4,
              opacity: hover ? 1 : 0,
              transition: "opacity 80ms ease",
            }}
          >
            ×
          </button>
        )}
      </BTd>
    </tr>
  );
}

// -----------------------------------------------------------------------------
// SolutionRow — blend-section row for a pre-mixed solution. Renders across
// all three columns (colSpan=3) with its own compound layout:
//   - solution name input + total grams
//   - one row per component ingredient (picker · % · × on hover)
//   - "+ Add component" button
// Components' % values should sum to 100; a small summary shows the running
// total in real time.
// -----------------------------------------------------------------------------
function SolutionRow({
  row,
  rawMaterials,
  savedSolutions,
  sectionUnit,
  unitFactor,
  onUpdate,
  onSaveToLibrary,
  onRemove,
  pctOfFinishedText,
  residualMoistureText,
  showOverageColumn,
  dnd,
}: {
  row: GummyFormulaIngredient;
  rawMaterials: RawMaterialOption[];
  savedSolutions: SavedSolution[];
  sectionUnit: LabelClaimUnit;
  unitFactor: number;
  onUpdate: (patch: Partial<GummyFormulaIngredient>) => void;
  onSaveToLibrary: () => Promise<
    { ok: true; solution: SavedSolution } | { ok: false; error: string }
  >;
  onRemove: () => void;
  /** Cooked-only: pre-formatted "% of finished product" for this row's
   *  grams. When provided, the row renders an extra column between the
   *  grams input and the delete button, matching the outer thead's
   *  "% of finished product" column so the numbers line up vertically. */
  pctOfFinishedText?: string;
  /** Cooked-only: pre-formatted "Residual Moisture %" for this row.
   *  Empty string when the solution has no water content (so the
   *  column width still holds but no digits render). undefined on
   *  pre-cook where the column doesn't exist. Paired with
   *  pctOfFinishedText — the two travel together. */
  residualMoistureText?: string;
  /** Secondary-Blend-only: when true, the outer <td> colSpan includes
   *  the Overage % column. Solutions can't be label-claim-sourced (a
   *  claim always seeds a plain ingredient row) so the Overage cell
   *  itself just renders an em-dash inside the row's internal grid. */
  showOverageColumn?: boolean;
  /** Drag-and-drop wiring (same shape as BlendIngredientRow). When
   *  present, the row becomes draggable and renders a ⋮⋮ handle inside
   *  the single spanning <td> at the far left, mirroring the delete-×
   *  opacity-on-hover pattern. */
  dnd?: {
    trProps: React.HTMLAttributes<HTMLTableRowElement> & { draggable: boolean };
    trStyle?: React.CSSProperties;
    renderHandle: (hover: boolean) => React.ReactNode;
  };
}) {
  const showPctCell = pctOfFinishedText !== undefined;
  const showResidualCell = residualMoistureText !== undefined;
  const showOverageCell = showOverageColumn === true;
  const [hover, setHover] = useState(false);
  const [saveState, setSaveState] = useState<
    | { kind: "idle" }
    | { kind: "saving" }
    | { kind: "ok"; when: number }
    | { kind: "err"; text: string }
  >({ kind: "idle" });
  const components: SolutionComponent[] = row.solutionComponents ?? [];
  const totalPct = components.reduce((s, c) => s + (Number(c.pct) || 0), 0);
  const nameTrimmed = (row.customName ?? "").trim();
  const canSave = nameTrimmed.length > 0 && components.length > 0;

  // Is the current row already in the library? Check by case-insensitive
  // name match. If the name matches AND the components look the same
  // (same identifiers and same %), it's an exact match — show a static
  // "Saved to library" pill and hide the Save button. If just the name
  // matches (but components differ), fall back to showing a save button
  // so the rep can update the library entry.
  const librarySolution = useMemo(() => {
    if (!nameTrimmed) return null;
    const lower = nameTrimmed.toLowerCase();
    return savedSolutions.find((s) => s.name.trim().toLowerCase() === lower) ?? null;
  }, [nameTrimmed, savedSolutions]);
  const componentsMatchLibrary = useMemo(() => {
    if (!librarySolution) return false;
    if (components.length !== librarySolution.components.length) return false;
    // Compare by (rawMaterialId | rawMaterialFpCode | customName) + pct.
    // Component ids differ per instance so we ignore them.
    const key = (c: SolutionComponent) =>
      `${c.rawMaterialId ?? ""}|${(c.rawMaterialFpCode ?? "").toUpperCase()}|${(c.customName ?? "").trim().toLowerCase()}|${Number(c.pct) || 0}`;
    const rowKeys = components.map(key).sort();
    const libKeys = librarySolution.components.map(key).sort();
    return rowKeys.every((k, i) => k === libKeys[i]);
  }, [librarySolution, components]);
  const isAlreadySaved = !!librarySolution && componentsMatchLibrary;
  // Once a solution has a name, collapse to a pill (like the ingredient
  // picker's picked state). "Change" flips back to editing so the rep
  // can rename or swap the whole solution out.
  const [nameEditing, setNameEditing] = useState<boolean>(nameTrimmed === "");

  async function handleSave() {
    setSaveState({ kind: "saving" });
    const res = await onSaveToLibrary();
    if (res.ok) {
      setSaveState({ kind: "ok", when: Date.now() });
      // Auto-clear the "Saved" flash after a moment.
      setTimeout(() => {
        setSaveState((s) => (s.kind === "ok" ? { kind: "idle" } : s));
      }, 2500);
    } else {
      setSaveState({ kind: "err", text: res.error });
    }
  }
  // Composition collapses by default so the pre-cook table stays scannable.
  // Auto-expand new solutions (no components filled in yet) so the rep isn't
  // confused about where to add them.
  const isFresh =
    components.length === 0 ||
    components.every(
      (c) =>
        !c.rawMaterialId &&
        !c.rawMaterialFpCode &&
        !c.customName &&
        (Number(c.pct) || 0) === 0,
    );
  const [expanded, setExpanded] = useState<boolean>(isFresh);

  function updateComponent(id: string, patch: Partial<SolutionComponent>) {
    onUpdate({
      solutionComponents: components.map((c) =>
        c.id === id ? { ...c, ...patch } : c,
      ),
    });
  }
  function addComponent() {
    onUpdate({
      solutionComponents: [...components, emptySolutionComponent()],
    });
  }
  function removeComponent(id: string) {
    onUpdate({
      solutionComponents: components.filter((c) => c.id !== id),
    });
  }

  return (
    <tr
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        borderTop: "1px solid var(--line-2, #efe9da)",
        background: hover ? "var(--cream-soft, #fbf6ec)" : "transparent",
        transition: "background 80ms ease, opacity 80ms ease",
        ...(dnd?.trStyle ?? null),
      }}
      {...(dnd?.trProps ?? {})}
    >
      <td
        colSpan={
          // Base columns: Ingredient + Grams + delete = 3.
          // + Overage column (Secondary Blend only) = +1
          // + % of finished product (cooked-card subsections) = +1
          // + Residual Moisture % (cooked-card subsections) = +1
          3 + (showOverageCell ? 1 : 0) + (showPctCell ? 1 : 0) + (showResidualCell ? 1 : 0)
        }
        style={{ padding: "10px 0", verticalAlign: "top", position: "relative" }}
      >
        {dnd ? dnd.renderHandle(hover) : null}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 8,
          }}
        >
          {/* Header row — name, [Overage?], grams, [% of finished?],
              [residual?], remove button. Column widths match the outer
              ingredient table (Overage = 90, grams = 120, % = 120,
              delete = 40) so every input/value lines up vertically
              with ingredient rows above and below. Overage only exists
              on the Secondary Blend subsection; % / residual only
              exist on cooked-card subsections (see
              renderIngredientsBlock's pctBaseG param). */}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: [
                "1fr",
                showOverageCell ? "90px" : null,
                "120px",
                showPctCell ? "120px" : null,
                showResidualCell ? "120px" : null,
                "40px",
              ]
                .filter((v): v is string => v !== null)
                .join(" "),
              gap: 0,
              alignItems: "center",
            }}
          >
            {/* Picker column — pad-left 12 to match BTd horizontal
                padding so the name/label lines up with ingredient
                pickers above. */}
            <div style={{ display: "flex", flexDirection: "column", paddingLeft: 12 }}>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  marginBottom: 2,
                }}
              >
                <span
                  style={{
                    fontSize: 10,
                    fontWeight: 700,
                    letterSpacing: "0.1em",
                    textTransform: "uppercase",
                    color: "var(--teal-700, #1d6c7b)",
                  }}
                >
                  Solution
                </span>
                <span
                  style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
                >
                  {isAlreadySaved ? (
                    // Solution already exists in the library with the
                    // exact same components — no reason to show a save
                    // button. Static "In library" pill instead.
                    <span
                      title="This solution matches an entry in the library"
                      style={{
                        fontSize: 10.5,
                        fontWeight: 700,
                        letterSpacing: "0.06em",
                        textTransform: "uppercase",
                        color: "var(--teal-700, #1d6c7b)",
                        border: "1px solid var(--teal-700, #1d6c7b)",
                        borderRadius: 6,
                        padding: "2px 8px",
                      }}
                    >
                      Saved to library
                    </span>
                  ) : (
                    <>
                      {saveState.kind === "ok" ? (
                        <span
                          style={{
                            fontSize: 10.5,
                            fontWeight: 700,
                            color: "var(--teal-700, #1d6c7b)",
                            letterSpacing: "0.06em",
                            textTransform: "uppercase",
                          }}
                        >
                          Saved to library
                        </span>
                      ) : saveState.kind === "err" ? (
                        <span
                          title={saveState.text}
                          style={{
                            fontSize: 10.5,
                            fontWeight: 700,
                            color: "#8b2f2f",
                            letterSpacing: "0.06em",
                            textTransform: "uppercase",
                          }}
                        >
                          Save failed
                        </span>
                      ) : null}
                      <button
                        type="button"
                        onClick={handleSave}
                        disabled={!canSave || saveState.kind === "saving"}
                        title={
                          canSave
                            ? librarySolution
                              ? "This name matches a library entry but components differ — click to overwrite the library version"
                              : "Save this solution to the library so other formulas can pick it"
                            : "Give the solution a name and at least one component before saving"
                        }
                        style={{
                          fontSize: 10.5,
                          fontWeight: 700,
                          letterSpacing: "0.06em",
                          textTransform: "uppercase",
                          color: canSave
                            ? "var(--teal-700, #1d6c7b)"
                            : "var(--ink-3, #8a9498)",
                          background: "transparent",
                          border: "1px solid var(--line, #e3dcc9)",
                          borderRadius: 6,
                          padding: "2px 8px",
                          cursor:
                            canSave && saveState.kind !== "saving" ? "pointer" : "not-allowed",
                        }}
                      >
                        {saveState.kind === "saving"
                          ? "Saving…"
                          : librarySolution
                            ? "Update in library"
                            : "Save to library"}
                      </button>
                    </>
                  )}
                </span>
              </div>
              {nameTrimmed !== "" && !nameEditing ? (
                <div
                  className="pricing__input"
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                  }}
                  title={nameTrimmed}
                >
                  <span
                    style={{
                      flex: 1,
                      minWidth: 0,
                      whiteSpace: "nowrap",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      fontWeight: 700,
                      color: "var(--teal-900, #0f4a56)",
                    }}
                  >
                    {nameTrimmed}
                  </span>
                  <button
                    type="button"
                    onClick={() => setNameEditing(true)}
                    style={{
                      fontSize: 10.5,
                      fontWeight: 700,
                      letterSpacing: "0.08em",
                      textTransform: "uppercase",
                      color: "var(--teal-700, #1d6c7b)",
                      background: "transparent",
                      border: "none",
                      padding: 0,
                      cursor: "pointer",
                    }}
                  >
                    Change
                  </button>
                </div>
              ) : (
                <input
                  type="text"
                  value={row.customName ?? ""}
                  onChange={(e) => onUpdate({ customName: e.target.value })}
                  onBlur={() => {
                    // Collapse back to pill on blur if the field has a
                    // value. Otherwise leave the input open so the rep
                    // doesn't lose the field.
                    if ((row.customName ?? "").trim() !== "") {
                      setNameEditing(false);
                    }
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      if ((row.customName ?? "").trim() !== "") {
                        setNameEditing(false);
                      }
                    }
                  }}
                  placeholder="e.g. Citric Acid 50% sol"
                  className="pricing__input"
                  autoComplete="off"
                  autoFocus
                />
              )}
            </div>
            {/* Overage % cell — mirror ingredient-row layout so the
                column widths line up. Solutions can't be claim-sourced
                so this always renders an em-dash. Only present in the
                Secondary Blend subsection. */}
            {showOverageCell ? (
              <div
                style={{
                  textAlign: "right",
                  padding: "0 12px",
                  color: "var(--ink-3, #8a9498)",
                }}
              >
                —
              </div>
            ) : null}
            {/* Grams cell — mirrors BTd padding "8px 12px" so the input
                sits at the same X-coordinate as the grams input in
                ingredient rows above/below. */}
            <div
              style={{
                textAlign: "right",
                padding: "0 12px",
              }}
            >
              <div
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 4,
                }}
              >
                <input
                  type="number"
                onFocus={(e) => {
                  // Chrome's <input type="number"> doesn't select on
                  // focus synchronously — defer one frame so the
                  // digits are highlighted and any keystroke replaces
                  // the placeholder 0 instead of prepending to it.
                  const el = e.currentTarget;
                  setTimeout(() => {
                    try { el.select(); } catch {}
                  }, 0);
                }}
                  value={
                    row.grams !== null && row.grams !== undefined
                      ? row.grams * unitFactor
                      : 0
                  }
                  onChange={(e) => {
                    const n = Number(e.target.value);
                    // Store as grams regardless of display unit so the
                    // saved formula scales identically no matter which
                    // unit the author happened to be viewing.
                    onUpdate({
                      grams: Number.isFinite(n) ? n / unitFactor : 0,
                    });
                  }}
                  step="0.1"
                  min={0}
                  className="pricing__input"
                  style={{
                    width: 80,
                    // Force literal width (see ingredient grams input
                    // above for why this override is needed).
                    flex: "0 0 80px",
                    textAlign: "right",
                    fontVariantNumeric: "tabular-nums",
                  }}
                />
                <span
                  style={{
                    fontSize: 12,
                    color: "var(--ink-3, #8a9498)",
                  }}
                >
                  {sectionUnit}
                </span>
              </div>
            </div>
            {/* % of finished product cell — mirrors BTd padding
                "8px 12px" so the value sits at the same X as the
                ingredient rows' % cell above/below. Only rendered
                when the outer table has the extra % column. */}
            {showPctCell ? (
              <div
                style={{
                  textAlign: "right",
                  padding: "0 12px",
                  fontVariantNumeric: "tabular-nums",
                  whiteSpace: "nowrap",
                }}
              >
                <span>{pctOfFinishedText}</span>
                <span
                  style={{
                    fontSize: 12,
                    color: "var(--ink-3, #8a9498)",
                  }}
                >
                  %
                </span>
              </div>
            ) : null}
            {/* Residual Moisture % cell — mirrors the % of finished
                cell's layout. residualMoistureText is empty when the
                solution has no water content, in which case the cell
                just holds column width without rendering digits. */}
            {showResidualCell ? (
              <div
                style={{
                  textAlign: "right",
                  padding: "0 12px",
                  fontVariantNumeric: "tabular-nums",
                  whiteSpace: "nowrap",
                }}
              >
                {residualMoistureText ? (
                  <>
                    <span>{residualMoistureText}</span>
                    <span
                      style={{
                        fontSize: 12,
                        color: "var(--ink-3, #8a9498)",
                      }}
                    >
                      %
                    </span>
                  </>
                ) : null}
              </div>
            ) : null}
            <button
              type="button"
              onClick={onRemove}
              title="Remove solution"
              aria-label="Remove solution"
              style={{
                background: "transparent",
                border: "none",
                color: "var(--ink-3, #8a9498)",
                cursor: "pointer",
                fontSize: 16,
                lineHeight: 1,
                padding: 4,
                opacity: hover ? 1 : 0,
                transition: "opacity 80ms ease",
              }}
            >
              ×
            </button>
          </div>

          {/* Composition — collapsible sub-section. Header (Composition
              label + running total + chevron) is always visible; the
              component list only renders when expanded. Kept visually
              quiet with just a thin left rule when open.
              paddingLeft/Right 12 mirrors the outer BTd horizontal
              padding so this sub-section still lines up with the
              ingredient columns above. */}
          <div style={{ display: "flex", flexDirection: "column", gap: 4, padding: "0 12px" }}>
            <button
              type="button"
              onClick={() => setExpanded((s) => !s)}
              aria-expanded={expanded}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                width: "100%",
                padding: "4px 6px",
                background: "transparent",
                border: "none",
                cursor: "pointer",
                textAlign: "left",
                color: "var(--teal-900, #0f4a56)",
              }}
            >
              {/* All composition-summary bits sit inline on the left:
                  chevron → "Composition" label → "N components" hint →
                  "Total: %" pill. Keeps the running total right next to
                  the count instead of pushed to the far right edge. */}
              <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                <span
                  aria-hidden="true"
                  style={{
                    fontSize: 9,
                    color: "var(--ink-3, #8a9498)",
                    transform: expanded ? "rotate(90deg)" : "rotate(0deg)",
                    transition: "transform 120ms ease",
                    display: "inline-block",
                    width: 9,
                  }}
                >
                  ▶
                </span>
                <span
                  style={{
                    fontSize: 10,
                    fontWeight: 700,
                    letterSpacing: "0.1em",
                    textTransform: "uppercase",
                    color: "var(--ink-3, #8a9498)",
                  }}
                >
                  Composition
                </span>
                <span
                  style={{
                    fontSize: 11,
                    color: "var(--ink-3, #8a9498)",
                  }}
                >
                  {components.length === 0
                    ? "empty"
                    : `${components.length} component${components.length === 1 ? "" : "s"}`}
                </span>
                <span
                  style={{
                    fontSize: 11,
                    fontVariantNumeric: "tabular-nums",
                    color:
                      Math.abs(totalPct - 100) < 0.01
                        ? "var(--teal-700, #1d6c7b)"
                        : "#8b2f2f",
                    fontWeight: 700,
                  }}
                  title="Component percentages should sum to 100%"
                >
                  Total: {totalPct.toFixed(2)}%
                </span>
              </span>
            </button>
            {expanded ? (
              <div
                style={{
                  padding: "4px 0 4px 12px",
                  marginLeft: 8,
                  borderLeft: "2px solid var(--line-2, #efe9da)",
                  display: "flex",
                  flexDirection: "column",
                  gap: 6,
                }}
              >
                {components.length === 0 ? (
                  <div
                    style={{
                      padding: "6px 0",
                      fontSize: 11.5,
                      color: "var(--ink-3, #8a9498)",
                    }}
                  >
                    No components. Add at least two ingredients.
                  </div>
                ) : (
                  components.map((c) => (
                    <SolutionComponentRow
                      key={c.id}
                      component={c}
                      rawMaterials={rawMaterials}
                      onUpdate={(patch) => updateComponent(c.id, patch)}
                      onRemove={() => removeComponent(c.id)}
                    />
                  ))
                )}
                <button
                  type="button"
                  onClick={addComponent}
                  style={{
                    alignSelf: "flex-start",
                    marginTop: 2,
                    padding: "4px 10px",
                    background: "transparent",
                    color: "var(--teal-900, #0f4a56)",
                    border: "1px dashed var(--line, #e3dcc9)",
                    borderRadius: 6,
                    fontSize: 11.5,
                    fontWeight: 700,
                    cursor: "pointer",
                  }}
                >
                  + Add component
                </button>
              </div>
            ) : null}
          </div>
        </div>
      </td>
    </tr>
  );
}

// -----------------------------------------------------------------------------
// SolutionComponentRow — a single ingredient inside a SolutionRow. Picker
// + % input + delete-on-hover. Reuses IngredientPicker for the picker so
// the same type-to-search flow (curated raw_materials, Fishbowl PC-RW,
// custom "Not in FB") works inside solutions too.
// -----------------------------------------------------------------------------
function SolutionComponentRow({
  component,
  rawMaterials,
  onUpdate,
  onRemove,
}: {
  component: SolutionComponent;
  rawMaterials: RawMaterialOption[];
  onUpdate: (patch: Partial<SolutionComponent>) => void;
  onRemove: () => void;
}) {
  const [hover, setHover] = useState(false);

  const resolved: RawMaterialOption | null = (() => {
    if (component.rawMaterialId) {
      const hit = rawMaterials.find((r) => r.id === component.rawMaterialId);
      if (hit) return hit;
    }
    if (component.rawMaterialFpCode) {
      const q = component.rawMaterialFpCode.toUpperCase();
      const hit = rawMaterials.find(
        (r) => (r.fpCode ?? "").toUpperCase() === q,
      );
      if (hit) return hit;
    }
    return null;
  })();

  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: "grid",
        gridTemplateColumns: "1fr 90px 32px",
        gap: 8,
        alignItems: "center",
      }}
    >
      <IngredientPicker
        row={{
          rawMaterialId: component.rawMaterialId,
          rawMaterialFpCode: component.rawMaterialFpCode ?? null,
          customName: component.customName ?? null,
        }}
        resolved={resolved}
        rawMaterials={rawMaterials}
        onPick={(opt) =>
          onUpdate(
            opt.source === "fishbowl"
              ? {
                  rawMaterialId: null,
                  rawMaterialFpCode: opt.fpCode,
                  customName: null,
                }
              : {
                  rawMaterialId: opt.id,
                  rawMaterialFpCode: opt.fpCode,
                  customName: null,
                },
          )
        }
        onPickCustom={(name) =>
          onUpdate({
            rawMaterialId: null,
            rawMaterialFpCode: null,
            customName: name,
          })
        }
        onClear={() =>
          onUpdate({
            rawMaterialId: null,
            rawMaterialFpCode: null,
            customName: null,
          })
        }
      />
      <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
        <input
          type="number"
                onFocus={(e) => {
                  // Chrome's <input type="number"> doesn't select on
                  // focus synchronously — defer one frame so the
                  // digits are highlighted and any keystroke replaces
                  // the placeholder 0 instead of prepending to it.
                  const el = e.currentTarget;
                  setTimeout(() => {
                    try { el.select(); } catch {}
                  }, 0);
                }}
          value={Number.isFinite(component.pct) ? component.pct : 0}
          onChange={(e) => {
            const n = Number(e.target.value);
            onUpdate({ pct: Number.isFinite(n) ? n : 0 });
          }}
          step="0.1"
          min={0}
          max={100}
          className="pricing__input"
          style={{
            width: "100%",
            textAlign: "right",
            fontVariantNumeric: "tabular-nums",
          }}
        />
        <span style={{ fontSize: 12, color: "var(--ink-3, #8a9498)" }}>%</span>
      </div>
      <button
        type="button"
        onClick={onRemove}
        title="Remove component"
        aria-label="Remove component"
        style={{
          background: "transparent",
          border: "none",
          color: "var(--ink-3, #8a9498)",
          cursor: "pointer",
          fontSize: 14,
          lineHeight: 1,
          padding: 4,
          opacity: hover ? 1 : 0,
          transition: "opacity 80ms ease",
        }}
      >
        ×
      </button>
    </div>
  );
}

// -----------------------------------------------------------------------------
// LabelClaimRow — grid row for a single label claim, with delete affordance
// hidden until hover (matches BlendIngredientRow). Expects three children
// (picker, amount input, unit select) plus the standard row grid.
// -----------------------------------------------------------------------------
function LabelClaimRow({
  onRemove,
  children,
}: {
  onRemove: () => void;
  children: React.ReactNode;
}) {
  const [hover, setHover] = useState(false);
  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: "grid",
        // Picker + amount + unit + delete (delete stays fixed-width so the
        // other columns don't jiggle when the × fades in).
        gridTemplateColumns: "1fr 110px 90px 32px",
        gap: 8,
        alignItems: "center",
      }}
    >
      {children}
      <button
        type="button"
        onClick={onRemove}
        title="Remove claim"
        aria-label="Remove label claim"
        style={{
          width: 28,
          height: 28,
          background: "transparent",
          border: "1px solid var(--line, #e3dcc9)",
          borderRadius: 6,
          color: "var(--ink-3, #8a9498)",
          fontSize: 14,
          fontWeight: 700,
          cursor: "pointer",
          lineHeight: 1,
          opacity: hover ? 1 : 0,
          transition: "opacity 80ms ease",
        }}
      >
        ×
      </button>
    </div>
  );
}

// -----------------------------------------------------------------------------
// IngredientPicker — type-to-search dropdown for picking a raw material
// (curated raw_materials row OR Fishbowl-only PC-RW product). Mirrors the
// Product Code picker on the identity header: shows a compact pill when a
// pick is committed, expands into a text input + filtered results list
// when the rep hits Change (or the row is empty).
// -----------------------------------------------------------------------------
function IngredientPicker({
  row,
  resolved,
  rawMaterials,
  onPick,
  onPickCustom,
  onClear,
}: {
  // Minimal shape so both GummyFormulaIngredient and LabelClaim rows can
  // share this picker — both carry the same rawMaterialId /
  // rawMaterialFpCode / customName fields.
  row: {
    rawMaterialId: string | null;
    rawMaterialFpCode?: string | null;
    customName?: string | null;
  };
  resolved: RawMaterialOption | null;
  rawMaterials: RawMaterialOption[];
  onPick: (opt: RawMaterialOption) => void;
  // Called when the rep chooses to add whatever they've typed as a custom
  // (not-in-Fishbowl, not-in-raw_materials) ingredient. Parent stores the
  // name on the row and clears rawMaterialId / rawMaterialFpCode.
  onPickCustom: (name: string) => void;
  onClear: () => void;
}) {
  const [search, setSearch] = useState("");
  // Consider the row "picked" (collapsed pill state) whenever it resolves
  // to a raw material OR carries a custom name.
  const hasCustom = !resolved && !!row.customName && row.customName.trim() !== "";
  const [editing, setEditing] = useState<boolean>(!resolved && !hasCustom);

  // Auto-collapse to picked state if the row already carries a resolved
  // raw material AND we're not mid-edit.
  useEffect(() => {
    if (resolved && editing && search === "") {
      // Don't force-close; let the rep still change until they blur.
    }
  }, [resolved, editing, search]);

  const results = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return [];
    return rawMaterials
      .filter(
        (r) =>
          (r.fpCode ?? "").toLowerCase().includes(q) ||
          r.name.toLowerCase().includes(q),
      )
      .slice(0, 10);
  }, [search, rawMaterials]);

  if ((resolved || hasCustom) && !editing) {
    const customLabel = row.customName ?? "";
    return (
      <div
        className="pricing__input"
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
        }}
        title={resolved?.name ?? customLabel}
      >
        <span
          style={{
            flex: 1,
            minWidth: 0,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {resolved ? (
            resolved.fpCode ? (
              <>
                <code style={{ fontWeight: 700, color: "var(--teal-900, #0f4a56)" }}>
                  {resolved.fpCode}
                </code>{" "}
                <span style={{ color: "var(--ink-2, #415056)" }}>· {resolved.name}</span>
              </>
            ) : (
              resolved.name
            )
          ) : (
            <span style={{ color: "var(--ink-2, #415056)" }}>{customLabel}</span>
          )}
        </span>
        {!resolved && hasCustom ? (
          <span
            title="Not in Fishbowl or raw_materials — added as a custom ingredient"
            style={{
              fontSize: 10,
              fontWeight: 700,
              letterSpacing: "0.08em",
              textTransform: "uppercase",
              color: "var(--ink-3, #8a9498)",
              border: "1px dashed var(--line, #e3dcc9)",
              borderRadius: 999,
              padding: "1px 6px",
              whiteSpace: "nowrap",
            }}
          >
            Not in FB
          </span>
        ) : null}
        <button
          type="button"
          onClick={() => {
            setEditing(true);
            setSearch("");
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              setEditing(true);
              setSearch("");
            }
          }}
          style={{
            fontSize: 10.5,
            fontWeight: 700,
            letterSpacing: "0.08em",
            textTransform: "uppercase",
            color: "var(--teal-700, #1d6c7b)",
            background: "transparent",
            border: "none",
            padding: 0,
            cursor: "pointer",
          }}
        >
          Change
        </button>
      </div>
    );
  }

  return (
    <div style={{ position: "relative" }}>
      <input
        type="text"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="Type to search PC-RW products or raw materials…"
        className="pricing__input"
        autoComplete="off"
        autoFocus={!!resolved}
        style={{ width: "100%" }}
      />
      {search.trim().length > 0 && results.length > 0 ? (
        <ul
          style={{
            position: "absolute",
            top: "calc(100% + 2px)",
            left: 0,
            right: 0,
            zIndex: 20,
            margin: 0,
            padding: 0,
            listStyle: "none",
            background: "#fff",
            border: "1px solid var(--line, #e3dcc9)",
            borderRadius: 6,
            boxShadow: "0 4px 12px rgba(15,74,86,0.12)",
            maxHeight: 280,
            overflow: "auto",
          }}
        >
          {/* Custom-add option — always available at the top of the
              results list so the rep can skip the picklist entirely for
              ingredients that aren't in Fishbowl yet. */}
          <li>
            <button
              type="button"
              onClick={() => {
                onPickCustom(search.trim());
                setEditing(false);
                setSearch("");
              }}
              style={{
                display: "block",
                width: "100%",
                textAlign: "left",
                padding: "8px 10px",
                background: "var(--cream-soft, #fbf6ec)",
                border: "none",
                borderBottom: "1px solid var(--line-2, #efe9da)",
                cursor: "pointer",
                fontSize: 12,
                color: "var(--teal-900, #0f4a56)",
                fontWeight: 700,
              }}
              title="Add this text as a custom ingredient (not tied to Fishbowl or raw_materials)"
            >
              + Add &ldquo;{search.trim()}&rdquo; as custom ingredient
            </button>
          </li>
          {results.map((r) => (
            <li key={r.id}>
              <button
                type="button"
                onClick={() => {
                  onPick(r);
                  setEditing(false);
                  setSearch("");
                }}
                style={{
                  display: "block",
                  width: "100%",
                  textAlign: "left",
                  padding: "8px 10px",
                  background: "transparent",
                  border: "none",
                  borderBottom: "1px solid var(--line-2, #efe9da)",
                  cursor: "pointer",
                  fontSize: 12,
                }}
                onMouseEnter={(e) =>
                  (e.currentTarget.style.background = "var(--cream-soft, #fbf6ec)")
                }
                onMouseLeave={(e) =>
                  (e.currentTarget.style.background = "transparent")
                }
              >
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    gap: 8,
                  }}
                >
                  <div>
                    {r.fpCode ? (
                      <code
                        style={{
                          fontWeight: 700,
                          color: "var(--teal-900, #0f4a56)",
                        }}
                      >
                        {r.fpCode}
                      </code>
                    ) : null}
                    <div style={{ color: "var(--ink-2, #415056)", marginTop: 2 }}>
                      {r.name}
                    </div>
                  </div>
                  {r.source === "fishbowl" ? (
                    <span
                      title="From Fishbowl; cost not yet imported to raw_materials"
                      style={{
                        fontSize: 10,
                        fontWeight: 700,
                        letterSpacing: "0.08em",
                        textTransform: "uppercase",
                        color: "var(--ink-3, #8a9498)",
                        border: "1px dashed var(--line, #e3dcc9)",
                        borderRadius: 999,
                        padding: "1px 6px",
                      }}
                    >
                      Fishbowl
                    </span>
                  ) : r.source === "builtin" ? (
                    <span
                      title="Built-in ingredient — always available regardless of Fishbowl/raw_materials"
                      style={{
                        fontSize: 10,
                        fontWeight: 700,
                        letterSpacing: "0.08em",
                        textTransform: "uppercase",
                        color: "var(--teal-700, #1d6c7b)",
                        border: "1px dashed var(--teal-700, #1d6c7b)",
                        borderRadius: 999,
                        padding: "1px 6px",
                      }}
                    >
                      Built-in
                    </span>
                  ) : null}
                </div>
              </button>
            </li>
          ))}
        </ul>
      ) : search.trim().length > 0 ? (
        <div
          style={{
            position: "absolute",
            top: "calc(100% + 2px)",
            left: 0,
            right: 0,
            zIndex: 20,
            background: "#fff",
            border: "1px solid var(--line, #e3dcc9)",
            borderRadius: 6,
            boxShadow: "0 4px 12px rgba(15,74,86,0.12)",
            overflow: "hidden",
          }}
        >
          <div
            style={{
              padding: "8px 10px",
              fontSize: 11,
              color: "var(--ink-3, #8a9498)",
              borderBottom: "1px solid var(--line-2, #efe9da)",
            }}
          >
            No raw materials matched &ldquo;{search.trim()}&rdquo;.
          </div>
          <button
            type="button"
            onClick={() => {
              onPickCustom(search.trim());
              setEditing(false);
              setSearch("");
            }}
            style={{
              display: "block",
              width: "100%",
              textAlign: "left",
              padding: "8px 10px",
              background: "var(--cream-soft, #fbf6ec)",
              border: "none",
              cursor: "pointer",
              fontSize: 12,
              color: "var(--teal-900, #0f4a56)",
              fontWeight: 700,
            }}
          >
            + Add &ldquo;{search.trim()}&rdquo; as custom ingredient
          </button>
        </div>
      ) : null}
      {row.rawMaterialId || row.rawMaterialFpCode || row.customName ? (
        <button
          type="button"
          onClick={() => {
            onClear();
            setEditing(true);
            setSearch("");
          }}
          style={{
            marginTop: 4,
            background: "transparent",
            border: "none",
            fontSize: 10.5,
            fontWeight: 700,
            letterSpacing: "0.08em",
            textTransform: "uppercase",
            color: "var(--ink-3, #8a9498)",
            cursor: "pointer",
            padding: 0,
          }}
        >
          Clear selection
        </button>
      ) : null}
    </div>
  );
}

// -----------------------------------------------------------------------------
// AuditTimeline — chronological log of every save event for this formula.
// One row per audit entry with author, time, one-line summary, and an
// expandable "what changed" panel with the structured diff.
// -----------------------------------------------------------------------------

function AuditTimeline({
  events,
  loading,
}: {
  events: GummyFormulaAuditRecord[];
  loading: boolean;
}) {
  // Activity is auxiliary — the audit log is useful when investigating a
  // change but noisy the rest of the time. Collapsed by default; the
  // header is a click target that toggles the events list open.
  const [expanded, setExpanded] = useState(false);
  const countLabel = loading
    ? "loading…"
    : events.length === 0
      ? "no events yet"
      : `${events.length} event${events.length === 1 ? "" : "s"}`;

  return (
    <section
      style={{
        marginTop: 24,
        border: "1px solid var(--line, #e3dcc9)",
        borderRadius: 8,
        background: "var(--paper, #fffdf8)",
        overflow: "hidden",
      }}
    >
      <button
        type="button"
        onClick={() => setExpanded((s) => !s)}
        aria-expanded={expanded}
        style={{
          width: "100%",
          padding: "10px 14px",
          background: "var(--cream, #f6efe3)",
          borderTop: "none",
          borderLeft: "none",
          borderRight: "none",
          borderBottom: expanded
            ? "1.5px solid var(--teal-700, #1d6c7b)"
            : "none",
          display: "flex",
          alignItems: "center",
          gap: 8,
          cursor: "pointer",
          textAlign: "left",
        }}
      >
        <span
          aria-hidden="true"
          style={{
            fontSize: 10,
            color: "var(--teal-900, #0f4a56)",
            transform: expanded ? "rotate(90deg)" : "rotate(0deg)",
            transition: "transform 120ms ease",
            display: "inline-block",
            width: 10,
          }}
        >
          ▶
        </span>
        <span
          style={{
            fontSize: 10.5,
            fontWeight: 700,
            letterSpacing: "0.14em",
            textTransform: "uppercase",
            color: "var(--teal-900, #0f4a56)",
          }}
        >
          Activity
        </span>
        <span
          style={{
            fontSize: 11,
            color: "var(--ink-3, #8a9498)",
          }}
        >
          {countLabel}
        </span>
        <span style={{ flex: 1 }} />
        <span
          style={{
            fontSize: 10.5,
            fontWeight: 700,
            letterSpacing: "0.08em",
            textTransform: "uppercase",
            color: "var(--teal-700, #1d6c7b)",
          }}
        >
          {expanded ? "Hide" : "Show"}
        </span>
      </button>
      {expanded ? (
        events.length === 0 && !loading ? (
          <div
            style={{
              padding: 18,
              fontSize: 12,
              color: "var(--ink-3, #8a9498)",
              textAlign: "center",
            }}
          >
            No changes recorded yet.
          </div>
        ) : (
          <ol style={{ margin: 0, padding: 0, listStyle: "none" }}>
            {events.map((ev) => (
              <AuditRow key={ev.id} event={ev} />
            ))}
          </ol>
        )
      ) : null}
    </section>
  );
}

function AuditRow({ event }: { event: GummyFormulaAuditRecord }) {
  const [expanded, setExpanded] = useState(false);
  const at = new Date(event.at);
  const when = at.toLocaleString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
  const who = event.byDisplay || event.byEmail || "Unknown";
  const kindLabel = {
    created: "Created",
    identity: "Identity edit",
    version: `Version v${event.versionNum ?? "?"}`,
  }[event.kind];
  const kindColor = {
    created: "var(--sage-700, #5f8e3a)",
    identity: "var(--teal-500, #3a8d9c)",
    version: "var(--teal-900, #0f4a56)",
  }[event.kind];

  const hasDiff = event.kind !== "created";

  return (
    <li
      style={{
        padding: "10px 14px",
        borderTop: "1px solid var(--line-2, #efe9da)",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "flex-start",
          gap: 12,
          flexWrap: "wrap",
        }}
      >
        <span
          style={{
            display: "inline-block",
            padding: "1px 8px",
            background: "#fff",
            border: `1px solid ${kindColor}`,
            borderRadius: 999,
            fontSize: 10.5,
            fontWeight: 700,
            letterSpacing: "0.08em",
            textTransform: "uppercase",
            color: kindColor,
            flexShrink: 0,
          }}
        >
          {kindLabel}
        </span>
        <div style={{ flex: 1, minWidth: 240 }}>
          <div style={{ fontSize: 12.5, color: "var(--ink, #1f2a2d)" }}>
            {event.summary}
          </div>
          <div
            style={{
              marginTop: 3,
              fontSize: 11,
              color: "var(--ink-3, #8a9498)",
            }}
          >
            {when} · by <strong>{who}</strong>
          </div>
        </div>
        {hasDiff ? (
          <button
            type="button"
            onClick={() => setExpanded((s) => !s)}
            style={{
              padding: "4px 10px",
              background: "transparent",
              border: "1px solid var(--line, #e3dcc9)",
              borderRadius: 6,
              fontSize: 11,
              fontWeight: 700,
              color: "var(--teal-900, #0f4a56)",
              cursor: "pointer",
              flexShrink: 0,
            }}
          >
            {expanded ? "Hide details" : "Details"}
          </button>
        ) : null}
      </div>
      {expanded && hasDiff ? <AuditDiffPanel event={event} /> : null}
    </li>
  );
}

function AuditDiffPanel({ event }: { event: GummyFormulaAuditRecord }) {
  if (event.kind === "identity") {
    const d = event.diff as IdentityDiff;
    if (!d?.changes || d.changes.length === 0) return null;
    return (
      <div
        style={{
          marginTop: 8,
          padding: "8px 12px",
          background: "var(--cream-soft, #fbf6ec)",
          borderRadius: 6,
          fontSize: 12,
        }}
      >
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <tbody>
            {d.changes.map((c, i) => (
              <tr key={i}>
                <td
                  style={{
                    padding: "3px 8px",
                    fontWeight: 700,
                    color: "var(--ink-3, #8a9498)",
                    textTransform: "capitalize",
                    width: 120,
                  }}
                >
                  {c.field}
                </td>
                <td style={{ padding: "3px 8px", color: "var(--ink-2, #415056)" }}>
                  <code style={{ background: "#fff", padding: "1px 6px", borderRadius: 4 }}>
                    {formatDiffValue(c.from)}
                  </code>{" "}
                  →{" "}
                  <code style={{ background: "#fff", padding: "1px 6px", borderRadius: 4 }}>
                    {formatDiffValue(c.to)}
                  </code>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }
  if (event.kind === "version") {
    const d = event.diff as VersionDiff;
    return (
      <div
        style={{
          marginTop: 8,
          padding: "8px 12px",
          background: "var(--cream-soft, #fbf6ec)",
          borderRadius: 6,
          fontSize: 12,
        }}
      >
        {d.paramChanges?.length > 0 ? (
          <>
            <div
              style={{
                fontSize: 10.5,
                fontWeight: 700,
                letterSpacing: "0.1em",
                textTransform: "uppercase",
                color: "var(--ink-3, #8a9498)",
                marginBottom: 4,
              }}
            >
              Batch parameters
            </div>
            <ul style={{ margin: "0 0 8px 20px", padding: 0 }}>
              {d.paramChanges.map((c, i) => (
                <li key={i} style={{ marginBottom: 2 }}>
                  <strong style={{ color: "var(--teal-900, #0f4a56)" }}>{c.field}</strong>:{" "}
                  <code style={{ background: "#fff", padding: "1px 6px", borderRadius: 4 }}>
                    {c.from}
                  </code>{" "}
                  →{" "}
                  <code style={{ background: "#fff", padding: "1px 6px", borderRadius: 4 }}>
                    {c.to}
                  </code>
                </li>
              ))}
            </ul>
          </>
        ) : null}
        {d.added?.length > 0 ? (
          <>
            <div
              style={{
                fontSize: 10.5,
                fontWeight: 700,
                letterSpacing: "0.1em",
                textTransform: "uppercase",
                color: "var(--sage-700, #5f8e3a)",
                marginBottom: 4,
              }}
            >
              Added ({d.added.length})
            </div>
            <ul style={{ margin: "0 0 8px 20px", padding: 0 }}>
              {d.added.map((r, i) => (
                <li key={i}>
                  {r.rawMaterialId ? r.rawMaterialId.slice(0, 8) + "…" : "(custom)"} @{" "}
                  {r.pctInFinished}%
                </li>
              ))}
            </ul>
          </>
        ) : null}
        {d.removed?.length > 0 ? (
          <>
            <div
              style={{
                fontSize: 10.5,
                fontWeight: 700,
                letterSpacing: "0.1em",
                textTransform: "uppercase",
                color: "#8b2f2f",
                marginBottom: 4,
              }}
            >
              Removed ({d.removed.length})
            </div>
            <ul style={{ margin: "0 0 8px 20px", padding: 0 }}>
              {d.removed.map((r, i) => (
                <li key={i}>
                  {r.rawMaterialId ? r.rawMaterialId.slice(0, 8) + "…" : "(custom)"} @{" "}
                  {r.pctInFinished}%
                </li>
              ))}
            </ul>
          </>
        ) : null}
        {d.modified?.length > 0 ? (
          <>
            <div
              style={{
                fontSize: 10.5,
                fontWeight: 700,
                letterSpacing: "0.1em",
                textTransform: "uppercase",
                color: "var(--teal-500, #3a8d9c)",
                marginBottom: 4,
              }}
            >
              Modified ({d.modified.length})
            </div>
            <ul style={{ margin: "0 0 8px 20px", padding: 0 }}>
              {d.modified.map((r, i) => (
                <li key={i} style={{ marginBottom: 4 }}>
                  <strong>
                    {r.rawMaterialId ? r.rawMaterialId.slice(0, 8) + "…" : "(custom)"}
                  </strong>
                  <ul style={{ margin: "2px 0 0 16px", padding: 0 }}>
                    {r.changes.map((c, j) => (
                      <li key={j} style={{ fontSize: 11 }}>
                        {String(c.field)}:{" "}
                        <code style={{ background: "#fff", padding: "1px 6px", borderRadius: 4 }}>
                          {formatDiffValue(c.from)}
                        </code>{" "}
                        →{" "}
                        <code style={{ background: "#fff", padding: "1px 6px", borderRadius: 4 }}>
                          {formatDiffValue(c.to)}
                        </code>
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          </>
        ) : null}
      </div>
    );
  }
  return null;
}

function formatDiffValue(v: unknown): string {
  if (v === null || v === undefined) return "∅";
  if (v === "") return "(empty)";
  if (typeof v === "boolean") return v ? "true" : "false";
  return String(v);
}
