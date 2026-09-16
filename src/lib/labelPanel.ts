// Supplement Facts panel support (v81) — FDA Daily Value lookup and the
// persisted panel state for the formula editor's Label tab.
//
// DVs are the FDA's adult / children ≥4 values from the 2016 Nutrition
// Facts final rule (21 CFR 101.9(c), as used for supplements under
// 101.36). Matching is by name keyword against the label-claim's display
// name — good enough to auto-fill vitamins and minerals; botanicals and
// blends won't match and correctly fall to the † footnote. Every
// computed %DV can be overridden per row on the panel.

// ---------------------------------------------------------------------------
// Persisted state (rides inside GummyFormulaCosting.labelPanel)
// ---------------------------------------------------------------------------

/** One serving-size sub-tab beyond the base panel. */
export type LabelServingVariant = {
  id: string;
  name: string;
  /** Gummies per serving for this variant (base is 1). */
  gummiesPerServing: number;
  /** Servings-per-container line; null = omit the line. */
  servingsPerContainer: number | null;
};

export type LabelPanelState = {
  /** Servings-per-container for the base (1-gummy) panel; null = omit. */
  servingsPerContainer?: number | null;
  /** Display name for the base pill; null renders "1 Gummy". */
  baseName?: string | null;
  /** Extra serving-size sub-tabs. */
  variants?: LabelServingVariant[] | null;
  /** %DV override per label-claim row id. A number pins the %DV; null
   *  pins the † footnote even when a DV match exists. Absent = auto. */
  dvOverrides?: Record<string, number | null> | null;
  /** Panel display-name override per label-claim row id (raw-material
   *  names are internal; labels often need "Vitamin C (as Ascorbic
   *  Acid)"). Absent = the claim's resolved name. */
  nameOverrides?: Record<string, string> | null;
  /** "Other ingredients" line; null = auto-seed from the blend
   *  (non-active ingredients, descending weight). */
  otherIngredients?: string | null;
  /** Per-gummy nutrition facts (v81.2) shown above the actives, FDA
   *  style: Calories / Total Carbohydrate / Total Sugars / Added
   *  Sugars. Null field = omit that row. Values scale with the
   *  serving-size variants. */
  nutrition?: {
    calories?: number | null;
    carbsG?: number | null;
    sugarsG?: number | null;
    addedSugarsG?: number | null;
    /** v81.4: Dietary Fiber (g) and Sodium (mg) per gummy. Null = auto. */
    fiberG?: number | null;
    sodiumMg?: number | null;
  } | null;
  /** v81.4: FALCPA allergen line ("Contains: Tree Nuts (Coconut)…").
   *  Null/empty = no line printed. */
  allergens?: string | null;
};

/** FDA Daily Values used by the nutrition rows (adults ≥4). */
export const CARB_DV_G = 275;
export const ADDED_SUGAR_DV_G = 50;
export const FIBER_DV_G = 28;
export const SODIUM_DV_MG = 2300;

// ---------------------------------------------------------------------------
// FDA Daily Values
// ---------------------------------------------------------------------------

export type DvUnit = "mcg" | "mg" | "g";

type DvEntry = {
  /** Canonical nutrient name (for reference/debugging). */
  nutrient: string;
  /** Daily Value amount, in `unit`. */
  dv: number;
  unit: DvUnit;
  /** Case-insensitive keywords matched against the claim display name. */
  keywords: string[];
};

