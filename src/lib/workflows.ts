// Shared workflow types + a couple of server helpers.
//
// The shape here is the canonical version of the form state that lives in
// /start (and used to be duplicated in /workflow/review). The DB persists it
// as the JSONB `state` column on `workflows`. Keep this file as the single
// source of truth — when the form gets new fields, update here first, then
// the page / API surface.

import type { WorkflowAttachment } from "./storage";

// We don't have generated Database types, so trying to use the real
// SupabaseClient generic from either @supabase/ssr or @supabase/supabase-js
// here makes TS attempt to unify two different deeply-instantiated query
// builders and trip the "Type instantiation is excessively deep" check.
// `any` here is intentional and contained — it leaks into one helper only.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnySupabase = any;

export type WorkflowMode = "existing" | "new";

// Sourcing mode for a workflow product.
//   - "purchase": default. We don't have stock; the product needs to be
//     sourced. Goes through the normal monday push for sourcing and the
//     pricing calculator's inbound-cost flow.
//   - "stock":    we already have inventory in our warehouse. The landed
//     cost is already known in Fishbowl, so the pricing calculator skips
//     inbound costs (freight/duties/insurance/etc.) and the monday push
//     excludes this product (Rosy doesn't need to source it).
export type ProductSourceMode = "purchase" | "stock";

// Pinned formula snapshot for PC-manufactured gummy products (task #164 /
// user-driven follow-up). The formula catalog on formula.pharmacenter.app
// owns the canonical record; we snapshot the identity fields here so the
// workflow listing + review page can show the formula without a fetch.
// Costing / spec data is read on demand from `/api/formulas/[id]` at
// pricing time — the pinned snapshot is intentionally identity-only so
// stale unit-cost values never leak into a quote.
export type PinnedFormula = {
  formulaId: string;
  // Numeric version we pinned. Today we default to the formula's current
  // `latestVersionNum` at pin time; a later phase can add explicit version
  // pinning + audit stability.
  versionNum: number;
  // Sequential formula number, e.g. 1 → renders as "F0001". Stored as a
  // number so future zero-padding tweaks stay a formatting concern.
  formulaNumber: number;
  // R&D-facing product code from the Formula catalog (e.g. PC-BK-01234).
  // Optional — a fresh formula can be TBD.
  pcBkCode: string | null;
  // Display name at pin time.
  name: string;
  // Optional flavor tag from the formula card.
  flavor: string | null;
};

export type ProductEntry = {
  uid: string;
  mode: WorkflowMode;
  productId: string | null;
  newProduct: { name_desc: string; notes: string };
  quantities: string[];
  attachments: WorkflowAttachment[];
  // Optional for backward compatibility with workflows saved before this
  // field existed — those rows behave like "purchase" by default.
  sourceMode?: ProductSourceMode;
  // PC-manufactured gummies only: the formula this product is made from.
  // Optional so pre-formula workflows still parse. When set, the formula
  // is the product identity — the Fishbowl ProductPicker is skipped and
  // downstream pricing pulls unit cost from the Formula app's costing tab.
  pinnedFormula?: PinnedFormula;
  // Contract Packaging → Bottles: the per-product packaging spec mirroring
  // the PandaDoc "Packaging Specification Form (Bottles)". Optional and
  // fillable-later; a future PandaDoc sync pushes it into a real form.
  packagingSpec?: PackagingSpecBottles;
  // Contract Packaging → Blisters: same idea, mirroring the PandaDoc
  // "Packaging Form (Blisters)". A product carries at most one of the two —
  // whichever matches the workflow's packaging type.
  blisterSpec?: PackagingSpecBlisters;
  // Hydrated display fields — not persisted to JSONB. Marked optional so the
  // server-loaded rows (which won't have them) typecheck.
  _name?: string | null;
  _code?: string | null;
};

