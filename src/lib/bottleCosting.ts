// Bottle costing model for Contract-Packaging (Bottles) quotes.
//
// WHAT THIS IS
//
// Pure functions. No React, no fetch, no DOM. The UI and any API route both
// import from here, so there is exactly one place where the money is worked
// out. This is a deliberate departure from formulaCosting.ts, whose own header
// admits it is a hand-maintained duplicate of math living inside
// FormulaEditor.tsx render state, kept in sync by 17 line-number references
// that rot every time that file is touched. We are not repeating that.
//
// THE MODEL
//
//   Materials  Σ over BOM lines of (qty per finished unit × cost per each)
//   Labor      mirrors the gummy Costing tab exactly, with ONE substitution:
//              production hours come from line speed rather than daily yield
//   Overhead   mirrors the gummy Costing tab
//
//   Cost per bottle = materials + labor + overhead
//
// THE TWO RULES THAT MATTER
//
// 1. NULL PROPAGATION. If any single input cannot be resolved, the number that
//    depends on it is null — not zero, not a guess. A blank line is a visible
//    "we don't know yet"; a zero is an invisible wrong answer that reaches a
//    customer. Every aggregate here returns null if any contributor is null.
//
// 2. THE ZERO GATE (task #358). A cost of $0 means three different things
//    depending on who owns the part, and only one of them is a fact:
//
//      CA- part at $0  a genuine assertion. Customer free-issues it. Resolved.
//      PC part at NULL an admitted absence. Blanks the line. Visible.
//      PC part at $0   an absence wearing a number's clothes. It passes the
//                      null check because 0 IS a number, contributes $0.00,
//                      and silently under-costs the quote.
//
//    62 PharmaCenter-owned rows currently sit at exactly $0 — including 19
//    master boxes and 2 child-resistant caps. Corrugated boxes are not free.
//    So a PC $0 does NOT count until a human ticks `zeroCostConfirmed`.
//    Unconfirmed it behaves exactly like a missing cost. A real zero costs one
//    click; a data gap cannot reach a customer.

// ============================================================
// Types
// ============================================================

/** Mirrors packaging_components.category. */
export type PackagingSlot =
  | "bottle"
  | "closure"
  | "liner"
  | "neckband"
  | "sleeve"
  | "label"
  | "carton"
  | "insert"
  | "safety_seal"
  | "master_box"
  | "other";

/** Mirrors the cost_status expression in the packaging_components_costed view. */
export type CostStatus =
  | "ok"
  | "customer_asset"
  | "no_cost"
  | "zero_cost"
  | "uom_unresolved";

export type BomLine = {
  id: string;
  slot: PackagingSlot;
  /** Fishbowl part number, null while the line is still unassigned. */
  fpCode: string | null;
  name: string;
  /**
   * How many of this component per FINISHED BOTTLE. Usually 1. A master box
   * holding 12 bottles is 1/12. Storing the fraction rather than "12 per box"
   * keeps every line in the same unit so they can simply be summed.
   */
  qtyPerUnit: number | null;
  /** effective_cost_per_unit from the view: already per-each, already converted. */
  costPerUnit: number | null;
  costStatus: CostStatus;
  /** The #358 gate. Only consulted when costStatus === 'zero_cost'. */
  zeroCostConfirmed?: boolean;
  /**
   * This job does not use this slot at all — no liner, no unit carton, no
   * sleeve. Distinct from "not chosen yet", and the distinction is the whole
   * point: an unchosen line must BLOCK the total, whereas a deliberately
   * unused one must not.
   *
   * Without this the calculator could never resolve for a real job. Q0016 has
   * no sleeve and no unit carton, and PharmaCenter stocks no standalone liners
   * at all (the liner is part of the cap — see #362), so three of the eight
   * slots would have blocked the number forever.
   */
  notUsed?: boolean;

  /**
   * Who buys this component.
   *
   * Defaults from the packaging form's *SuppliedBy answers, but the human can
   * change it — the form is filled early and reality moves.
   *
   * This, NOT the Fishbowl CA-/PC- prefix, is now what decides whether a line
   * costs anything. The prefix describes how a part is stocked; this describes
   * who pays on THIS job, and only the second one belongs in a price.
   */
  suppliedBy: SuppliedBy;

  /** Where the $/each comes from. Same four options as the gummy Costing tab. */
  costSource: CostSource;
  /** Only consulted when costSource is "Manual". */
  manualCostPerUnit?: number | null;
  /** Per-each cost from Fishbowl's inventory average. */
  inventoryCostPerUnit?: number | null;
  /** Per-each cost from the last purchase order. */
  lastOrderCostPerUnit?: number | null;
};

