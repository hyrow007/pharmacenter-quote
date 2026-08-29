"use client";

/**
 * Bottle costing board for Contract-Packaging (Bottles) workflows.
 *
 * Visually this is the gummy Costing tab: the same `shell` / `band` cards, the
 * same ParamBlock + ReadOnly readouts, the same auto-fit metric grid, and the
 * same running order — Considerations on top, Costs at the bottom.
 *
 * All arithmetic lives in lib/bottleCosting.ts. This file renders and collects
 * input; it never works out a number itself. That is the deliberate difference
 * from FormulaEditor.tsx, where the math is trapped in render state and has to
 * be mirrored by hand into formulaCosting.ts.
 *
 * PERSISTENCE: we store the INPUTS (bpm, crew, rates, BOM choices) on the
 * workflow — never the computed dollars. Reopening a quote next quarter then
 * recalculates honestly against today's costs instead of quietly showing a
 * stale number that looks authoritative.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  computeBottleCosting,
  DEFAULT_LEADER_RATE,
  DEFAULT_OPERATOR_RATE,
  DEFAULT_SETUP_HOURS,
  DEFAULT_CLEANING_HOURS,
  DEFAULT_WORKING_DAYS_PER_MONTH,
  overheadRowMonthly,
  overheadRowCharged,
  overheadGroupCharged,
  labTestsTotal,
  type OverheadItem,
  type LabTestItem,
  type OverheadGroupMode,
  DEFAULT_TAX_PCT,
  DEFAULT_WC_PCT,
  laborBreakdown,
  DEFAULT_MARGIN_PCT,
  DEFAULT_HOS_COMMISSION_PCT,
  DEFAULT_REP_COMMISSION_PCT,
  DEFAULT_COST_SOURCE,
  DEFAULT_WASTE_PCT,
  COST_SOURCES,
  costFromSource,
  wasteFactor,
  type SuppliedBy,
  type CostSource,
  type BomLine,
  type CostStatus,
  type PackagingSlot,
  type BottleCostingInputs,
  type MarginMode,
} from "@/lib/bottleCosting";
import {
  OVERHEAD_RENT_DEFAULTS_BOTTLE,
  OVERHEAD_INDIRECT_DEFAULTS,
  OVERHEAD_OTHER_DEFAULTS,
  INDIRECT_HOURS_PER_MONTH,
} from "@/lib/overheadCosting";
import { buildQuoteHtml, type QuoteLineItem } from "@/app/pricing/PricingCalculator";

/**
 * Print rules. Written as a normal single-quoted string, NOT a template
 * literal: a stray backtick inside a template literal is what broke the
 * builds behind tasks #348 and #349, and CSS is full of quotes.
 */
const PRINT_CSS = [
  "@media print {",
  "  @page { size: letter portrait; margin: 0.5in; }",
  "  header, nav, .bc-actions { display: none !important; }",
  "  .bc-price, .bc-actions { break-inside: avoid; }",
  "  body { background: #fff !important; }",
  "  * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }",
  "}",
  // The component dropdown renders inside the Material Costs card, whose
  // overflow:hidden (there to clip the rounded corners) was cutting the
  // result list off at the card edge. While a list is open, let the clipping
  // ancestor overflow; the rounded corners come back when it closes. Same
  // fix as task #190 on the gummy editor.
  ".bc-materials:has(.bc-pop) { overflow: visible !important; }",
].join("\n");

// ============================================================
// Shared look — lifted verbatim from the gummy Costing tab
// ============================================================
const shell: React.CSSProperties = {
  border: "1px solid var(--teal-700, #1d6c7b)",
  borderRadius: 8,
  background: "var(--paper, #fffdf8)",
  overflow: "hidden",
};
const band: React.CSSProperties = {
  padding: "12px 16px",
  fontSize: 14.5,
  fontWeight: 700,
  letterSpacing: "0.06em",
  textTransform: "uppercase",
  color: "var(--teal-900, #0f4a56)",
  background: "var(--cream, #f6efe3)",
  borderBottom: "2px solid var(--teal-700, #1d6c7b)",
  whiteSpace: "nowrap",
};
const metricGrid: React.CSSProperties = {
  padding: 14,
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
  gap: 14,
  alignItems: "end",
};

function ParamBlock({
  label,
  children,
  nowrap,
}: {
  label: string;
  children: React.ReactNode;
  nowrap?: boolean;
}) {
  return (
    <div>
      <div
        style={{
          fontSize: 11.5,
          fontWeight: 700,
          letterSpacing: "0.05em",
          textTransform: "uppercase",
          color: "var(--teal-700, #1d6c7b)",
          marginBottom: 6,
          whiteSpace: nowrap ? "nowrap" : undefined,
        }}
      >
        {label}
      </div>
      {children}
    </div>
  );
}

/**
 * The bottom line of a cost card.
 *
 * One component for all three cards rather than three hand-built footers, so
 * they cannot drift into three different shapes — and so the em dash for
 * "not resolved yet" is guaranteed to mean the same thing in each.
 *
 * It never computes a cost. `perUnit` always arrives from the model, because a
 * footer that re-derived its own subtotal could disagree with the Costs card
 * above it, and two different answers to the same question is the exact
 * failure this calculator exists to avoid. The only arithmetic here is
 * per-bottle × quantity, which is presentation, not costing.
 */
function CardTotal({
  label,
  perUnit,
  quantity,
}: {
  label: string;
  perUnit: number | null;
  quantity: number | null;
}) {
  const total =
    perUnit !== null && quantity !== null && quantity > 0
      ? perUnit * quantity
      : null;
  return (
    <div
      style={{
        display: "flex",
        alignItems: "baseline",
        justifyContent: "space-between",
        gap: 12,
        margin: "0 14px",
        padding: "10px 0 12px",
        borderTop: "1px solid var(--line, #e3dcc9)",
      }}
    >
      <span
        style={{
          fontSize: 11.5,
          fontWeight: 700,
          textTransform: "uppercase",
          letterSpacing: "0.04em",
          color: "var(--ink-3, #7b7364)",
        }}
      >
        {label}
      </span>
      <span style={{ textAlign: "right" }}>
        {/* "Total" sits against the figure rather than being folded into the
            left-hand label, so the eye lands on the word and the number as one
            unit. The card already says WHAT is being measured on the left;
            this says that the number beside it is the sum, not another row. */}
        <span
          style={{
            display: "flex",
            alignItems: "baseline",
            justifyContent: "flex-end",
            gap: 8,
          }}
        >
          <span
            style={{
              fontSize: 11.5,
              fontWeight: 700,
              textTransform: "uppercase",
              letterSpacing: "0.04em",
              color: "var(--ink-3, #7b7364)",
            }}
          >
            Total
          </span>
          <ReadOnly>{perUnit !== null ? money(perUnit) : "—"}</ReadOnly>
        </span>
        {total !== null && (
          <div
            style={{
              fontSize: 11,
              color: "var(--ink-3, #7b7364)",
              marginTop: 2,
            }}
          >
            {money(total, 2)} for {quantity!.toLocaleString("en-US")} bottles
          </div>
        )}
      </span>
    </div>
  );
}

// ============================================================
// Direct Labor Costs table chrome
//
// Ported from the gummy Costing tab so the two cards are visually identical.
// `tableLayout: fixed` with explicit 170px data columns is what makes the five
// stacked sub-tables line up their columns even though their row labels are
// different lengths.
// ============================================================
const labSub: React.CSSProperties = {
  border: "1px solid var(--line, #e3dcc9)",
  borderRadius: 8,
  margin: "12px 14px",
  background: "var(--paper, #fffdf8)",
  overflow: "hidden",
};
const labSubTitle: React.CSSProperties = {
  padding: "10px 14px 4px",
  fontSize: 13,
  fontWeight: 700,
  color: "var(--teal-900, #0f4a56)",
};
const labTable: React.CSSProperties = {
  width: "100%",
  borderCollapse: "collapse",
  tableLayout: "fixed",
};
const labHeadRow: React.CSSProperties = {
  borderBottom: "1.5px solid var(--teal-700, #1d6c7b)",
};
const labBodyRow: React.CSSProperties = {
  borderBottom: "1px solid var(--line-2, #efe9da)",
};
const labTotalRow: React.CSSProperties = {
  background: "var(--cream-soft, #fbf6ec)",
};
const labTh: React.CSSProperties = {
  padding: "8px 12px",
  fontSize: 11,
  fontWeight: 700,
  letterSpacing: "0.09em",
  textTransform: "uppercase",
  color: "var(--ink-3, #8a9498)",
  textAlign: "right",
};
const labTd: React.CSSProperties = {
  padding: "8px 12px",
  fontSize: 13,
  textAlign: "right",
  fontVariantNumeric: "tabular-nums",
  fontWeight: 600,
  color: "var(--ink-1, #1f2a2d)",
};

/**
 * Read-only figure cell.
 *
 * type="text" rather than a number input so thousands can carry commas —
 * number inputs reject them. The 14px right padding mirrors the spinner
 * gutter Chrome reserves on the editable cells, so digits in a computed row
 * still column-align with digits in a typed one.
 */
const labSum = (v: number | null, dec = 2) => (
  <input
    type="text"
    readOnly
    tabIndex={-1}
    value={
      v === null
        ? ""
        : v.toLocaleString("en-US", {
            minimumFractionDigits: dec,
            maximumFractionDigits: dec,
          })
    }
    style={{
      width: "100%",
      maxWidth: 120,
      border: "none",
      background: "transparent",
      textAlign: "right",
      fontVariantNumeric: "tabular-nums",
      fontWeight: 700,
      fontSize: 13,
      color: "var(--teal-900, #0f4a56)",
      pointerEvents: "none",
      paddingRight: 14,
    }}
  />
);

const labMoney = (v: number, dec = 2) => (
  <input
    type="text"
    readOnly
    tabIndex={-1}
    value={v.toLocaleString("en-US", {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: dec,
      maximumFractionDigits: dec,
    })}
    style={{
      width: "100%",
      maxWidth: 120,
      border: "none",
      background: "transparent",
      textAlign: "right",
      fontVariantNumeric: "tabular-nums",
      fontWeight: 700,
      fontSize: 13,
      color: "var(--teal-900, #0f4a56)",
      pointerEvents: "none",
      paddingRight: 14,
    }}
  />
);

/** Editable cell for the labour tables, with the #206 focus-select fix. */
function LabNum({
  value,
  onChange,
  step,
  prefix,
}: {
  value: number;
  onChange: (v: number | null) => void;
  step?: string;
  prefix?: string;
}) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 2,
        justifyContent: "flex-end",
        width: "100%",
      }}
    >
      {prefix && (
        <span style={{ fontSize: 12, color: "var(--ink-3, #7b7364)" }}>
          {prefix}
        </span>
      )}
      <input
        type="number"
        step={step ?? "any"}
        min={0}
        value={Number.isFinite(value) ? value : ""}
        onFocus={(e) => {
          const el = e.currentTarget;
          setTimeout(() => {
            try {
              el.select();
            } catch {}
          }, 0);
        }}
        onChange={(e) => {
          const raw = e.target.value;
          if (raw === "") return onChange(null);
          const n = Number(raw);
          onChange(Number.isFinite(n) ? n : null);
        }}
        style={{
          width: "100%",
          maxWidth: 110,
          padding: "4px 6px",
          border: "1px solid var(--line, #e3dcc9)",
          borderRadius: 6,
          fontSize: 13,
          fontWeight: 600,
          textAlign: "right",
          fontVariantNumeric: "tabular-nums",
          background: "#fff",
          color: "var(--ink-1, #1f2a2d)",
        }}
      />
    </span>
  );
}

/**
 * One overhead sub-card: Lease Expenses, Indirect Labor or Other Expenses.
 *
 * One component for all three rather than three tables, because the only real
 * difference is which columns a row needs — a lease has CAM, a payroll row has
 * a rate and a burden, an expense has neither. The Monthly / Share / Allocated
 * / per-bottle tail is identical, and that tail is the part carrying money.
 */
