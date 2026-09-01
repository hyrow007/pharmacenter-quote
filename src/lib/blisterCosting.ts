// Blister costing model for Contract-Packaging (Blisters) quotes.
//
// WHAT THIS IS
//
// The blister sibling of lib/bottleCosting.ts — and deliberately NOT a copy of
// it. Everything the two calculators genuinely share (BOM resolution with the
// zero gate, waste factors, overhead pools, lab testing, the pricing algebra,
// the break-even yardstick) is IMPORTED from bottleCosting and re-exported, so
// there is still exactly one place each of those rules lives. Only what is
// blister-specific is defined here:
//
//   LINE SPEED    strokes/min × blisters per stroke × (1 − penalty%). The
//                 machine strokes at a rated speed and forms several blisters
//                 per stroke, but real lines never run the rated figure —
//                 film splices, reel changes, jams. The penalty (default 20%,
//                 editable) turns the nameplate speed into a planning speed.
//
//   FINISHED UNIT Pricing is per FINISHED UNIT, not per blister. With
//                 secondary packaging, several blisters go into one carton —
//                 blistersPerUnit carries that. Line hours run on BLISTERS
//                 (quantity × blistersPerUnit); everything else runs on units.
//
//   HAND STATIONS Packout, cartoning and bundling are hand work downstream of
//                 the line, each derived from a per-person units/min speed
//                 exactly the way bottle kitting is. They run ALONGSIDE the
//                 line, so occupancy takes the max, not the sum.
//
// The result and breakdown SHAPES are bottleCosting's own, so the board's
// tables, overhead card and pricing tier render either model unchanged.

import {
  type BomLine,
  type LaborPhase,
  type OverheadInputs,
  type LabTestingInputs,
  type PricingInputs,
  type BottleCostingResult,
  type LaborBreakdown,
  type LaborPhaseBreakdown,
  type LaborRoleBreakdown,
  materialsPerUnit,
  overheadPerUnit,
  labTestsTotal,
  computeSalePrice,
  burdenedRate,
  DEFAULT_TAX_PCT,
  DEFAULT_WC_PCT,
  DEFAULT_LEADER_RATE,
  DEFAULT_OPERATOR_RATE,
  DEFAULT_SETUP_HOURS,
  DEFAULT_CLEANING_HOURS,
  DEFAULT_HOURS_PER_DAY,
} from "./bottleCosting";

// One import surface for the board: the generic machinery passes through, so
// BlisterCostingBoard imports everything from this module and cannot end up
// with two subtly different copies of a shared rule.
export * from "./bottleCosting";

const num = (v: number | null | undefined): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

/**
 * The house speed penalty. A blister line's nameplate speed assumes the film
 * never splices, the foil never wrinkles and nobody stops to clear a cavity.
 * 20% off is the planning figure the floor actually hits — editable per job,
 * because a well-behaved format earns some of it back.
 */
export const DEFAULT_SPEED_PENALTY_PCT = 20;

export type BlisterLaborInputs = {
  /** Machine strokes per minute — the nameplate figure. */
  strokesPerMinute: number | null;
  /** Blisters formed per stroke (tooling-dependent). */
  blistersPerStroke: number | null;
  /** % knocked off the nameplate speed. Null reads as the 20% house figure. */
  speedPenaltyPct?: number | null;
  /**
   * Blisters in one FINISHED UNIT. 1 for a bare blister card; with secondary
   * packaging it is the carton count (e.g. 2 blisters per IFC). Quantity is
   * always finished units, so the line has quantity × this to form.
   */
  blistersPerUnit?: number | null;
  /** Units per minute PER PERSON on packout. Null/0 = this job has no packout. */
  packoutSpeed?: number | null;
  /** Units per minute PER PERSON on cartoning / carton printing. */
  cartoningSpeed?: number | null;
  /** Units per minute PER PERSON on bundling. */
  bundlingSpeed?: number | null;
  setup: LaborPhase;
  /** The blister line itself. hours null = derive from the speed chain. */
  line: LaborPhase;
  packout: LaborPhase;
  cartoning: LaborPhase;
  bundling: LaborPhase;
  cleaning: LaborPhase;
  leaderRate: number | null;
  operatorRate: number | null;
  leaderTaxPct?: number | null;
  leaderWcPct?: number | null;
  operatorTaxPct?: number | null;
  operatorWcPct?: number | null;
};