export type SuppliedBy = "pharmacenter" | "customer";

/**
 * Cost sources, spelled exactly as the gummy Costing tab spells them so the
 * two calculators stay legible to the same person. "App" is deliberately
 * unwired in both — it is a placeholder for a future source, and it yields a
 * blank rather than a guess.
 */
export type CostSource =
  | "Fish Bowl (Inventory)"
  | "Fish Bowl (Last Order)"
  | "App"
  | "Manual";

export const COST_SOURCES: CostSource[] = [
  "Fish Bowl (Inventory)",
  "Fish Bowl (Last Order)",
  "App",
  "Manual",
];

export const DEFAULT_COST_SOURCE: CostSource = "Fish Bowl (Inventory)";

export type LaborPhase = {
  /** Shifts. Production is derived from line speed, so it ignores this. */
  days: number | null;
  hoursPerDay: number | null;
  leaders: number | null;
  operators: number | null;
};

export type LaborInputs = {
  /**
   * Bottles per minute. The whole production estimate hangs off this, so there
   * is deliberately NO default — an empty value yields null labor, which
   * blanks the line rather than inventing a plausible-looking rate.
   */
  bottlesPerMinute: number | null;
  setup: LaborPhase;
  production: Pick<LaborPhase, "leaders" | "operators">;
  cleaning: LaborPhase;
  leaderRate: number | null;
  operatorRate: number | null;
  leaderTaxPct?: number | null;
  leaderWcPct?: number | null;
  operatorTaxPct?: number | null;
  operatorWcPct?: number | null;
};

export type OverheadItem = {
  id: string;
  label: string;
  /** Monthly cost of the item before any share is applied. */
  monthly: number;
  /** Percent of that monthly cost this job should carry. */
  sharePct: number | null;
};

export type OverheadInputs = {
  rentLease: OverheadItem[];
  indirectLabor: OverheadItem[];
  other: OverheadItem[];
  workingDaysPerMonth: number | null;
};

export type BottleCostingInputs = {
  /** Finished bottles being quoted. */
  quantity: number | null;
  bom: BomLine[];
  labor: LaborInputs;
  overhead: OverheadInputs;
  /** Flat lab/testing cost for the whole job, spread across the quantity. */
  labTestingTotal?: number | null;
  /**
   * Margin tier. For contract-packaging bottles this board IS the pricing
   * calculator, so it has to carry cost all the way to a sale price — a
   * cost-only board cannot issue a quote.
   */
  pricing?: PricingInputs;
};

/**
 * How the margin number is meant: a markup ON cost, or a margin OF the sale
 * price. These are NOT the same and the difference is money — 30% markup on
 * $0.49 is $0.637, 30% gross margin is $0.70. The pricing calculator has
 * always offered both, so bottles offer both too rather than silently
 * picking one.
 */
export type MarginMode = "markup" | "gross-margin";

export type PricingInputs = {
  /** Percent, as typed: 30 means 30%. */
  marginPct: number | null;
  marginMode: MarginMode;
  /** Head of Sales commission, % of SALE price. */
  hosCommissionPct?: number | null;
  /** Sales rep commission, % of SALE price. */
  repCommissionPct?: number | null;
};