function OverheadGroup({
  title,
  mode,
  list,
  onChange,
  jobDays,
  workingDays,
  quantity,
}: {
  title: string;
  mode: OverheadGroupMode;
  list: OverheadItem[];
  onChange: (next: OverheadItem[]) => void;
  jobDays: number | null;
  workingDays: number | null;
  quantity: number | null;
}) {
  const patch = (i: number, p: Partial<OverheadItem>) =>
    onChange(list.map((r, n) => (n === i ? { ...r, ...p } : r)));
  const remove = (i: number) => onChange(list.filter((_, n) => n !== i));
  const add = () =>
    onChange([
      ...list,
      mode === "labor"
        ? {
            label: "",
            monthly: 0,
            payType: "hourly",
            rate: 0,
            qty: 1,
            taxPct: DEFAULT_TAX_PCT,
            wcPct: DEFAULT_WC_PCT,
            hours: INDIRECT_HOURS_PER_MONTH,
            sharePct: 0,
          }
        : { label: "", monthly: 0, sharePct: 0 },
    ]);

  const wd = workingDays ?? DEFAULT_WORKING_DAYS_PER_MONTH;
  /** This row's contribution to the cost of one bottle. */
  const perUnitOf = (charged: number) =>
    jobDays === null || wd <= 0 || !quantity || quantity <= 0
      ? null
      : ((charged / wd) * jobDays) / quantity;

  const groupCharged = overheadGroupCharged(list, mode);

  return (
    <div style={labSub}>
      <div style={labSubTitle}>{title}</div>
      <div style={{ overflowX: "auto" }}>
        <table style={{ ...labTable, minWidth: mode === "labor" ? 1150 : 760 }}>
          <thead>
            <tr style={labHeadRow}>
              <th style={{ ...labTh, textAlign: "left", minWidth: 190 }}>
                Item
              </th>
              {mode === "lease" && (
                <>
                  <th style={{ ...labTh, width: 120 }}>Base rent</th>
                  <th style={{ ...labTh, width: 120 }}>CAM</th>
                </>
              )}
              {mode === "labor" && (
                <>
                  <th style={{ ...labTh, width: 110 }}>Pay type</th>
                  <th style={{ ...labTh, width: 110 }}>Rate</th>
                  <th style={{ ...labTh, width: 80 }}>QTY</th>
                  <th style={{ ...labTh, width: 90 }}>Tax %</th>
                  <th style={{ ...labTh, width: 90 }}>WC %</th>
                  <th style={{ ...labTh, width: 100 }}>Hours / mo</th>
                </>
              )}
              {mode === undefined && (
                <>
                  <th style={{ ...labTh, width: 110 }}>QB acct</th>
                  <th style={{ ...labTh, width: 130 }}>Monthly</th>
                </>
              )}
              {mode !== undefined && (
                <th style={{ ...labTh, width: 130 }}>Monthly</th>
              )}
              <th style={{ ...labTh, width: 100 }}>Share %</th>
              <th style={{ ...labTh, width: 130 }}>Allocated</th>
              <th style={{ ...labTh, width: 120 }}>$ / bottle</th>
              <th style={{ ...labTh, width: 44 }} />
            </tr>
          </thead>
          <tbody>
            {list.map((r, i) => {
              const charged = overheadRowCharged(r, mode);
              const per = perUnitOf(charged);
              return (
                <tr key={i} style={labBodyRow}>
                  <td style={{ ...labTd, textAlign: "left" }}>
                    <input
                      value={r.label}
                      onChange={(e) => patch(i, { label: e.target.value })}
                      placeholder="Name this line"
                      style={{
                        width: "100%",
                        padding: "4px 6px",
                        border: "1px solid var(--line, #e3dcc9)",
                        borderRadius: 6,
                        fontSize: 13,
                        background: "#fff",
                      }}
                    />
                  </td>

                  {mode === "lease" && (
                    <>
                      <td style={labTd}>
                        <LabNum
                          value={r.monthly}
                          onChange={(n) => patch(i, { monthly: n ?? 0 })}
                          step="0.01"
                          prefix="$"
                        />
                      </td>
                      <td style={labTd}>
                        <LabNum
                          value={r.cam ?? 0}
                          onChange={(n) => patch(i, { cam: n })}
                          step="0.01"
                          prefix="$"
                        />
                      </td>
                    </>
                  )}

                  {mode === "labor" && (
                    <>
                      <td style={labTd}>
                        <select
                          value={r.payType ?? "hourly"}
                          onChange={(e) =>
                            patch(i, {
                              payType: e.target.value as "hourly" | "salary",
                            })
                          }
                          style={{
                            width: "100%",
                            padding: "4px 6px",
                            border: "1px solid var(--line, #e3dcc9)",
                            borderRadius: 6,
                            fontSize: 12,
                            background: "#fff",
                          }}
                        >
                          <option value="hourly">Hourly</option>
                          <option value="salary">Salary</option>
                        </select>
                      </td>
                      <td style={labTd}>
                        <LabNum
                          value={r.rate ?? 0}
                          onChange={(n) => patch(i, { rate: n })}
                          step="0.01"
                          prefix="$"
                        />
                      </td>
                      <td style={labTd}>
                        <LabNum
                          value={r.qty ?? 1}
                          onChange={(n) => patch(i, { qty: n })}
                          step="1"
                        />
                      </td>
                      <td style={labTd}>
                        <LabNum
                          value={r.taxPct ?? DEFAULT_TAX_PCT}
                          onChange={(n) => patch(i, { taxPct: n })}
                          step="0.1"
                        />
                      </td>
                      <td style={labTd}>
                        <LabNum
                          value={r.wcPct ?? DEFAULT_WC_PCT}
                          onChange={(n) => patch(i, { wcPct: n })}
                          step="0.1"
                        />
                      </td>
                      <td style={labTd}>
                        {/* Only meaningful for hourly rows — a salary is
                            already a monthly figure. */}
                        {r.payType === "salary" ? (
                          labSum(null)
                        ) : (
                          <LabNum
                            value={r.hours ?? INDIRECT_HOURS_PER_MONTH}
                            onChange={(n) => patch(i, { hours: n })}
                            step="0.01"
                          />
                        )}
                      </td>
                    </>
                  )}

                  {mode === undefined && (
                    <>
                      <td style={labTd}>
                        <input
                          value={r.qbAccount ?? ""}
                          onChange={(e) =>
                            patch(i, { qbAccount: e.target.value })
                          }
                          placeholder="—"
                          style={{
                            width: "100%",
                            padding: "4px 6px",
                            border: "1px solid var(--line, #e3dcc9)",
                            borderRadius: 6,
                            fontSize: 12,
                            textAlign: "right",
                            background: "#fff",
                          }}
                        />
                      </td>
                      <td style={labTd}>
                        <LabNum
                          value={r.monthly}
                          onChange={(n) => patch(i, { monthly: n ?? 0 })}
                          step="0.01"
                          prefix="$"
                        />
                      </td>
                    </>
                  )}

                  {/* Effective monthly — base + CAM for a lease, the burdened
                      conversion for payroll. Computed, never typed. */}
                  {mode !== undefined && (
                    <td style={labTd}>{labMoney(overheadRowMonthly(r, mode), 2)}</td>
                  )}

                  <td style={labTd}>
                    <LabNum
                      value={r.sharePct ?? 0}
                      onChange={(n) => patch(i, { sharePct: n ?? 0 })}
                      step="1"
                    />
                  </td>
                  <td style={labTd}>{labMoney(charged, 2)}</td>
                  <td style={labTd}>
                    {per === null ? labSum(null) : labMoney(per, 4)}
                  </td>
                  <td style={labTd}>
                    <button
                      type="button"
                      onClick={() => remove(i)}
                      title="Remove this line"
                      style={{
                        border: "none",
                        background: "none",
                        color: "#8b2f2f",
                        cursor: "pointer",
                        fontSize: 15,
                        lineHeight: 1,
                        padding: 2,
                      }}
                    >
                      ×
                    </button>
                  </td>
                </tr>
              );
            })}

            <tr style={labTotalRow}>
              <td style={{ ...labTh, textAlign: "left" }}>Group total</td>
              {mode === "lease" && (
                <>
                  <td style={labTd} />
                  <td style={labTd} />
                </>
              )}
              {mode === "labor" && (
                <>
                  <td style={labTd} />
                  <td style={labTd} />
                  <td style={labTd} />
                  <td style={labTd} />
                  <td style={labTd} />
                  <td style={labTd} />
                </>
              )}
              {mode === undefined && (
                <>
                  <td style={labTd} />
                  <td style={labTd} />
                </>
              )}
              {mode !== undefined && <td style={labTd} />}
              <td style={labTd} />
              <td style={labTd}>{labMoney(groupCharged, 2)}</td>
              <td style={labTd}>
                {perUnitOf(groupCharged) === null
                  ? labSum(null)
                  : labMoney(perUnitOf(groupCharged) as number, 4)}
              </td>
              <td style={labTd} />
            </tr>
          </tbody>
        </table>
      </div>
      <div style={{ padding: "0 14px 12px" }}>
        <button
          type="button"
          onClick={add}
          style={{
            padding: "5px 12px",
            border: "1px solid var(--teal-700, #1d6c7b)",
            borderRadius: 6,
            background: "#fff",
            color: "var(--teal-900, #0f4a56)",
            fontSize: 12.5,
            fontWeight: 600,
            cursor: "pointer",
          }}
        >
          + Add line
        </button>
      </div>
    </div>
  );
}

/**
 * One lab-testing sub-card: Raw Materials or Finished Product.
 *
 * Starts empty on purpose. Testing varies by customer and by job, and a seeded
 * list would put dollars on a quote that nobody chose to spend.
 */
function LabTestGroup({
  title,
  list,
  onChange,
  quantity,
}: {
  title: string;
  list: LabTestItem[];
  onChange: (next: LabTestItem[]) => void;
  quantity: number | null;
}) {
  const patch = (i: number, p: Partial<LabTestItem>) =>
    onChange(list.map((r, n) => (n === i ? { ...r, ...p } : r)));
  const remove = (i: number) => onChange(list.filter((_, n) => n !== i));
  const total = labTestsTotal(list);
  const per = quantity && quantity > 0 ? total / quantity : null;

  return (
    <div style={labSub}>
      <div style={labSubTitle}>{title}</div>
      <table style={labTable}>
        <thead>
          <tr style={labHeadRow}>
            <th style={{ ...labTh, textAlign: "left", minWidth: 200 }}>Test</th>
            <th style={{ ...labTh, width: 150 }}>Cost / test</th>
            <th style={{ ...labTh, width: 150 }}>Tests / job</th>
            <th style={{ ...labTh, width: 150 }}>Job total</th>
            <th style={{ ...labTh, width: 150 }}>$ / bottle</th>
            <th style={{ ...labTh, width: 44 }} />
          </tr>
        </thead>
        <tbody>
          {list.length === 0 && (
            <tr style={labBodyRow}>
              <td
                colSpan={6}
                style={{
                  ...labTd,
                  textAlign: "left",
                  fontWeight: 500,
                  fontStyle: "italic",
                  color: "var(--ink-3, #7b7364)",
                }}
              >
                No tests on this job yet.
              </td>
            </tr>
          )}
          {list.map((t, i) => {
            const line = (Number(t.cost) || 0) * (Number(t.qty) || 0);
            return (
              <tr key={i} style={labBodyRow}>
                <td style={{ ...labTd, textAlign: "left" }}>
                  <input
                    value={t.label}
                    onChange={(e) => patch(i, { label: e.target.value })}
                    placeholder="Name this test"
                    style={{
                      width: "100%",
                      padding: "4px 6px",
                      border: "1px solid var(--line, #e3dcc9)",
                      borderRadius: 6,
                      fontSize: 13,
                      background: "#fff",
                    }}
                  />
                </td>
                <td style={labTd}>
                  <LabNum
                    value={t.cost}
                    onChange={(n) => patch(i, { cost: n ?? 0 })}
                    step="0.01"
                    prefix="$"
                  />
                </td>
                <td style={labTd}>
                  <LabNum
                    value={t.qty}
                    onChange={(n) => patch(i, { qty: n ?? 0 })}
                    step="1"
                  />
                </td>
                <td style={labTd}>{labMoney(line, 2)}</td>
                <td style={labTd}>
                  {quantity && quantity > 0
                    ? labMoney(line / quantity, 4)
                    : labSum(null)}
                </td>
                <td style={labTd}>
                  <button
                    type="button"
                    onClick={() => remove(i)}
                    title="Remove this test"
                    style={{
                      border: "none",
                      background: "none",
                      color: "#8b2f2f",
                      cursor: "pointer",
                      fontSize: 15,
                      lineHeight: 1,
                      padding: 2,
                    }}
                  >
                    ×
                  </button>
                </td>
              </tr>
            );
          })}
          <tr style={labTotalRow}>
            <td style={{ ...labTh, textAlign: "left" }}>Group total</td>
            <td style={labTd} />
            <td style={labTd} />
            <td style={labTd}>{labMoney(total, 2)}</td>
            <td style={labTd}>
              {per === null ? labSum(null) : labMoney(per, 4)}
            </td>
            <td style={labTd} />
          </tr>
        </tbody>
      </table>
      <div style={{ padding: "0 14px 12px" }}>
        <button
          type="button"
          onClick={() => onChange([...list, { label: "", cost: 0, qty: 1 }])}
          style={{
            padding: "5px 12px",
            border: "1px solid var(--teal-700, #1d6c7b)",
            borderRadius: 6,
            background: "#fff",
            color: "var(--teal-900, #0f4a56)",
            fontSize: 12.5,
            fontWeight: 600,
            cursor: "pointer",
          }}
        >
          + Add test
        </button>
      </div>
    </div>
  );
}

function ReadOnly({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        fontSize: 16,
        fontWeight: 700,
        color: "var(--teal-900, #0f4a56)",
        fontVariantNumeric: "tabular-nums",
      }}
    >
      {children}
    </div>
  );
}

const numInput: React.CSSProperties = {
  width: "100%",
  padding: "7px 9px",
  border: "1px solid var(--teal-700, #1d6c7b)",
  borderRadius: 6,
  background: "var(--paper, #fffdf8)",
  fontSize: 15,
  fontWeight: 600,
  color: "var(--teal-900, #0f4a56)",
  fontVariantNumeric: "tabular-nums",
  textAlign: "right",
};

function NumField({
  value,
  onChange,
  placeholder,
  step,
}: {
  value: number | null;
  onChange: (v: number | null) => void;
  placeholder?: string;
  step?: string;
}) {
  return (
    <input
      type="number"
      step={step ?? "any"}
      value={value ?? ""}
      placeholder={placeholder}
      onChange={(e) => {
        const raw = e.target.value;
        if (raw === "") return onChange(null);
        const n = Number(raw);
        onChange(Number.isFinite(n) ? n : null);
      }}
      onFocus={(e) => {
        // Deferred by a frame, per #206. Chrome does not select a number
        // input's contents synchronously on focus, so the first keystroke
        // prepends to the existing digits instead of replacing them — typing
        // 5 over 10 gave 510. This handler had kept the synchronous form and
        // therefore still had the bug; the inline quantity editor below was
        // fixed but the manual $/each field here was not.
        const el = e.currentTarget;
        setTimeout(() => {
          try {
            el.select();
          } catch {}
        }, 0);
      }}
      style={numInput}
    />
  );
}

const money = (v: number, dec = 4) =>
  v.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: dec,
    maximumFractionDigits: dec,
  });

// ============================================================
// Types shared with the page
// ============================================================
export type ComponentOption = {
  fp_code: string;
  name: string;
  category: PackagingSlot | null;
  owner: "pharmacenter" | "customer";
  /** Per-each, from Fishbowl's inventory average. */
  effective_cost_per_unit: number | null;
  /** Per-each, from the last purchase order. Feeds the cost-source picker. */
  last_order_cost_per_unit: number | null;
  cost_status: CostStatus;
};