// -----------------------------------------------------------------------------
// Packaging Specification Form (Bottles) — PandaDoc form version 202401
// -----------------------------------------------------------------------------
// Field-for-field mirror of the PandaDoc form, MINUS what the workflow
// already captures elsewhere (company, product name/code, bottle count,
// dosage type, attachments). Everything is a plain string so hydration is
// lossless and partially-filled specs round-trip cleanly:
//   - yes/no questions:    "" (unanswered) | "yes" | "no"
//   - supplied-by pickers: "" | "pharmacenter" | "customer"
//   - picklists:           "" | option id | "other" (paired *Other free text)
// Keys are grouped by the form's section letters so the future PandaDoc
// sync can map 1:1 without a translation table.
export type PackagingSpecBottles = {
  formVersion: string; // "202401"

  // --- Section A — finished product ---
  // (product code + name come from the product card; only the count lives
  // here so a single workflow can quote a 30ct and a 60ct side by side)
  bottleCount: string;             // pieces per bottle, e.g. "30"

  // --- Section B — bulk ---
  bulkSuppliedBy: string;          // "" | "pharmacenter" | "customer"
  bulkProductCode: string;         // PC bulk code when PharmaCenter-supplied
  dosageType: string;              // softgel | gummy | tablet | capsule | other
  dosageTypeOther: string;         // free text when dosageType = other
  dosageSize: string;
  dosageShape: string;

  // --- Section C — bottle ---
  bottleSuppliedBy: string;
  bottleMaterial: string;          // pet | hdpe | glass | pcr | other
  bottleMaterialOther: string;
  bottleSize: string;              // 75cc | 100cc | 120cc | 150cc | 200cc | 250cc | 300cc | other
  bottleSizeOther: string;
  bottleShape: string;             // round | packer | square | oval | other
  bottleShapeOther: string;
  bottleColor: string;             // clear | white | amber | black | other
  bottleColorOther: string;

  // --- Section D — filler ---
  fillerRequired: string;          // yes/no
  fillerSuppliedBy: string;
  fillerCotton: string;            // yes/no
  fillerDesiccant: string;         // yes/no
  fillerOther: string;             // free text ("" = none)

  // --- Section E — closure ---
  closureSuppliedBy: string;
  closureFinish: string;           // smooth | ribbed | crc | flip-top | other
  closureFinishOther: string;
  closureSizeMm: string;           // 33-400 | 38-400 | 45-400 | 53-400 | other
  closureSizeOther: string;
  closureColor: string;            // white | black | other
  closureColorOther: string;
  closureLiner: string;            // induction | pressure-sensitive | foam | none | other
  closureLinerOther: string;

  // --- Section F — neckband ---
  neckbandRequired: string;        // yes/no
  neckbandSuppliedBy: string;
  neckbandColor: string;           // clear | other
  neckbandColorOther: string;
  neckbandPrint: string;           // free text
  neckbandPerforation: string;     // yes/no

  // --- Section G — full sleeve ---
  sleeveRequired: string;          // yes/no
  sleeveSuppliedBy: string;
  sleeveColor: string;             // clear | other
  sleeveColorOther: string;
  sleevePrint: string;             // free text
  sleevePerforation: string;       // yes/no

  // --- Section H — bottle label ---
  labelRequired: string;           // yes/no
  labelSuppliedBy: string;
  labelArtwork: string;            // free text / artwork reference

  // --- Section I — bottle lot & date printing ---
  lotPrintRequired: string;        // yes/no
  lotPrintSource: string;
  lotPrintFormat: string;          // julian | yymmdd | lot-alpha | other
  lotPrintFormatOther: string;
  lotPrintLine: string;
  expPrintRequired: string;        // yes/no
  expPrintSource: string;
  expPrintFormat: string;          // mm-yyyy | mm-dd-yyyy | yyyy-mm | other
  expPrintFormatOther: string;
  expPrintLine: string;
  otherPrintRequired: string;      // yes/no
  otherPrintWhat: string;
  otherPrintSource: string;
  otherPrintLine: string;
  printLocation: string;           // bottle | label | cap | other
  printLocationOnLabel: string;    // where on the label
  printColor: string;

  // --- Section J — secondary/retail packaging ---
  retailRequired: string;          // yes/no
  retailSuppliedBy: string;
  retailType: string;              // carton | display-box | other
  retailTypeOther: string;
  retailBottlesPerPack: string;
  // J.1 — retail printing
  retailArtwork: string;
  retailLotPrintRequired: string;  // yes/no
  retailLotPrintSource: string;
  retailLotPrintFormat: string;
  retailLotPrintFormatOther: string;
  retailLotPrintLine: string;
  retailExpPrintRequired: string;  // yes/no
  retailExpPrintSource: string;
  retailExpPrintFormat: string;
  retailExpPrintFormatOther: string;
  retailExpPrintLine: string;
  retailOtherPrintRequired: string; // yes/no
  retailOtherPrintWhat: string;
  retailOtherPrintSource: string;
  retailOtherPrintLine: string;
  retailPrintLocation: string;
  retailPrintColor: string;
  // J.2 — retail extra applications
  safetySealRequired: string;      // yes/no
  safetySealSuppliedBy: string;
  insertRequired: string;          // yes/no
  insertSuppliedBy: string;
  stickersRequired: string;        // yes/no
  stickersSuppliedBy: string;
  stickersWhere: string;
  retailExtraOther: string;        // free text ("" = none)

  // --- Section K — bundling ---
  bundlingRequired: string;        // yes/no
  bundleUnitsPerBundle: string;
  bundleShrinkWrap: string;        // yes/no
  bundleShrinkWrapSuppliedBy: string;
  bundleTrays: string;             // yes/no
  bundleTraysSuppliedBy: string;
  bundleOther: string;             // free text ("" = none)
  // K.1 — bundle extra applications
  bundleStickersRequired: string;  // yes/no
  bundleStickersWhere: string;
  bundleExtraOther: string;

  // --- Section L — inner pack ---
  innerPackRequired: string;       // yes/no
  innerPackSuppliedBy: string;
  innerPackHow: string;            // upright | laydown | bulk | other
  innerPackHowOther: string;
  innerPackQty: string;            // "" = no specific qty
  innerPackSize: string;           // "" = no specific size
  innerPackLabelInfo: string;      // "" = nothing specific
  innerPackLabelSize: string;      // "" = no specific size

  // --- Section M — master box ---
  masterBoxSuppliedBy: string;
  masterBoxQty: string;            // finished units or inner cases per box
  masterBoxSize: string;
  masterBoxLabelInfo: string;
  masterBoxLabelSize: string;

  // --- Section N — pallet ---
  palletType: string;              // gma-wood | heat-treated | plastic | other
  palletTypeOther: string;
  palletSize: string;              // 48x40 | 48x42 | euro | other
  palletSizeOther: string;
  palletConfig: string;            // "" = no specific configuration
  palletDimensionLimits: string;
  palletLabelRequired: string;     // yes/no
  palletLabelInfo: string;
  palletLabelSize: string;
  palletTemptale: string;          // yes/no

  // --- Section O — additional ---
  additionalInfo: string;
};