export type BlisterCostingInputs = {
  /** FINISHED UNITS being quoted (cartons when secondary packaging exists). */
  quantity: number | null;
  bom: BomLine[];
  labor: BlisterLaborInputs;
  overhead: OverheadInputs;
  labTesting?: LabTestingInputs;
  labTestingTotal?: number | null;
  pricing?: PricingInputs;
};

/**
 * The planning line speed in blisters per minute:
 *
 *   strokes/min × blisters/stroke × (1 − penalty/100)
 *
 * Null if either speed input is missing — the whole production estimate hangs
 * off this, and a guessed speed is a guessed job. A penalty at or past 100%
 * is a line that never runs, which is not a speed; it returns null too.
 */
export function effectiveBlistersPerMinute(
  labor: Pick<
    BlisterLaborInputs,
    "strokesPerMinute" | "blistersPerStroke" | "speedPenaltyPct"
  >,
): number | null {
  const spm = num(labor.strokesPerMinute);
  const bps = num(labor.blistersPerStroke);
  const pen = num(labor.speedPenaltyPct) ?? DEFAULT_SPEED_PENALTY_PCT;
  if (spm === null || spm <= 0 || bps === null || bps <= 0) return null;
  if (pen >= 100 || pen < 0) return null;
  return spm * bps * (1 - pen / 100);
}

/**
 * Line time in hours. The line forms BLISTERS, not finished units, so the
 * quantity is multiplied out first:
 *
 *   hours = (units × blisters per unit) ÷ (effective blisters/min × 60)
 */
export function blisterProductionHours(
  quantity: number | null,
  labor: BlisterLaborInputs,
): number | null {
  const q = num(quantity);
  const bpu = num(labor.blistersPerUnit) ?? 1;
  const eff = effectiveBlistersPerMinute(labor);
  if (q === null || q <= 0 || bpu <= 0 || eff === null || eff <= 0) return null;
  return (q * bpu) / (eff * 60);
}

/**
 * The whole labour matrix in one pass — six phases instead of the bottle
 * board's four, same breakdown shape so the same five tables render it.
 *
 * Packout, cartoning and bundling derive like bottle kitting: hand work at a
 * per-person speed, so hours = units ÷ (people × speed × 60). A blank speed
 * means the job does not do that step — zero hours, visible as zero. Typed
 * hours on those phases win over the derivation (an odd job is an odd job).
 */
