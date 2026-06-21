"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/lib/supabase";

// Pricing calculator client component. All math is dollar-and-percent simple
// arithmetic, derived from input strings live as the user types. Inputs are
// kept as strings (with comma formatting for dollars) so we can render
// exactly what the user typed and re-parse to numbers per render.

type Mode = "markup" | "gross-margin";
type VendorMode = "existing" | "new";
// Shipping origin — affects whether duties apply. "usa" treats the duties
// percentage as zero and hides the input; "international" exposes it. The
// product cost stays whatever the user types regardless of origin.
type ShippingOrigin = "usa" | "international";

// Incoterms 2020 for international shipments. Each term flips which cost
// inputs the buyer is responsible for. The matrix below (INCOTERM_FIELDS)
// is the source of truth — change there to update the visible inputs.
type Incoterm = "EXW" | "FOB" | "CFR" | "CIF" | "DAP" | "DDP";

const INCOTERM_LABELS: Record<Incoterm, string> = {
  EXW: "EXW — Ex Works",
  FOB: "FOB — Free On Board",
  CFR: "CFR — Cost & Freight",
  CIF: "CIF — Cost, Insurance & Freight",
  DAP: "DAP — Delivered at Place",
  DDP: "DDP — Delivered Duty Paid",
};

const INCOTERM_DESCRIPTIONS: Record<Incoterm, string> = {
  EXW: "You pay everything from the supplier's door — international freight, insurance, duties, and customs clearance.",
  FOB: "Supplier delivers to the ship at the origin port. You pay international freight, insurance, duties, and customs clearance.",
  CFR: "Supplier pays freight to the destination port. You pay insurance, duties, and customs clearance.",
  CIF: "Supplier pays freight + insurance to the destination port. You pay duties and customs clearance.",
  DAP: "Supplier delivers to the place you name. You pay duties and customs clearance.",
  DDP: "Supplier handles everything including duties. Your only extras are lab testing and any other miscellaneous fees.",
};

// Which buyer-side cost fields show up for each Incoterm. Lab testing and
// "other fees" are always shown (constants across all terms).
const INCOTERM_FIELDS: Record<
  Incoterm,
  { freight: boolean; insurance: boolean; duties: boolean; customs: boolean }
> = {
  EXW: { freight: true, insurance: true, duties: true, customs: true },
  FOB: { freight: true, insurance: true, duties: true, customs: true },
  CFR: { freight: false, insurance: true, duties: true, customs: true },
  CIF: { freight: false, insurance: false, duties: true, customs: true },
  DAP: { freight: false, insurance: false, duties: true, customs: true },
  DDP: { freight: false, insurance: false, duties: false, customs: false },
};

// Per-workflow-product dropdown option passed in from the server.
export type WorkflowProductOption = {
  uid: string;
  label: string;
  sub: string | null;
  // Pre-fill value for the calculator's quantity input when the user picks
  // this product. Already formatted with commas if applicable.
  quantity: string | null;
};

// Row shape we get back from the vendors table search. Mirrors the columns
// declared by the vendors schema migration.
type VendorRow = {
  id: string;
  name: string;
};

const VENDOR_SEARCH_LIMIT = 12;

// ---------- input formatters ----------

function formatValueInput(raw: string): string {
  const cleaned = raw.replace(/[^\d.]/g, "");
  const firstDot = cleaned.indexOf(".");
  const safe =
    firstDot === -1
      ? cleaned
      : cleaned.slice(0, firstDot + 1) + cleaned.slice(firstDot + 1).replace(/\./g, "");
  const [intPart, decPart] = safe.split(".");
  const withCommas = (intPart || "").replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  if (decPart === undefined) return withCommas;
  return `${withCommas}.${decPart.slice(0, 2)}`;
}

function formatPercentInput(raw: string): string {
  const cleaned = raw.replace(/[^\d.]/g, "");
  const firstDot = cleaned.indexOf(".");
  const safe =
    firstDot === -1
      ? cleaned
      : cleaned.slice(0, firstDot + 1) + cleaned.slice(firstDot + 1).replace(/\./g, "");
  const [intPart, decPart] = safe.split(".");
  if (decPart === undefined) return intPart;
  return `${intPart}.${decPart.slice(0, 4)}`;
}

