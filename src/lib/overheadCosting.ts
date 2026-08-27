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
// A NOTE ON THE SHARE PERCENTAGES — READ THIS BEFORE EDITING
//
// The monthly amounts are facts about the building and the payroll. The
// sharePct values are NOT: they say how much of a given space one production
// line bears, and that differs by line. PharmaCenter holds three spaces and
// uses them for different things:
//
//   Suite 300      offices + PACKAGING
//   Suite 400      gummy MANUFACTURING
//   Suite 500/600  warehouse, shared
//
// So the gummy line and the bottling line do not charge the same rooms. An
// earlier version of this file carried ONE rent array shared by both
// calculators, which made that impossible to express — and worse, meant a
// correct edit for one calculator was a silent wrong answer in the other.
// Hence the two arrays below: the RENT AMOUNTS are declared once, the SHARES
// twice.
//
// When a rent steps up, change the suite constant — both calculators follow.
// When a line's floor usage changes, change only that line's sharePct.
//
// A zero share is deliberate and stays visible as a row, rather than the row
// being deleted. Zero means "this line does not use this space"; a missing row
// would mean "nobody has considered it". Those are different claims and the
// operator can see the difference on screen.

import type { OverheadItem } from "./bottleCosting";

/** Working hours per month used to monthlyise an hourly indirect-labour rate. */
export const INDIRECT_HOURS_PER_MONTH = 173.33;

// -----------------------------------------------------------------------------
// THE SPACES — rent amounts, declared once
// -----------------------------------------------------------------------------

/**
 * SUITE 300 — offices and packaging. Sixth Amendment to Lease (July 2025),
 * 15851 SW 41st Street, Davie FL, approximately 10,720 rentable square feet.
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
 * reproduces the schedule exactly. THIS STEPS UP EVERY 1 AUGUST — the next
 * change is to $15,942.78 on 1 Aug 2027.
 *
 * CAM IS AN ESTIMATE, NOT A LEASE TERM. The amendment obliges "Tenant's
 * pro-rata share of Expenses as Additional Rent" but states no amount, no
 * percentage and no base year — those live in the original lease's Expenses
 * definition and the landlord's annual estimate statement, neither of which we
 * hold. $3,590 is extrapolated by floor area from Suite 400's $1,775.73 across
 * 5,300 sq ft ($0.335/sq ft/mo x 10,720 = $3,591.67), rounded down so the
 * number looks like the approximation it is. REPLACE IT from a rent statement.
 */
const SUITE_300 = { label: "Suite 300", monthly: 15329.6, cam: 3590 };

/**
 * SUITE 400 — gummy manufacturing. Fifth Amendment to Lease (Oct 2022),
 * 15951 SW 41st Street, approximately 3,072 rentable square feet; term ends
 * 1-31-28. Verified against the amendment on 17 Aug 2026.
 *
 * BASE RENT SCHEDULE (Second Expansion Space):
 *
 *   11-21-25 to 10-31-26   $4,182.08 /mo
 *   11- 1-26 to 10-31-27   $4,307.55 /mo  <-- carried below (operator chose to
 *                                             cost forward-looking batches at
 *                                             the autumn rate, Aug 2026)
 *   11- 1-27 to  1-31-28   $4,436.77 /mo
 *
 * CAM $1,775.73 is from the landlord's 2026 estimate letter / rent ledger —
 * re-estimated annually, replace when the 2027 statement lands.
 */
const SUITE_400 = { label: "Suite 400", monthly: 4307.55, cam: 1775.73 };

/**
 * SUITE 500/600 — warehouse, shared by both lines. Fourth Amendment to Lease
 * (Dec 2021), 15951 SW 41st Street, approximately 8,879 rentable square feet;
 * term ends 1-31-28. Verified against the amendment on 17 Aug 2026. Rent is
 * banded by LEASE MONTH from the 18 Oct 2022 commencement date:
 *
 *   months 37-48  (~Nov 25 - Oct 26)   $12,087.48 /mo
 *   months 49-60  (~Nov 26 - Oct 27)   $12,450.10 /mo  <-- carried below
 *                                          (operator chose the autumn rate,
 *                                           Aug 2026, for forward costing)
 *   months 61-63  (~Nov 27 - Jan 28)   $12,823.60 /mo
 *
 * CAM $5,132.38 is the landlord's 2026 estimate (ledger-confirmed). The
 * earlier observation stands: CAM here runs ~42% of base vs ~23% on Suite
 * 300 — likely the buildings' expense pools genuinely differ, but worth a
 * question to the property manager with the 2027 statement.
 */
const SUITE_500_600 = { label: "Suite 500/600", monthly: 12450.10, cam: 5132.38 };

// -----------------------------------------------------------------------------
// THE SHARES — declared per production line
// -----------------------------------------------------------------------------

/** Bulk gummy manufacturing (/formulas/[id] Costing tab). */
export const OVERHEAD_RENT_DEFAULTS_GUMMY: OverheadItem[] = [
  { ...SUITE_400, sharePct: 100 },
  // Offices and packaging: no part of a gummy manufacturing run happens here.
  { ...SUITE_300, sharePct: 0 },
  { ...SUITE_500_600, sharePct: 50 },
];

/** Contract-packaging bottle line (/workflow/[id]/bottle-costing). */
export const OVERHEAD_RENT_DEFAULTS_BOTTLE: OverheadItem[] = [
  // Packaging happens in Suite 300 — but the suite is offices AND packaging,
  // so 100% charges a bottling job for floor it does not occupy. Left at 100
  // pending a call on the office/packaging split rather than guessed at.
  { ...SUITE_300, sharePct: 100 },
  // Gummy manufacturing: a bottling job does not use it.
  { ...SUITE_400, sharePct: 0 },
  { ...SUITE_500_600, sharePct: 50 },
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