/** Why a line could not be costed. Drives the UI badge, not just a blank. */
export type LineIssue = {
  lineId: string;
  name: string;
  slot: PackagingSlot;
  reason:
    | "unassigned"
    | "no_qty"
    | "no_cost"
    | "uom_unresolved"
    | "zero_unconfirmed";
  message: string;
};

export type BottleCostingResult = {
  materialsPerUnit: number | null;
  laborPerUnit: number | null;
  overheadPerUnit: number | null;
  labTestingPerUnit: number | null;
  /** materials + labor + overhead + testing. Null if ANY component is null. */
  costPerUnit: number | null;
  totalCost: number | null;
  /** Line time in hours, from quantity and line speed. */
  productionHours: number | null;
  /** Everything blocking a complete number, for display next to the offender. */
  issues: LineIssue[];

  // ---- pricing tier ----
  /** What we'd charge per bottle. Null whenever cost is null. */
  salePerUnit: number | null;
  /** salePerUnit × quantity. */
  totalRevenue: number | null;
  hosCommission: number | null;
  repCommission: number | null;
  /** Revenue − true cost − commissions. The number the margin % promised. */
  grossProfit: number | null;
  /** Realised margin as a % of sale, after commissions. Sanity-check readout. */
  effectiveMarginPct: number | null;
};

// ============================================================
// Defaults
// ============================================================

/** Payroll burden, matching the gummy Costing tab defaults. */
export const DEFAULT_TAX_PCT = 8.5;
export const DEFAULT_WC_PCT = 4;

/** Confirmed rates for bottling: leader $20/hr, operator $17/hr. */
export const DEFAULT_LEADER_RATE = 20;
export const DEFAULT_OPERATOR_RATE = 17;

export const DEFAULT_HOURS_PER_DAY = 8;
export const DEFAULT_SETUP_DAYS = 1;
export const DEFAULT_WORKING_DAYS_PER_MONTH = 21;

/**
 * Shift rounding, copied from the gummy model so both calculators agree on
 * what "a day and a bit" costs. A remainder over 0.24 of a shift bills a whole
 * one — you cannot staff a quarter shift.
 */
export function roundDays(x: number): number {
  if (x <= 0) return 0;
  const whole = Math.floor(x);
  return whole + (x - whole > 0.24 ? 1 : 0);
}

const num = (v: number | null | undefined): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

/** base × (1 + tax% + workers-comp%) — the burdened hourly rate. */
export function burdenedRate(
  base: number,
  taxPct: number = DEFAULT_TAX_PCT,
  wcPct: number = DEFAULT_WC_PCT,
): number {
  return base * (1 + taxPct / 100 + wcPct / 100);
}

// ============================================================
// Materials
// ============================================================

/**
 * Resolve one BOM line to a cost per finished bottle.
 *
 * Returns null with an issue rather than throwing or defaulting, so the caller
 * can show the user exactly which line is blocking the quote.
 */