/** A fresh, fully-blank Packaging Spec (Bottles) — every field "".
 *  Exported so /start can seed one lazily on first edit. */
export function blankPackagingSpecBottles(): PackagingSpecBottles {
  return {
    formVersion: "202401",
    bottleCount: "",
    bulkSuppliedBy: "", bulkProductCode: "", dosageType: "", dosageTypeOther: "", dosageSize: "", dosageShape: "",
    bottleSuppliedBy: "", bottleMaterial: "", bottleMaterialOther: "", bottleSize: "", bottleSizeOther: "",
    bottleShape: "", bottleShapeOther: "", bottleColor: "", bottleColorOther: "",
    fillerRequired: "", fillerSuppliedBy: "", fillerCotton: "", fillerDesiccant: "", fillerOther: "",
    closureSuppliedBy: "", closureFinish: "", closureFinishOther: "", closureSizeMm: "", closureSizeOther: "",
    closureColor: "", closureColorOther: "", closureLiner: "", closureLinerOther: "",
    neckbandRequired: "", neckbandSuppliedBy: "", neckbandColor: "", neckbandColorOther: "",
    neckbandPrint: "", neckbandPerforation: "",
    sleeveRequired: "", sleeveSuppliedBy: "", sleeveColor: "", sleeveColorOther: "",
    sleevePrint: "", sleevePerforation: "",
    labelRequired: "", labelSuppliedBy: "", labelArtwork: "",
    lotPrintRequired: "", lotPrintSource: "", lotPrintFormat: "", lotPrintFormatOther: "", lotPrintLine: "",
    expPrintRequired: "", expPrintSource: "", expPrintFormat: "", expPrintFormatOther: "", expPrintLine: "",
    otherPrintRequired: "", otherPrintWhat: "", otherPrintSource: "", otherPrintLine: "",
    printLocation: "", printLocationOnLabel: "", printColor: "",
    retailRequired: "", retailSuppliedBy: "", retailType: "", retailTypeOther: "", retailBottlesPerPack: "",
    retailArtwork: "",
    retailLotPrintRequired: "", retailLotPrintSource: "", retailLotPrintFormat: "",
    retailLotPrintFormatOther: "", retailLotPrintLine: "",
    retailExpPrintRequired: "", retailExpPrintSource: "", retailExpPrintFormat: "",
    retailExpPrintFormatOther: "", retailExpPrintLine: "",
    retailOtherPrintRequired: "", retailOtherPrintWhat: "", retailOtherPrintSource: "", retailOtherPrintLine: "",
    retailPrintLocation: "", retailPrintColor: "",
    safetySealRequired: "", safetySealSuppliedBy: "", insertRequired: "", insertSuppliedBy: "",
    stickersRequired: "", stickersSuppliedBy: "", stickersWhere: "", retailExtraOther: "",
    bundlingRequired: "", bundleUnitsPerBundle: "", bundleShrinkWrap: "", bundleShrinkWrapSuppliedBy: "",
    bundleTrays: "", bundleTraysSuppliedBy: "", bundleOther: "",
    bundleStickersRequired: "", bundleStickersWhere: "", bundleExtraOther: "",
    innerPackRequired: "", innerPackSuppliedBy: "", innerPackHow: "", innerPackHowOther: "",
    innerPackQty: "", innerPackSize: "", innerPackLabelInfo: "", innerPackLabelSize: "",
    masterBoxSuppliedBy: "", masterBoxQty: "", masterBoxSize: "", masterBoxLabelInfo: "", masterBoxLabelSize: "",
    palletType: "", palletTypeOther: "", palletSize: "", palletSizeOther: "",
    palletConfig: "", palletDimensionLimits: "",
    palletLabelRequired: "", palletLabelInfo: "", palletLabelSize: "", palletTemptale: "",
    additionalInfo: "",
  };
}

