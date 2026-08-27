// -----------------------------------------------------------------------------
// formulaCosting.ts — server-usable mirror of the FormulaEditor Costing-tab
// math, so GET /api/formulas/[id] can return the SAME per-piece cost figures
// the operator sees on screen (`costingComputed` block consumed by the
// quote-side PricingCalculator).
//
// !!! SOURCE OF TRUTH IS src/app/formulas/[id]/FormulaEditor.tsx !!!
//
// The editor computes these figures inside its render from live React state.
// Extracting that state web into shared functions was judged too invasive for
// the ~9,500-line file (its <style> template literal has broken the Vercel
// build three times), so this module MIRRORS the math instead. If you touch
// the costing math in FormulaEditor, update the matching block here. Line
// references below are against FormulaEditor.tsx as of 2026-07-31:
//
//   isWaterRow ................................ FormulaEditor.tsx 242–246
//   carryOverDefaultMoisturePct ............... FormulaEditor.tsx 156–165
//   computeCarryOverWaterPct .................. FormulaEditor.tsx 275–304
//   computeCarryOverPrimaryNetG ............... FormulaEditor.tsx 311–332
//   computeScaleUpModel ....................... FormulaEditor.tsx 6886–6928
//   scaleUpGummiesOf / scaleUpDailyYield ...... FormulaEditor.tsx 1927–1936
//   resolveRowName ............................ FormulaEditor.tsx 404–415
//   BUILTIN_INGREDIENTS (Water) + dedup ....... FormulaEditor.tsx 138–149, 550–559
//   costingModel (material $) ................. FormulaEditor.tsx 1948–2080
//   materialCostPerGummy null rule ............ FormulaEditor.tsx 4163–4166
//   laborCostPerGummy ......................... FormulaEditor.tsx 2084–2117
//   overheadCostPerGummy ...................... FormulaEditor.tsx 2121–2153
//   defaultLabTests / labTestingCostPerGummy .. FormulaEditor.tsx 2158–2184
//   trueCost (total) rule ..................... FormulaEditor.tsx 7891–7899
//   topDec display rounding ................... FormulaEditor.tsx 854, 7884–7890
//   state seeds (`|| null` semantics etc.) .... FormulaEditor.tsx 637–878
//   OVERHEAD_*_DEFAULTS + 173.33 h/mo ......... FormulaEditor.tsx 72–104
//   roundDays ................................. FormulaEditor.tsx 877–878
// -----------------------------------------------------------------------------

import type {
  GummyFormulaIngredient,
  GummyFormulaVersion,
  LabTestItem,
  LabelClaim,
  OverheadItem,
} from "./formulas";

// The plant's real overhead rows. Imported for LOCAL use here and re-exported
// further down, where the comment explaining the split lives.
import {
  INDIRECT_HOURS_PER_MONTH,
  OVERHEAD_RENT_DEFAULTS,
  OVERHEAD_INDIRECT_DEFAULTS,
  OVERHEAD_OTHER_DEFAULTS,
} from "./overheadCosting";

// -----------------------------------------------------------------------------
// Inputs
// -----------------------------------------------------------------------------

/** Minimal raw-material fields the costing math actually reads. The
 *  editor's RawMaterialOption satisfies this structurally. */
export type CostingRawMaterial = {
  id: string;
  name: string;
  /** Fishbowl nightly-sync costs ($/kg). Null = no Fishbowl data. */
  inventoryCostPerKg?: number | null;
  lastOrderCostPerKg?: number | null;
};

/** ADP reference employees for the Direct Labor default rates — mirrors
 *  page.tsx 140–141 so the API route resolves the same defaults the
 *  editor is seeded with. */
export const LINE_LEADER_ADP_ID = "lacruz anchicoque, leonardo arturo";
export const LINE_OPERATOR_ADP_ID = "oquendo diaz, leticia c";

// -----------------------------------------------------------------------------
// Output contract (consumed by the quote-side PricingCalculator)
// -----------------------------------------------------------------------------