export function resolveLine(line: BomLine): {
  cost: number | null;
  issue: LineIssue | null;
} {
  const mk = (reason: LineIssue["reason"], message: string) => ({
    cost: null,
    issue: { lineId: line.id, name: line.name, slot: line.slot, reason, message },
  });

  // Deliberately excluded from this job — contributes nothing and blocks
  // nothing. Checked FIRST so an unused slot never has to be filled in.
  if (line.notUsed) return { cost: 0, issue: null };

  // Customer free-issues it, so it genuinely adds nothing to OUR cost.
  //
  // Checked before the part-chosen guard on purpose. Requiring a Fishbowl part
  // for something we never buy would block the total on bookkeeping — and on
  // Q0016 the bottle, cap and label are ALL customer-supplied, so that guard
  // alone would have made the job unpriceable. Picking a part is still allowed
  // and still useful for the spec; it just is not a precondition for a price.
  if (line.suppliedBy === "customer") return { cost: 0, issue: null };

  // From here down, PharmaCenter is buying it — so a real number is required.
  if (!line.fpCode && line.costSource !== "Manual")
    return mk("unassigned", "No component chosen yet.");

  const qty = num(line.qtyPerUnit);
  if (qty === null || qty <= 0)
    return mk("no_qty", "Quantity per bottle is missing.");

  // A UOM we cannot convert poisons BOTH Fishbowl sources, so it is checked
  // before the source switch. Manual sidesteps it — that is the escape hatch.
  if (line.costStatus === "uom_unresolved" && line.costSource !== "Manual")
    return mk(
      "uom_unresolved",
      "Fishbowl prices this in a unit with no per-each conversion. Choose Manual, or set a units-per-purchase-unit override.",
    );

  const cost = costFromSource(line);

  if (cost === null) {
    if (line.costSource === "Manual")
      return mk("no_cost", "Enter a manual cost per each.");
    if (line.costSource === "App")
      return mk("no_cost", "The App source is not wired up yet — choose another source.");
    if (line.costSource === "Fish Bowl (Last Order)")
      return mk("no_cost", "No last-order cost in Fishbowl for this part.");
    return mk("no_cost", "No inventory cost in Fishbowl for this part.");
  }

  // The #358 gate, now applied to whichever source was chosen rather than only
  // to Fishbowl's inventory column. PharmaCenter is buying this, so a $0 is an
  // absence wearing a number's clothes until a human says otherwise.
  if (cost === 0 && !line.zeroCostConfirmed)
    return mk(
      "zero_unconfirmed",
      "$0 for a PharmaCenter-purchased part. Confirm it is genuinely free before it counts.",
    );

  return { cost: qty * cost, issue: null };
}

/**
 * The per-each cost implied by the line's chosen source. Null means "this
 * source has nothing for this part" — never 0, which would be a silent lie.
 */
export function costFromSource(line: BomLine): number | null {
  switch (line.costSource) {
    case "Manual":
      return num(line.manualCostPerUnit);
    case "Fish Bowl (Last Order)":
      return num(line.lastOrderCostPerUnit);
    case "App":
      // Deliberately unwired, exactly as on the gummy tab.
      return null;
    case "Fish Bowl (Inventory)":
    default:
      // costPerUnit is the view's effective_cost_per_unit, which IS the
      // inventory figure; inventoryCostPerUnit is the explicit alias.
      return num(line.inventoryCostPerUnit ?? line.costPerUnit);
  }
}

export function materialsPerUnit(bom: BomLine[]): {
  total: number | null;
  issues: LineIssue[];
} {
  const issues: LineIssue[] = [];
  let sum = 0;
  let blocked = false;

  for (const line of bom) {
    const { cost, issue } = resolveLine(line);
    if (issue) {
      issues.push(issue);
      blocked = true;
      // Keep going rather than bailing: the user should see EVERY blocking
      // line at once, not fix them one reload at a time.
      continue;
    }
    sum += cost ?? 0;
  }
  return { total: blocked ? null : sum, issues };
}

// ============================================================
// Labor
// ============================================================

/**
 * Line time. This is the one place the bottle model departs from the gummy
 * model: gummies derive production shifts from a daily yield, bottles derive
 * production hours from line speed.
 *
 *   hours = quantity ÷ (bottles per minute × 60)
 */
export function productionHours(
  quantity: number | null,
  bottlesPerMinute: number | null,
): number | null {
  const q = num(quantity);
  const bpm = num(bottlesPerMinute);
  if (q === null || bpm === null || bpm <= 0 || q <= 0) return null;
  return q / (bpm * 60);
}

