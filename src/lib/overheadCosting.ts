// The plant's actual overhead figures — one copy, two calculators.
//
// WHY THIS FILE EXISTS
//
// These rows are spread across jobs by both the gummy Costing tab
// (/formulas/[id]) and the Contract-Packaging bottle board. They were
// previously render-local constants inside FormulaEditor.tsx, so standing a
// second calculator up would have meant a second copy — and a rent rise or a
// payroll change would then have to be remembered in two places, with nothing
// to notice when it was not.
//
// Only the DATA lives here. The arithmetic that turns these rows into a cost
// per unit — overheadRowMonthly, overheadRowCharged, overheadGroupCharged —
// is in bottleCosting.ts, which is where the money is worked out. Keeping the
// math there also keeps that model free of imports, which is what lets it be
// run directly by the .mjs test harness.
//
// Worked out with the operator from the lease ledgers, the ADP roster
// (burdened at 8.5% tax + 4% workers' comp) and the Jan–Jun 2026 P&L averages.
// Every row is editable per job; these are only the starting point.
//
// A NOTE ON THE SHARE PERCENTAGES
//
// The monthly amounts are facts about the building and the payroll. The
// sharePct values are a judgement about how much of the plant belongs to ONE
// production line, and they were set for bulk gummy production. A bottling job
// occupies the floor differently, so the bottle board labels them as inherited
// rather than presenting them as settled.

import type { OverheadItem } from "./bottleCosting";

/** Working hours per month used to monthlyise an hourly indirect-labour rate. */
export const INDIRECT_HOURS_PER_MONTH = 173.33;

/**
 * SUITE 300 — from the Sixth Amendment to Lease (July 2025).
 *
 * The row this replaces was labelled "Suite 400", which the lease itself shows
 * to be two moves out of date: Suite 400 was the ORIGINAL 5,300 sq ft premises
 * and the First Amendment (Dec 2011) vacated it and relocated the tenant to
 * Suite 300, 15851 SW 41st Street, Davie FL — approximately 10,720 rentable
 * square feet. Every quote priced off that row was carrying the rent of a unit
 * PharmaCenter left fifteen years ago.
 *
 * BASE RENT SCHEDULE — Extended Term, 1 Aug 2025 to 30 Nov 2030:
 *
 *   8-1-25 to  7-31-26   $16.50 /sq ft   $14,740.00 /mo  (first 4 months abated)
 *   8-1-26 to  7-31-27   $17.16 /sq ft   $15,329.60 /mo  <-- current
 *   8-1-27 to  7-31-28   $17.85 /sq ft   $15,942.78 /mo
 *   8-1-28 to  7-31-29   $18.56 /sq ft   $16,580.53 /mo
 *   8-1-29 to  7-31-30   $19.30 /sq ft   $17,243.75 /mo
 *   8-1-30 to 11-30-30   $20.07 /sq ft   $17,933.49 /mo
 *
 * The rate is annual per square foot: 10,720 x 17.16 / 12 = 15,329.60, which
 * reproduces the schedule exactly. THIS FIGURE STEPS UP EVERY 1 AUGUST — the
 * next change is to $15,942.78 on 1 Aug 2027.
 *
 * THE CAM FIGURE IS AN ESTIMATE, NOT A LEASE TERM. The amendment obliges
 * "Tenant's pro-rata share of Expenses as Additional Rent" but never states an
 * amount, a percentage or a base year — those live in the original lease's
 * Expenses definition and in the landlord's annual estimate statement, neither
 * of which we hold. So $3,590 is extrapolated by floor area from the row this
 * replaced: Suite 400 carried $1,775.73 across 5,300 sq ft, i.e. $0.335 per sq
 * ft per month; at Suite 300's 10,720 sq ft that is $3,591.67, rounded down to
 * $3,590 so the number LOOKS like the approximation it is.
 *
 * Two caveats worth keeping in view. The Suite 400 rate it derives from was
 * itself undocumented, so this inherits whatever that row's provenance was.
 * And CAM is re-estimated by the landlord annually, so it drifts even when it
 * is right. REPLACE IT the moment a rent statement is to hand — that is the
 * authoritative source, and it is a one-line correction here.
 */
export const OVERHEAD_RENT_DEFAULTS: OverheadItem[] = [
  // cam: estimated by floor area — see the note above. Not a lease figure.
  { label: "Suite 300", monthly: 15329.6, cam: 3590, sharePct: 100 },
  { label: "Suite 500/600", monthly: 12087.48, cam: 5132.38, sharePct: 50 },
];

export const OVERHEAD_INDIRECT_DEFAULTS: OverheadItem[] = [
  { label: "Production Manager", monthly: 0, payType: "salary", rate: 4525.41, qty: 1, taxPct: 8.5, wcPct: 4, hours: 173.33, sharePct: 25 },
  { label: "Plant Mechanic", monthly: 0, payType: "hourly", rate: 26.0, qty: 1, taxPct: 8.5, wcPct: 4, hours: 173.33, sharePct: 25 },
  { label: "Quality Manager", monthly: 0, payType: "salary", rate: 5250.01, qty: 1, taxPct: 8.5, wcPct: 4, hours: 173.33, sharePct: 25 },
  { label: "Quality Tech", monthly: 0, payType: "hourly", rate: 17.0, qty: 1, taxPct: 8.5, wcPct: 4, hours: 173.33, sharePct: 25 },
  { label: "Quality Tech II", monthly: 0, payType: "hourly", rate: 15.0, qty: 1, taxPct: 8.5, wcPct: 4, hours: 173.33, sharePct: 25 },
  { label: "Warehouse Staff", monthly: 0, payType: "hourly", rate: 15.0, qty: 3, taxPct: 8.5, wcPct: 4, hours: 173.33, sharePct: 25 },
  // Part-time salaried: $803.68 biweekly (ADP base rate) × 26 ÷ 12 = $1,741.31/mo
  { label: "Purchasing Logistics", monthly: 0, payType: "salary", rate: 1741.31, qty: 1, taxPct: 8.5, wcPct: 4, hours: 173.33, sharePct: 25 },
];

export const OVERHEAD_OTHER_DEFAULTS: OverheadItem[] = [
  { label: "Electricity", monthly: 4497, qbAccount: "5135.30", sharePct: 30 },
  { label: "Warehouse Supplies & Tools", monthly: 2525, qbAccount: "5195.19", sharePct: 40 },
  { label: "Licenses & Permits", monthly: 2428, qbAccount: "5145.70", sharePct: 40 },
  { label: "Insurance (liability + property)", monthly: 3281, qbAccount: "5130", sharePct: 40 },
  { label: "Repairs & Maintenance", monthly: 1278, qbAccount: "5145", sharePct: 40 },
  { label: "Cleaning", monthly: 675, qbAccount: "5135.05", sharePct: 40 },
  { label: "Other Utilities & Services", monthly: 291, qbAccount: "5135", sharePct: 40 },
];