export function blisterLaborBreakdown(
  quantity: number | null,
  labor: BlisterLaborInputs,
): LaborBreakdown | null {
  const q = num(quantity);

  const setupHours = num(labor.setup.hours) ?? DEFAULT_SETUP_HOURS;
  const cleanHours = num(labor.cleaning.hours) ?? DEFAULT_CLEANING_HOURS;

  const handHours = (phase: LaborPhase, speed: number | null | undefined) => {
    const typed = num(phase.hours);
    if (typed !== null) return typed;
    const s = num(speed);
    const people = (num(phase.leaders) ?? 0) + (num(phase.operators) ?? 0);
    if (q === null || q <= 0 || s === null || s <= 0 || people <= 0) return 0;
    return q / (people * s * 60);
  };

  const packoutHours = handHours(labor.packout, labor.packoutSpeed);
  const cartoningHours = handHours(labor.cartoning, labor.cartoningSpeed);
  const bundlingHours = handHours(labor.bundling, labor.bundlingSpeed);

  // Typed run length wins over the derivation, same as bottles — which is
  // also how a job gets priced before anyone has timed the format.
  const lineHours =
    num(labor.line.hours) ?? blisterProductionHours(q, labor);
  if (lineHours === null) return null;

  const mk = (
    label: string,
    totalHours: number,
    leaders: number | null | undefined,
    operators: number | null | undefined,
  ): LaborPhaseBreakdown => {
    const l = num(leaders) ?? 0;
    const o = num(operators) ?? 0;
    return {
      label,
      totalHours,
      leaders: l,
      operators: o,
      leaderManHours: l * totalHours,
      operatorManHours: o * totalHours,
    };
  };

  // Process order: set up, run the line, and while it runs the hand stations
  // pack out, carton and bundle what comes off it; then clean down.
  const phases = [
    mk("Setup", setupHours, labor.setup.leaders, labor.setup.operators),
    mk("Blister Line", lineHours, labor.line.leaders, labor.line.operators),
    mk("Packout", packoutHours, labor.packout.leaders, labor.packout.operators),
    mk(
      "Cartoning",
      cartoningHours,
      labor.cartoning.leaders,
      labor.cartoning.operators,
    ),
    mk(
      "Bundling",
      bundlingHours,
      labor.bundling.leaders,
      labor.bundling.operators,
    ),
    mk("Cleaning", cleanHours, labor.cleaning.leaders, labor.cleaning.operators),
  ];

  const role = (
    label: string,
    base: number,
    taxPct: number,
    wcPct: number,
    manHours: number,
  ): LaborRoleBreakdown => {
    const burdened = burdenedRate(base, taxPct, wcPct);
    return { label, base, taxPct, wcPct, burdened, manHours, total: manHours * burdened };
  };

  const roles = [
    role(
      "Line Leaders",
      num(labor.leaderRate) ?? DEFAULT_LEADER_RATE,
      num(labor.leaderTaxPct) ?? DEFAULT_TAX_PCT,
      num(labor.leaderWcPct) ?? DEFAULT_WC_PCT,
      phases.reduce((s, p) => s + p.leaderManHours, 0),
    ),
    role(
      "Line Operators",
      num(labor.operatorRate) ?? DEFAULT_OPERATOR_RATE,
      num(labor.operatorTaxPct) ?? DEFAULT_TAX_PCT,
      num(labor.operatorWcPct) ?? DEFAULT_WC_PCT,
      phases.reduce((s, p) => s + p.operatorManHours, 0),
    ),
  ];

  const grandTotal = roles.reduce((s, r) => s + r.total, 0);

  return {
    phases,
    totalHours: phases.reduce((s, p) => s + p.totalHours, 0),
    // The hand stations run ALONGSIDE the line — the floor is held for
    // setup + cleaning + whichever parallel stream lasts longest. Summing
    // all six would charge rent several times for the same afternoon; the
    // max covers the slow hand crew that outlasts the line.
    occupancyHours:
      setupHours +
      cleanHours +
      Math.max(lineHours, packoutHours, cartoningHours, bundlingHours),
    roles,
    grandTotal,
    perUnit: q !== null && q > 0 ? grandTotal / q : null,
  };
}

export function blisterLaborPerUnit(
  quantity: number | null,
  labor: BlisterLaborInputs,
): number | null {
  return blisterLaborBreakdown(quantity, labor)?.perUnit ?? null;
}

/**
 * Top level — the same pipeline as computeBottleCosting, with the blister
 * labour model swapped in. Returns bottleCosting's result shape so every
 * consumer of the bottle result renders this one unchanged.
 */
export function computeBlisterCosting(
  input: BlisterCostingInputs,
): BottleCostingResult {
  const q = num(input.quantity);

  const mat = materialsPerUnit(input.bom);
  const prodHours = blisterProductionHours(q, input.labor);
  const lb = blisterLaborBreakdown(q, input.labor);
  const lab = lb?.perUnit ?? null;

  const jobDays =
    lb === null ? null : lb.occupancyHours / DEFAULT_HOURS_PER_DAY;

  const ovh = overheadPerUnit(q, input.overhead, jobDays);

  const testingTotal =
    input.labTesting !== undefined
      ? labTestsTotal(input.labTesting.rawMaterials) +
        labTestsTotal(input.labTesting.finishedProduct)
      : num(input.labTestingTotal);
  const testingPerUnit =
    testingTotal === null ? 0 : q === null || q <= 0 ? null : testingTotal / q;

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
