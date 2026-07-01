// Hardcoded pricing-calculator defaults for the v2 landed-cost model.
//
// These numbers come from actual EMLI broker invoices + CBP Form 7501s for
// 6 international shipments (POs 5527, 5528, 5537, 5627, 5642, 5670) —
// see task #154 for the raw analysis.
//
// When new invoices come in and the numbers here drift, update this file
// in one place and every calculator + audit-print picks up the change.
// (An admin UI for tuning was considered and deferred — Option 1 chosen
// in the July 2026 pricing brainstorm.)

// -----------------------------------------------------------------------------
// Broker baseline: 7 fixed line items that appear on EVERY EMLI invoice
// regardless of shipment size. They sum to $450 flat.
//
// When we print the audit-trail cost sheet, this expands to show all 7 lines.
// When we display the summary landed-cost breakdown, we just show the total.
// -----------------------------------------------------------------------------
export const BROKER_BASELINE_LINES: { label: string; amount: number }[] = [
  { label: "Customs clearance fee",                    amount: 145.00 },
  { label: "Destination handling",                     amount:  85.00 },
  { label: "FDA entry declaration",                    amount:  50.00 },
  { label: "FDA prior notice",                         amount:  50.00 },
  { label: "ISF fee",                                  amount:  45.00 },
  { label: "CBP DIS (document import system)",         amount:  25.00 },
  { label: "OGA CBP/AG",                               amount:  50.00 },
];

export const BROKER_BASELINE_TOTAL = BROKER_BASELINE_LINES.reduce(
  (s, l) => s + l.amount,
  0,
); // → 450.00

// Extra fee tacked on when shipping mode is Air. Average of the two air
// shipments in our data (Sirio $276.19 via Atlas, Nutrifirst $114.95 via JAL
// → mean ≈ $195, rounded to $200). Skipped on ocean shipments.
export const AIR_TERMINAL_HANDLING_FEE = 200.00;

// LCL floor for destination delivery Port Everglades → Davie. Five of our
// six shipments (weights 80 – 488 kg) all landed at $230 flat, so anything
// under this threshold treats delivery as the flat minimum. Above the
// threshold the rep types their own number in `deliveryOverride` because we
// don't have enough data points between 500 kg and 19,000 kg to fit a curve.
export const DELIVERY_FLAT_KG_THRESHOLD = 500;
export const DELIVERY_FLAT_AMOUNT       = 230.00;

// -----------------------------------------------------------------------------
// CBP fees — these are pure math off the entered value (a.k.a. CIF).
// -----------------------------------------------------------------------------
// Merchandise Processing Fee: 0.3464% of CIF, capped at $634.62 per entry.
export const MPF_RATE = 0.003464;
export const MPF_MAX  = 634.62;

// Harbor Maintenance Fee: 0.125% of CIF, ocean shipments ONLY.
export const HMF_RATE = 0.00125;

// -----------------------------------------------------------------------------
// Duty rate — a 25% default that comfortably covers the observed 23.9%
// combined China rate (base HTSUS 6.4% + Section 301 7.5% + IEEPA 10%).
// The rep can override per quote for non-China origins or different HTS codes.
// -----------------------------------------------------------------------------
export const DEFAULT_DUTY_PCT = 25;

// -----------------------------------------------------------------------------
// Sales-input defaults (seeded when a fresh pricing tab is opened).
// -----------------------------------------------------------------------------
export const DEFAULT_LAB_TESTING = 500;
export const DEFAULT_OTHER_COSTS = 200;
export const DEFAULT_SHIPPING_MODE: "ocean" | "air" = "ocean";

// -----------------------------------------------------------------------------
// Average unit weight (grams) per dosage form. Used to convert `units × 1000
// softgels/unit × weight_g/softgel → shipment kg` for delivery-tier lookup.
//
// Range validated against real invoices:
//   Vit D3 small softgel (PO5642): 0.27 g
//   Vit E 400IU/Multivitamin small: 0.45 – 0.75 g
//   Fish oil / omega-3 1000 mg: 1.07 g
//
// Softgel default of 0.8 g is the median. Gummy default matches the
// NB-26 formula sheet piece weight of 3.0 g.
// -----------------------------------------------------------------------------
export const DEFAULT_UNIT_WEIGHT_G: Record<string, number> = {
  softgel: 0.8,
  gummy:   3.0,
  tablet:  1.0,
  capsule: 0.5,
  other:   1.0, // conservative fallback
};

/**
 * Look up the per-unit weight (grams) for a dosage-form id, with a hard
 * fallback so callers can never crash on a null / unknown form.
 */
export function unitWeightForForm(formId: string | null | undefined): number {
  if (!formId) return DEFAULT_UNIT_WEIGHT_G.other;
  return DEFAULT_UNIT_WEIGHT_G[formId] ?? DEFAULT_UNIT_WEIGHT_G.other;
}