// -----------------------------------------------------------------------------
// Packaging Specification Form (Blisters) — PandaDoc "Packaging Form (Blisters)"
// -----------------------------------------------------------------------------
// Field-for-field mirror of the blister card form (sections A–L), MINUS what
// the workflow captures elsewhere (company, product name/code, dosage type,
// attachments — dosage details stay here like the bottles spec does so the
// spec is self-contained for the PandaDoc sync). Same conventions as
// PackagingSpecBottles: everything a string, "" = unanswered, yes/no fields
// hold "yes" | "no", supplied-by fields hold "pharmacenter" | "customer",
// picklists pair with an *Other free-text field.
export type PackagingSpecBlisters = {
  formVersion: string; // "blisters-202210"

  // --- Section A — product / bulk ---
  bulkSuppliedBy: string;          // "" | "pharmacenter" | "customer"
  bulkProductCode: string;         // PC bulk code when PharmaCenter-supplied
  dosageType: string;              // tablet | capsule | softgel | gummy | other
  dosageTypeOther: string;
  dosageSize: string;              // e.g. "00"
  dosageShape: string;

  // --- Section B — blister card ---
  cardFormatCode: string;          // tooling format, e.g. "C709", "A703"
  cardCount: string;               // doses per blister card, e.g. "15"
  cardLengthMm: string;
  cardWidthMm: string;

  // --- Section C — film (forming web) ---
  filmSuppliedBy: string;
  filmMaterial: string;            // pvc | pvdc | aclar | pet | other
  filmMaterialOther: string;
  filmThickness: string;           // 7.5-mil | 10-mil | 12-mil | other
  filmThicknessOther: string;
  filmColor: string;               // natural | amber | white | other
  filmColorOther: string;

  // --- Section D — lidding (foil) ---
  liddingSuppliedBy: string;
  liddingMaterial: string;         // aluminum | paper-alu | child-resistant | other
  liddingMaterialOther: string;
  liddingThickness: string;        // 20-um | 25-um | other
  liddingThicknessOther: string;
  liddingColor: string;            // natural | white | other
  liddingColorOther: string;
  liddingPreprinted: string;       // yes/no — pre-printed foil vs plain
  liddingPrintSides: string;       // single | double (when pre-printed)

  // --- Section E — blister card extras ---
  perforationRequired: string;     // yes/no
  butterflyHoleRequired: string;   // yes/no

  // --- Section F — lot & date coding ---
  codingType: string;              // printed-thermal | embossed | none | other
  codingTypeOther: string;
  lotPrintRequired: string;        // yes/no
  lotPrintSource: string;
  lotPrintFormat: string;          // e.g. "Lot: L####"
  expPrintRequired: string;        // yes/no
  expPrintSource: string;
  expPrintFormat: string;          // e.g. "EXP: MM/YYYY"
  otherPrintRequired: string;      // yes/no
  otherPrintWhat: string;
  otherPrintSource: string;

  // --- Section G — secondary/retail packaging ---
  retailRequired: string;          // yes/no — when yes, the finished unit is
  //                                  the carton, not the blister card
  retailSuppliedBy: string;
  retailType: string;              // ifc | carton | display-box | bifold-card | other
  retailTypeOther: string;
  retailBlistersPerPack: string;   // blisters per finished unit
  // G.1 — retail printing
  retailArtwork: string;
  retailPrintWhere: string;        // where lot/EXP go on the retail pack
  retailPrintColor: string;
  retailPrintFormat: string;
  retailLotSource: string;
  retailExpSource: string;
  // G.2 — retail extra applications
  safetySealRequired: string;      // yes/no
  safetySealSuppliedBy: string;
  /** Seals per finished unit — some jobs seal both ends, so 2. */
  safetySealQty: string;
  insertRequired: string;          // yes/no
  insertSuppliedBy: string;
  stickersRequired: string;        // yes/no
  stickersSuppliedBy: string;
  stickersWhere: string;
  retailExtraOther: string;

  // --- Section H — bundling ---
  bundlingRequired: string;        // yes/no
  bundleUnitsPerBundle: string;
  bundleShrinkWrap: string;        // yes/no
  bundleShrinkWrapSuppliedBy: string;
  bundleTrays: string;             // yes/no
  bundleTraysSuppliedBy: string;
  bundleOther: string;
  // H.1 — bundle extra applications
  bundleStickersRequired: string;  // yes/no
  bundleStickersWhere: string;
  bundleExtraOther: string;

  // --- Section I — inner pack ---
  innerPackRequired: string;       // yes/no
  innerPackSuppliedBy: string;
  innerPackHow: string;            // upright | laydown | bulk | other
  innerPackHowOther: string;
  innerPackQty: string;
  innerPackSize: string;
  innerPackLabelInfo: string;
  innerPackLabelSize: string;

  // --- Section J — master box ---
  masterBoxSuppliedBy: string;
  masterBoxQty: string;            // finished units or inner cases per box
  masterBoxSize: string;
  masterBoxLabelInfo: string;
  masterBoxLabelSize: string;

  // --- Section K — pallet ---
  palletType: string;              // gma-wood | heat-treated | plastic | other
  palletTypeOther: string;
  palletSize: string;              // 48x40 | 48x42 | euro | other
  palletSizeOther: string;
  palletConfig: string;
  palletDimensionLimits: string;
  palletLabelRequired: string;     // yes/no
  palletLabelInfo: string;
  palletLabelSize: string;
  palletTemptale: string;          // yes/no

  // --- Section L — additional ---
  additionalInfo: string;
};

