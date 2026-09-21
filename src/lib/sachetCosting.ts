// Sachet costing model for Contract-Packaging (Sachets) quotes — a clone of
// lib/pouchCosting.ts (2026-09-21). The Printing phase stays in the model for
// shape parity but the sachet board always passes no printing speed: sachets
// are printed on the line, never at a hand station.
//
// WHAT THIS IS
//
// The sachet sibling of lib/blisterCosting.ts, built the same way: everything
// the calculators genuinely share (BOM resolution with the zero gate, waste
// factors, overhead pools, lab testing, the pricing algebra, the break-even
// yardstick) is IMPORTED from bottleCosting and re-exported, so each of those
// rules still lives in exactly one place. Only what is sachet-specific is
// defined here:
//
//   LINE SPEED    sachets/min (nameplate) × (1 − penalty%). The sachet machine
//                 has a rated PPM but real lines lose time to film splices,
//                 seal-jaw jams and reel changes. The house penalty
//                 (default 20%, editable) turns the nameplate figure into a
//                 planning speed. (Reference: the Honey gummy project sheet
//                 ran 15 PPM flat — set the penalty to 0 to reproduce it.)
//
//   FINISHED UNIT Pricing is per FINISHED UNIT, not per sachet. With
//                 secondary/retail packaging several sachets can go into one
//                 carton — sachetsPerUnit carries that. Line hours run on
//                 SACHETS (quantity × sachetsPerUnit); everything else runs
//                 on units.
//
//   HAND STATIONS Printing (lot/EXP on the bag), packout, cartoning and
//                 bundling are hand work alongside the line, each derived
//                 from a per-person units/min speed exactly like blister
//                 packout. A blank speed means the job has no such step.
//                 They run ALONGSIDE the line, so occupancy takes the max,
//                 not the sum. Office admin time is NOT direct labor — it
//                 lives in Overhead → Indirect Labor.
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
// SachetCostingBoard imports everything from this module and cannot end up
// with two subtly different copies of a shared rule.
export * from "./bottleCosting";

const num = (v: number | null | undefined): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

/**
 * The house speed penalty. A sachet machine's nameplate PPM assumes the film
 * never splices and the zipper feed never hangs up. 20% off is the planning
 * figure — editable per job, and zero when a proven format has earned it.
 */
export const DEFAULT_SACHET_SPEED_PENALTY_PCT = 20;