function formatQtyInput(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function num(formatted: string): number {
  const cleaned = formatted.replace(/,/g, "");
  if (cleaned.trim() === "") return 0;
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : 0;
}

const usd = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

// Kept as a separate formatter in case we ever want sub-cent precision back,
// but for now every price/cost display uses 2 decimal places — the per-unit
// values were too noisy when shown to 4 decimals.
const usdFine = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const pct = new Intl.NumberFormat("en-US", {
  style: "percent",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

type Props = {
  workflowProducts: WorkflowProductOption[];
  workflowLabel: string | null;
};

export default function PricingCalculator({ workflowProducts, workflowLabel }: Props) {
  // --- Workflow product picker ----------------------------------------
  // Only relevant when we were launched from a workflow. "" means "not picked"
  // — the dropdown shows "Choose product" in that state.
  const [workflowProductUid, setWorkflowProductUid] = useState<string>("");

  const pickedProduct = useMemo(
    () => workflowProducts.find((p) => p.uid === workflowProductUid) ?? null,
    [workflowProducts, workflowProductUid],
  );

  // --- Vendor picker --------------------------------------------------
  // Mirrors the customer selector UX on /start: toggle between existing
  // (autocomplete from vendors table) and new (free-text). The selected
  // vendor never gets persisted by this page — it's purely informational
  // for the user while they explore pricing.
  const [vendorMode, setVendorMode] = useState<VendorMode>("existing");
  const [vendorId, setVendorId] = useState<string | null>(null);
  const [vendorName, setVendorName] = useState<string | null>(null);
  const [vendorSearch, setVendorSearch] = useState<string>("");
  const [vendorResults, setVendorResults] = useState<VendorRow[]>([]);
  const [vendorSearching, setVendorSearching] = useState(false);
  // True when the user is actively browsing the dropdown — once they pick a
  // vendor we collapse the search list. The "Change" link reopens it.
  const [vendorEditing, setVendorEditing] = useState(true);
  const [newVendorName, setNewVendorName] = useState<string>("");

  // Debounced search against the vendors table. We use ilike so any
  // substring matches, matching how the customer selector behaves.
  useEffect(() => {
    if (vendorMode !== "existing") {
      setVendorResults([]);
      return;
    }
    const term = vendorSearch.trim();
    if (term.length === 0) {
      setVendorResults([]);
      return;
    }
    const sb = supabase;
    if (!sb) return;
    setVendorSearching(true);
    const handle = setTimeout(async () => {
      const { data, error } = await sb
        .from("vendors")
        .select("id, name")
        .eq("active", true)
        .ilike("name", `%${term}%`)
        .order("name")
        .limit(VENDOR_SEARCH_LIMIT);
      // Table may not exist yet in the schema (early bootstrap); swallow
      // and treat as "no results" so the UI doesn't surface a scary error.
      if (error) {
        console.warn("vendors search failed:", error.message);
        setVendorResults([]);
      } else {
        setVendorResults((data ?? []) as VendorRow[]);
      }
      setVendorSearching(false);
    }, 180);
    return () => {
      clearTimeout(handle);
      setVendorSearching(false);
    };
  }, [vendorSearch, vendorMode]);

  const pickVendor = (v: VendorRow) => {
    setVendorId(v.id);
    setVendorName(v.name);
    setVendorSearch(v.name);
    setVendorEditing(false);
    setVendorResults([]);
  };

  const resetVendor = () => {
    setVendorId(null);
    setVendorName(null);
    setVendorSearch("");
    setVendorEditing(true);
    setVendorResults([]);
  };

  const onVendorModeChange = (next: VendorMode) => {
    setVendorMode(next);
    // Clear cross-mode state so we don't keep stale picks lingering.
    setVendorId(null);
    setVendorName(null);
    setVendorSearch("");
    setVendorResults([]);
    setVendorEditing(true);
  };

  const selectedVendorDisplay =
    vendorMode === "existing"
      ? vendorName
      : newVendorName.trim().length > 0
        ? newVendorName.trim()
        : null;

  // --- Inputs ----------------------------------------------------------
  const [shippingOrigin, setShippingOrigin] = useState<ShippingOrigin>("usa");
  // Default Incoterm. Only meaningful when shippingOrigin is "international".
  // CIF is the most common term we quote against — supplier pays freight +
  // insurance to the destination port and we cover duties + customs.
  const [incoterm, setIncoterm] = useState<Incoterm>("CIF");
  const [unitCost, setUnitCost] = useState<string>("");
  const [quantity, setQuantity] = useState<string>("");
  const [freight, setFreight] = useState<string>("");
  // International-shipment specific cost slots. Each is a total-dollar
  // amount distributed across qty (same as freight/handling).
  const [insurance, setInsurance] = useState<string>("");
  const [customsBroker, setCustomsBroker] = useState<string>("");
  const [dutiesPct, setDutiesPct] = useState<string>("");
  const [handling, setHandling] = useState<string>("");
  // Lab / analytical testing fee. Constant on all terms — always shown.
  const [testing, setTesting] = useState<string>("");
  const [margin, setMargin] = useState<string>("30");
  const [marginMode, setMarginMode] = useState<Mode>("gross-margin");

  // Which buyer-side cost inputs to show for the current shipping mode.
  // For USA we hide everything Incoterm-related and only keep freight +
  // testing + other fees. For international we let the Incoterm decide.
  const visibility = shippingOrigin === "usa"
    ? { freight: true, insurance: false, duties: false, customs: false }
    : INCOTERM_FIELDS[incoterm];

  // When the user picks a workflow product, copy its quantity into the qty
  // field (overwriting whatever was there). They can still edit afterwards.
  const onPickWorkflowProduct = (uid: string) => {
    setWorkflowProductUid(uid);
    const product = workflowProducts.find((p) => p.uid === uid);
    if (product?.quantity) {
      setQuantity(formatQtyInput(product.quantity));
    }
  };

  // --- Derived ---------------------------------------------------------
  const results = useMemo(() => {
    const u = num(unitCost);
    const q = num(quantity);
    // Only count buyer-side costs that are currently visible — when a field
    // is hidden because the Incoterm covers it, its value drops out of the
    // math even if the user previously typed something. Lab testing and
    // "other fees" are always counted.
    const fr = visibility.freight ? num(freight) : 0;
    const ins = visibility.insurance ? num(insurance) : 0;
    const cb = visibility.customs ? num(customsBroker) : 0;
    const dp = visibility.duties ? num(dutiesPct) / 100 : 0;
    const hd = num(handling);
    const ts = num(testing);
    const mPct = num(margin) / 100;

    const productCost = u * q;
    const dutiesAmount = productCost * dp;
    const landedTotal = productCost + fr + ins + cb + dutiesAmount + hd + ts;
    const landedPerUnit = q > 0 ? landedTotal / q : 0;

    let salePerUnit = 0;
    if (landedPerUnit > 0) {
      if (marginMode === "markup") {
        salePerUnit = landedPerUnit * (1 + mPct);
      } else {
        const capped = Math.min(mPct, 0.9999);
        salePerUnit = landedPerUnit / (1 - capped);
      }
    }
    const totalRevenue = salePerUnit * q;
    const grossProfit = totalRevenue - landedTotal;
    const effectiveMargin = totalRevenue > 0 ? grossProfit / totalRevenue : 0;
    const effectiveMarkup = landedTotal > 0 ? grossProfit / landedTotal : 0;

    return {
      productCost,
      dutiesAmount,
      landedTotal,
      landedPerUnit,
      salePerUnit,
      totalRevenue,
      grossProfit,
      effectiveMargin,
      effectiveMarkup,
      hasInputs: u > 0 && q > 0,
    };
  }, [
    unitCost, quantity,
    freight, insurance, customsBroker, dutiesPct, handling, testing,
    margin, marginMode,
    shippingOrigin, incoterm,
    visibility.freight, visibility.insurance, visibility.duties, visibility.customs,
  ]);

  const reset = () => {
    setWorkflowProductUid("");
    setShippingOrigin("usa");
    setIncoterm("CIF");
    setUnitCost("");
    setQuantity("");
    setFreight("");
    setInsurance("");
    setCustomsBroker("");
    setDutiesPct("");
    setHandling("");
    setTesting("");
    setMargin("30");
    setMarginMode("gross-margin");
    resetVendor();
    setNewVendorName("");
    setVendorMode("existing");
  };

  return (
    <div className="pricing">
      {workflowProducts.length > 0 ? (
        <section className="pricing__section">
          <h2 className="pricing__section-title">
            Workflow product
            {workflowLabel ? (
              <span className="pricing__section-tag">{workflowLabel}</span>
            ) : null}
          </h2>
          <label className="pricing__field">
            <span className="pricing__label">Pricing for</span>
            <div className="pricing__input-wrap">
              <select
                className="pricing__input pricing__input--select"
                value={workflowProductUid}
                onChange={(e) => onPickWorkflowProduct(e.target.value)}
              >
                <option value="">Choose a product…</option>
                {workflowProducts.map((p) => (
                  <option key={p.uid} value={p.uid}>
                    {p.label}
                    {p.sub ? ` — ${p.sub}` : ""}
                    {p.quantity ? ` (${p.quantity} units)` : ""}
                  </option>
                ))}
              </select>
            </div>
          </label>
          {pickedProduct ? (
            <p className="pricing__hint">
              Picking <strong>{pickedProduct.label}</strong> filled in the
              quantity below — adjust it if you&rsquo;re pricing a different
              run size.
            </p>
          ) : (
            <p className="pricing__hint">
              Pick the product on this workflow you&rsquo;re pricing for. The
              quantity from that product will pre-fill below.
            </p>
          )}
        </section>
      ) : null}

      <section className="pricing__section">
        <h2 className="pricing__section-title">Vendor</h2>
        <div className="pricing__vendor-toggle" role="radiogroup" aria-label="Vendor mode">
          <button
            type="button"
            role="radio"
            aria-checked={vendorMode === "existing"}
            className={`pricing__mode ${vendorMode === "existing" ? "pricing__mode--active" : ""}`}
            onClick={() => onVendorModeChange("existing")}
          >
            Existing vendor
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={vendorMode === "new"}
            className={`pricing__mode ${vendorMode === "new" ? "pricing__mode--active" : ""}`}
            onClick={() => onVendorModeChange("new")}
          >
            New vendor
          </button>
        </div>

        {vendorMode === "existing" ? (
          vendorName && !vendorEditing ? (
            <div className="pricing__vendor-picked">
              <div>
                <div className="pricing__vendor-picked-name">{vendorName}</div>
                <div className="pricing__vendor-picked-sub">
                  From Fishbowl vendor directory
                </div>
              </div>
              <button
                type="button"
                className="pricing__vendor-change"
                onClick={resetVendor}
              >
                Change
              </button>
            </div>
          ) : (
            <div className="pricing__vendor-search">
              <label className="pricing__field">
                <span className="pricing__label">Search vendors</span>
                <div className="pricing__input-wrap">
                  <input
                    type="text"
                    className="pricing__input"
                    placeholder="Start typing a vendor name…"
                    value={vendorSearch}
                    onChange={(e) => {
                      setVendorSearch(e.target.value);
                      setVendorEditing(true);
                      if (vendorId) {
                        setVendorId(null);
                        setVendorName(null);
                      }
                    }}
                    autoComplete="off"
                  />
                </div>
              </label>
              {vendorSearch.trim().length > 0 ? (
                vendorResults.length > 0 ? (
                  <ul className="pricing__vendor-list">
                    {vendorResults.map((v) => (
                      <li key={v.id}>
                        <button
                          type="button"
                          className="pricing__vendor-option"
                          onClick={() => pickVendor(v)}
                        >
                          {v.name}
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : vendorSearching ? (
                  <p className="pricing__hint pricing__hint--inline">Searching…</p>
                ) : (
                  <p className="pricing__hint pricing__hint--inline">
                    No vendors matched &ldquo;{vendorSearch.trim()}&rdquo;. Try
                    switching to <strong>New vendor</strong> if this one
                    isn&rsquo;t in Fishbowl yet.
                  </p>
                )
              ) : null}
            </div>
          )
        ) : (
          <label className="pricing__field">
            <span className="pricing__label">Vendor name</span>
            <div className="pricing__input-wrap">
              <input
                type="text"
                className="pricing__input"
                placeholder="e.g. New Asia Pharma Co."
                value={newVendorName}
                onChange={(e) => setNewVendorName(e.target.value)}
                autoComplete="off"
              />
            </div>
          </label>
        )}

        <p className="pricing__hint">
          Vendor is informational — it doesn&rsquo;t change the math. Helpful
          when you&rsquo;re comparing quotes from different suppliers.
        </p>
      </section>

      <section className="pricing__section">
        <h2 className="pricing__section-title">Product cost</h2>
        <div className="pricing__row">
          <label className="pricing__field">
            <span className="pricing__label">Cost per unit</span>
            <div className="pricing__input-wrap">
              <span className="pricing__input-prefix">$</span>
              <input
                type="text"
                inputMode="decimal"
                className="pricing__input pricing__input--money"
                value={unitCost}
                onChange={(e) => setUnitCost(formatValueInput(e.target.value))}
                placeholder="0.00"
                autoComplete="off"
              />
            </div>
          </label>
          <label className="pricing__field">
            <span className="pricing__label">Quantity (units)</span>
            <div className="pricing__input-wrap">
              <input
                type="text"
                inputMode="numeric"
                className="pricing__input"
                value={quantity}
                onChange={(e) => setQuantity(formatQtyInput(e.target.value))}
                placeholder="0"
                autoComplete="off"
              />
            </div>
          </label>
        </div>
      </section>

      <section className="pricing__section">
        <h2 className="pricing__section-title">Inbound costs</h2>
        <div className="pricing__row">
          <div className="pricing__field">
            <span className="pricing__label">Shipping origin</span>
            <div
              className="pricing__mode-toggle"
              role="radiogroup"
              aria-label="Shipping origin"
            >
              <button
                type="button"
                role="radio"
                aria-checked={shippingOrigin === "usa"}
                className={`pricing__mode ${shippingOrigin === "usa" ? "pricing__mode--active" : ""}`}
                onClick={() => setShippingOrigin("usa")}
              >
                USA (domestic)
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={shippingOrigin === "international"}
                className={`pricing__mode ${shippingOrigin === "international" ? "pricing__mode--active" : ""}`}
                onClick={() => setShippingOrigin("international")}
              >
                International
              </button>
            </div>
          </div>
          {shippingOrigin === "international" ? (
            <div className="pricing__field">
              <span className="pricing__label">Shipping terms (Incoterm)</span>
              <IncotermSelect value={incoterm} onChange={setIncoterm} />
            </div>
          ) : null}
        </div>

        <div className="pricing__row" style={{ marginTop: 4 }}>
          {visibility.freight ? (
            <label className="pricing__field">
              <span className="pricing__label">
                {shippingOrigin === "international" ? "Freight (international + inland)" : "Freight (total)"}
              </span>
              <div className="pricing__input-wrap">
                <span className="pricing__input-prefix">$</span>
                <input
                  type="text"
                  inputMode="decimal"
                  className="pricing__input pricing__input--money"
                  value={freight}
                  onChange={(e) => setFreight(formatValueInput(e.target.value))}
                  placeholder="0.00"
                  autoComplete="off"
                />
              </div>
            </label>
          ) : null}
          {visibility.insurance ? (
            <label className="pricing__field">
              <span className="pricing__label">Insurance</span>
              <div className="pricing__input-wrap">
                <span className="pricing__input-prefix">$</span>
                <input
                  type="text"
                  inputMode="decimal"
                  className="pricing__input pricing__input--money"
                  value={insurance}
                  onChange={(e) => setInsurance(formatValueInput(e.target.value))}
                  placeholder="0.00"
                  autoComplete="off"
                />
              </div>
            </label>
          ) : null}
          {visibility.duties ? (
            <label className="pricing__field">
              <span className="pricing__label">Duties</span>
              <div className="pricing__input-wrap">
                <input
                  type="text"
                  inputMode="decimal"
                  className="pricing__input pricing__input--pct"
                  value={dutiesPct}
                  onChange={(e) => setDutiesPct(formatPercentInput(e.target.value))}
                  placeholder="0"
                  autoComplete="off"
                />
                <span className="pricing__input-suffix">%</span>
              </div>
            </label>
          ) : null}
          {visibility.customs ? (
            <label className="pricing__field">
              <span className="pricing__label">Customs broker</span>
              <div className="pricing__input-wrap">
                <span className="pricing__input-prefix">$</span>
                <input
                  type="text"
                  inputMode="decimal"
                  className="pricing__input pricing__input--money"
                  value={customsBroker}
                  onChange={(e) => setCustomsBroker(formatValueInput(e.target.value))}
                  placeholder="0.00"
                  autoComplete="off"
                />
              </div>
            </label>
          ) : null}
          <label className="pricing__field">
            <span className="pricing__label">Lab testing</span>
            <div className="pricing__input-wrap">
              <span className="pricing__input-prefix">$</span>
              <input
                type="text"
                inputMode="decimal"
                className="pricing__input pricing__input--money"
                value={testing}
                onChange={(e) => setTesting(formatValueInput(e.target.value))}
                placeholder="0.00"
                autoComplete="off"
              />
            </div>
          </label>
          <label className="pricing__field">
            <span className="pricing__label">Other fees</span>
            <div className="pricing__input-wrap">
              <span className="pricing__input-prefix">$</span>
              <input
                type="text"
                inputMode="decimal"
                className="pricing__input pricing__input--money"
                value={handling}
                onChange={(e) => setHandling(formatValueInput(e.target.value))}
                placeholder="0.00"
                autoComplete="off"
              />
            </div>
          </label>
        </div>
        <p className="pricing__hint">
          {visibility.duties
            ? "Duties are applied as a percent of the product cost. All other inbound costs are total dollar amounts distributed across the full quantity."
            : "All inbound costs shown are total dollar amounts distributed across the full quantity."}
        </p>
      </section>

      <section className="pricing__section">
        <h2 className="pricing__section-title">Pricing</h2>
        <div className="pricing__row">
          <label className="pricing__field pricing__field--margin">
            <span className="pricing__label">Margin</span>
            <div className="pricing__input-wrap">
              <input
                type="text"
                inputMode="decimal"
                className="pricing__input pricing__input--pct"
                value={margin}
                onChange={(e) => setMargin(formatPercentInput(e.target.value))}
                placeholder="30"
                autoComplete="off"
              />
              <span className="pricing__input-suffix">%</span>
            </div>
          </label>
          <div className="pricing__field pricing__field--mode">
            <span className="pricing__label">Margin type</span>
            <div className="pricing__mode-toggle" role="radiogroup" aria-label="Margin type">
              <button
                type="button"
                role="radio"
                aria-checked={marginMode === "gross-margin"}
                className={`pricing__mode ${marginMode === "gross-margin" ? "pricing__mode--active" : ""}`}
                onClick={() => setMarginMode("gross-margin")}
              >
                Gross margin
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={marginMode === "markup"}
                className={`pricing__mode ${marginMode === "markup" ? "pricing__mode--active" : ""}`}
                onClick={() => setMarginMode("markup")}
              >
                Markup
              </button>
            </div>
          </div>
        </div>
        <p className="pricing__hint">
          {marginMode === "gross-margin"
            ? "Gross margin: the % of the sale price that's profit. Sale = cost ÷ (1 − margin)."
            : "Markup: the % added on top of cost. Sale = cost × (1 + markup)."}
        </p>
      </section>

      <section className="pricing__results">
        <div className="pricing__results-header">
          <h2 className="pricing__section-title pricing__section-title--results">
            Results
          </h2>
          <button type="button" className="pricing__reset" onClick={reset}>
            Reset
          </button>
        </div>

        {pickedProduct || selectedVendorDisplay ? (
          <div className="pricing__context">
            {pickedProduct ? (
              <div className="pricing__context-pair">
                <span className="pricing__context-label">Product</span>
                <span className="pricing__context-value">{pickedProduct.label}</span>
              </div>
            ) : null}
            {selectedVendorDisplay ? (
              <div className="pricing__context-pair">
                <span className="pricing__context-label">Vendor</span>
                <span className="pricing__context-value">
                  {selectedVendorDisplay}
                  {vendorMode === "new" ? " · New" : ""}
                </span>
              </div>
            ) : null}
          </div>
        ) : null}

        {!results.hasInputs ? (
          <p className="pricing__empty">
            Enter a unit cost and quantity to see the math.
          </p>
        ) : (
          <>
            <div className="pricing__breakdown">
              <Row label="Product cost subtotal" value={usd.format(results.productCost)} />
              {visibility.duties ? (
                <Row label="Duties" value={usd.format(results.dutiesAmount)} muted />
              ) : null}
              {visibility.freight ? (
                <Row label="Freight" value={usd.format(num(freight))} muted />
              ) : null}
              {visibility.insurance ? (
                <Row label="Insurance" value={usd.format(num(insurance))} muted />
              ) : null}
              {visibility.customs ? (
                <Row label="Customs broker" value={usd.format(num(customsBroker))} muted />
              ) : null}
              <Row label="Lab testing" value={usd.format(num(testing))} muted />
              <Row label="Other fees" value={usd.format(num(handling))} muted />
              <Row
                label="Landed cost (in warehouse)"
                value={usd.format(results.landedTotal)}
                emphasis
              />
              <Row
                label="Landed cost per unit"
                value={usdFine.format(results.landedPerUnit)}
                muted
              />
            </div>

            <div className="pricing__highlight">
              <div className="pricing__highlight-label">Sale price per unit</div>
              <div className="pricing__highlight-value">
                {usdFine.format(results.salePerUnit)}
              </div>
              <div className="pricing__highlight-sub">
                {pct.format(results.effectiveMargin)} gross margin ·{" "}
                {pct.format(results.effectiveMarkup)} markup
              </div>
            </div>

            <div className="pricing__breakdown">
              <Row
                label="Total revenue at this price"
                value={usd.format(results.totalRevenue)}
              />
              <Row
                label="Gross profit"
                value={usd.format(results.grossProfit)}
                emphasis
              />
            </div>
          </>
        )}
      </section>
    </div>
  );
}

// Custom Incoterm dropdown — native <select> can't style options with
// descriptions, so we render a button that opens a panel listing each term
// with its full label on top and a small muted description below. Click
// outside or press Escape to close.
function IncotermSelect({
  value,
  onChange,
}: {
  value: Incoterm;
  onChange: (v: Incoterm) => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (!wrapRef.current) return;
      if (!wrapRef.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const terms = Object.keys(INCOTERM_LABELS) as Incoterm[];

  return (
    <div ref={wrapRef} style={{ position: "relative" }}>
      <button
        type="button"
        className="pricing__input pricing__input--select"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        style={{
          display: "block",
          width: "100%",
          textAlign: "left",
          cursor: "pointer",
        }}
      >
        <div style={{ fontWeight: 500 }}>{INCOTERM_LABELS[value]}</div>
        <div style={{ fontSize: 12, color: "#64748b", marginTop: 2, lineHeight: 1.4 }}>
          {INCOTERM_DESCRIPTIONS[value]}
        </div>
      </button>
      {open ? (
        <div
          role="listbox"
          style={{
            position: "absolute",
            top: "calc(100% + 4px)",
            left: 0,
            right: 0,
            background: "#fff",
            border: "1px solid #e5e7eb",
            borderRadius: 8,
            boxShadow: "0 12px 32px rgba(15, 23, 42, 0.12)",
            zIndex: 30,
            maxHeight: 360,
            overflowY: "auto",
            padding: 4,
          }}
        >
          {terms.map((t) => {
            const selected = t === value;
            return (
              <button
                key={t}
                type="button"
                role="option"
                aria-selected={selected}
                onClick={() => {
                  onChange(t);
                  setOpen(false);
                }}
                style={{
                  display: "block",
                  width: "100%",
                  textAlign: "left",
                  padding: "10px 12px",
                  background: selected ? "#f1f5f9" : "transparent",
                  border: "none",
                  borderRadius: 6,
                  cursor: "pointer",
                  marginBottom: 2,
                }}
                onMouseEnter={(e) => {
                  if (!selected) e.currentTarget.style.background = "#f8fafc";
                }}
                onMouseLeave={(e) => {
                  if (!selected) e.currentTarget.style.background = "transparent";
                }}
              >
                <div style={{ fontWeight: 500, fontSize: 14, color: "#0f172a" }}>
                  {INCOTERM_LABELS[t]}
                </div>
                <div style={{ fontSize: 12, color: "#64748b", marginTop: 2, lineHeight: 1.4 }}>
                  {INCOTERM_DESCRIPTIONS[t]}
                </div>
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

function Row({
  label,
  value,
  muted,
  emphasis,
}: {
  label: string;
  value: string;
  muted?: boolean;
  emphasis?: boolean;
}) {
  return (
    <div
      className={`pricing__breakdown-row ${
        emphasis ? "pricing__breakdown-row--emphasis" : ""
      } ${muted ? "pricing__breakdown-row--muted" : ""}`}
    >
      <span className="pricing__breakdown-label">{label}</span>
      <span className="pricing__breakdown-value">{value}</span>
    </div>
  );
}