/** A fresh, fully-blank Packaging Spec (Blisters) — every field "". */
export function blankPackagingSpecBlisters(): PackagingSpecBlisters {
  return {
    formVersion: "blisters-202210",
    bulkSuppliedBy: "", bulkProductCode: "", dosageType: "", dosageTypeOther: "", dosageSize: "", dosageShape: "",
    cardFormatCode: "", cardCount: "", cardLengthMm: "", cardWidthMm: "",
    filmSuppliedBy: "", filmMaterial: "", filmMaterialOther: "",
    filmThickness: "", filmThicknessOther: "", filmColor: "", filmColorOther: "",
    liddingSuppliedBy: "", liddingMaterial: "", liddingMaterialOther: "",
    liddingThickness: "", liddingThicknessOther: "", liddingColor: "", liddingColorOther: "",
    liddingPreprinted: "", liddingPrintSides: "",
    perforationRequired: "", butterflyHoleRequired: "",
    codingType: "", codingTypeOther: "",
    lotPrintRequired: "", lotPrintSource: "", lotPrintFormat: "",
    expPrintRequired: "", expPrintSource: "", expPrintFormat: "",
    otherPrintRequired: "", otherPrintWhat: "", otherPrintSource: "",
    retailRequired: "", retailSuppliedBy: "", retailType: "", retailTypeOther: "", retailBlistersPerPack: "",
    retailArtwork: "", retailPrintWhere: "", retailPrintColor: "", retailPrintFormat: "",
    retailLotSource: "", retailExpSource: "",
    safetySealRequired: "", safetySealSuppliedBy: "", safetySealQty: "", insertRequired: "", insertSuppliedBy: "",
    stickersRequired: "", stickersSuppliedBy: "", stickersWhere: "", retailExtraOther: "",
    bundlingRequired: "", bundleUnitsPerBundle: "", bundleShrinkWrap: "", bundleShrinkWrapSuppliedBy: "",
    bundleTrays: "", bundleTraysSuppliedBy: "", bundleOther: "",
    bundleStickersRequired: "", bundleStickersWhere: "", bundleExtraOther: "",
    innerPackRequired: "", innerPackSuppliedBy: "", innerPackHow: "", innerPackHowOther: "",
    innerPackQty: "", innerPackSize: "", innerPackLabelInfo: "", innerPackLabelSize: "",
    masterBoxSuppliedBy: "", masterBoxQty: "", masterBoxSize: "", masterBoxLabelInfo: "", masterBoxLabelSize: "",
    palletType: "", palletTypeOther: "", palletSize: "", palletSizeOther: "",
    palletConfig: "", palletDimensionLimits: "",
    palletLabelRequired: "", palletLabelInfo: "", palletLabelSize: "", palletTemptale: "",
    additionalInfo: "",
  };
}