export type CostingComputed = {
  materialUsdPerPiece: number | null;
  laborUsdPerPiece: number | null;
  overheadUsdPerPiece: number | null;
  testingUsdPerPiece: number | null;
  /** "Other costs" card doesn't exist on the Costing tab yet — always
   *  null until GummyFormulaCosting grows that field. */
  otherUsdPerPiece: number | null;
  /** True Cost / gummy: material + labor + overhead + (testing ?? 0),
   *  null unless material, labor AND overhead are all computable —
   *  same rule as the editor's top card (FormulaEditor 7891–7899). */
  totalUsdPerPiece: number | null;
  /** True Cost per 1,000 pieces, rounded to cents from the UNROUNDED
   *  per-piece total — matches the Costing tab's "Cost per Thousand"
   *  readout exactly. The PricingCalculator imports THIS (its sales unit
   *  is 1,000 gummies); deriving it from the topDec-rounded
   *  totalUsdPerPiece × 1000 drifts by a few cents (e.g. 56.80 vs 56.77). */
  costPerThousandUsd: number | null;
  /** True Cost per kg of finished gummies — raw total × (1000 /
   *  gummyPieceWeightG), cents-rounded. Mirrors the Costing tab's
   *  "Cost per Kg" readout (FormulaEditor 7929–7932). Null when the
   *  piece weight isn't set. */
  costPerKgUsd: number | null;
  /** True Cost across the whole run — raw total × targetYieldUnits,
   *  cents-rounded. Mirrors "Total Batch Cost" (FormulaEditor 7934–7937). */
  totalBatchCostUsd: number | null;
  basisTargetYieldUnits: number;
  basisBenchBatchG: number;
};

// -----------------------------------------------------------------------------
// Shared defaults — RE-EXPORTED, no longer copied.
//
// These were a verbatim third copy of the same rows (FormulaEditor had one,
// the bottle board needed one). That mattered the day the lease changed: the
// Sixth Amendment moved PharmaCenter from Suite 400 to Suite 300 years ago and
// only one copy would have been corrected, leaving THIS module — the one the
// quote-side PricingCalculator reads through GET /api/formulas/[id] — quietly
// serving the old unit's rent.
//
// Only the DATA moved. The mirrored MATH below still lives here for the reason
// this file's header gives.
// -----------------------------------------------------------------------------

// The import that backs this sits with the other imports at the top of the
// file, and the two halves must STAY apart. The one-line shorthand
// `export { … } from "./overheadCosting"` re-exports the names for other
// modules but creates no local binding, so every consumer inside this file
// (overheadRent, overheadIndirect, overheadOther, the indirect-hours divisor)
// stops resolving — which is exactly how build 5461e48 failed.
export {
  INDIRECT_HOURS_PER_MONTH,
  OVERHEAD_RENT_DEFAULTS,
  OVERHEAD_INDIRECT_DEFAULTS,
  OVERHEAD_OTHER_DEFAULTS,
};

/** Whole-shift rounding rule (FormulaEditor 877–878): fractions of .25
 *  and up round up to an additional shift; .24 and below round down. */
export function roundDays(x: number): number {
  return x <= 0 ? 0 : Math.floor(x) + (x - Math.floor(x) > 0.24 ? 1 : 0);
}

// -----------------------------------------------------------------------------
// Bench-top / scale-up primitives — verbatim mirrors.
// -----------------------------------------------------------------------------

// FormulaEditor 242–246.
function isWaterRow(r: GummyFormulaIngredient): boolean {
  if (r.rawMaterialId === "builtin:water") return true;
  const name = (r.customName ?? "").trim().toLowerCase();
  return name === "water";
}

// FormulaEditor 156–165.
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

// FormulaEditor 275–304.
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
      const pct = Number.isFinite(raw) ? raw : carryOverDefaultMoisturePct(r);
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

// FormulaEditor 311–332.
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
    const pct = Number.isFinite(raw) ? raw : carryOverDefaultMoisturePct(r);
    const frac = Math.max(0, Math.min(100, pct)) / 100;
    return s + g * (1 - frac);
  }, 0);
}

