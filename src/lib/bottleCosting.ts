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
  /**
   * A bundle of bottles inside the master carton — a shrink-wrapped six-pack,
   * a chipboard tray, a small inner carton. Shares its arithmetic with the
   * master box: one of them is spread across the bottles it holds.
   *
   * Kept as its own slot rather than reusing master_box because a job can have
   * BOTH, at different counts, and each needs its own cost and its own bottles
   * -per figure. Folding them together would force one of the two to be typed
   * as a fraction by hand.
   */
  | "inner_pack"
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
   * This line is a hand-typed description, not a Fishbowl part.
   *
   * Needed because `fpCode === null` already means something else — "nobody has
   * chosen yet" — and those two states must not be confused. An unchosen line
   * has to block the quote; a deliberately described one has to price. Without
   * a flag to tell them apart, one of the two behaves wrongly.
   *
   * Exists for the parts that are real but absent from Fishbowl: a new
   * component not yet set up, a one-off bought on a credit card, something the
   * customer named that we have not coded. The alternative is that the quote
   * stalls waiting on a data-entry job in another system, which is how people
   * end up doing the sums in a spreadsheet instead.
   *
   * A custom part can only be priced Manually — there is no Fishbowl record to
   * read an inventory or last-order figure from.
   */
  customPart?: boolean;
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

  /**
   * Scrap rate for this component, as a percentage of what we BUY.
   *
   * Per-line rather than one figure for the job, because the rates genuinely
   * differ by an order of magnitude: labels are misfed and thrown away by the
   * hundred on a web changeover, whereas bottles are rarely lost at all.
   *
   * Blank means no waste has been declared, which is treated as 0. That is a
   * deliberate exception to the null-propagation rule everywhere else in this
   * file. An unspecified waste rate is not an unknown quantity, it is an
   * unclaimed allowance — and blanking the whole quote until someone types 0
   * into ten rows would punish the common case to describe the rare one.
   */
  wastePct?: number | null;
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
  /**
   * TOTAL hours for this phase — not shifts, and not hours per shift.
   *
   * Bottling is not scheduled in whole shifts the way a gummy cook is: a
   * changeover is a couple of hours, a wash-down is a couple of hours, and the
   * run is however long the line takes. Asking for shifts × hours-per-shift
   * made people multiply in their heads to express two hours.
   */
  hours: number | null;
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
  /**
   * Kitting speed, in bottles per minute PER PERSON.
   *
   * Kitting is hand work, so it scales with headcount in a way a machine line
   * does not: the line runs at its own speed no matter who is watching it,
   * whereas two people kit twice as fast as one. Hence the per-person unit.
   *
   *   kitting hours = quantity / (people x speed x 60)
   *
   * Note what falls out of that: man hours come to quantity / (speed x 60)
   * regardless of headcount. Putting more people on kitting shortens the job
   * without changing what it costs — which is correct, and is exactly why the
   * crew count and the speed are separate inputs rather than one fudged rate.
   */
  kittingSpeed?: number | null;
  setup: LaborPhase;
  /**
   * Production is a full phase like the others now, so the board can show
   * Shifts × Hours per Shift the way the gummy Costing tab does.
   *
   * `days` left null means "derive it from line speed" — quantity ÷ bpm gives
   * line hours, which round up to whole shifts. Typing a value overrides that,
   * which also makes a job priceable before anyone has measured a line speed.
   */
  production: LaborPhase;
  cleaning: LaborPhase;
  /**
   * Pulling and staging components for the run. Optional — see
   * DEFAULT_KITTING_HOURS for why it does not get a house default.
   */
  kitting: LaborPhase;
  leaderRate: number | null;
  operatorRate: number | null;
  leaderTaxPct?: number | null;
  leaderWcPct?: number | null;
  operatorTaxPct?: number | null;
  operatorWcPct?: number | null;
};

/**
 * One overhead line.
 *
 * Structurally identical to the type in lib/formulas.ts, because these are the
 * same rows: a lease, a salaried manager, an electricity bill. The plant's
 * actual figures live in overheadDefaults.ts, shared by both calculators —
 * only the SHAPE and the ARITHMETIC live here, because this file is where the
 * money is worked out.
 */