export function laborPerUnit(
  quantity: number | null,
  labor: LaborInputs,
): number | null {
  const q = num(quantity);
  if (q === null || q <= 0) return null;

  const prodHours = productionHours(q, labor.bottlesPerMinute);
  if (prodHours === null) return null; // no line speed => no honest estimate

  const hpd = num(labor.setup.hoursPerDay) ?? DEFAULT_HOURS_PER_DAY;

  // Setup and cleaning keep the gummy shape (shifts × hours per shift).
  // Cleaning defaults to a quarter of the production time, as in the gummy tab.
  const setupHours =
    (num(labor.setup.days) ?? DEFAULT_SETUP_DAYS) *
    (num(labor.setup.hoursPerDay) ?? DEFAULT_HOURS_PER_DAY);

  const prodShiftEquivalent = roundDays(prodHours / hpd);
  const cleaningHours =
    (num(labor.cleaning.days) ?? roundDays(prodShiftEquivalent / 4)) *
    (num(labor.cleaning.hoursPerDay) ?? DEFAULT_HOURS_PER_DAY);

  const phaseHours = [setupHours, prodHours, cleaningHours];

  const roles = [
    {
      crew: [
        num(labor.setup.leaders) ?? 0,
        num(labor.production.leaders) ?? 0,
        num(labor.cleaning.leaders) ?? 0,
      ],
      rate: burdenedRate(
        num(labor.leaderRate) ?? DEFAULT_LEADER_RATE,
        num(labor.leaderTaxPct) ?? DEFAULT_TAX_PCT,
        num(labor.leaderWcPct) ?? DEFAULT_WC_PCT,
      ),
    },
    {
      crew: [
        num(labor.setup.operators) ?? 0,
        num(labor.production.operators) ?? 0,
        num(labor.cleaning.operators) ?? 0,
      ],
      rate: burdenedRate(
        num(labor.operatorRate) ?? DEFAULT_OPERATOR_RATE,
        num(labor.operatorTaxPct) ?? DEFAULT_TAX_PCT,
        num(labor.operatorWcPct) ?? DEFAULT_WC_PCT,
      ),
    },
  ];

  const grand = roles.reduce(
    (s, r) => s + r.crew.reduce((a, c, i) => a + c * phaseHours[i], 0) * r.rate,
    0,
  );
  return grand / q;
}

// ============================================================
// Overhead
// ============================================================

/**
 * Monthly overhead, apportioned by share%, spread over the working month, then
 * charged for the days this job occupies and divided across the bottles made.
 */
export function overheadPerUnit(
  quantity: number | null,
  overhead: OverheadInputs,
  jobDays: number | null,
): number | null {
  const q = num(quantity);
  const days = num(jobDays);
  const wdpm = num(overhead.workingDaysPerMonth) ?? DEFAULT_WORKING_DAYS_PER_MONTH;
  if (q === null || q <= 0 || days === null || days <= 0 || wdpm <= 0) return null;

  const sumList = (list: OverheadItem[]) =>
    list.reduce((s, i) => s + i.monthly * ((num(i.sharePct) ?? 0) / 100), 0);

  const monthly =
    sumList(overhead.rentLease) +
    sumList(overhead.indirectLabor) +
    sumList(overhead.other);

  return ((monthly / wdpm) * days) / q;
}

// ============================================================
// Top level
// ============================================================

export function computeBottleCosting(
  input: BottleCostingInputs,
): BottleCostingResult {
  const q = num(input.quantity);

  const mat = materialsPerUnit(input.bom);
  const prodHours = productionHours(q, input.labor.bottlesPerMinute);
  const lab = laborPerUnit(q, input.labor);

  const hpd = num(input.labor.setup.hoursPerDay) ?? DEFAULT_HOURS_PER_DAY;
  const jobDays =
    prodHours === null
      ? null
      : (num(input.labor.setup.days) ?? DEFAULT_SETUP_DAYS) +
        roundDays(prodHours / hpd) +
        (num(input.labor.cleaning.days) ??
          roundDays(roundDays(prodHours / hpd) / 4));

  const ovh = overheadPerUnit(q, input.overhead, jobDays);

  const testingTotal = num(input.labTestingTotal);
  const testingPerUnit =
    testingTotal === null ? 0 : q === null || q <= 0 ? null : testingTotal / q;

  // Null propagation: one unknown makes the whole per-unit cost unknown.
  const parts = [mat.total, lab, ovh, testingPerUnit];
  const costPerUnit = parts.some((p) => p === null)
    ? null
    : (parts as number[]).reduce((a, b) => a + b, 0);

  const totalCost =
    costPerUnit === null || q === null ? null : costPerUnit * q;

  const price = computeSalePrice(costPerUnit, q, input.pricing);

  return {
    materialsPerUnit: mat.total,
    laborPerUnit: lab,
    overheadPerUnit: ovh,
    labTestingPerUnit: testingPerUnit,
    costPerUnit,
    totalCost,
    productionHours: prodHours,
    issues: mat.issues,
    ...price,
  };
}