// A saved pricing-calculator snapshot. A workflow can have many — they show
// up as Excel-style tabs in the calculator. Each tab targets one workflow
// product (optional) so a single workflow with multiple products can have
// independent pricing per product without losing context.
// All money/percent inputs are stored as their string representation (matches
// what the calculator UI uses) so re-hydration is lossless. Results are also
// included so the workflow detail view can summarise without re-doing math.
export type PricingSnapshot = {
  // Stable id for this tab — generated client-side, never reused.
  tabId: string;
  // Optional user-facing tab label. When null we auto-derive from the picked
  // product name (or fall back to "Tab N" via the tab index).
  label: string | null;
  // The workflow product this tab is pricing. Empty string = not picked yet.
  workflowProductUid: string;

  // Vendor context — either a saved vendor row or a free-form new vendor name
  // typed in the calculator.
  vendorMode: "existing" | "new";
  vendorId: string | null;
  vendorLabel: string | null; // human-readable vendor name at save time
  newVendorName: string;

  // Cost inputs (strings to preserve exact formatting the user typed).
  shippingOrigin: "usa" | "international";
  incoterm: "EXW" | "FOB" | "CFR" | "CIF" | "DAP" | "DDP";
  unitCost: string;
  quantity: string;
  freight: string;
  insurance: string;
  customsBroker: string;
  dutiesPct: string;
  handling: string;
  testing: string;
  margin: string;
  marginMode: "markup" | "gross-margin";

  // Sales commissions (task #352) — percent of sale price, deducted from
  // gross profit. Bulk quotes default HoS 0.50% + Rep 3%; both editable.
  // Optional so pre-commission snapshots still parse (hydrate as blank = 0%).
  hosCommissionPct?: string;
  repCommissionPct?: string;

  // v2 landed-cost model (Jul 2026 rebuild — see task #155).
  // Optional so pre-v2 snapshots still parse; defaults get applied on hydrate.
  //   shippingMode: only meaningful when shippingOrigin === "international".
  //                 Air adds a $200 airline terminal-handling fee to the broker
  //                 baseline and skips HMF (HMF is ocean-only per CBP).
  //   otherCosts:   catch-all buffer for CBP hold-and-exam fees, misc inspection
  //                 charges, etc. Default $200 seeded on new tabs.
  //   deliveryOverride: only used when shipment kg > 500. Under 500 kg we auto-
  //                     apply the $230 LCL minimum. Above that the rep types a
  //                     value here (we haven't calibrated the >500kg curve yet).
  shippingMode?: "ocean" | "air";
  otherCosts?: string;
  deliveryOverride?: string;

  // Domestic landed-cost model v1 (task #157) — mirrors the international
  // v2 model for USA shipments. Fields are optional so pre-v1 snapshots
  // still parse; defaults get applied on hydrate.
  //   domesticMode:    FTL (full truckload — ALG-style broker quote) or
  //                    LTL (less-than-truckload — TQL/TForce-style). Parallels
  //                    ocean/air. Purely informational today; drives the
  //                    lane-history table once we start logging.
  //   originState:     2-letter US state code of the shipment origin. Used
  //                    to key rate history for lane-level suggestions.
  //   shipmentWeightLb: total shipment weight in pounds — auto-computed from
  //                    unitWeightG × qty when known, or rep-typed.
  //   palletCount:     # of pallets on the shipment (metadata; helps rate
  //                    lookup and freight-class inference).
  //   freightClass:    NMFC class for LTL shipments (65, 70, 85, etc.).
  //                    Ignored for FTL. Optional even for LTL.
  //   accessorials:    Detention, liftgate, notification, late-delivery
  //                    credits, etc. Separate from the base freight so
  //                    the rep can capture the negotiated final total.
  domesticMode?: "ftl" | "ltl";
  originState?: string;
  shipmentWeightLb?: string;
  palletCount?: string;
  freightClass?: string;
  accessorials?: string;

  // Snapshot of computed results at the moment of save. Stored as plain
  // numbers in dollars — useful for the workflow listing summary so it
  // doesn't have to redo arithmetic.
  result: {
    landedTotal: number;
    landedPerUnit: number;
    salePerUnit: number;
    totalRevenue: number;
    grossProfit: number;
    effectiveMargin: number;
    effectiveMarkup: number;
  };

  savedAt: string; // ISO timestamp
  savedByEmail: string;
};