export type OverheadItem = {
  label: string;
  /** Full monthly cost in $. For lease rows this is the BASE rent. */
  monthly: number;
  /** CAM / additional rent, lease rows only. Effective = monthly + cam. */
  cam?: number | null;
  /**
   * Labour rows carry a rate plus burden instead of a monthly figure.
   *   hourly: monthly = rate x burden x hours x qty
   *   salary: monthly = rate x burden x qty   (rate is already monthly)
   */
  rate?: number | null;
  taxPct?: number | null;
  wcPct?: number | null;
  hours?: number | null;
  qty?: number | null;
  payType?: "hourly" | "salary" | null;
  /** QuickBooks account, carried for audit reference only. */
  qbAccount?: string | null;
  /**
   * Percent of this line charged to this job's production line, 0-100.
   *
   * NOT nullable, deliberately — lib/formulas.ts declares it `number`, and the
   * shared defaults in overheadCosting.ts have to satisfy BOTH types. Widening
   * it here broke the gummy editor's build: a `number | null` array will not
   * go into state typed `number`. A blank share means zero, and the UI coerces
   * on the way in rather than carrying the null through.
   */
  sharePct: number;
};

/** How a group's rows convert to an effective monthly figure. */
export type OverheadGroupMode = "lease" | "labor" | undefined;

/** Working hours per month used to monthlyise an hourly indirect-labour rate. */
export const INDIRECT_HOURS_PER_MONTH = 173.33;

/** Burdened rate for a labour row — hourly, or monthly for a salary row. */
export function overheadBurdenedRate(r: OverheadItem): number {
  return (
    (num(r.rate) ?? 0) *
    (1 + (num(r.taxPct) ?? DEFAULT_TAX_PCT) / 100 + (num(r.wcPct) ?? DEFAULT_WC_PCT) / 100)
  );
}

/**
 * Effective FULL monthly cost of one row, before its share is applied.
 * Lease rows add CAM to the base rent; labour rows convert a rate; everything
 * else is already monthly.
 */
export function overheadRowMonthly(
  r: OverheadItem,
  mode?: OverheadGroupMode,
): number {
  if (mode === "labor") {
    const burdened = overheadBurdenedRate(r);
    return r.payType === "salary"
      ? burdened * (num(r.qty) ?? 1)
      : burdened * (num(r.hours) ?? INDIRECT_HOURS_PER_MONTH) * (num(r.qty) ?? 1);
  }
  return (num(r.monthly) ?? 0) + (num(r.cam) ?? 0);
}

/** The portion of one row actually charged to this production line. */
export function overheadRowCharged(
  r: OverheadItem,
  mode?: OverheadGroupMode,
): number {
  return overheadRowMonthly(r, mode) * ((num(r.sharePct) ?? 0) / 100);
}

/** Sum of a group's charged amounts. */
export function overheadGroupCharged(
  list: OverheadItem[],
  mode?: OverheadGroupMode,
): number {
  return list.reduce((s, r) => s + overheadRowCharged(r, mode), 0);
}

/**
 * One lab test line — a test that costs something and runs some number of
 * times per job.
 */
export type LabTestItem = {
  label: string;
  /** Cost per test in $. */
  cost: number;
  /** Tests run per job. */
  qty: number;
};

/** Total spend across a list of tests. */
export function labTestsTotal(list: LabTestItem[]): number {
  return list.reduce(
    (s, t) => s + (num(t.cost) ?? 0) * (num(t.qty) ?? 0),
    0,
  );
}

export type OverheadInputs = {
  rentLease: OverheadItem[];
  indirectLabor: OverheadItem[];
  other: OverheadItem[];
  workingDaysPerMonth: number | null;
  /**
   * v74: rent charged per RUN-DAY — the packaging-floor pool plus this line's
   * share of warehouse and office, over the run-days the line actually works.
   * Resolved from the database (sql/overhead_pools.sql).
   *
   * NULL means "not available", and the model falls back to the old
   * row-and-share-over-21-calendar-days arithmetic. Null and 0 differ here as
   * everywhere else: 0 would mean rent is genuinely free.
   */
  leasePerRunDay?: number | null;
  /**
   * v76: indirect payroll charged per RUN-DAY, same cure as the lease.
   *
   * Production-support people (manager, mechanic, quality) spread over ALL
   * production days in the plant at equal weight — 67.2 packaging run-days
   * plus 21 gummy batch-days — because their day is consumed by jobs running,
   * whichever floor they run on. Warehouse and purchasing take the line's
   * gross-margin share over its own run-days, exactly like warehouse rent.
   * Resolved from sql/overhead_indirect_pools.sql.
   *
   * NULL falls back to the row-share-over-calendar-days arithmetic, same as
   * the lease; 0 would claim these people are free and is not honoured.
   */
  indirectPerRunDay?: number | null;
  /**
   * v77: other expenses charged per RUN-DAY — the last calendar-day holdout.
   * Electricity and repairs run with production days (both floors, equal
   * weight); insurance, licenses, cleaning, warehouse supplies and misc
   * utilities take the line's margin share like everything else that serves
   * the entire operation. Resolved from sql/overhead_other_pools.sql, same
   * fallback contract as the lease and indirect rates.
   */
  otherPerRunDay?: number | null;
};