// FormulaEditor 6886–6928.
export function computeScaleUpModel(params: {
  groups: Record<string, GummyFormulaIngredient[]>;
  benchBatchG: number;
  batchKg: number;
  cfaBatchKg: number;
}) {
  const preCookRows = params.groups["pre-cook"] ?? [];
  const secG = (params.groups["cooked"] ?? []).reduce(
    (s, r) => s + (Number(r.grams) || 0),
    0,
  );
  const finG = (params.groups["final"] ?? []).reduce(
    (s, r) => s + (Number(r.grams) || 0),
    0,
  );
  const totalPrimaryG = preCookRows.reduce(
    (s, r) => s + (Number(r.grams) || 0),
    0,
  );
  const carryNetG = computeCarryOverPrimaryNetG({
    preCookRows,
    benchBatchG: params.benchBatchG,
    secondaryG: secG,
    finalG: finG,
  });
  const carryKg =
    totalPrimaryG > 0 ? (carryNetG * params.batchKg) / totalPrimaryG : 0;
  const cfaKgPerBatch =
    totalPrimaryG > 0
      ? ((carryNetG + secG + finG) * params.batchKg) / totalPrimaryG
      : 0;
  const grandCfaKg =
    carryNetG > 0
      ? params.cfaBatchKg + ((secG + finG) * params.cfaBatchKg) / carryNetG
      : 0;
  return { secG, finG, totalPrimaryG, carryNetG, carryKg, cfaKgPerBatch, grandCfaKg };
}

// FormulaEditor 404–415.
function resolveRowName(
  r: GummyFormulaIngredient,
  rmById: Map<string, CostingRawMaterial>,
): string {
  const custom = (r.customName ?? "").trim();
  if (custom) return custom;
  if (r.rawMaterialId) {
    const hit = rmById.get(r.rawMaterialId);
    if (hit) return (hit.name ?? "").trim();
  }
  return "";
}

/** Round to `dec` places — matches how the editor's top card formats the
 *  per-gummy readouts (toLocaleString currency, min/max fraction digits =
 *  topDec, default halfExpand rounding; FormulaEditor 7884–7890). Costs
 *  are non-negative so Math.round is equivalent. */
function roundTo(v: number, dec: number): number {
  const f = Math.pow(10, dec);
  return Math.round(v * f) / f;
}

// -----------------------------------------------------------------------------
// Main entry — what /api/formulas/[id] calls.
// -----------------------------------------------------------------------------