export type SavedState = {
  bom: BomLine[];
  /**
   * Quantity for THIS costing, when it differs from the workflow's stated one.
   *
   * Null means "use the workflow's figure" — the normal case. An override is a
   * scenario ("what does 24,000 look like?") and deliberately does NOT write
   * back to the workflow: the quantity on the request is a fact about what the
   * customer asked for, and a costing experiment must not quietly rewrite it.
   *
   * Q0016 is exactly why this exists — its 12,000 is flagged CONFIRM BEFORE
   * QUOTING on the spec itself.
   */
  quantityOverride: number | null;
  bottlesPerMinute: number | null;
  /** Bottles per minute PER PERSON on kitting. Drives the kitting hours. */
  kittingSpeed: number | null;
  /**
   * Bottles in one master box, for a job WITHOUT an inner pack.
   *
   * With an inner pack the master box is counted in inners instead, and this
   * field goes unread — bottles-per-box becomes a derived figure. Two fields
   * rather than one that changes meaning: a saved "12" must always mean twelve
   * bottles, whatever the job grows into later.
   */
  bottlesPerMasterBox: number | null;
  /** Bottles in one inner pack. */
  bottlesPerInnerPack: number | null;
  /** Inner packs in one master box. Only read when an inner pack exists. */
  innersPerMasterBox: number | null;
  /** TOTAL setup hours. */
  setupHours: number | null;
  setupLeaders: number | null;
  setupOperators: number | null;
  /**
   * TOTAL production hours. Null means "derive from bottles per minute" — the
   * default path. A typed value overrides it, which is also how a job gets
   * priced before anyone has timed the line.
   *
   * Named ...Total rather than reusing the old `prodHours` on purpose: that
   * field briefly meant hours PER SHIFT and was saved as 8. Reusing the name
   * would have made a stale 8 read as an eight-hour run.
   */
  prodHoursTotal: number | null;
  prodLeaders: number | null;
  prodOperators: number | null;
  /** TOTAL cleaning hours. */
  cleaningHours: number | null;
  cleaningLeaders: number | null;
  cleaningOperators: number | null;
  kittingLeaders: number | null;
  kittingOperators: number | null;
  leaderRate: number | null;
  operatorRate: number | null;
  /** Payroll burden, per role and editable — as on the gummy Pay Rates card. */
  leaderTaxPct: number | null;
  leaderWcPct: number | null;
  operatorTaxPct: number | null;
  operatorWcPct: number | null;
  /**
   * Overhead as three editable lists, matching the gummy Costing tab. The old
   * single overheadMonthly/overheadSharePct pair is migrated on load.
   */
  overheadRent: OverheadItem[];
  overheadIndirect: OverheadItem[];
  overheadOther: OverheadItem[];
  workingDaysPerMonth: number | null;
  /** Lab testing as two lists — raw material and finished product. */
  labTestRm: LabTestItem[];
  labTestFp: LabTestItem[];

  // ---- pricing tier ----
  // For contract-packaging bottles this board IS the pricing calculator, so
  // it carries margin through to a sale price. Without these a quote could
  // never be issued from here.
  marginPct: number | null;
  marginMode: MarginMode;
  hosCommissionPct: number | null;
  repCommissionPct: number | null;
};

/**
 * The seven slots a bottle job fills. Order matches the physical build-up:
 * the bottle, what goes in it, what closes it, what decorates it, what ships it.
 */
const SLOTS: { slot: PackagingSlot; label: string }[] = [
  { slot: "bottle", label: "Bottle" },
  { slot: "closure", label: "Closure / cap" },
  { slot: "liner", label: "Liner" },
  { slot: "other", label: "Filler (cotton / desiccant)" },
  { slot: "neckband", label: "Neckband" },
  { slot: "sleeve", label: "Full sleeve" },
  { slot: "label", label: "Label" },
  { slot: "safety_seal", label: "Safety seal" },
  { slot: "insert", label: "Insert" },
  { slot: "carton", label: "Retail / unit carton" },
  { slot: "inner_pack", label: "Inner pack" },
  { slot: "master_box", label: "Master box" },
];

/**
 * Which packaging-form answer decides whether a slot is on this job at all.
 *
 * Verified against PackagingSpecSection. null = inherent to any bottle job
 * (there is no "bottle required?" question, because there always is one).
 */
/**
 * One source of truth for the Material Costs column layout.
 *
 * The header row and every data row have to agree exactly or the columns
 * visibly drift apart, and this literal was previously written out twice —
 * which is precisely the shape of edit that lets them disagree. Named once,
 * they cannot.
 *
 * Only the part-name column grows. Everything else is a control of known size
 * (a supplied-by select, a cost-source select, a right-aligned figure), so
 * handing them extra width would just spread them out; the Fishbowl name is
 * the one field with genuinely unbounded content — "ALTERNATIVE LABS /
 * SHIPPER BOXES (24X12X12)" and friends.
 */
const MATERIALS_COLUMNS = "170px 1fr 118px 165px 78px 120px";

/**
 * Liner types, spelled as the packaging form spells them. Shown as a caption
 * on the Closure row because the liner has no row of its own.
 */
const LINER_LABEL: Record<string, string> = {
  induction: "Induction (heat seal)",
  "pressure-sensitive": "Pressure-sensitive",
  foam: "Foam",
  other: "Other — see spec",
};

const SLOT_PRESENCE_SPEC_KEY: Partial<Record<PackagingSlot, string>> = {
  other: "fillerRequired",
  neckband: "neckbandRequired",
  sleeve: "sleeveRequired",
  label: "labelRequired",
  carton: "retailRequired",
  safety_seal: "safetySealRequired",
  insert: "insertRequired",
};

/**
 * Is this slot part of the job, per the packaging form?
 *
 * Only an explicit "no" removes a component. A BLANK answer keeps it, because
 * blank means the form was not filled in — and silently dropping something we
 * might actually buy would under-quote the job. Dropping a real cost is
 * invisible; carrying an extra row the user can delete is not. Same asymmetry
 * that makes an unanswered "supplied by" default to PharmaCenter.
 *
 * The liner is the exception: it is never generated, because it is not a
 * separate part. See the note in the function body.
 */
function slotIsInSpec(
  slot: PackagingSlot,
  spec: Record<string, string> | null,
): boolean {
  // The liner comes IN the cap. It is a property of the closure, not a part
  // we buy separately — which is why every "liner" search returns caps, and
  // why the Fishbowl descriptions read "CAP 53/400 W/ LINER" rather than
  // listing a liner of their own (#362). The closure's cost already includes
  // it, so generating a Liner row would either sit empty forever or, worse,
  // get filled with a cap and count the cap twice.
  //
  // Still in the Add-component list for the rare job that buys liners loose.
  if (slot === "liner") return false;

  // Same treatment, different reason: the packaging form never asks whether
  // there is an inner pack, so there is no answer to read. Generating the row
  // anyway would put an empty, unpriceable component on every bottle job —
  // and most bottle jobs go straight from bottle to master case. Add it from
  // the picker on the jobs that genuinely bundle.
  if (slot === "inner_pack") return false;

  // Safety seal and insert are asked INSIDE the retail-packaging section of
  // the form. With no retail packaging those questions are never rendered, so
  // they stay permanently blank — and the blank-keeps-it rule below would then
  // add two components to every job that has no retail carton. Checked against
  // the real Q0016 record, where retailRequired="no" and both of these are "".
  if (slot === "safety_seal" || slot === "insert") {
    if ((spec?.retailRequired ?? "") === "no") return false;
  }

  const key = SLOT_PRESENCE_SPEC_KEY[slot];
  if (!key) return true; // bottle, closure, master box
  return (spec?.[key] ?? "") !== "no";
}

/**
 * Which packaging-form answer decides who supplies each slot.
 *
 * These key names are VERIFIED against PackagingSpecSection, not guessed —
 * the last time I guessed spec keys the failure was silent and the fields
 * just sat empty. Values are "pharmacenter" | "customer" | "".
 *
 * Two slots have no answer of their own:
 *   liner  — PharmaCenter stocks no standalone liners; it arrives as part of
 *            the cap, so it inherits the closure's answer (#362).
 *   carton — the form calls this "Secondary / retail packaging".
 */
const SUPPLIED_BY_SPEC_KEY: Record<PackagingSlot, string | null> = {
  bottle: "bottleSuppliedBy",
  closure: "closureSuppliedBy",
  liner: "closureSuppliedBy",
  other: "fillerSuppliedBy",
  neckband: "neckbandSuppliedBy",
  label: "labelSuppliedBy",
  carton: "retailSuppliedBy",
  // The packaging form has no inner-pack question of its own — masterBoxQty is
  // labelled "Units / inner cases per box" and that is the only mention. So
  // there is nothing to inherit and it defaults to PharmaCenter-supplied,
  // which is the common case for a bundling material.
  inner_pack: null,
  master_box: "masterBoxSuppliedBy",
  sleeve: "sleeveSuppliedBy",
  insert: "insertSuppliedBy",
  safety_seal: "safetySealSuppliedBy",
};

/**
 * Read the form's answer for a slot. Defaults to PharmaCenter when the form
 * is silent — the conservative direction, because assuming the customer
 * supplies something we actually buy would drop a real cost to $0 and
 * under-quote the job. Assuming the reverse merely asks for a part number.
 */
function suppliedByFromSpec(
  slot: PackagingSlot,
  spec: Record<string, string> | null,
): SuppliedBy {
  const key = SUPPLIED_BY_SPEC_KEY[slot];
  const v = key ? spec?.[key] : undefined;
  return v === "customer" ? "customer" : "pharmacenter";
}

export function blankState(
  bottlesPerMasterBox: number | null,
  spec?: Record<string, string> | null,
): SavedState {
  return {
    // The list is generated FROM THE SPEC, not fixed. A job with no retail
    // carton simply has no carton row to explain away.
    bom: SLOTS.filter((s) => slotIsInSpec(s.slot, spec ?? null)).map((s, i) => ({
      id: `slot-${i}-${s.slot}`,
      slot: s.slot,
      fpCode: null,
      name: s.label,
      // A master box is shared across the bottles inside it. So is an inner
      // pack — but it is never generated here (see slotIsInSpec), so it can
      // only arrive via addLine, which starts it blank.
      qtyPerUnit:
        s.slot === "master_box"
          ? bottlesPerMasterBox && bottlesPerMasterBox > 0
            ? 1 / bottlesPerMasterBox
            : null
          : s.slot === "inner_pack"
            ? null
            : 1,
      costPerUnit: null,
      costStatus: "no_cost",
      suppliedBy: suppliedByFromSpec(s.slot, spec ?? null),
      costSource: DEFAULT_COST_SOURCE,
      wastePct: DEFAULT_WASTE_PCT[s.slot],
      manualCostPerUnit: null,
      inventoryCostPerUnit: null,
      lastOrderCostPerUnit: null,
    })),
    quantityOverride: null,
    bottlesPerMinute: null,
    kittingSpeed: null,
    bottlesPerMasterBox,
    // No spec question to seed these from, and no house standard worth
    // assuming — a blank that the user fills in is honest, a guessed 6 is not.
    bottlesPerInnerPack: null,
    innersPerMasterBox: null,
    setupHours: DEFAULT_SETUP_HOURS,
    setupLeaders: 1,
    setupOperators: 2,
    // Null so it derives from bottles per minute until someone overrides it.
    prodHoursTotal: null,
    prodLeaders: 1,
    prodOperators: 3,
    cleaningHours: DEFAULT_CLEANING_HOURS,
    cleaningLeaders: 0,
    cleaningOperators: 2,
    kittingLeaders: 0,
    kittingOperators: 2,
    leaderRate: DEFAULT_LEADER_RATE,
    operatorRate: DEFAULT_OPERATOR_RATE,
    leaderTaxPct: DEFAULT_TAX_PCT,
    leaderWcPct: DEFAULT_WC_PCT,
    operatorTaxPct: DEFAULT_TAX_PCT,
    operatorWcPct: DEFAULT_WC_PCT,
    overheadRent: OVERHEAD_RENT_DEFAULTS_BOTTLE,
    overheadIndirect: OVERHEAD_INDIRECT_DEFAULTS,
    overheadOther: OVERHEAD_OTHER_DEFAULTS,
    workingDaysPerMonth: DEFAULT_WORKING_DAYS_PER_MONTH,
    // Empty, not seeded. Testing varies job to job and a default list would
    // put invented dollars on every quote.
    labTestRm: [],
    labTestFp: [],
    marginPct: DEFAULT_MARGIN_PCT,
    marginMode: "gross-margin",
    hosCommissionPct: DEFAULT_HOS_COMMISSION_PCT,
    repCommissionPct: DEFAULT_REP_COMMISSION_PCT,
  };
}