/**
 * Lab testing, as two lists rather than one flat total — raw-material tests
 * and finished-product tests, matching the gummy Costing tab. The split
 * matters because the two are triggered by different things: RM tests by lots
 * arriving, FP tests by the batch shipping.
 */
export type LabTestingInputs = {
  rawMaterials: LabTestItem[];
  finishedProduct: LabTestItem[];
};

export type BottleCostingInputs = {
  /** Finished bottles being quoted. */
  quantity: number | null;
  bom: BomLine[];
  labor: LaborInputs;
  overhead: OverheadInputs;
  /**
   * Lab testing. The two-list form is preferred; `labTestingTotal` is the old
   * single-figure field, still read so costings saved before the split keep
   * their number.
   */
  labTesting?: LabTestingInputs;
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
    | "zero_unconfirmed"
    | "waste_invalid";
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

/**
 * Starting scrap rate per slot.
 *
 * 5% is the house figure for anything handled on the line. Two exceptions,
 * both from how the part is applied rather than what it is made of:
 *
 *   labels      10%  — a web changeover misfeeds and destroys labels by the
 *                      handful, and a mislabelled bottle is scrap twice over.
 *   master box   2%  — cases are hand-assembled at the end of the line, out of
 *                      the machine's way, so very few are lost.
 *
 * These are DEFAULTS, not rules: they seed the input and every one is editable
 * per line, because the right number is a property of the job and the customer,
 * not of the category.
 *
 * Note the neckband and sleeve sit at 5% rather than the label's 10%, even
 * though Fishbowl files all three under the -LL- infix. That is a guess at the
 * boundary of the instruction and worth confirming — shrink film on an
 * applicator may well scrap more like a label than like a bottle.
 */
export const DEFAULT_WASTE_PCT: Record<PackagingSlot, number> = {
  bottle: 5,
  closure: 5,
  liner: 5,
  neckband: 5,
  sleeve: 5,
  label: 10,
  safety_seal: 5,
  insert: 5,
  carton: 5,
  // Bundled at the end of the line alongside the master case, and lost at
  // about the same rate.
  inner_pack: 2,
  master_box: 2,
  other: 5,
};

/** Payroll burden, matching the gummy Costing tab defaults. */
export const DEFAULT_TAX_PCT = 8.5;
export const DEFAULT_WC_PCT = 4;

/** Confirmed rates for bottling: leader $20/hr, operator $17/hr. */
export const DEFAULT_LEADER_RATE = 20;
export const DEFAULT_OPERATOR_RATE = 17;

export const DEFAULT_HOURS_PER_DAY = 8;
export const DEFAULT_SETUP_DAYS = 1;

/**
 * Confirmed house figures for bottling: a changeover is about two hours, and
 * so is the wash-down afterwards. Production is not defaulted — it comes from
 * the line speed, because guessing a run length would be guessing the job.
 */
export const DEFAULT_SETUP_HOURS = 2;
export const DEFAULT_CLEANING_HOURS = 2;

/**
 * Kitting defaults to zero, unlike setup and cleaning.
 *
 * Every bottling job has a changeover and a wash-down, so a house figure for
 * those is a reasonable starting point. Not every job is kitted — plenty run
 * straight from stock — so a default here would quietly add labour to jobs
 * that never do it. Zero contributes nothing and is visible in the table as a
 * zero, which is the honest starting state for a phase that may not happen.
 */
export const DEFAULT_KITTING_HOURS = 0;
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
 * How much we must BUY per good bottle, expressed as a multiplier on the
 * quantity the bottle actually consumes.
 *
 * THE CONVENTION, AND WHY
 *
 * Waste is a fraction of what we purchase, not of what survives. If 5% of
 * labels are destroyed on setup then 95 good labels come out of every 100
 * bought, so labelling one bottle costs 1 / 0.95 = 1.0526 labels.
 *
 * The tempting alternative — multiply by 1.05 — quietly under-buys. It is
 * close enough to hide at 5% (1.0500 against 1.0526) and wrong enough to
 * matter as rates climb: at 20% it orders 1.20 where the line needs 1.25, so
 * a run that budgeted exactly would stop four fifths of the way through.
 * Since the whole point of this calculator is to refuse plausible-looking
 * wrong numbers, it uses the yield form.
 *
 * 100% or more cannot be honoured — everything bought is scrapped, so no
 * amount of purchasing yields a bottle. That returns null, not a huge number,
 * because a division by something at or below zero is not a price.
 */
export function wasteFactor(line: BomLine): number | null {
  const w = num(line.wastePct);
  if (w === null || w === 0) return 1;
  if (w < 0 || w >= 100) return null;
  return 1 / (1 - w / 100);
}

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
  //
  // A hand-typed part counts as chosen. It has no fpCode and never will, so
  // the guard below would otherwise call it "not chosen yet" forever.
  if (line.customPart && line.costSource !== "Manual")
    return mk(
      "no_cost",
      "A typed-in part has no Fishbowl record to price from. Set Cost source to Manual and enter the cost.",
    );

  if (!line.fpCode && !line.customPart && line.costSource !== "Manual")
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

  // Checked last, so a nonsense waste rate is reported on a line that is
  // otherwise ready rather than masking a more basic problem underneath it.
  const waste = wasteFactor(line);
  if (waste === null)
    return mk(
      "waste_invalid",
      "Waste % must be between 0 and 99. At 100% every unit bought is scrapped, so no quantity produces a bottle.",
    );

  return { cost: qty * cost * waste, issue: null };
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

/** One phase's worth of the labour matrix, fully resolved. */
export type LaborPhaseBreakdown = {
  label: string;
  /** Total hours for the phase. */
  totalHours: number;
  leaders: number;
  operators: number;
  /** leaders x totalHours */
  leaderManHours: number;
  /** operators x totalHours */
  operatorManHours: number;
};

/** One role's pay row, base through burdened. */
export type LaborRoleBreakdown = {
  label: string;
  base: number;
  taxPct: number;
  wcPct: number;
  /** base x (1 + tax% + wc%) */
  burdened: number;
  /** man hours across every phase */
  manHours: number;
  /** manHours x burdened */
  total: number;
};

export type LaborBreakdown = {
  phases: LaborPhaseBreakdown[];
  totalHours: number;
  /**
   * Elapsed hours the job holds the packaging floor:
   *
   *   setup + cleaning + max(production, kitting)
   *
   * NOT the same as totalHours, and the difference is rent. Kitting runs
   * ALONGSIDE the line, not after it — the kitters work the same clock hours
   * as the run. Summing all four phases would charge floor occupancy twice
   * for the same afternoon. The max() covers the case that matters: a slow
   * kitting crew that outlasts the line still holds the floor and still
   * pays for it.
   *
   * Labour cost stays on totalHours — man-hours cost money whether they
   * happen in sequence or in parallel; the payroll does not care. Only the
   * lease charges by elapsed time.
   */
  occupancyHours: number;
  roles: LaborRoleBreakdown[];
  grandTotal: number;
  /** grandTotal / quantity. Null when the quantity is unknown. */
  perUnit: number | null;
};

/**
 * The whole labour matrix in one pass.
 *
 * Every figure the Direct Labor Costs card shows comes from here. The card
 * renders it and computes nothing of its own, because four tables each doing
 * their own arithmetic is four chances for the displayed sum to disagree with
 * the cost that reaches the quote.
 *
 * Hours, not shifts. Setup and cleaning default to the house two hours;
 * production comes from the line speed and is the only figure with no
 * defensible default, so a job with neither a speed nor a typed run length
 * returns null rather than a plausible-looking guess.
 */
export function laborBreakdown(
  quantity: number | null,
  labor: LaborInputs,
): LaborBreakdown | null {
  const q = num(quantity);

  const setupHours = num(labor.setup.hours) ?? DEFAULT_SETUP_HOURS;
  const cleanHours = num(labor.cleaning.hours) ?? DEFAULT_CLEANING_HOURS;
  // Typed hours win; otherwise derive from the kitting speed and the people on
  // it; otherwise zero, meaning this job does not kit.
  const kitPeople =
    (num(labor.kitting?.leaders) ?? 0) + (num(labor.kitting?.operators) ?? 0);
  const kitSpeed = num(labor.kittingSpeed);
  const derivedKitHours =
    q !== null && q > 0 && kitSpeed !== null && kitSpeed > 0 && kitPeople > 0
      ? q / (kitPeople * kitSpeed * 60)
      : null;
  const kitHours =
    num(labor.kitting?.hours) ?? derivedKitHours ?? DEFAULT_KITTING_HOURS;

  // Typed run length wins over the derivation, which is also how a job gets
  // priced before anyone has timed the line.
  const prodHours =
    num(labor.production.hours) ?? productionHours(q, labor.bottlesPerMinute);
  if (prodHours === null) return null;

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

  const phases = [
    mk("Setup", setupHours, labor.setup.leaders, labor.setup.operators),
    mk(
      "Production",
      prodHours,
      labor.production.leaders,
      labor.production.operators,
    ),
    // Kitting before Cleaning: it runs alongside production, so it reads in
    // process order — you kit while the line runs, then you clean.
    mk(
      "Kitting",
      kitHours,
      labor.kitting?.leaders,
      labor.kitting?.operators,
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
    return {
      label,
      base,
      taxPct,
      wcPct,
      burdened,
      manHours,
      total: manHours * burdened,
    };
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
    occupancyHours: setupHours + cleanHours + Math.max(prodHours, kitHours),
    roles,
    grandTotal,
    perUnit: q !== null && q > 0 ? grandTotal / q : null,
  };
}

export function laborPerUnit(
  quantity: number | null,
  labor: LaborInputs,
): number | null {
  return laborBreakdown(quantity, labor)?.perUnit ?? null;
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

  // ---- LEASE ----------------------------------------------------------
  //
  // v74: rent is charged PER RUN-DAY, not per calendar day.
  //
  // Dividing by 21 assumed the plant does one job at a time. Measured from the
  // packaging yield log it runs 3.28 jobs in parallel and 67.2 run-days a
  // month, so a calendar-day divisor over-charged rent by roughly 3x. It also
  // charged Suite 300 at 100% when only 40% of that suite is packaging floor.
  //
  // leasePerRunDay resolves both: it is the packaging-floor pool plus this
  // line's share of the warehouse-and-office pool, divided by the run-days the
  // line actually works. See sql/overhead_pools.sql for where the number comes
  // from, and docs/overhead-allocation-spec.md for why.
  //
  // Null falls back to the old row-and-share arithmetic, so a board that cannot
  // reach the database still costs — it just costs the old way.
  const leaseRate = num(overhead.leasePerRunDay);
  const leaseCharge =
    leaseRate !== null && leaseRate > 0
      ? leaseRate * days
      : (overheadGroupCharged(overhead.rentLease, "lease") / wdpm) * days;

  // ---- INDIRECT LABOUR ------------------------------------------------
  //
  // v76: same rate mechanism as the lease. Falls back to the old row-share
  // over calendar days when the pools have not resolved a rate.
  const indirectRate = num(overhead.indirectPerRunDay);
  const indirectCharge =
    indirectRate !== null && indirectRate > 0
      ? indirectRate * days
      : (overheadGroupCharged(overhead.indirectLabor, "labor") / wdpm) * days;

  // ---- OTHER EXPENSES -------------------------------------------------
  //
  // v77: the last calendar-day holdout joins the rate mechanism. All three
  // overhead groups now speak the same language: a per-run-day rate from the
  // pools, with the old row-share arithmetic as the offline fallback.
  const otherRate = num(overhead.otherPerRunDay);
  const otherCharge =
    otherRate !== null && otherRate > 0
      ? otherRate * days
      : (overheadGroupCharged(overhead.other) / wdpm) * days;

  return (leaseCharge + indirectCharge + otherCharge) / q;
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

  // Overhead is charged by how long the job occupies the floor — OCCUPANCY
  // hours over an 8-hour working day, not total man-phase hours, because
  // kitting runs alongside the line rather than after it (see occupancyHours
  // on LaborBreakdown). Left fractional, because overhead is a smooth spread:
  // rounding a 12-hour job up to two whole days would overcharge it by a
  // third.
  const lbForDays = laborBreakdown(q, input.labor);
  const jobDays =
    lbForDays === null
      ? null
      : lbForDays.occupancyHours / DEFAULT_HOURS_PER_DAY;

  const ovh = overheadPerUnit(q, input.overhead, jobDays);

  // Two lists if present, otherwise the pre-split single figure.
  const testingTotal =
    input.labTesting !== undefined
      ? labTestsTotal(input.labTesting.rawMaterials) +
        labTestsTotal(input.labTesting.finishedProduct)
      : num(input.labTestingTotal);
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
