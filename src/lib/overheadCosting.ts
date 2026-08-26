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

export const OVERHEAD_RENT_DEFAULTS: OverheadItem[] = [
  { label: "Suite 400", monthly: 4182.08, cam: 1775.73, sharePct: 100 },
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