export function computeCostingComputed(params: {
  version: GummyFormulaVersion;
  /** Curated raw_materials + Fishbowl-only PC-RW entries, exactly like
   *  page.tsx assembles for the editor (curated wins on fp_code dedup;
   *  Fishbowl-only entries use id `fb:<fp_code>` and null costs). The
   *  builtin Water entry is prepended here, mirroring FormulaEditor
   *  550–559. */
  rawMaterials: CostingRawMaterial[];
  /** ADP-synced default hourly rates (page.tsx 140–156). */
  laborRateDefaults: { leader: number | null; operator: number | null };
}): CostingComputed | null {
  const { version, laborRateDefaults } = params;

  // Rule 1: Costing tab never set up → whole block null.
  const costing = version.costing ?? null;
  if (!costing) return null;

  // --- Editor state seeds (FormulaEditor 637–878) ----------------------------
  // NOTE the `|| null` (not `??`) on the labor fields: a stray saved 0
  // means "use the default rule", exactly like the editor.
  const benchBatchG = version.benchBatchG;
  const batchKg = version.batchKg;
  const batchesPerDay = version.batchesPerDay;
  const fixedLossKgPerDay = version.fixedLossKgPerDay;
  const wetCastPieceWeightG = version.wetCastPieceWeightG ?? 0;
  const targetYieldUnits = version.targetYieldUnits ?? 0;
  const cfaBatchKg = version.cfaBatchKg ?? 25;
  const ingredients = version.ingredients;
  const labelClaims: LabelClaim[] = version.labelClaims ?? [];

  const costSourceByKey: Record<string, string> = { ...(costing.sources ?? {}) };
  const manualCostByKey: Record<string, number> = { ...(costing.manualCosts ?? {}) };

  const setupDays = costing.setupDays || null;
  const productionDays = costing.productionDays || null;
  const cleaningDays = costing.cleaningDays || null;
  const setupHours = costing.setupHours || null;
  const productionHours = costing.productionHours || null;
  const cleaningHours = costing.cleaningHours || null;
  const setupLeaders = costing.setupLeaders || null;
  const productionLeaders = costing.productionLeaders || null;
  const cleaningLeaders = costing.cleaningLeaders || null;
  const setupOperators = costing.setupOperators || null;
  const productionOperators = costing.productionOperators || null;
  const cleaningOperators = costing.cleaningOperators || null;
  const leaderRate = costing.leaderRate || null;
  const operatorRate = costing.operatorRate || null;
  const leaderTaxPct = costing.leaderTaxPct || null;
  const operatorTaxPct = costing.operatorTaxPct || null;
  const leaderWcPct = costing.leaderWcPct || null;
  const operatorWcPct = costing.operatorWcPct || null;
  const workingDaysPerMonth = costing.workingDaysPerMonth || null;
  const overheadRent = costing.overheadRent ?? OVERHEAD_RENT_DEFAULTS;
  const overheadIndirect = costing.overheadIndirect ?? OVERHEAD_INDIRECT_DEFAULTS;
  const overheadOther = costing.overheadOther ?? OVERHEAD_OTHER_DEFAULTS;
  const labTestingRm = costing.labTestingRm ?? null;
  const labTestingFp = costing.labTestingFp ?? null;
  const topDec = costing.topDec ?? 4;

  // --- Raw-material lookup (FormulaEditor 550–559, 1154–1158) ----------------
  // Prepend builtin Water unless a real Water row exists, then map by id.
  const seenIds = new Set(params.rawMaterials.map((r) => r.id));
  const seenNames = new Set(
    params.rawMaterials.map((r) => r.name.trim().toLowerCase()),
  );
  const withBuiltins: CostingRawMaterial[] =
    seenIds.has("builtin:water") || seenNames.has("water")
      ? params.rawMaterials
      : [
          {
            id: "builtin:water",
            name: "Water",
            inventoryCostPerKg: null,
            lastOrderCostPerKg: null,
          },
          ...params.rawMaterials,
        ];
  const rmById = new Map<string, CostingRawMaterial>();
  for (const r of withBuiltins) rmById.set(r.id, r);

  // --- Phase grouping + scale-up model (FormulaEditor 1899–1936) -------------
  const groups: Record<string, GummyFormulaIngredient[]> = {
    "pre-cook": [],
    cooking: [],
    cooked: [],
    secondary: [],
    final: [],
  };
  for (const row of ingredients) {
    if (row.blendPhase && groups[row.blendPhase]) groups[row.blendPhase].push(row);
  }
  const scaleUp = computeScaleUpModel({ groups, benchBatchG, batchKg, cfaBatchKg });
  const scaleUpGummiesOf = (kg: number) =>
    wetCastPieceWeightG > 0 ? (kg * 1000) / wetCastPieceWeightG : 0;
  const scaleUpDailyYield =
    wetCastPieceWeightG > 0
      ? (Math.max(0, scaleUp.cfaKgPerBatch * batchesPerDay - fixedLossKgPerDay) *
          1000) /
        wetCastPieceWeightG
      : 0;

  // --- Material $ / gummy (costingModel, FormulaEditor 1948–2080) ------------
  // Dedup ingredient entries (solutions expanded, Water merged), QTYs
  // scaled by batch counts, costs resolved per the saved Cost Source.
  const materialUsdPerPieceRaw = (() => {
    const qtyPrimaryBatches =
      scaleUpGummiesOf(scaleUp.carryKg) > 0
        ? targetYieldUnits / scaleUpGummiesOf(scaleUp.carryKg)
        : 0;
    const qtyCfaBatches =
      scaleUpGummiesOf(scaleUp.grandCfaKg) > 0
        ? targetYieldUnits / scaleUpGummiesOf(scaleUp.grandCfaKg)
        : 0;
    const preKgOf = (grams: number) =>
      scaleUp.totalPrimaryG > 0 ? (grams * batchKg) / scaleUp.totalPrimaryG : 0;
    const cfaKgOf = (grams: number) =>
      scaleUp.carryNetG > 0 ? (grams * cfaBatchKg) / scaleUp.carryNetG : 0;
    type CostEntry = {
      key: string;
      preKg: number;
      cfaKg: number;
      inventoryCostPerKg: number | null;
      lastOrderCostPerKg: number | null;
    };
    const byKey = new Map<string, CostEntry>();
    const order: string[] = [];
    const accumulate = (
      rawMaterialId: string | null,
      nameIn: string,
      col: "pre" | "cfa",
      kg: number,
    ) => {
      const rm = rawMaterialId ? rmById.get(rawMaterialId) : null;
      const name = (nameIn || rm?.name || "").trim();
      if (!name) return;
      const keyName = name.toLowerCase();
      const key =
        keyName === "water" || keyName === "agua"
          ? "name:water"
          : rawMaterialId ?? `name:${keyName}`;
      let e = byKey.get(key);
      if (!e) {
        e = {
          key,
          preKg: 0,
          cfaKg: 0,
          inventoryCostPerKg: rm?.inventoryCostPerKg ?? null,
          lastOrderCostPerKg: rm?.lastOrderCostPerKg ?? null,
        };
        byKey.set(key, e);
        order.push(key);
      }
      if (col === "pre") e.preKg += kg;
      else e.cfaKg += kg;
    };
    for (const r of ingredients) {
      const phase = r.blendPhase;
      const col: "pre" | "cfa" | null =
        phase === "pre-cook"
          ? "pre"
          : phase === "cooked" || phase === "final"
            ? "cfa"
            : null;
      if (!col) continue;
      const grams = Number(r.grams) || 0;
      const rowKg = col === "pre" ? preKgOf(grams) : cfaKgOf(grams);
      const isSolution =
        !r.rawMaterialId && (r.solutionComponents?.length ?? 0) > 0;
      if (isSolution) {
        for (const c of r.solutionComponents ?? []) {
          const share = (Number(c.pct) || 0) / 100;
          accumulate(
            c.rawMaterialId ?? null,
            (c.customName ?? "").trim(),
            col,
            rowKg * share,
          );
        }
      } else {
        accumulate(r.rawMaterialId ?? null, resolveRowName(r, rmById), col, rowKg);
      }
    }
    // Resolved $/kg per the saved Cost Source. Null = the "—" line
    // ("App" source is intentionally null — same as the editor).
    const resolveCostPerKg = (e: CostEntry): number | null => {
      const src = costSourceByKey[e.key] ?? "Fish Bowl (Inventory)";
      if (src === "Fish Bowl (Inventory)") return e.inventoryCostPerKg;
      if (src === "Fish Bowl (Last Order)") return e.lastOrderCostPerKg;
      if (src === "Manual") return manualCostByKey[e.key] ?? null;
      return null;
    };
    let costSum = 0;
    let costMissing = false;
    for (const k of order) {
      const e = byKey.get(k)!;
      const c = resolveCostPerKg(e);
      if (c === null) costMissing = true;
      else costSum += (e.preKg * qtyPrimaryBatches + e.cfaKg * qtyCfaBatches) * c;
    }
    // Null rule from the CostTab call site (FormulaEditor 4163–4166).
    return !costMissing && targetYieldUnits > 0 ? costSum / targetYieldUnits : null;
  })();

  // --- Direct Labor $ / gummy (FormulaEditor 2084–2117) ----------------------
  const laborUsdPerPieceRaw = (() => {
    const prodShifts =
      productionDays ??
      roundDays(scaleUpDailyYield > 0 ? targetYieldUnits / scaleUpDailyYield : 0);
    const shifts = [
      setupDays ?? 1,
      prodShifts,
      cleaningDays ?? roundDays(prodShifts / 4),
    ];
    const hours = [setupHours ?? 8, productionHours ?? 8, cleaningHours ?? 8];
    const phaseHours = shifts.map((s, i) => s * hours[i]);
    const roles = [
      {
        crew: [setupLeaders ?? 0, productionLeaders ?? 0, cleaningLeaders ?? 0],
        base: leaderRate ?? laborRateDefaults.leader ?? 0,
        tax: leaderTaxPct ?? 8.5,
        wc: leaderWcPct ?? 4,
      },
      {
        crew: [setupOperators ?? 0, productionOperators ?? 0, cleaningOperators ?? 0],
        base: operatorRate ?? laborRateDefaults.operator ?? 0,
        tax: operatorTaxPct ?? 8.5,
        wc: operatorWcPct ?? 4,
      },
    ];
    const grand = roles.reduce(
      (s, r) =>
        s +
        r.crew.reduce((a, c, i) => a + c * phaseHours[i], 0) *
          (r.base * (1 + r.tax / 100 + r.wc / 100)),
      0,
    );
    return targetYieldUnits > 0 ? grand / targetYieldUnits : null;
  })();

  // --- Overhead $ / gummy (FormulaEditor 2121–2153) --------------------------
  const overheadUsdPerPieceRaw = (() => {
    const H = INDIRECT_HOURS_PER_MONTH;
    const effRate = (r: OverheadItem) =>
      r.rate ??
      (r.monthly > 0
        ? r.monthly / ((1 + (r.taxPct ?? 8.5) / 100 + (r.wcPct ?? 4) / 100) * H)
        : 0);
    const burdenedOf = (r: OverheadItem) =>
      effRate(r) * (1 + (r.taxPct ?? 8.5) / 100 + (r.wcPct ?? 4) / 100);
    const rowTotal = (r: OverheadItem, mode?: "lease" | "labor") =>
      mode === "labor"
        ? r.payType === "salary"
          ? burdenedOf(r) * (r.qty ?? 1)
          : burdenedOf(r) * (r.hours ?? H) * (r.qty ?? 1)
        : r.monthly + (r.cam ?? 0);
    const chargedOf = (list: OverheadItem[], mode?: "lease" | "labor") =>
      list.reduce((s, r) => s + rowTotal(r, mode) * (r.sharePct / 100), 0);
    const totalMonthly =
      chargedOf(overheadRent, "lease") +
      chargedOf(overheadIndirect, "labor") +
      chargedOf(overheadOther);
    const prodShifts =
      productionDays ??
      roundDays(scaleUpDailyYield > 0 ? targetYieldUnits / scaleUpDailyYield : 0);
    const batchDays =
      (setupDays ?? 1) + prodShifts + (cleaningDays ?? roundDays(prodShifts / 4));
    const workDays = workingDaysPerMonth ?? 21;
    return workDays > 0 && targetYieldUnits > 0
      ? ((totalMonthly / workDays) * batchDays) / targetYieldUnits
      : null;
  })();

  // --- Lab Testing $ / gummy (FormulaEditor 2158–2184) -----------------------
  // Default rule: one $120 potency test per label-claim active plus
  // Microbiology + Yeast & Mold at $80 each, applied to BOTH sub-cards
  // until the operator edits a card (then the saved list wins).
  const testingUsdPerPieceRaw = (() => {
    const actives = labelClaims
      .map((c) => {
        const custom = (c.customName ?? "").trim();
        if (custom) return custom;
        if (c.rawMaterialId) return (rmById.get(c.rawMaterialId)?.name ?? "").trim();
        return "";
      })
      .filter(Boolean)
      .map((label) => ({ label, cost: 120, qty: 1 }));
    const defaultLabTests: LabTestItem[] = [
      ...actives,
      { label: "Microbiology", cost: 80, qty: 1 },
      { label: "Yeast & Mold", cost: 80, qty: 1 },
    ];
    const labRmList = labTestingRm ?? defaultLabTests;
    const labFpList = labTestingFp ?? defaultLabTests;
    return targetYieldUnits > 0
      ? [...labRmList, ...labFpList].reduce(
          (s, t) => s + (Number(t.cost) || 0) * (Number(t.qty) || 0),
          0,
        ) / targetYieldUnits
      : null;
  })();

  // --- True Cost (FormulaEditor 7891–7899) -----------------------------------
  const totalRaw =
    materialUsdPerPieceRaw !== null &&
    laborUsdPerPieceRaw !== null &&
    overheadUsdPerPieceRaw !== null
      ? materialUsdPerPieceRaw +
        laborUsdPerPieceRaw +
        overheadUsdPerPieceRaw +
        (testingUsdPerPieceRaw ?? 0)
      : null;

  // Round to the SAME precision the top card displays (topDec, default 4)
  // so API values match the on-screen figures digit-for-digit. The total
  // is rounded from the raw sum — exactly what the screen shows — so it
  // may differ from the sum of the rounded sub-fields in the last digit.
  const r = (v: number | null) => (v === null ? null : roundTo(v, topDec));
  return {
    materialUsdPerPiece: r(materialUsdPerPieceRaw),
    laborUsdPerPiece: r(laborUsdPerPieceRaw),
    overheadUsdPerPiece: r(overheadUsdPerPieceRaw),
    testingUsdPerPiece: r(testingUsdPerPieceRaw),
    otherUsdPerPiece: null,
    totalUsdPerPiece: r(totalRaw),
    // Cents-rounded from the RAW sum (see CostingComputed docs) — mirrors
    // the Costing tab's Cost per Thousand, which also multiplies before
    // rounding.
    costPerThousandUsd: totalRaw === null ? null : roundTo(totalRaw * 1000, 2),
    costPerKgUsd:
      totalRaw === null || !(version.gummyPieceWeightG > 0)
        ? null
        : roundTo(totalRaw * (1000 / version.gummyPieceWeightG), 2),
    totalBatchCostUsd:
      totalRaw === null || targetYieldUnits <= 0
        ? null
        : roundTo(totalRaw * targetYieldUnits, 2),
    basisTargetYieldUnits: targetYieldUnits,
    basisBenchBatchG: benchBatchG,
  };
}