// ============================================================
// Pricing tier — cost → sale price
// ============================================================

/** Commission defaults, matching the pricing calculator (task #352). */
export const DEFAULT_HOS_COMMISSION_PCT = 0.5;
export const DEFAULT_REP_COMMISSION_PCT = 3;
export const DEFAULT_MARGIN_PCT = 30;

/**
 * Turn a true cost into a sale price.
 *
 * Commissions are a percentage OF THE SALE PRICE, but they are also a cost
 * that the margin has to cover — so the price cannot simply be marked up and
 * then have commission subtracted. It solves algebraically, exactly as the
 * pricing calculator does:
 *
 *   gross-margin: sale = cost / (1 − margin − commissionRate)
 *   markup:       sale = cost × (1 + markup) / (1 − rate × (1 + markup))
 *
 * Both leave the rep with precisely the margin they asked for once
 * commission has been paid.
 *
 * Null in, null out — a cost we could not resolve must not silently price at
 * zero, which is the same rule the rest of this module follows.
 */
export function computeSalePrice(
  costPerUnit: number | null,
  quantity: number | null,
  pricing?: PricingInputs,
): {
  salePerUnit: number | null;
  totalRevenue: number | null;
  hosCommission: number | null;
  repCommission: number | null;
  grossProfit: number | null;
  effectiveMarginPct: number | null;
} {
  const none = {
    salePerUnit: null,
    totalRevenue: null,
    hosCommission: null,
    repCommission: null,
    grossProfit: null,
    effectiveMarginPct: null,
  };
  if (costPerUnit === null || !pricing) return none;

  const m = num(pricing.marginPct);
  if (m === null) return none;

  const mPct = m / 100;
  const hosRate = (num(pricing.hosCommissionPct) ?? 0) / 100;
  const repRate = (num(pricing.repCommissionPct) ?? 0) / 100;
  const commissionRate = hosRate + repRate;

  let salePerUnit: number;
  if (pricing.marginMode === "markup") {
    const denom = 1 - commissionRate * (1 + mPct);
    if (denom <= 0.0001) return none;
    salePerUnit = (costPerUnit * (1 + mPct)) / denom;
  } else {
    // A margin of 100% (or margin + commission ≥ 100%) has no finite price.
    // Refuse rather than emit a vast or negative number.
    const capped = mPct + commissionRate;
    if (capped >= 0.9999) return none;
    salePerUnit = costPerUnit / (1 - capped);
  }

  const q = num(quantity);
  const totalRevenue = q === null ? null : salePerUnit * q;
  const hosCommission = totalRevenue === null ? null : totalRevenue * hosRate;
  const repCommission = totalRevenue === null ? null : totalRevenue * repRate;
  const grossProfit =
    totalRevenue === null || q === null
      ? null
      : totalRevenue - costPerUnit * q - (hosCommission ?? 0) - (repCommission ?? 0);
  const effectiveMarginPct =
    totalRevenue === null || totalRevenue === 0 || grossProfit === null
      ? null
      : (grossProfit / totalRevenue) * 100;

  return {
    salePerUnit,
    totalRevenue,
    hosCommission,
    repCommission,
    grossProfit,
    effectiveMarginPct,
  };
}