export type WorkflowState = {
  // Storage prefix for attachments. Generated once on the client when a fresh
  // workflow is created. Stays stable even after the DB row's UUID is known.
  workflowUid: string;
  customerMode: WorkflowMode;
  customerId: string | null;
  newCustomer: { name: string; contact: string; email: string };
  type: string | null;
  form: string | null;
  source: string | null;
  // For Contract Packaging workflows only: the dosage form of whatever is
  // being packaged (Softgels / Gummies / Tablets / Capsules / Other).
  // Bulk uses state.form for its dosage form already, so this field is
  // null on Bulk workflows. Optional so historical rows still parse.
  dosage?: string | null;
  // Contract Packaging only: pieces per display unit ("Dosage per unit
  // (count)" on the bottle costing sheet — 30ct / 60ct). Stored as the
  // typed string like every other numeric input. Optional so historical
  // rows still parse.
  dosageCount?: string | null;
  products: ProductEntry[];
  // Pricing tabs in order. Each entry is the saved state of one calculator
  // tab. Order is meaningful (it matches the order shown in the calculator
  // tab bar). Optional for backward compatibility with workflows created
  // before this feature.
  //
  // Historical note: an earlier version of this field used a
  // Record<productUid, snapshot> shape. The hydration code accepts both
  // shapes so existing rows still load.
  pricing?: PricingSnapshot[];
  // Saved customer-facing quote document versions ("Issue a Quote" tabs).
  // Each entry is one tab in the quote popup — a full snapshot of the
  // editable sheet HTML, so we round-trip every edit (line items, custom
  // T&Cs, signature names) lossless. Optional for backward compatibility
  // with workflows created before the multi-version quote feature.
  issuedQuotes?: IssuedQuoteTab[];
  // Saved gummy-formula calculator state for CP → Gummies → Manufactured at
  // PharmaCenter workflows. Optional; only present after the user visits
  // /workflow/[id]/gummy-formula and hits Save. See GummyFormula below.
  //
  // LEGACY: pre-catalog workflows authored the formula inline right here.
  // New workflows (post-catalog rollout) use gummyFormulaRef instead — a
  // pointer to a versioned catalog row. Both fields can coexist during the
  // transition; if a ref is present it wins.
  gummyFormula?: GummyFormula;
  // Contract-Packaging (Bottles) cost build-up. Deliberately stores the
  // INPUTS — component picks, bottles/minute, crew, rates, overhead shares —
  // and never the computed dollars, so reopening an old quote recalculates
  // against today's costs instead of showing a stale number that looks
  // authoritative. Shape lives in app/workflow/[id]/bottle-costing
  // (SavedState); typed loosely here to avoid a lib -> app import cycle.
  bottleCosting?: Record<string, unknown>;
  // Reference to a snapshotted version in the gummy_formulas catalog. See
  // /lib/formulas.ts (GummyFormulaReference). Small enough to store on the
  // state row without bloating it — cached identity fields let the workflow
  // detail page render "PC-BK-247 — Sour Green Apple" without a fetch.
  gummyFormulaRef?: import("./formulas").GummyFormulaReference;
};

// -----------------------------------------------------------------------------
// Gummy-formula calculator persistence
// -----------------------------------------------------------------------------

// One row on the gummy-formula sheet — an ingredient line.
// rawMaterialId is a FK into public.raw_materials (nullable so users can add
// custom one-off lines). costPerKgOverride/solidsOverride let a line stray
// from the raw_materials defaults for THIS formula without disturbing the
// catalogue. pctInFinished is the % of the finished, post-cook blend the
// ingredient contributes.
export type GummyFormulaRow = {
  id: string;
  rawMaterialId: string | null;
  customName: string | null;
  pctInFinished: number;               // 0..100
  costPerKgOverride: number | null;    // dollars/kg; null = use raw material default
  solidsOverride: number | null;       // 0..1; null = use raw material default
  notes: string | null;
};

// Batch-level params for the gummy-formula calculator.
//   fixedLossKgPerDay:  ~20 kg/day is lost regardless of how many 100kg batches
//                       we run. 1 batch/day → 20% loss; 6 batches/day → 3.33%.
//                       Applied as: effective_yield = (batches*kg − fixed_loss)/(batches*kg).
//   yieldPct:           process yield BEFORE the daily fixed loss (100% = perfect).
//   gummyPieceWeightG:  finished gummy weight, e.g. 3.0g for a bear gummy.
export type GummyFormula = {
  batchKg: number;                     // e.g. 100
  batchesPerDay: number;               // e.g. 6
  fixedLossKgPerDay: number;           // e.g. 20
  gummyPieceWeightG: number;           // e.g. 3.0
  yieldPct: number;                    // e.g. 100 (before daily loss)
  rows: GummyFormulaRow[];
  savedAt: string;                     // ISO
  savedByEmail: string;
};

// One tab in the customer-facing quote popup. We persist the full inner
// HTML of the .q-sheet container rather than try to model each editable
// field — that way any custom T&Cs / signature edits / line item tweaks
// the user made survive a save/reload round-trip.
export type IssuedQuoteTab = {
  id: string;          // stable client-generated id
  label: string;       // user-facing tab label e.g. "Version 1"
  sheetHtml: string;   // innerHTML of .q-sheet at save time
  savedAt: string;     // ISO timestamp
};

// Lifecycle of a workflow. "in_progress" is the default until the user
// explicitly marks a quote as Won or Lost. Mirrors the DB CHECK constraint.
export type WorkflowStatus = "in_progress" | "won" | "lost";

export const WORKFLOW_STATUS_LABELS: Record<WorkflowStatus, string> = {
  in_progress: "In Progress",
  won: "Won",
  lost: "Lost",
};

