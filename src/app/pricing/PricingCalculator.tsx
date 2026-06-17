"use client";

import { useMemo, useState } from "react";

// Pricing calculator client component. All math is dollar-and-percent simple
// arithmetic so we can derive everything from the input strings live as the
// user types. Inputs are kept as strings (with comma formatting for dollars)
// so we can render exactly what the user typed; we re-parse to numbers per
// render rather than holding a parallel numeric state — that way there's no
// risk of the displayed string drifting from the underlying number.

type Mode = "markup" | "gross-margin";

// Strip everything except digits and a single decimal point, cap to two
// decimal places, then re-insert thousands commas. Used for all dollar
// inputs. Returns the user-visible string; pair with parseValueInput to
// recover the number.
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

// Percentages allow up to two decimals (e.g. "8.25%") but no commas.
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
  // Whole units only — quantities are integer in our context.
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

const usdFine = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 4,
  maximumFractionDigits: 4,
});

const pct = new Intl.NumberFormat("en-US", {
  style: "percent",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

export default function PricingCalculator() {
  // --- Inputs ----------------------------------------------------------
  const [unitCost, setUnitCost] = useState<string>("");
  const [quantity, setQuantity] = useState<string>("");
  const [freight, setFreight] = useState<string>("");
  const [dutiesPct, setDutiesPct] = useState<string>("");
  const [handling, setHandling] = useState<string>("");
  const [margin, setMargin] = useState<string>("30");
  // "markup" = sale = cost × (1 + m%). "gross-margin" = m = (sale − cost) / sale.
  // We default to gross-margin because that's how distributors typically
  // think about pricing here, but offer the toggle since both are common.
  const [marginMode, setMarginMode] = useState<Mode>("gross-margin");

  // --- Derived ---------------------------------------------------------
  const results = useMemo(() => {
    const u = num(unitCost);
    const q = num(quantity);
    const fr = num(freight);
    const dp = num(dutiesPct) / 100;
    const hd = num(handling);
    const mPct = num(margin) / 100;

    const productCost = u * q;
    const dutiesAmount = productCost * dp;
    const landedTotal = productCost + fr + dutiesAmount + hd;
    const landedPerUnit = q > 0 ? landedTotal / q : 0;

    // Sale price per unit derived from the chosen margin convention.
    // For gross-margin mode we guard against margin >= 100% (would divide
    // by zero / go negative); cap the formula at 99.99% so the math stays
    // finite even if a curious user types 100.
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
    // Effective gross margin and markup for the result panel — gives the
    // user a sanity check that the numbers match what they intended.
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
  }, [unitCost, quantity, freight, dutiesPct, handling, margin, marginMode]);

  const reset = () => {
    setUnitCost("");
    setQuantity("");
    setFreight("");
    setDutiesPct("");
    setHandling("");
    setMargin("30");
    setMarginMode("gross-margin");
  };

  return (
    <div className="pricing">
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
          <label className="pricing__field">
            <span className="pricing__label">Freight (total)</span>
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
          Duties are applied as a percent of the product cost. Freight and
          other fees are total dollar amounts and get distributed across the
          full quantity.
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

        {!results.hasInputs ? (
          <p className="pricing__empty">
            Enter a unit cost and quantity to see the math.
          </p>
        ) : (
          <>
            <div className="pricing__breakdown">
              <Row label="Product cost subtotal" value={usd.format(results.productCost)} />
              <Row label="Duties" value={usd.format(results.dutiesAmount)} muted />
              <Row label="Freight" value={usd.format(num(freight))} muted />
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