export type SachetLaborInputs = {
  /** Machine sachets per minute — the nameplate figure. */
  sachetsPerMinute: number | null;
  /** % knocked off the nameplate speed. Null reads as the 20% house figure. */
  speedPenaltyPct?: number | null;
  /**
   * Sachets in one FINISHED UNIT. 1 for a bare sachet; with secondary/retail
   * packaging it is the carton count. Quantity is always finished units, so
   * the line has quantity × this to fill.
   */
  sachetsPerUnit?: number | null;
  /** Units per minute PER PERSON on lot/EXP printing. Null/0 = no printing step. */
  printingSpeed?: number | null;
  /** Units per minute PER PERSON on packout. Null/0 = this job has no packout. */
  packoutSpeed?: number | null;
  /** Units per minute PER PERSON on cartoning / carton printing. */
  cartoningSpeed?: number | null;
  /** Units per minute PER PERSON on bundling. */
  bundlingSpeed?: number | null;
  setup: LaborPhase;
  /** The sachet line itself. hours null = derive from the speed chain. */
  line: LaborPhase;
  printing: LaborPhase;
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

export type SachetCostingInputs = {
  /** FINISHED UNITS being quoted (cartons when retail packaging exists). */
  quantity: number | null;
  bom: BomLine[];
  labor: SachetLaborInputs;
  overhead: OverheadInputs;
  labTesting?: LabTestingInputs;
  labTestingTotal?: number | null;
  pricing?: PricingInputs;
};

/**
 * The planning line speed in sachets per minute:
 *
 *   nameplate PPM × (1 − penalty/100)
 *
 * Null if the speed is missing — the whole production estimate hangs off
 * this, and a guessed speed is a guessed job. A penalty at or past 100% is a
 * line that never runs, which is not a speed; it returns null too.
 */
export function effectiveSachetsPerMinute(
  labor: Pick<SachetLaborInputs, "sachetsPerMinute" | "speedPenaltyPct">,
): number | null {
  const ppm = num(labor.sachetsPerMinute);
  const pen = num(labor.speedPenaltyPct) ?? DEFAULT_SACHET_SPEED_PENALTY_PCT;
  if (ppm === null || ppm <= 0) return null;
  if (pen >= 100 || pen < 0) return null;
  return ppm * (1 - pen / 100);
}

/**
 * Line time in hours. The line fills SACHETS, not finished units, so the
 * quantity is multiplied out first:
 *
 *   hours = (units × sachets per unit) ÷ (effective sachets/min × 60)
 */
export function sachetProductionHours(
  quantity: number | null,
  labor: SachetLaborInputs,
): number | null {
  const q = num(quantity);
  const ppu = num(labor.sachetsPerUnit) ?? 1;
  const eff = effectiveSachetsPerMinute(labor);
  if (q === null || q <= 0 || ppu <= 0 || eff === null || eff <= 0) return null;
  return (q * ppu) / (eff * 60);
}

/**
 * The whole labour matrix in one pass — seven phases, same breakdown shape
 * as the bottle and blister boards so the same five tables render it.
 *
 * Printing, packout, cartoning and bundling derive like blister packout:
 * hand work at a per-person speed, so hours = units ÷ (people × speed × 60).
 * A blank speed means the job does not do that step — zero hours, visible as
 * zero. Typed hours on those phases win over the derivation.
 */
export function sachetLaborBreakdown(
  quantity: number | null,
  labor: SachetLaborInputs,
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

  const printingHours = handHours(labor.printing, labor.printingSpeed);
  const packoutHours = handHours(labor.packout, labor.packoutSpeed);
  const cartoningHours = handHours(labor.cartoning, labor.cartoningSpeed);
  const bundlingHours = handHours(labor.bundling, labor.bundlingSpeed);

  // Typed run length wins over the derivation, same as bottles and blisters
  // — which is also how a job gets priced before anyone has timed the format.
  const lineHours = num(labor.line.hours) ?? sachetProductionHours(q, labor);
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

  // Process order: set up, run the sachet line, and while it runs the hand
  // stations print, pack out, carton and bundle what comes off it; then
  // clean down.
  const phases = [
    mk("Setup", setupHours, labor.setup.leaders, labor.setup.operators),
    mk("Sachet Line", lineHours, labor.line.leaders, labor.line.operators),
    mk(
      "Printing",
      printingHours,
      labor.printing.leaders,
      labor.printing.operators,
    ),
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
    // all seven would charge rent several times for the same afternoon; the
    // max covers the slow hand crew that outlasts the line.
    occupancyHours:
      setupHours +
      cleanHours +
      Math.max(
        lineHours,
        printingHours,
        packoutHours,
        cartoningHours,
        bundlingHours,
      ),
    roles,
    grandTotal,
    perUnit: q !== null && q > 0 ? grandTotal / q : null,
  };
}

export function sachetLaborPerUnit(
  quantity: number | null,
  labor: SachetLaborInputs,
): number | null {
  return sachetLaborBreakdown(quantity, labor)?.perUnit ?? null;
}

/**
 * Top level — the same pipeline as computeBlisterCosting, with the sachet
 * labour model swapped in. Returns bottleCosting's result shape so every
 * consumer of the bottle result renders this one unchanged.
 */
export function computeSachetCosting(
  input: SachetCostingInputs,
): BottleCostingResult {
  const q = num(input.quantity);

  const mat = materialsPerUnit(input.bom);
  const prodHours = sachetProductionHours(q, input.labor);
  const lb = sachetLaborBreakdown(q, input.labor);
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
    costPerUnit: costPerUnit,
    totalCost,
    productionHours: prodHours,
    issues: mat.issues,
    ...price,
  };
}