// Recorded when a workflow is marked Won — one entry per Sales Order tied to
// this quote. Persisted as the JSONB `sales_orders` column on `workflows`.
// `value` is in whole-dollar units (no currency code, en-US assumed).
export type SalesOrder = {
  so_number: string;
  value: number; // dollars
};

export type WorkflowRow = {
  id: string;
  // Per-workflow sequential number backed by a Postgres sequence. Display
  // form is "Q" followed by the number zero-padded to 4 digits (Q0001).
  // Stable for the life of the row even after edits.
  quote_number: number;
  created_by_email: string;
  created_at: string;
  updated_at: string;
  state: WorkflowState;
  status: WorkflowStatus;
  sales_orders: SalesOrder[];
  // Optional user-typed override for the description that shows in the
  // /workflows listing. When null/empty, the server falls back to a label
  // computed from the products + form (see buildAutoDescription).
  description_override: string | null;
  monday_item_id: string | null;
  monday_item_url: string | null;
  monday_last_pushed_at: string | null;
};

/** Format a quote_number as the user-facing "Q0001" string. */
export function formatQuoteNumber(n: number): string {
  return `Q${String(n).padStart(4, "0")}`;
}

// Dosage form labels (Bulk) — kept here (not in the page) so the
// auto-description helper can share them with the listing/management
// pages.
const DESCRIPTION_FORM_LABELS: Record<string, string> = {
  softgel: "Softgels",
  gummy: "Gummies",
  tablet: "Tablets",
  capsule: "Capsules",
  other: "Other",
};

// Packaging-type labels (Contract Packaging). Same idea as the dosage
// form map — the start page reuses state.form to store this value, but
// the id namespace is its own (bottles/blisters/sachets/pouches/kitting).
const DESCRIPTION_PACKAGING_LABELS: Record<string, string> = {
  bottles: "Bottles",
  blisters: "Blisters",
  sachets: "Sachets",
  pouches: "Pouches",
  kitting: "Kitting",
  other: "Other",
};

/**
 * Single-line "Description" summary used in both the workflows table and the
 * inline description editor placeholder. Built from product names + the
 * dosage form (for bulk) so "Omega 3 + Vitamin D3 Softgels" comes out
 * verbatim. Callers pass in their own lookup of productId → display name so
 * this helper doesn't need to know about the DB schema.
 *
 * Empty string when there are no products — callers decide whether to show
 * "—" or a different placeholder.
 */
export function buildAutoDescription(
  state: WorkflowState,
  productNameById: Record<string, string>,
): string {
  const products = state.products ?? [];
  const names = products.map((p) => {
    if (p.mode === "new") return p.newProduct?.name_desc || "New product";
    if (p.productId && productNameById[p.productId]) return productNameById[p.productId];
    return "Product";
  });
  if (names.length === 0) return "";
  const joined = names.join(" + ");
  // Append the right second-step label depending on quote type:
  // Bulk → dosage form (Softgels / Gummies / ...), Contract Packaging →
  // dosage form + packaging type ("Softgels in Bottles"). All other
  // types skip it.
  let formLabel = "";
  if (state.type === "bulk" && state.form) {
    formLabel = DESCRIPTION_FORM_LABELS[state.form] || state.form;
  } else if (state.type === "contract-packaging") {
    const dosage = state.dosage
      ? DESCRIPTION_FORM_LABELS[state.dosage] || state.dosage
      : "";
    const pack = state.form
      ? DESCRIPTION_PACKAGING_LABELS[state.form] || state.form
      : "";
    if (dosage && pack) formLabel = `${dosage} in ${pack}`;
    else formLabel = dosage || pack;
  }
  return formLabel ? `${joined} ${formLabel}` : joined;
}

/** Picks the user-typed override when present, otherwise the auto-label. */
export function resolveDescription(
  override: string | null | undefined,
  auto: string,
): string {
  const trimmed = override?.trim();
  if (trimmed) return trimmed;
  return auto;
}

/**
 * Check whether an email is registered in the `admins` table. Used by the
 * /workflow/[id] page to decide whether to show the delete button — RLS
 * still enforces the rule on DELETE, this is purely UI.
 *
 * Accepts a Supabase client (server-side `createClient()`) so this can be
 * called from route handlers or RSCs without re-creating one.
 */
export async function isAdmin(
  supabase: AnySupabase,
  email: string | null | undefined,
): Promise<boolean> {
  if (!email) return false;
  const { data, error } = await supabase
    .from("admins")
    .select("email")
    .eq("email", email)
    .maybeSingle();
  if (error) {
    // Don't throw — surface as "not admin" so the page still renders.
    console.error("isAdmin lookup failed:", error.message);
    return false;
  }
  return !!data;
}