// Order matters: first match wins. More specific names (e.g. "vitamin
// b12") are listed before looser ones that could shadow them.
const DV_TABLE: DvEntry[] = [
  { nutrient: "Vitamin B12", dv: 2.4, unit: "mcg", keywords: ["vitamin b12", "b-12", "b12", "cobalamin"] },
  { nutrient: "Vitamin B6", dv: 1.7, unit: "mg", keywords: ["vitamin b6", "b-6", "b6", "pyridoxine"] },
  { nutrient: "Thiamin", dv: 1.2, unit: "mg", keywords: ["thiamin", "vitamin b1", "b-1"] },
  { nutrient: "Riboflavin", dv: 1.3, unit: "mg", keywords: ["riboflavin", "vitamin b2", "b-2"] },
  { nutrient: "Niacin", dv: 16, unit: "mg", keywords: ["niacin", "niacinamide", "vitamin b3", "b-3"] },
  { nutrient: "Folate", dv: 400, unit: "mcg", keywords: ["folate", "folic", "methylfolate"] },
  { nutrient: "Biotin", dv: 30, unit: "mcg", keywords: ["biotin", "vitamin b7"] },
  { nutrient: "Pantothenic Acid", dv: 5, unit: "mg", keywords: ["pantothenic", "pantothenate", "vitamin b5"] },
  { nutrient: "Vitamin A", dv: 900, unit: "mcg", keywords: ["vitamin a", "retinol", "retinyl", "beta-carotene", "beta carotene"] },
  { nutrient: "Vitamin C", dv: 90, unit: "mg", keywords: ["vitamin c", "ascorbic", "ascorbate"] },
  { nutrient: "Vitamin D", dv: 20, unit: "mcg", keywords: ["vitamin d", "cholecalciferol", "ergocalciferol"] },
  { nutrient: "Vitamin E", dv: 15, unit: "mg", keywords: ["vitamin e", "tocopherol", "tocopheryl"] },
  { nutrient: "Vitamin K", dv: 120, unit: "mcg", keywords: ["vitamin k", "phylloquinone", "menaquinone", "mk-7"] },
  { nutrient: "Calcium", dv: 1300, unit: "mg", keywords: ["calcium"] },
  { nutrient: "Iron", dv: 18, unit: "mg", keywords: ["iron", "ferrous", "ferric"] },
  { nutrient: "Phosphorus", dv: 1250, unit: "mg", keywords: ["phosphorus", "phosphate"] },
  { nutrient: "Iodine", dv: 150, unit: "mcg", keywords: ["iodine", "iodide", "kelp"] },
  { nutrient: "Magnesium", dv: 420, unit: "mg", keywords: ["magnesium"] },
  { nutrient: "Zinc", dv: 11, unit: "mg", keywords: ["zinc"] },
  { nutrient: "Selenium", dv: 55, unit: "mcg", keywords: ["selenium", "selenite", "selenomethionine"] },
  { nutrient: "Copper", dv: 0.9, unit: "mg", keywords: ["copper", "cupric"] },
  { nutrient: "Manganese", dv: 2.3, unit: "mg", keywords: ["manganese"] },
  { nutrient: "Chromium", dv: 35, unit: "mcg", keywords: ["chromium", "picolinate"] },
  { nutrient: "Molybdenum", dv: 45, unit: "mcg", keywords: ["molybdenum"] },
  { nutrient: "Chloride", dv: 2300, unit: "mg", keywords: ["chloride"] },
  { nutrient: "Choline", dv: 550, unit: "mg", keywords: ["choline"] },
  { nutrient: "Potassium", dv: 4700, unit: "mg", keywords: ["potassium"] },
  { nutrient: "Sodium", dv: 2300, unit: "mg", keywords: ["sodium"] },
];

/** Find the FDA Daily Value for a claim display name, or null when the
 *  ingredient has no established DV (botanicals, blends, aminos…). */
export function dailyValueFor(
  displayName: string,
): { nutrient: string; dv: number; unit: DvUnit } | null {
  const lower = displayName.toLowerCase();
  if (!lower.trim()) return null;
  for (const entry of DV_TABLE) {
    if (entry.keywords.some((k) => lower.includes(k))) {
      return { nutrient: entry.nutrient, dv: entry.dv, unit: entry.unit };
    }
  }
  return null;
}

const MG_PER: Record<DvUnit, number> = { mcg: 0.001, mg: 1, g: 1000 };

/** Convert an amount between label units (mcg/mg/g). */
export function convertAmount(amount: number, from: DvUnit, to: DvUnit): number {
  return (amount * MG_PER[from]) / MG_PER[to];
}

/** Compute %DV for a per-serving amount, or null when no DV exists.
 *  Returns the exact percentage; display rounding is the caller's. */
export function percentDailyValue(
  displayName: string,
  amount: number,
  unit: DvUnit,
): number | null {
  const hit = dailyValueFor(displayName);
  if (!hit || !(amount > 0)) return null;
  const inDvUnit = convertAmount(amount, unit, hit.unit);
  return (inDvUnit / hit.dv) * 100;
}

/** FDA-style %DV display: "<1%" for tiny non-zero, else nearest whole. */
export function formatPercentDv(pct: number): string {
  if (pct > 0 && pct < 1) return "<1%";
  return `${Math.round(pct)}%`;
}

/** Amount display for the panel: trims trailing zeros, keeps up to two
 *  decimals ("500 mg", "12.5 mg", "0.9 mg"). */
export function formatAmount(amount: number, unit: DvUnit): string {
  const rounded = Math.round(amount * 100) / 100;
  const text = Number.isInteger(rounded)
    ? rounded.toLocaleString("en-US")
    : String(rounded);
  return `${text} ${unit}`;
}