// ============================================================
// Component picker — type-to-search, recommendations first
// ============================================================
function ComponentPicker({
  slot,
  current,
  spec,
  onPick,
  onCustom,
}: {
  slot: PackagingSlot;
  current: BomLine;
  spec: Record<string, string> | null;
  onPick: (opt: ComponentOption | null) => void;
  /** Commit the typed text as a hand-described part with no Fishbowl record. */
  onCustom: (name: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<ComponentOption[]>([]);
  const [loading, setLoading] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  /**
   * Seed the search from the packaging spec so the first thing the user sees
   * is a shortlist rather than 1,927 rows. Recommendations only — the pick is
   * always theirs, because a description match is a hint, not an identification.
   */
  /**
   * Seed the search from the packaging spec so the first thing the user sees
   * is a shortlist rather than 1,927 rows.
   *
   * KEY NAMES HERE ARE VERIFIED against a real saved workflow, not guessed. An
   * earlier pass used `closureSize` and `masterBoxUnitsPerBox` — neither
   * exists (they are `closureSizeMm` and `masterBoxQty`) and the failure was
   * silent: an empty suggestion rather than an error. If you add a slot, go
   * and read a stored spec first.
   */
  const suggested = useMemo(() => {
    if (!spec) return "";
    const pick = (...keys: string[]) => {
      for (const k of keys) {
        const v = spec[k];
        if (v && !/^n\/a$/i.test(v)) return v;
      }
      return "";
    };
    const bits: string[] = [];
    if (slot === "bottle") {
      const size = pick("bottleSizeOther", "bottleSize");
      if (size) bits.push(size.replace(/\s*cc$/i, ""));
      bits.push(pick("bottleMaterialOther", "bottleMaterial"));
      bits.push(pick("bottleColorOther", "bottleColor"));
    } else if (slot === "closure") {
      bits.push(pick("closureSizeOther", "closureSizeMm"));
      bits.push(pick("closureFinishOther", "closureFinish"));
    } else if (slot === "liner") {
      bits.push(pick("closureLinerOther", "closureLiner"));
    } else if (slot === "neckband") {
      bits.push("neckband");
    } else if (slot === "master_box") {
      bits.push("box");
    } else if (slot === "inner_pack") {
      // Fishbowl has no inner-pack category, so there is nothing to filter on
      // and the seed has to do the work. "inner" catches parts named as such;
      // the rest of the list is whatever the user types.
      bits.push("inner");
    }
    // "other" is a spec ANSWER, not a search term — without this every picker
    // whose field was set to Other would go looking for the word "other".
    return bits
      .filter((b) => b && b.toLowerCase() !== "other")
      .join(" ")
      .trim();
  }, [slot, spec]);

  useEffect(() => {
    if (!open) return;
    const term = (q || suggested).trim();
    let cancelled = false;
    setLoading(true);
    const t = setTimeout(async () => {
      try {
        const r = await fetch(
          `/api/packaging-components?slot=${encodeURIComponent(slot)}&q=${encodeURIComponent(term)}`,
        );
        const j = await r.json();
        if (!cancelled) setRows(Array.isArray(j.rows) ? j.rows : []);
      } catch {
        if (!cancelled) setRows([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, 180);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [open, q, slot, suggested]);

  useEffect(() => {
    const h = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node))
        setOpen(false);
    };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, []);

  return (
    <div ref={boxRef} style={{ position: "relative" }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        style={{
          width: "100%",
          textAlign: "left",
          padding: "7px 9px",
          border: "1px solid var(--teal-700, #1d6c7b)",
          borderRadius: 6,
          background: "var(--paper, #fffdf8)",
          fontSize: 14,
          color:
            current.fpCode || current.customPart
              ? "var(--teal-900, #0f4a56)"
              : "var(--teal-700, #1d6c7b)",
          cursor: "pointer",
        }}
      >
        {current.fpCode ? (
          <>
            <span style={{ fontWeight: 700 }}>{current.fpCode}</span>{" "}
            <span style={{ opacity: 0.75 }}>{current.name}</span>
          </>
        ) : current.customPart ? (
          <>
            {/* Tagged, not disguised. A typed part should never be mistaken at
                a glance for one Fishbowl has vouched for. */}
            <span
              style={{
                display: "inline-block",
                padding: "1px 7px",
                borderRadius: 999,
                background: "#fdf3e0",
                color: "#8a5a00",
                fontSize: 11,
                fontWeight: 700,
                marginRight: 6,
              }}
            >
              typed in
            </span>
            <span>{current.name}</span>
          </>
        ) : (
          "Choose a component…"
        )}
      </button>

      {open && (
        <div
          className="bc-pop"
          style={{
            position: "absolute",
            zIndex: 40,
            top: "calc(100% + 4px)",
            left: 0,
            right: 0,
            maxHeight: 300,
            overflowY: "auto",
            border: "1px solid var(--teal-700, #1d6c7b)",
            borderRadius: 8,
            background: "var(--paper, #fffdf8)",
            boxShadow: "0 8px 20px rgba(0,0,0,.12)",
          }}
        >
          <div style={{ padding: 8, borderBottom: "1px solid #e6ddcc" }}>
            <input
              autoFocus
              value={q}
              placeholder={
                suggested ? `Suggested: ${suggested}` : "Search code or name…"
              }
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => {
                // Enter commits the typed text. The escape hatch is worthless
                // if you have to hunt for it with the mouse.
                if (e.key === "Enter" && q.trim()) {
                  e.preventDefault();
                  onCustom(q.trim());
                  setQ("");
                  setOpen(false);
                }
              }}
              style={{ ...numInput, textAlign: "left", fontWeight: 500 }}
            />
          </div>

          {/* Type-it-yourself escape hatch.
              Sits directly under the search box rather than at the end of the
              list, because the moment you need it is the moment the list is
              empty — and hiding it below "No matching components" would put it
              exactly where a user has already given up looking.
              Deliberately NOT offered on an empty query: a blank description
              is worse than no part at all. */}
          {q.trim() && (
            <button
              type="button"
              onClick={() => {
                onCustom(q.trim());
                setQ("");
                setOpen(false);
              }}
              style={{
                ...rowBtn,
                background: "#fdf9f0",
                borderBottom: "1px solid #e6ddcc",
              }}
            >
              <div
                style={{
                  fontSize: 13,
                  fontWeight: 700,
                  color: "var(--teal-900, #0f4a56)",
                }}
              >
                + Use “{q.trim()}”
              </div>
              <div style={{ fontSize: 11.5, opacity: 0.75, marginTop: 2 }}>
                Not in Fishbowl — you will enter the cost manually.
              </div>
            </button>
          )}

          {(current.fpCode || current.customPart) && (
            <button
              type="button"
              onClick={() => {
                onPick(null);
                setOpen(false);
              }}
              style={rowBtn}
            >
              <span style={{ color: "#a3421f" }}>Clear this line</span>
            </button>
          )}
          {loading && <div style={{ padding: 10, fontSize: 13 }}>Searching…</div>}
          {!loading && rows.length === 0 && (
            <div style={{ padding: 10, fontSize: 13, opacity: 0.7 }}>
              No matching components.
            </div>
          )}
          {rows.map((r) => (
            <button
              key={r.fp_code}
              type="button"
              onClick={() => {
                onPick(r);
                setOpen(false);
              }}
              style={rowBtn}
            >
              <div style={{ fontWeight: 700, fontSize: 13 }}>{r.fp_code}</div>
              <div style={{ fontSize: 12.5, opacity: 0.8 }}>{r.name}</div>
              <div style={{ fontSize: 11.5, marginTop: 2 }}>
                <StatusChip status={r.cost_status} />{" "}
                {r.effective_cost_per_unit !== null
                  ? money(r.effective_cost_per_unit)
                  : "no cost"}
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

const rowBtn: React.CSSProperties = {
  display: "block",
  width: "100%",
  textAlign: "left",
  padding: "8px 10px",
  border: "none",
  borderBottom: "1px solid #efe7d8",
  background: "transparent",
  cursor: "pointer",
};

function StatusChip({ status }: { status: CostStatus }) {
  const map: Record<CostStatus, { bg: string; fg: string; text: string }> = {
    ok: { bg: "#e3f2e6", fg: "#1d6b2f", text: "costed" },
    customer_asset: { bg: "#e7eef5", fg: "#24506e", text: "customer — $0" },
    no_cost: { bg: "#fdecec", fg: "#a3281f", text: "no cost" },
    zero_cost: { bg: "#fdf3e0", fg: "#8a5a00", text: "$0 — confirm" },
    uom_unresolved: { bg: "#fdf3e0", fg: "#8a5a00", text: "UOM unresolved" },
  };
  const s = map[status];
  return (
    <span
      style={{
        display: "inline-block",
        padding: "1px 7px",
        borderRadius: 999,
        background: s.bg,
        color: s.fg,
        fontSize: 11,
        fontWeight: 700,
      }}
    >
      {s.text}
    </span>
  );
}

// ============================================================
// Board
// ============================================================
export default function BottleCostingBoard({
  workflowId,
  quoteNumber,
  customerName,
  productName,
  quantity,
  spec,
  initial,
}: {
  workflowId: string;
  quoteNumber: string;
  customerName: string;
  productName: string;
  quantity: number | null;
  spec: Record<string, string> | null;
  initial: SavedState | null;
}) {
  // masterBoxQty — verified key name. See the note on `suggested` above.
  const [st, setSt] = useState<SavedState>(() => {
    const perBox = Number(spec?.masterBoxQty ?? "");
    const blank = blankState(
      Number.isFinite(perBox) && perBox > 0 ? perBox : null,
      spec,
    );
    if (!initial) return blank;
    // Read off the pre-list shape before it is spread away.
    const legacy = initial as unknown as {
      overheadMonthly?: number | null;
      overheadSharePct?: number | null;
      labTestingTotal?: number | null;
    };
    const legacyOverheadMonthly = legacy.overheadMonthly ?? null;
    const legacySharePct = legacy.overheadSharePct ?? null;
    const legacyLabTotal = legacy.labTestingTotal ?? null;
    // Costings saved BEFORE the pricing tier existed have no margin fields.
    // Spreading blank first backfills them, so an old record opens with the
    // standard 30% / commissions rather than an undefined that would turn
    // the margin select into an uncontrolled input and the price into NaN.
    //
    // The bom array needs the SAME treatment one level down: a top-level
    // spread replaces it wholesale, so saved lines would arrive with no
    // suppliedBy and no costSource. An undefined suppliedBy is not merely
    // cosmetic — resolveLine would read it as "not customer", silently
    // demanding a cost for something the customer actually free-issues.
    return {
      ...blank,
      ...initial,
      // Costings saved before Direct Labor Costs became a five-table matrix
      // have no production shift fields and no per-role burden. A top-level
      // spread would leave them undefined, which turns the burden inputs into
      // uncontrolled fields and the rates into NaN. `??` so a saved 0 — a
      // deliberate "no workers' comp on this one" — is not overwritten.
      prodHoursTotal: initial.prodHoursTotal ?? blank.prodHoursTotal,
      setupHours: initial.setupHours ?? blank.setupHours,
      cleaningHours: initial.cleaningHours ?? blank.cleaningHours,
      // Costings saved before the three-list overhead card. The old pair was
      // one lump sum with one share; carry it across as a single "Other" row
      // so the number survives and is visible, rather than silently resetting
      // the job to the plant defaults it was never costed against.
      overheadRent: initial.overheadRent ?? blank.overheadRent,
      overheadIndirect: initial.overheadIndirect ?? blank.overheadIndirect,
      overheadOther:
        initial.overheadOther ??
        (legacyOverheadMonthly && legacyOverheadMonthly > 0
          ? [
              {
                label: "Facility overhead (migrated)",
                monthly: legacyOverheadMonthly,
                sharePct: legacySharePct ?? 100,
              },
            ]
          : blank.overheadOther),
      labTestRm:
        initial.labTestRm ??
        (legacyLabTotal && legacyLabTotal > 0
          ? [{ label: "Lab testing (migrated)", cost: legacyLabTotal, qty: 1 }]
          : []),
      labTestFp: initial.labTestFp ?? [],
      kittingLeaders: initial.kittingLeaders ?? blank.kittingLeaders,
      kittingOperators: initial.kittingOperators ?? blank.kittingOperators,
      leaderTaxPct: initial.leaderTaxPct ?? blank.leaderTaxPct,
      leaderWcPct: initial.leaderWcPct ?? blank.leaderWcPct,
      operatorTaxPct: initial.operatorTaxPct ?? blank.operatorTaxPct,
      operatorWcPct: initial.operatorWcPct ?? blank.operatorWcPct,
      bom: (initial.bom ?? blank.bom).map((l) => ({
        ...l,
        // A saved line that already resolved as a customer asset must stay
        // customer-supplied. That fact came from the chosen Fishbowl part
        // (a CA- code), which is a stronger signal than the form answer —
        // and without this check such a line would silently flip to
        // PharmaCenter and start demanding a $0 confirmation for something
        // we never buy.
        suppliedBy:
          l.suppliedBy ??
          (l.costStatus === "customer_asset"
            ? "customer"
            : suppliedByFromSpec(l.slot, spec)),
        costSource: l.costSource ?? DEFAULT_COST_SOURCE,
        // Seed the house scrap rate on lines saved before the column existed,
        // so an old costing and a new one price the same job identically.
        //
        // `??` and not `||` on purpose: a deliberate 0% must survive. Someone
        // who typed zero meant zero, and `||` would overwrite it with 5.
        //
        // This does move the number on an already-saved costing — but it moves
        // it visibly, with 5 / 10 / 2 sitting in the inputs where they can be
        // read and changed, and nothing is written back until Save is pressed.
        wastePct: l.wastePct ?? DEFAULT_WASTE_PCT[l.slot],
      })),
    };
  });
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [addSlot, setAddSlot] = useState<PackagingSlot>("other");

  // ----------------------------------------------------------------
  // Plant overhead: refresh the DEFAULTS from the shared reference data
  // ----------------------------------------------------------------
  //
  // The rows above came from the constants in lib/overheadCosting.ts, which are
  // a fallback. The live figures live in Supabase (sql/overhead_reference.sql),
  // banded by date so a rent step-up applies itself. Fetch them and swap in.
  //
  // ONLY FOR A JOB THAT HAS NEVER SAVED ITS OWN ROWS. Once a costing has been
  // saved it owns its overhead, and quietly re-pricing someone's saved job
  // because a lease changed is exactly the behaviour a snapshot exists to
  // prevent. `initial.overheadRent` present means this job made that choice.
  const usingPlantDefaults = useRef(!initial?.overheadRent);
  const [overheadMeta, setOverheadMeta] = useState<{
    asOf: string | null;
    leasePerRunDay: number | null;
    leaseFloorRate: number | null;
    leaseFacilityRate: number | null;
    runDaysPerMonth: number | null;
    attention: {
      label: string;
      status: string;
      daysLeft: number | null;
      camEstimated: boolean;
    }[];
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // The key is the DEPARTMENT, not this calculator. Blisters, sachets,
        // pouches and kitting run on the same floor with the same equipment and
        // will ask for the same key — they are not dividing Suite 300 between
        // them, they are each claiming it for the days they run. Five copies of
        // one judgement is what went wrong with the rent rows.
        const res = await fetch("/api/overhead?line=contract_packaging");
        const json = await res.json();
        // reason === "not_migrated" lands here too: the SQL has not been run on
        // this project yet, the constants on screen are correct, say nothing.
        if (cancelled || !json?.ok) return;
        setOverheadMeta({
          asOf: json.asOf ?? null,
          leasePerRunDay: json.lease?.perRunDay ?? null,
          leaseFloorRate: json.lease?.floorRate ?? null,
          leaseFacilityRate: json.lease?.facilityRate ?? null,
          runDaysPerMonth: json.lease?.runDaysPerMonth ?? null,
          attention: json.attention ?? [],
        });
        if (!usingPlantDefaults.current) return;
        // Flip the guard BEFORE the state update so a slow response cannot
        // land twice and overwrite an edit made in between.
        usingPlantDefaults.current = false;
        setSt((p) => ({
          ...p,
          overheadRent: json.rent ?? p.overheadRent,
          overheadIndirect: json.indirect ?? p.overheadIndirect,
          overheadOther: json.other ?? p.overheadOther,
        }));
      } catch {
        // Offline, blocked, or the route is missing. The constants already
        // rendered are a complete answer — a costing board that cannot reach
        // the network should still cost.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const set = <K extends keyof SavedState>(k: K, v: SavedState[K]) =>
    setSt((p) => ({ ...p, [k]: v }));

  const setLine = (id: string, patch: Partial<BomLine>) =>
    setSt((p) => ({
      ...p,
      bom: p.bom.map((l) => (l.id === id ? { ...l, ...patch } : l)),
    }));

  /**
   * Add a component the spec did not call for. The spec is a starting point,
   * not a cage — real jobs pick up an extra part after the form is filled in.
   * The id carries a timestamp so a slot can appear twice (two label types,
   * say) without the two rows sharing a key.
   */
  const addLine = (slot: PackagingSlot) => {
    const meta = SLOTS.find((s) => s.slot === slot);
    setSt((p) => ({
      ...p,
      bom: [
        ...p.bom,
        {
          id: `added-${slot}-${Date.now()}`,
          slot,
          fpCode: null,
          name: meta?.label ?? slot,
          // A shared container starts blank so the user states how many
          // bottles it holds; everything else is one per bottle.
          qtyPerUnit:
            slot === "inner_pack"
              ? p.bottlesPerInnerPack && p.bottlesPerInnerPack > 0
                ? 1 / p.bottlesPerInnerPack
                : null
              : slot === "master_box"
                ? p.bottlesPerMasterBox && p.bottlesPerMasterBox > 0
                  ? 1 / p.bottlesPerMasterBox
                  : null
                : 1,
          costPerUnit: null,
          costStatus: "no_cost",
          suppliedBy: suppliedByFromSpec(slot, spec),
          costSource: DEFAULT_COST_SOURCE,
          wastePct: DEFAULT_WASTE_PCT[slot],
          manualCostPerUnit: null,
          inventoryCostPerUnit: null,
          lastOrderCostPerUnit: null,
        },
      ],
    }));
  };

  const removeLine = (id: string) =>
    setSt((p) => ({ ...p, bom: p.bom.filter((l) => l.id !== id) }));

  /**
   * Does this job bundle bottles into inner packs before they go in the case?
   *
   * This single fact changes how the master box is counted, which is why it is
   * derived from the BOM rather than being a separate switch the user could
   * forget to flip. Adding the Inner pack row IS the declaration.
   */
  const hasInnerPack = st.bom.some((l) => l.slot === "inner_pack");

  /**
   * The quantity everything below costs against. The override when one is set,
   * otherwise the workflow's. Resolved once here so no card can be looking at
   * a different number than the card next to it.
   */
  const qty = st.quantityOverride ?? quantity;

  /**
   * Bottles in one master box.
   *
   * WITHOUT an inner pack this is typed directly, as it always has been.
   * WITH one the case is counted in inners, so the bottle figure is the
   * product of the two nestings and becomes a readout rather than an input.
   *
   * Null if any part of the chain is missing. A half-specified nesting must
   * not quietly collapse to "1", which would price a whole case against every
   * single bottle.
   */
  const bottlesPerMasterBoxEffective = useMemo(() => {
    if (!hasInnerPack) {
      const n = st.bottlesPerMasterBox;
      return n && n > 0 ? n : null;
    }
    const per = st.bottlesPerInnerPack;
    const inners = st.innersPerMasterBox;
    if (!per || per <= 0 || !inners || inners <= 0) return null;
    return per * inners;
  }, [
    hasInnerPack,
    st.bottlesPerMasterBox,
    st.bottlesPerInnerPack,
    st.innersPerMasterBox,
  ]);

  // Both containers are shared across the bottles inside them, so both are
  // derived from the counts above rather than typed as fractions.
  useEffect(() => {
    const perInner = st.bottlesPerInnerPack;
    const perBox = bottlesPerMasterBoxEffective;
    setSt((p) => ({
      ...p,
      bom: p.bom.map((l) => {
        if (l.slot === "master_box")
          return { ...l, qtyPerUnit: perBox ? 1 / perBox : null };
        if (l.slot === "inner_pack")
          return {
            ...l,
            qtyPerUnit: perInner && perInner > 0 ? 1 / perInner : null,
          };
        return l;
      }),
    }));
  }, [bottlesPerMasterBoxEffective, st.bottlesPerInnerPack]);

  const inputs: BottleCostingInputs = useMemo(
    () => ({
      quantity: qty,
      bom: st.bom,
      labor: {
        bottlesPerMinute: st.bottlesPerMinute,
        kittingSpeed: st.kittingSpeed,
        setup: {
          hours: st.setupHours,
          leaders: st.setupLeaders,
          operators: st.setupOperators,
        },
        production: {
          hours: st.prodHoursTotal,
          leaders: st.prodLeaders,
          operators: st.prodOperators,
        },
        cleaning: {
          hours: st.cleaningHours,
          leaders: st.cleaningLeaders,
          operators: st.cleaningOperators,
        },
        kitting: {
          // Always null: the board no longer offers a way to type this, so the
          // speed-and-crew derivation is the only source. Passing a stale
          // stored value would let an old typed figure outrank the inputs the
          // user can actually see.
          hours: null,
          leaders: st.kittingLeaders,
          operators: st.kittingOperators,
        },
        leaderRate: st.leaderRate,
        operatorRate: st.operatorRate,
        // These were in SavedState and on the Pay Rates card from the start,
        // but never made it into this mapping — so the tax and workers'-comp
        // cells were editable and inert, and every burdened rate quietly used
        // the 8.5 / 4 defaults no matter what was typed. Caught while chasing
        // an unrelated build failure.
        leaderTaxPct: st.leaderTaxPct,
        leaderWcPct: st.leaderWcPct,
        operatorTaxPct: st.operatorTaxPct,
        operatorWcPct: st.operatorWcPct,
      },
      overhead: {
        rentLease: st.overheadRent,
        indirectLabor: st.overheadIndirect,
        other: st.overheadOther,
        workingDaysPerMonth: st.workingDaysPerMonth,
        // v74: rent per run-day, from the shared pools. Null until the fetch
        // lands (or forever, if the tables are absent) — the model then falls
        // back to the old row-and-share arithmetic on its own.
        leasePerRunDay: overheadMeta?.leasePerRunDay ?? null,
      },
      labTesting: {
        rawMaterials: st.labTestRm,
        finishedProduct: st.labTestFp,
      },
      pricing: {
        marginPct: st.marginPct,
        marginMode: st.marginMode,
        hosCommissionPct: st.hosCommissionPct,
        repCommissionPct: st.repCommissionPct,
      },
    }),
    [st, qty],
  );

  const r = useMemo(() => computeBottleCosting(inputs), [inputs]);

  /**
   * The labour matrix, computed once by the model and merely rendered by the
   * five sub-tables below. Null when production cannot be established — no
   * line speed and no typed shift count — in which case the card says so
   * rather than drawing a table full of zeroes.
   */
  const lb = useMemo(
    () => laborBreakdown(qty, inputs.labor),
    [qty, inputs.labor],
  );

  /**
   * How many working days this job occupies the floor.
   *
   * Total labour hours over an 8-hour day, left FRACTIONAL. Overhead is a
   * smooth spread rather than something you buy in whole days, so rounding a
   * 13-hour job up to two would overcharge it by half. Null when there is no
   * labour estimate at all — the same rule as everywhere else.
   */
  const jobDays = useMemo(
    () => (lb === null ? null : lb.totalHours / 8),
    [lb],
  );

  /** Charged monthly overhead: every row's share, across all three groups. */
  const overheadMonthlyCharged = useMemo(
    () =>
      overheadGroupCharged(st.overheadRent, "lease") +
      overheadGroupCharged(st.overheadIndirect, "labor") +
      overheadGroupCharged(st.overheadOther),
    [st.overheadRent, st.overheadIndirect, st.overheadOther],
  );

  /** That monthly charge, prorated to this job's days. */
  const overheadJobTotal = useMemo(() => {
    const wd = st.workingDaysPerMonth ?? DEFAULT_WORKING_DAYS_PER_MONTH;
    if (jobDays === null || wd <= 0) return null;
    return (overheadMonthlyCharged / wd) * jobDays;
  }, [overheadMonthlyCharged, jobDays, st.workingDaysPerMonth]);

  /**
   * Issue a Quote — same customer-facing document the pricing calculator
   * produces, so a bottles quote and a bulk quote are indistinguishable to
   * the customer. One line item: this job, at the computed price.
   *
   * Refuses when there is no price. Issuing a quote with a blank or zero
   * price is exactly the silent-wrong-number failure the whole model is
   * built to prevent, and it would go out to a customer.
   */
  const issueQuote = useCallback(() => {
    if (r.salePerUnit === null) {
      window.alert(
        r.costPerUnit === null
          ? "No price yet — the costing is incomplete. Resolve the flagged component lines and enter bottles per minute first."
          : "No price yet — enter a margin percentage.",
      );
      return;
    }
    const lineItems: QuoteLineItem[] = [
      {
        itemRef: "ITEM 1",
        description: productName,
        quantity: qty ?? 0,
        unitPrice: r.salePerUnit,
      },
    ];
    const backUrl =
      typeof window !== "undefined"
        ? `${window.location.origin}/workflow/${workflowId}`
        : null;
    const html = buildQuoteHtml({
      customerName,
      customerAddress: null,
      customerContact: null,
      customerEmail: null,
      workflowLabel: quoteNumber,
      preparerName: "",
      preparerEmail: "",
      lineItems,
      backUrl,
      backLabel: `Back to workflow (${quoteNumber})`,
      initialTabs: [],
      saveEnabled: false,
    });
    const url = URL.createObjectURL(new Blob([html], { type: "text/html" }));
    const w = window.open(url, "_blank");
    if (!w) {
      window.alert(
        "Couldn't open the quote window — please allow popups for this site and try again.",
      );
      URL.revokeObjectURL(url);
      return;
    }
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }, [r, productName, qty, workflowId, customerName, quoteNumber]);

  /**
   * Same endpoint the pricing calculator and gummy formula save through — it
   * takes a partial state and merges it into the existing row. No bespoke
   * route for this board; one less thing to keep in step.
   */
  const save = useCallback(async () => {
    setSaving(true);
    try {
      const res = await fetch(`/api/workflows/${workflowId}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ state: { bottleCosting: st } }),
      });
      if (res.ok) setSavedAt(new Date().toLocaleTimeString());
    } finally {
      setSaving(false);
    }
  }, [st, workflowId]);

  const pctOf = (v: number) =>
    r.costPerUnit && r.costPerUnit > 0 ? (
      <span style={{ fontSize: 12, fontWeight: 600, opacity: 0.65 }}>
        {"  "}
        {((v / r.costPerUnit) * 100).toFixed(1)}%
      </span>
    ) : null;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {/* ---------- Considerations ---------- */}
      <div style={shell}>
        <div style={band}>Considerations</div>
        <div style={metricGrid}>
          {/* Editable, because the quantity on the request is often a
              placeholder and a costing is where you test alternatives. It
              writes to quantityOverride, NOT back to the workflow — what the
              customer asked for is a fact, and trying 24,000 here must not
              quietly rewrite it. Blank restores the workflow's figure. */}
          <ParamBlock label="QTY (Bottles)" nowrap>
            <NumField
              value={st.quantityOverride ?? quantity}
              onChange={(v) =>
                set("quantityOverride", v === quantity ? null : v)
              }
              placeholder="required"
            />
          </ParamBlock>
          <ParamBlock label="Line speed (bottles / minute)" nowrap>
            <NumField
              value={st.bottlesPerMinute}
              onChange={(v) => set("bottlesPerMinute", v)}
              placeholder="required"
            />
          </ParamBlock>
          {/* Per PERSON, unlike the line speed. Kitting is hand work: two
              people kit twice as fast, whereas the line runs at its own pace
              whoever is watching it. */}
          <ParamBlock label="Kitting speed (bottles / min / person)" nowrap>
            <NumField
              value={st.kittingSpeed}
              onChange={(v) => set("kittingSpeed", v)}
            />
          </ParamBlock>
          <ParamBlock label="Line time (hours)" nowrap>
            <ReadOnly>
              {r.productionHours !== null
                ? r.productionHours.toLocaleString("en-US", {
                    maximumFractionDigits: 2,
                  })
                : "—"}
            </ReadOnly>
          </ParamBlock>
          {/* Only when the two differ, so the override is never silent. */}
          {st.quantityOverride !== null &&
            st.quantityOverride !== quantity && (
              <ParamBlock label="Workflow qty" nowrap>
                <ReadOnly>
                  <span style={{ fontSize: 13, fontWeight: 600, opacity: 0.7 }}>
                    {quantity ? quantity.toLocaleString("en-US") : "—"}
                  </span>
                </ReadOnly>
              </ParamBlock>
            )}
          {/* Master-box and inner-pack counts used to live here too. They are
              typed on their own rows in Material Costs, where the part being
              counted is right next to the count — so a second copy up here was
              a second place for the same number to be edited. */}
        </div>
      </div>

      {/* ---------- Bill of materials ---------- */}
      <div style={shell} className="bc-materials">
        <div style={band}>Material Costs</div>
        <div style={{ padding: 14, display: "grid", gap: 10 }}>
          {/* Column headers — six columns is too many to read unlabelled. */}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: MATERIALS_COLUMNS,
              gap: 8,
              fontSize: 11,
              fontWeight: 700,
              textTransform: "uppercase",
              letterSpacing: "0.04em",
              color: "var(--ink-3, #7b7364)",
              paddingBottom: 2,
              borderBottom: "1px solid var(--line, #e3dcc9)",
            }}
          >
            <div>Component</div>
            <div>Fishbowl part</div>
            <div>Supplied by</div>
            <div>Cost source</div>
            <div style={{ textAlign: "right", whiteSpace: "nowrap" }}>
              Waste %
            </div>
            <div style={{ textAlign: "right" }}>$ / bottle</div>
          </div>
          {st.bom.map((line) => {
            const slotLabel =
              SLOTS.find((s) => s.slot === line.slot)?.label ?? line.slot;
            const issue = r.issues.find((i) => i.lineId === line.id);
            return (
              <div
                key={line.id}
                style={{
                  display: "grid",
                  gridTemplateColumns: MATERIALS_COLUMNS,
                  gap: 8,
                  alignItems: "start",
                  opacity: line.notUsed ? 0.55 : 1,
                }}
              >
                <div
                  style={{
                    fontSize: 12.5,
                    fontWeight: 700,
                    textTransform: "uppercase",
                    letterSpacing: "0.04em",
                    color: "var(--teal-700, #1d6c7b)",
                    paddingTop: 9,
                  }}
                >
                  {slotLabel}
                  {/* The liner has no row of its own (it arrives in the cap),
                      so the spec's answer is surfaced here — otherwise the
                      requirement would simply disappear from the costing and
                      someone could pick a cap with the wrong liner. */}
                  {line.slot === "closure" && LINER_LABEL[spec?.closureLiner ?? ""] && (
                    <div
                      style={{
                        fontSize: 11,
                        fontWeight: 500,
                        textTransform: "none",
                        letterSpacing: 0,
                        color: "var(--ink-3, #7b7364)",
                        marginTop: 2,
                      }}
                    >
                      liner: {LINER_LABEL[spec?.closureLiner ?? ""]}
                    </div>
                  )}
                  {/* A component shared across several bottles — the master box
                      being the usual one. Shown as the ratio a human would say
                      out loud rather than the 0.08333 the arithmetic needs. */}
                  {/* Shown whenever a component is shared across bottles, and
                      ALWAYS for the master box — otherwise a spec with no
                      units-per-box would render no caption and leave nowhere
                      to type the number. */}
                  {(line.slot === "master_box" ||
                    line.slot === "inner_pack" ||
                    (line.qtyPerUnit !== null &&
                      line.qtyPerUnit > 0 &&
                      line.qtyPerUnit < 1)) && (
                      <div
                        style={{
                          fontSize: 11,
                          fontWeight: 500,
                          textTransform: "none",
                          letterSpacing: 0,
                          color: "var(--ink-3, #7b7364)",
                          marginTop: 3,
                          display: "flex",
                          alignItems: "center",
                          gap: 3,
                        }}
                      >
                        {line.slot !== "master_box" &&
                          line.slot !== "inner_pack" &&
                          "1 per"}
                        <input
                          type="number"
                          min={1}
                          step="1"
                          placeholder="?"
                          value={
                            // The master box counts INNERS when the job has
                            // them, so it must show the number that was typed
                            // rather than 1/qtyPerUnit — which is bottles, and
                            // would put 72 in a box the user called 12 inners.
                            line.slot === "master_box" && hasInnerPack
                              ? (st.innersPerMasterBox ?? "")
                              : line.qtyPerUnit !== null && line.qtyPerUnit > 0
                                ? Math.round(1 / line.qtyPerUnit)
                                : ""
                          }
                          onFocus={(e) => {
                            // Chrome does not select a number input's contents
                            // synchronously on focus, so a keystroke prepends
                            // to the existing digits instead of replacing them
                            // — typing 24 over 12 gave 124. Deferring a frame
                            // is the workaround already proven in #206.
                            const el = e.currentTarget;
                            setTimeout(() => {
                              try {
                                el.select();
                              } catch {}
                            }, 0);
                          }}
                          onChange={(e) => {
                            const n = Number(e.target.value);
                            const per =
                              Number.isFinite(n) && n > 0 ? n : null;
                            // The master box has ONE source of truth —
                            // bottlesPerMasterBox, seeded from the packaging
                            // form and shown in Considerations. Write there and
                            // let the existing effect derive qtyPerUnit, rather
                            // than setting the row directly and ending up with
                            // two fields that can disagree.
                            if (line.slot === "master_box") {
                              // With inners in play the case is counted in
                              // inners, so the number typed here belongs to a
                              // different field. Writing it to bottlesPer-
                              // MasterBox would leave a stale bottle count
                              // sitting behind the derived one.
                              set(
                                hasInnerPack
                                  ? "innersPerMasterBox"
                                  : "bottlesPerMasterBox",
                                per,
                              );
                            } else if (line.slot === "inner_pack") {
                              set("bottlesPerInnerPack", per);
                            } else {
                              setLine(line.id, {
                                qtyPerUnit: per ? 1 / per : null,
                              });
                            }
                          }}
                          style={{
                            width: 44,
                            padding: "1px 4px",
                            border: "1px solid var(--line, #e3dcc9)",
                            borderRadius: 4,
                            fontSize: 11,
                            fontWeight: 600,
                            textAlign: "right",
                            color: "var(--teal-900, #0f4a56)",
                            background: "#fff",
                          }}
                        />
                        {line.slot === "master_box"
                          ? hasInnerPack
                            ? "inner packs per box"
                            : "bottles per box"
                          : line.slot === "inner_pack"
                            ? "bottles per inner pack"
                            : "bottles"}
                        {/* The derived bottle count, which used to sit in
                            Considerations. With two levels of nesting the
                            product is not obvious at a glance, and this is
                            the one place it can be checked against the two
                            numbers that produced it. */}
                        {line.slot === "master_box" &&
                          hasInnerPack &&
                          bottlesPerMasterBoxEffective !== null && (
                            <span style={{ opacity: 0.8 }}>
                              {" · "}
                              {bottlesPerMasterBoxEffective.toLocaleString(
                                "en-US",
                              )}{" "}
                              bottles
                            </span>
                          )}
                      </div>
                    )}
                </div>
                <div>
                  {line.notUsed ? (
                    <div
                      style={{
                        padding: "7px 9px",
                        border: "1px dashed var(--line, #e3dcc9)",
                        borderRadius: 6,
                        fontSize: 14,
                        color: "var(--ink-3, #7b7364)",
                        fontStyle: "italic",
                      }}
                    >
                      Not used on this job
                    </div>
                  ) : (
                    <ComponentPicker
                      slot={line.slot}
                      current={line}
                      spec={spec}
                      onPick={(opt) =>
                        setLine(line.id, {
                          fpCode: opt?.fp_code ?? null,
                          name: opt?.name ?? slotLabel,
                          // Clearing or choosing a real part both end any
                          // custom description that was here before.
                          customPart: false,
                          costPerUnit: opt?.effective_cost_per_unit ?? null,
                          // Both Fishbowl figures are stored so the source
                          // picker can switch between them without a refetch.
                          inventoryCostPerUnit:
                            opt?.effective_cost_per_unit ?? null,
                          lastOrderCostPerUnit:
                            opt?.last_order_cost_per_unit ?? null,
                          costStatus: opt?.cost_status ?? "no_cost",
                          zeroCostConfirmed: false,
                        })
                      }
                      onCustom={(text) =>
                        setLine(line.id, {
                          fpCode: null,
                          customPart: true,
                          name: text,
                          // Manual is the only source that can price this, so
                          // set it rather than leaving the user on a Fishbowl
                          // source that will never resolve. Any stale Fishbowl
                          // figures from a previously picked part are wiped —
                          // keeping them would let the old part's price hide
                          // behind the new part's name.
                          costSource: "Manual",
                          manualCostPerUnit: null,
                          costPerUnit: null,
                          inventoryCostPerUnit: null,
                          lastOrderCostPerUnit: null,
                          costStatus: "no_cost",
                          zeroCostConfirmed: false,
                        })
                      }
                    />
                  )}
                  {/* Remove replaces the old "Not used" checkbox: now that the
                      spec generates the list, a row that does not belong should
                      simply not be here. Anything removed can be added back
                      from the picker below. */}
                  <button
                    type="button"
                    onClick={() => removeLine(line.id)}
                    title="Remove this component from the costing"
                    style={{
                      marginTop: 5,
                      padding: 0,
                      border: "none",
                      background: "none",
                      fontSize: 12,
                      color: "#8b2f2f",
                      cursor: "pointer",
                      textDecoration: "underline",
                    }}
                  >
                    Remove
                  </button>
                  {/* The #358 gate. A PharmaCenter $0 does not count until a
                      human says it is genuinely free. */}
                  {!line.notUsed &&
                    line.suppliedBy === "pharmacenter" &&
                    costFromSource(line) === 0 && (
                    <label
                      style={{
                        display: "flex",
                        gap: 6,
                        alignItems: "center",
                        marginTop: 6,
                        fontSize: 12.5,
                        color: "#8a5a00",
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={!!line.zeroCostConfirmed}
                        onChange={(e) =>
                          setLine(line.id, {
                            zeroCostConfirmed: e.target.checked,
                          })
                        }
                      />
                      $0 from this source — confirm the part is genuinely free
                    </label>
                  )}
                  {issue && issue.reason !== "zero_unconfirmed" && (
                    <div
                      style={{ marginTop: 5, fontSize: 12, color: "#a3281f" }}
                    >
                      {issue.message}
                    </div>
                  )}
                </div>
                {/* Supplied by — defaults from the packaging form, but the
                    human can override. This is what decides whether the line
                    costs anything, so it sits before the money columns. */}
                <div style={{ paddingTop: 4 }}>
                  <select
                    value={line.suppliedBy}
                    disabled={line.notUsed}
                    onChange={(e) =>
                      setLine(line.id, {
                        suppliedBy: e.target.value as SuppliedBy,
                      })
                    }
                    style={{
                      width: "100%",
                      padding: "6px 6px",
                      border: "1px solid var(--line, #e3dcc9)",
                      borderRadius: 6,
                      fontSize: 12,
                      background: "#fff",
                    }}
                  >
                    <option value="pharmacenter">PharmaCenter</option>
                    <option value="customer">Customer</option>
                  </select>
                  {suppliedByFromSpec(line.slot, spec) !== line.suppliedBy && (
                    <div
                      style={{
                        marginTop: 3,
                        fontSize: 11,
                        color: "#8a5a00",
                      }}
                    >
                      Changed from the spec
                    </div>
                  )}
                </div>

                {/* Cost source — same four options as the gummy Costing tab.
                    Hidden when the customer supplies it: there is no cost to
                    source, and offering the choice would imply otherwise. */}
                <div style={{ paddingTop: 4 }}>
                  {line.notUsed || line.suppliedBy === "customer" ? (
                    <div
                      style={{
                        paddingTop: 5,
                        fontSize: 12,
                        color: "var(--ink-3, #7b7364)",
                        fontStyle: "italic",
                      }}
                    >
                      {line.notUsed ? "—" : "No cost to PC"}
                    </div>
                  ) : (
                    <>
                      <select
                        value={line.costSource}
                        onChange={(e) =>
                          setLine(line.id, {
                            costSource: e.target.value as CostSource,
                          })
                        }
                        style={{
                          width: "100%",
                          padding: "6px 6px",
                          border: "1px solid var(--line, #e3dcc9)",
                          borderRadius: 6,
                          fontSize: 12,
                          background: "#fff",
                        }}
                      >
                        {COST_SOURCES.map((s) => (
                          <option key={s} value={s}>
                            {s}
                          </option>
                        ))}
                      </select>
                      {line.costSource === "Manual" && (
                        <div style={{ marginTop: 4 }}>
                          <NumField
                            value={line.manualCostPerUnit ?? null}
                            onChange={(v) =>
                              setLine(line.id, { manualCostPerUnit: v })
                            }
                            placeholder="$ / each"
                            step="0.0001"
                          />
                        </div>
                      )}
                    </>
                  )}
                </div>

                {/* Waste % — the scrap rate for THIS component.
                    Per-line because the rates differ by an order of magnitude:
                    a label web changeover throws away hundreds, a bottle
                    almost never gets lost. Blank means none is claimed.
                    Hidden when the customer supplies it or the slot is unused,
                    for the same reason the cost source is: we buy none of it,
                    so there is nothing of ours to scrap. */}
                <div style={{ paddingTop: 4 }}>
                  {line.notUsed || line.suppliedBy === "customer" ? (
                    <div
                      style={{
                        paddingTop: 5,
                        textAlign: "right",
                        fontSize: 12,
                        color: "var(--ink-3, #7b7364)",
                        fontStyle: "italic",
                      }}
                    >
                      —
                    </div>
                  ) : (
                    <input
                      type="number"
                      min={0}
                      max={99}
                      step="0.5"
                      placeholder="0"
                      value={line.wastePct ?? ""}
                      onFocus={(e) => {
                        // #206 again — deferred a frame or the first keystroke
                        // prepends instead of replacing.
                        const el = e.currentTarget;
                        setTimeout(() => {
                          try {
                            el.select();
                          } catch {}
                        }, 0);
                      }}
                      onChange={(e) => {
                        const raw = e.target.value;
                        if (raw === "")
                          return setLine(line.id, { wastePct: null });
                        const n = Number(raw);
                        // Out-of-range is STORED, not clamped. Clamping 150
                        // to 99 would silently invent a rate nobody typed;
                        // storing it lets resolveLine refuse the line and say
                        // why, which is the behaviour everywhere else here.
                        setLine(line.id, {
                          wastePct: Number.isFinite(n) ? n : null,
                        });
                      }}
                      style={{
                        width: "100%",
                        padding: "6px 6px",
                        border: "1px solid var(--line, #e3dcc9)",
                        borderRadius: 6,
                        fontSize: 12,
                        textAlign: "right",
                        background: "#fff",
                      }}
                    />
                  )}
                </div>

                {/* The $/each actually in play, per the chosen source — not
                    whatever Fishbowl's inventory column happens to hold. If
                    this showed the inventory figure while the line was set to
                    Last Order, the displayed number and the number in the
                    total would disagree, which is worse than showing nothing. */}
                {/* What this line actually contributes to ONE BOTTLE —
                    i.e. the unit price already divided by how many bottles
                    share it. A master box at $3.30 for 12 bottles shows
                    $0.2750 here, which is the number that lands in the
                    total; the undivided price is kept as a caption so the
                    buyer can still sanity-check what a box costs. */}
                <div style={{ textAlign: "right", paddingTop: 8 }}>
                  <ReadOnly>
                    {line.notUsed
                      ? "—"
                      : line.suppliedBy === "customer"
                        ? money(0)
                        : (() => {
                            const c = costFromSource(line);
                            const q = line.qtyPerUnit;
                            // Mirrors resolveLine's final expression exactly,
                            // waste included, so the column and the total can
                            // never tell different stories.
                            const w = wasteFactor(line);
                            if (c === null || q === null || w === null)
                              return "—";
                            return money(q * c * w);
                          })()}
                  </ReadOnly>
                  {/* Show the working, not just the answer. The figure above
                      can now be moved by two separate divisors — how many
                      bottles share the part, and how many we scrap — and a
                      caption that named neither would leave the user unable
                      to tell why $3.30 became $0.29. */}
                  {!line.notUsed &&
                    line.suppliedBy === "pharmacenter" &&
                    costFromSource(line) !== null &&
                    (() => {
                      const c = costFromSource(line) as number;
                      const w =
                        typeof line.wastePct === "number" &&
                        Number.isFinite(line.wastePct)
                          ? line.wastePct
                          : null;
                      const parts: string[] = [];
                      if (line.qtyPerUnit !== null && line.qtyPerUnit !== 1)
                        parts.push(money(c) + " each");
                      if (w !== null && w > 0 && w < 100)
                        parts.push("incl. " + w + "% waste");
                      if (!parts.length) return null;
                      return (
                        <div
                          style={{
                            fontSize: 11,
                            color: "var(--ink-3, #7b7364)",
                            marginTop: 2,
                          }}
                        >
                          {parts.join(" · ")}
                        </div>
                      );
                    })()}
                </div>
              </div>
            );
          })}

          {/* Add a component the spec did not ask for. */}
          <div
            style={{
              display: "flex",
              gap: 8,
              alignItems: "center",
              marginTop: 4,
              paddingTop: 10,
              borderTop: "1px solid var(--line, #e3dcc9)",
            }}
          >
            <span
              style={{
                fontSize: 11.5,
                fontWeight: 700,
                textTransform: "uppercase",
                letterSpacing: "0.04em",
                color: "var(--ink-3, #7b7364)",
              }}
            >
              Add component
            </span>
            <select
              value={addSlot}
              onChange={(e) => setAddSlot(e.target.value as PackagingSlot)}
              style={{
                padding: "6px 8px",
                border: "1px solid var(--line, #e3dcc9)",
                borderRadius: 6,
                fontSize: 13,
                background: "#fff",
              }}
            >
              {SLOTS.map((s) => (
                <option key={s.slot} value={s.slot}>
                  {s.label}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => addLine(addSlot)}
              style={{
                padding: "6px 14px",
                border: "1px solid var(--teal-700, #1d6c7b)",
                borderRadius: 6,
                background: "#fff",
                color: "var(--teal-900, #0f4a56)",
                fontSize: 13,
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              Add
            </button>
            <span style={{ fontSize: 12, color: "var(--ink-3, #7b7364)" }}>
              The list above comes from the packaging spec — add anything it
              missed.
            </span>
          </div>
        </div>
        <CardTotal
          label="Material cost / bottle"
          perUnit={r.materialsPerUnit}
          quantity={qty}
        />
      </div>

      {/* ---------- Direct labor ----------
          Ported from the gummy Costing tab so the two calculators read the
          same way: five stacked sub-tables walking Shifts -> Hours -> Man
          Hours -> Rates -> Money. Every number below comes from `lb`, the
          model's single pass; nothing here does its own arithmetic. */}
      <div style={shell}>
        <div style={band}>Direct Labor Costs</div>
        {lb === null ? (
          <div
            style={{
              margin: 14,
              padding: "10px 12px",
              borderRadius: 6,
              background: "#fdf3e0",
              border: "1px solid #e8cf9a",
              fontSize: 13,
              color: "#7a4f00",
            }}
          >
            {/* Points ONLY at Considerations. An earlier draft also offered
                "or type the production shifts below" — but the table holding
                that input is the very thing this message replaces, so the
                instruction pointed at something that was not on screen. */}
            <strong>No production estimate yet.</strong> Enter bottles per
            minute in Considerations above. The hours tables appear once there
            is a line speed.
          </div>
        ) : (
          <>
            {/* ---- Hours ----
                One editable row, not shifts x hours-per-shift. A changeover
                is two hours and a wash-down is two hours; making someone
                express that as a fraction of a shift was arithmetic in the
                head for no gain. Production carries its derived line time,
                and stays editable like the rest. */}
            <div style={labSub}>
              <div style={labSubTitle}>Hours</div>
              <table style={labTable}>
                <thead>
                  <tr style={labHeadRow}>
                    <th style={{ ...labTh, textAlign: "left" }} />
                    {lb.phases.map((p) => (
                      <th key={p.label} style={{ ...labTh, width: 170 }}>
                        {p.label}
                      </th>
                    ))}
                    <th style={{ ...labTh, width: 170 }}>Total</th>
                  </tr>
                </thead>
                <tbody>
                  <tr style={labTotalRow}>
                    <td style={{ ...labTh, textAlign: "left" }}>Total Hours</td>
                    {lb.phases.map((p, i) => (
                      <td key={p.label} style={labTd}>
                        {/* Kitting is READ-ONLY. It is a function of the
                            kitting speed and the people on it, so an editable
                            cell here would offer to contradict the two inputs
                            that produce it — and whichever the user changed
                            last would win silently. Change the speed or the
                            crew instead. */}
                        {p.label === "Kitting" ? (
                          labSum(p.totalHours)
                        ) : (
                          <LabNum
                            value={p.totalHours}
                            onChange={(n) =>
                              set(
                                (
                                  [
                                    "setupHours",
                                    "prodHoursTotal",
                                    "cleaningHours",
                                  ] as const
                                )[i],
                                n,
                              )
                            }
                            step="0.5"
                          />
                        )}
                      </td>
                    ))}
                    <td style={labTd}>{labSum(lb.totalHours)}</td>
                  </tr>
                </tbody>
              </table>
              {/* Says where Production's number came from, so a figure that
                  moves when the line speed changes is not a surprise. */}
              <div
                style={{
                  padding: "0 14px 10px",
                  fontSize: 11.5,
                  color: "var(--ink-3, #7b7364)",
                }}
              >
                {st.prodHoursTotal === null
                  ? "Setup and cleaning default to 2 hours. Production is qty ÷ bottles per minute — type over it to override."
                  : "Production hours typed by hand; clear the field to go back to bottles per minute."}
              </div>
            </div>

            {/* ---- Line Crew ---- */}
            <div style={labSub}>
              <div style={labSubTitle}>Line Crew</div>
              <table style={labTable}>
                <thead>
                  <tr style={labHeadRow}>
                    <th style={{ ...labTh, textAlign: "left" }} />
                    {lb.phases.map((p) => (
                      <th key={p.label} style={{ ...labTh, width: 170 }}>
                        {p.label}
                      </th>
                    ))}
                    {/* Empty 170px column keeps these columns landing on the
                        same x-positions as the tables above and below. */}
                    <th style={{ ...labTh, width: 170 }} />
                  </tr>
                </thead>
                <tbody>
                  {(
                    [
                      {
                        label: "QTY of Line Leaders",
                        get: (p: (typeof lb.phases)[number]) => p.leaders,
                        keys: [
                          "setupLeaders",
                          "prodLeaders",
                          "cleaningLeaders",
                          "kittingLeaders",
                        ],
                      },
                      {
                        label: "QTY of Line Operators",
                        get: (p: (typeof lb.phases)[number]) => p.operators,
                        keys: [
                          "setupOperators",
                          "prodOperators",
                          "cleaningOperators",
                          "kittingOperators",
                        ],
                      },
                    ] as const
                  ).map((row) => (
                    <tr key={row.label} style={labBodyRow}>
                      <td style={{ ...labTh, textAlign: "left" }}>{row.label}</td>
                      {lb.phases.map((p, i) => (
                        <td key={p.label} style={labTd}>
                          <LabNum
                            value={row.get(p)}
                            onChange={(n) =>
                              set(
                                row.keys[i],
                                n === null ? null : Math.max(0, Math.round(n)),
                              )
                            }
                            step="1"
                          />
                        </td>
                      ))}
                      <td style={labTd} />
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* ---- Man Hours (computed) ---- */}
            <div style={labSub}>
              <div style={labSubTitle}>Man Hours</div>
              <table style={labTable}>
                <thead>
                  <tr style={labHeadRow}>
                    <th style={{ ...labTh, textAlign: "left" }} />
                    {lb.phases.map((p) => (
                      <th key={p.label} style={{ ...labTh, width: 170 }}>
                        {p.label}
                      </th>
                    ))}
                    <th style={{ ...labTh, width: 170 }}>Total</th>
                  </tr>
                </thead>
                <tbody>
                  {[
                    {
                      label: "Line Leaders Man Hours",
                      per: lb.phases.map((p) => p.leaderManHours),
                      total: lb.roles[0].manHours,
                    },
                    {
                      label: "Line Operators Man Hours",
                      per: lb.phases.map((p) => p.operatorManHours),
                      total: lb.roles[1].manHours,
                    },
                  ].map((row) => (
                    <tr key={row.label} style={labBodyRow}>
                      <td style={{ ...labTh, textAlign: "left" }}>{row.label}</td>
                      {row.per.map((v, i) => (
                        <td key={i} style={labTd}>
                          {labSum(v)}
                        </td>
                      ))}
                      <td style={labTd}>{labSum(row.total)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* ---- Pay Rates ---- */}
            <div style={labSub}>
              <div style={labSubTitle}>Pay Rates</div>
              <table style={labTable}>
                <thead>
                  <tr style={labHeadRow}>
                    <th style={{ ...labTh, textAlign: "left" }} />
                    <th style={{ ...labTh, width: 170 }}>Hourly Base Rate</th>
                    <th style={{ ...labTh, width: 170 }}>Payroll Tax %</th>
                    <th style={{ ...labTh, width: 170 }}>Workers&#39; Comp %</th>
                    <th style={{ ...labTh, width: 170 }}>Burdened Rate</th>
                  </tr>
                </thead>
                <tbody>
                  {(
                    [
                      {
                        role: lb.roles[0],
                        baseKey: "leaderRate",
                        taxKey: "leaderTaxPct",
                        wcKey: "leaderWcPct",
                      },
                      {
                        role: lb.roles[1],
                        baseKey: "operatorRate",
                        taxKey: "operatorTaxPct",
                        wcKey: "operatorWcPct",
                      },
                    ] as const
                  ).map(({ role, baseKey, taxKey, wcKey }) => (
                    <tr key={role.label} style={labBodyRow}>
                      <td style={{ ...labTh, textAlign: "left" }}>{role.label}</td>
                      <td style={labTd}>
                        <LabNum
                          value={role.base}
                          onChange={(n) => set(baseKey, n)}
                          step="0.01"
                          prefix="$"
                        />
                      </td>
                      <td style={labTd}>
                        <LabNum
                          value={role.taxPct}
                          onChange={(n) => set(taxKey, n)}
                          step="0.1"
                        />
                      </td>
                      <td style={labTd}>
                        <LabNum
                          value={role.wcPct}
                          onChange={(n) => set(wcKey, n)}
                          step="0.1"
                        />
                      </td>
                      <td style={labTd}>{labMoney(role.burdened, 2)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* ---- Job Labor Costs ---- */}
            <div style={labSub}>
              <div style={labSubTitle}>Job Labor Costs</div>
              <table style={labTable}>
                <thead>
                  <tr style={labHeadRow}>
                    <th style={{ ...labTh, textAlign: "left" }} />
                    <th style={{ ...labTh, width: 170 }}>Man Hours</th>
                    <th style={{ ...labTh, width: 170 }}>Burdened Rate</th>
                    <th style={{ ...labTh, width: 170 }}>Job Total</th>
                    <th style={{ ...labTh, width: 170 }}>Cost per Bottle</th>
                  </tr>
                </thead>
                <tbody>
                  {lb.roles.map((role) => (
                    <tr key={role.label} style={labBodyRow}>
                      <td style={{ ...labTh, textAlign: "left" }}>{role.label}</td>
                      <td style={labTd}>{labSum(role.manHours)}</td>
                      <td style={labTd}>{labMoney(role.burdened, 2)}</td>
                      <td style={labTd}>{labMoney(role.total, 2)}</td>
                      <td style={labTd}>
                        {qty && qty > 0
                          ? labMoney(role.total / qty, 4)
                          : labSum(null)}
                      </td>
                    </tr>
                  ))}
                  <tr style={labTotalRow}>
                    <td style={{ ...labTh, textAlign: "left" }}>Grand Total</td>
                    <td style={labTd} />
                    <td style={labTd} />
                    <td style={labTd}>{labMoney(lb.grandTotal, 2)}</td>
                    <td style={labTd}>
                      {lb.perUnit !== null
                        ? labMoney(lb.perUnit, 4)
                        : labSum(null)}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </>
        )}
        <CardTotal
          label="Direct labor / bottle"
          perUnit={r.laborPerUnit}
          quantity={qty}
        />
      </div>

      {/* ---------- Overhead ----------
          Three sub-cards, as on the gummy Costing tab: the lease, the indirect
          payroll, and everything else. Each row carries a share percentage —
          the fraction of that monthly cost this production line should bear —
          and the allocation spreads the charged total over the job's days.

          The plant figures come from lib/overheadCosting.ts. The rent AMOUNTS
          are shared with the gummy tab so a rise is edited once; the SHARES are
          not — this board reads OVERHEAD_RENT_DEFAULTS_BOTTLE, which charges
          Suite 300 (packaging) and zeroes Suite 400 (gummy manufacturing). The
          gummy tab does the opposite. Do not collapse the two back together. */}
      <div style={shell}>
        <div style={band}>Overhead Costs</div>

        {(
          [
            { title: "Lease Expenses", key: "overheadRent", mode: "lease" },
            { title: "Indirect Labor", key: "overheadIndirect", mode: "labor" },
            { title: "Other Expenses", key: "overheadOther", mode: undefined },
          ] as const
        ).map((g) => (
          <OverheadGroup
            key={g.title}
            title={g.title}
            mode={g.mode as OverheadGroupMode}
            list={st[g.key]}
            onChange={(next) => set(g.key, next)}
            jobDays={jobDays}
            workingDays={st.workingDaysPerMonth}
            quantity={qty}
          />
        ))}

        {/* ---- Job Allocation ---- */}
        <div style={labSub}>
          <div style={labSubTitle}>Job Allocation</div>
          <table style={labTable}>
            <thead>
              <tr style={labHeadRow}>
                <th style={{ ...labTh, textAlign: "left" }} />
                <th style={{ ...labTh, width: 170 }}>Charged / month</th>
                <th style={{ ...labTh, width: 170 }}>Working days</th>
                <th style={{ ...labTh, width: 170 }}>Job days</th>
                <th style={{ ...labTh, width: 170 }}>Job total</th>
              </tr>
            </thead>
            <tbody>
              <tr style={labBodyRow}>
                <td style={{ ...labTh, textAlign: "left" }}>Allocation</td>
                <td style={labTd}>{labMoney(overheadMonthlyCharged, 2)}</td>
                <td style={labTd}>
                  <LabNum
                    value={st.workingDaysPerMonth ?? DEFAULT_WORKING_DAYS_PER_MONTH}
                    onChange={(n) => set("workingDaysPerMonth", n)}
                    step="1"
                  />
                </td>
                {/* Job days is hours ÷ 8, left fractional — overhead is a
                    smooth spread, so rounding a 13-hour job up to two whole
                    days would overcharge it by half. */}
                <td style={labTd}>
                  {jobDays === null ? labSum(null) : labSum(jobDays, 2)}
                </td>
                <td style={labTd}>
                  {overheadJobTotal === null
                    ? labSum(null)
                    : labMoney(overheadJobTotal, 2)}
                </td>
              </tr>
            </tbody>
          </table>
          <div
            style={{
              padding: "0 14px 10px",
              fontSize: 11.5,
              color: "var(--ink-3, #7b7364)",
            }}
          >
            Lease shares are set for the bottling line: Suite 300 is offices
            and packaging, so it carries the job; Suite 400 is gummy
            manufacturing and sits at 0%. Suite 300 at 100% does include the
            office floor, and the indirect-labour and other-expense shares are
            still the gummy line&rsquo;s — treat those as a starting figure.
            {overheadMeta?.asOf ? (
              <>
                {" "}
                Figures are the plant rates in force on{" "}
                <strong>{overheadMeta.asOf}</strong> — the date this job is
                expected to run, not today — and step up on their own.
              </>
            ) : null}
            {overheadMeta?.leasePerRunDay ? (
              <div
                style={{
                  marginTop: 8,
                  padding: "8px 10px",
                  borderRadius: 6,
                  background: "var(--paper, #fffdf8)",
                  border: "1px solid var(--line, #e3dcc9)",
                }}
              >
                <strong>Lease is charged per run-day, not per calendar day.</strong>{" "}
                The rows above are the leases themselves; what this job actually
                absorbs is{" "}
                <strong>${overheadMeta.leasePerRunDay.toFixed(2)}</strong> for
                every day it occupies the packaging floor — $
                {overheadMeta.leaseFloorRate?.toFixed(2)} of packaging floor plus
                ${overheadMeta.leaseFacilityRate?.toFixed(2)} of warehouse and
                office. The floor runs{" "}
                {overheadMeta.runDaysPerMonth?.toFixed(1)} job-days a month with
                about three jobs in parallel, so dividing rent by 21 calendar
                days charged roughly three times too much.
              </div>
            ) : null}
            {overheadMeta?.attention?.length ? (
              <div
                style={{
                  marginTop: 8,
                  padding: "7px 10px",
                  borderRadius: 6,
                  background: "#fdf3e3",
                  border: "1px solid #e6d3ac",
                  color: "#7a5b18",
                }}
              >
                <strong>Wants a look:</strong>{" "}
                {overheadMeta.attention
                  .map((a) =>
                    a.status === "expired"
                      ? `${a.label} — lease band has lapsed, the rate shown is stale`
                      : a.daysLeft !== null && a.daysLeft <= 90
                        ? `${a.label} — term ends in ${a.daysLeft} days`
                        : `${a.label} — CAM is an estimate, not a billed figure`,
                  )
                  .join("; ")}
                .
              </div>
            ) : null}
          </div>
        </div>

        <CardTotal
          label="Overhead / bottle"
          perUnit={r.overheadPerUnit}
          quantity={qty}
        />
      </div>

      {/* ---------- Lab Testing ----------
          Its own card, as on the gummy Costing tab. Two lists because the two
          are triggered by different things: raw-material tests by lots
          arriving, finished-product tests by the job shipping.

          Seeded EMPTY. A default list would put invented dollars on a quote,
          and testing genuinely varies job to job. */}
      <div style={shell}>
        <div style={band}>Lab Testing</div>

        {(
          [
            { title: "Raw Materials", key: "labTestRm" },
            { title: "Finished Product", key: "labTestFp" },
          ] as const
        ).map((g) => (
          <LabTestGroup
            key={g.title}
            title={g.title}
            list={st[g.key]}
            onChange={(next) => set(g.key, next)}
            quantity={qty}
          />
        ))}

        <CardTotal
          label="Lab testing / bottle"
          perUnit={r.labTestingPerUnit}
          quantity={qty}
        />
      </div>

      {/* ---------- Costs ---------- */}
      <div style={shell}>
        <div style={band}>Costs</div>
        <div style={metricGrid}>
          <ParamBlock label="Material cost / bottle" nowrap>
            <ReadOnly>
              {r.materialsPerUnit !== null ? (
                <>
                  {money(r.materialsPerUnit)}
                  {pctOf(r.materialsPerUnit)}
                </>
              ) : (
                "—"
              )}
            </ReadOnly>
          </ParamBlock>
          <ParamBlock label="Direct labor / bottle" nowrap>
            <ReadOnly>
              {r.laborPerUnit !== null ? (
                <>
                  {money(r.laborPerUnit)}
                  {pctOf(r.laborPerUnit)}
                </>
              ) : (
                "—"
              )}
            </ReadOnly>
          </ParamBlock>
          <ParamBlock label="Overhead / bottle" nowrap>
            <ReadOnly>
              {r.overheadPerUnit !== null ? (
                <>
                  {money(r.overheadPerUnit)}
                  {pctOf(r.overheadPerUnit)}
                </>
              ) : (
                "—"
              )}
            </ReadOnly>
          </ParamBlock>
          <ParamBlock label="Lab testing / bottle" nowrap>
            <ReadOnly>
              {r.labTestingPerUnit !== null ? money(r.labTestingPerUnit) : "—"}
            </ReadOnly>
          </ParamBlock>
          <ParamBlock label="True Cost / bottle" nowrap>
            <ReadOnly>
              {r.costPerUnit !== null ? money(r.costPerUnit) : "—"}
            </ReadOnly>
          </ParamBlock>
          <ParamBlock label="Cost per Thousand" nowrap>
            <ReadOnly>
              {r.costPerUnit !== null ? money(r.costPerUnit * 1000, 2) : "—"}
            </ReadOnly>
          </ParamBlock>
          <ParamBlock label="Total Job Cost" nowrap>
            <ReadOnly>
              {r.totalCost !== null ? money(r.totalCost, 2) : "—"}
            </ReadOnly>
          </ParamBlock>
        </div>

        {/* Why the number is blank, stated plainly rather than left a mystery. */}
        {r.costPerUnit === null && (
          <div
            style={{
              margin: "0 14px 14px",
              padding: "10px 12px",
              borderRadius: 6,
              background: "#fdf3e0",
              border: "1px solid #e8cf9a",
              fontSize: 13,
              color: "#7a4f00",
            }}
          >
            <strong>Not costed yet.</strong>{" "}
            {r.issues.length > 0
              ? `${r.issues.length} component line${r.issues.length > 1 ? "s" : ""} still unresolved.`
              : "Enter bottles per minute and the overhead inputs."}{" "}
            A blank is deliberate — an unresolved input never silently becomes $0.
          </div>
        )}

      </div>

      {/* ---------- Margin & Price ----------
          For contract-packaging bottles this board IS the pricing
          calculator, so cost has to carry through to a price. Same margin
          convention as the main calculator, deliberately: two shops using
          two different definitions of "30%" is how quotes get mispriced. */}
      <div style={shell} className="bc-price">
        <div style={band}>Margin &amp; Price</div>
        <div style={metricGrid}>
          <ParamBlock label="Margin / markup %" nowrap>
            <NumField
              value={st.marginPct}
              onChange={(v) => set("marginPct", v)}
            />
          </ParamBlock>
          <ParamBlock label="Margin type" nowrap>
            <select
              value={st.marginMode}
              onChange={(e) => set("marginMode", e.target.value as MarginMode)}
              style={{
                padding: "7px 9px",
                border: "1px solid var(--line, #e3dcc9)",
                borderRadius: 6,
                fontSize: 14,
                background: "#fff",
                width: "100%",
              }}
            >
              <option value="gross-margin">Gross margin (% of price)</option>
              <option value="markup">Markup (% on cost)</option>
            </select>
          </ParamBlock>
          <ParamBlock label="HoS commission %" nowrap>
            <NumField
              value={st.hosCommissionPct}
              onChange={(v) => set("hosCommissionPct", v)}
            />
          </ParamBlock>
          <ParamBlock label="Sales rep commission %" nowrap>
            <NumField
              value={st.repCommissionPct}
              onChange={(v) => set("repCommissionPct", v)}
            />
          </ParamBlock>
        </div>
        <div style={metricGrid}>
          <ParamBlock label="Price / bottle" nowrap>
            <ReadOnly>
              {r.salePerUnit !== null ? money(r.salePerUnit) : "—"}
            </ReadOnly>
          </ParamBlock>
          <ParamBlock label="Price per Thousand" nowrap>
            <ReadOnly>
              {r.salePerUnit !== null ? money(r.salePerUnit * 1000, 2) : "—"}
            </ReadOnly>
          </ParamBlock>
          <ParamBlock label="Total Quote Value" nowrap>
            <ReadOnly>
              {r.totalRevenue !== null ? money(r.totalRevenue, 2) : "—"}
            </ReadOnly>
          </ParamBlock>
          <ParamBlock label="Commissions" nowrap>
            <ReadOnly>
              {r.hosCommission !== null && r.repCommission !== null
                ? money(r.hosCommission + r.repCommission, 2)
                : "—"}
            </ReadOnly>
          </ParamBlock>
          <ParamBlock label="Gross profit" nowrap>
            <ReadOnly>
              {r.grossProfit !== null ? money(r.grossProfit, 2) : "—"}
            </ReadOnly>
          </ParamBlock>
          <ParamBlock label="Realised margin" nowrap>
            <ReadOnly>
              {r.effectiveMarginPct !== null
                ? `${r.effectiveMarginPct.toFixed(1)}%`
                : "—"}
            </ReadOnly>
          </ParamBlock>
        </div>
      </div>

      {/* ---------- Action bar ----------
          Mirrors the pricing calculator's bar, because for this workflow
          type this page fills that role. */}
      <div
        className="bc-actions"
        style={{
          display: "flex",
          justifyContent: "flex-end",
          gap: 8,
          alignItems: "center",
          padding: "2px 0",
        }}
      >
        {savedAt && (
          <span style={{ fontSize: 12.5, opacity: 0.7, marginRight: "auto" }}>
            Saved {savedAt}
          </span>
        )}
        <button
          type="button"
          onClick={() => window.print()}
          title='Open the browser print dialog. Choose "Save as PDF" for a copy of this costing.'
          style={{
            background: "#fff",
            color: "#0f172a",
            border: "1px solid #cbd5e1",
            padding: "8px 14px",
            borderRadius: 8,
            fontSize: 14,
            fontWeight: 500,
            cursor: "pointer",
          }}
        >
          Print / Save PDF
        </button>
        <button
          type="button"
          onClick={() => {
            // Destructive, so confirm. Master-box qty is re-seeded from the
            // spec rather than blanked — it is a fact about the job, not a
            // typed assumption, so wiping it would just make work.
            if (
              !window.confirm(
                "Reset this costing to defaults? Every component pick and typed input will be cleared.",
              )
            )
              return;
            const perBox = Number(spec?.masterBoxQty ?? "");
            setSt(
              blankState(
                Number.isFinite(perBox) && perBox > 0 ? perBox : null,
                spec,
              ),
            );
          }}
          title="Clear all picks and inputs and restore default rates."
          style={{
            background: "#fffdf8",
            color: "#8b2f2f",
            border: "1px solid #d8b3b3",
            padding: "8px 14px",
            borderRadius: 8,
            fontSize: 14,
            fontWeight: 500,
            cursor: "pointer",
          }}
        >
          Reset
        </button>
        <button
          type="button"
          onClick={issueQuote}
          title="Generate a customer-facing quote (PDF) at the price above."
          style={{
            background: "var(--teal-700, #1d6c7b)",
            color: "#fff",
            border: "1px solid var(--teal-900, #0f4a56)",
            padding: "8px 14px",
            borderRadius: 8,
            fontSize: 14,
            fontWeight: 600,
            cursor: "pointer",
          }}
        >
          Issue a Quote
        </button>
        <button
          type="button"
          onClick={save}
          disabled={saving}
          style={{
            padding: "8px 18px",
            borderRadius: 8,
            border: "none",
            background: "var(--teal-900, #0f4a56)",
            color: "#fff",
            fontWeight: 700,
            fontSize: 14,
            cursor: saving ? "default" : "pointer",
            opacity: saving ? 0.6 : 1,
          }}
        >
          {saving ? "Saving…" : "Save"}
        </button>
      </div>

      <div style={{ fontSize: 12, opacity: 0.6, textAlign: "right" }}>
        {quoteNumber} · {customerName} · {productName}
      </div>

      {/* Print: drop the app chrome and the buttons, keep the numbers. */}
      <style>{PRINT_CSS}</style>
    </div>
  );
}

function PhaseLabel({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        fontSize: 12.5,
        fontWeight: 700,
        textTransform: "uppercase",
        letterSpacing: "0.04em",
        color: "var(--teal-700, #1d6c7b)",
        paddingTop: 10,
      }}
    >
      {children}
    </div>
  );
}
