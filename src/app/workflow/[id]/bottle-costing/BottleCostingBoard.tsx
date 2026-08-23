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
  DEFAULT_HOURS_PER_DAY,
  DEFAULT_SETUP_DAYS,
  DEFAULT_WORKING_DAYS_PER_MONTH,
  DEFAULT_MARGIN_PCT,
  DEFAULT_HOS_COMMISSION_PCT,
  DEFAULT_REP_COMMISSION_PCT,
  DEFAULT_COST_SOURCE,
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
  bottlesPerMinute: number | null;
  bottlesPerMasterBox: number | null;
  setupDays: number | null;
  setupHours: number | null;
  setupLeaders: number | null;
  setupOperators: number | null;
  prodLeaders: number | null;
  prodOperators: number | null;
  cleaningDays: number | null;
  cleaningHours: number | null;
  cleaningLeaders: number | null;
  cleaningOperators: number | null;
  leaderRate: number | null;
  operatorRate: number | null;
  overheadMonthly: number | null;
  overheadSharePct: number | null;
  workingDaysPerMonth: number | null;
  labTestingTotal: number | null;

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
      // A master box is shared across the bottles inside it.
      qtyPerUnit:
        s.slot === "master_box"
          ? bottlesPerMasterBox && bottlesPerMasterBox > 0
            ? 1 / bottlesPerMasterBox
            : null
          : 1,
      costPerUnit: null,
      costStatus: "no_cost",
      suppliedBy: suppliedByFromSpec(s.slot, spec ?? null),
      costSource: DEFAULT_COST_SOURCE,
      manualCostPerUnit: null,
      inventoryCostPerUnit: null,
      lastOrderCostPerUnit: null,
    })),
    bottlesPerMinute: null,
    bottlesPerMasterBox,
    setupDays: DEFAULT_SETUP_DAYS,
    setupHours: DEFAULT_HOURS_PER_DAY,
    setupLeaders: 1,
    setupOperators: 2,
    prodLeaders: 1,
    prodOperators: 3,
    cleaningDays: null,
    cleaningHours: DEFAULT_HOURS_PER_DAY,
    cleaningLeaders: 0,
    cleaningOperators: 2,
    leaderRate: DEFAULT_LEADER_RATE,
    operatorRate: DEFAULT_OPERATOR_RATE,
    overheadMonthly: null,
    overheadSharePct: null,
    workingDaysPerMonth: DEFAULT_WORKING_DAYS_PER_MONTH,
    labTestingTotal: null,
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
}: {
  slot: PackagingSlot;
  current: BomLine;
  spec: Record<string, string> | null;
  onPick: (opt: ComponentOption | null) => void;
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
          color: current.fpCode
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
              style={{ ...numInput, textAlign: "left", fontWeight: 500 }}
            />
          </div>
          {current.fpCode && (
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
      })),
    };
  });
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [addSlot, setAddSlot] = useState<PackagingSlot>("other");

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
          qtyPerUnit: 1,
          costPerUnit: null,
          costStatus: "no_cost",
          suppliedBy: suppliedByFromSpec(slot, spec),
          costSource: DEFAULT_COST_SOURCE,
          manualCostPerUnit: null,
          inventoryCostPerUnit: null,
          lastOrderCostPerUnit: null,
        },
      ],
    }));
  };

  const removeLine = (id: string) =>
    setSt((p) => ({ ...p, bom: p.bom.filter((l) => l.id !== id) }));

  // Master box qty is derived, so keep it in step with bottles-per-box.
  useEffect(() => {
    const n = st.bottlesPerMasterBox;
    setSt((p) => ({
      ...p,
      bom: p.bom.map((l) =>
        l.slot === "master_box"
          ? { ...l, qtyPerUnit: n && n > 0 ? 1 / n : null }
          : l,
      ),
    }));
  }, [st.bottlesPerMasterBox]);

  const inputs: BottleCostingInputs = useMemo(
    () => ({
      quantity,
      bom: st.bom,
      labor: {
        bottlesPerMinute: st.bottlesPerMinute,
        setup: {
          days: st.setupDays,
          hoursPerDay: st.setupHours,
          leaders: st.setupLeaders,
          operators: st.setupOperators,
        },
        production: { leaders: st.prodLeaders, operators: st.prodOperators },
        cleaning: {
          days: st.cleaningDays,
          hoursPerDay: st.cleaningHours,
          leaders: st.cleaningLeaders,
          operators: st.cleaningOperators,
        },
        leaderRate: st.leaderRate,
        operatorRate: st.operatorRate,
      },
      overhead: {
        rentLease:
          st.overheadMonthly && st.overheadMonthly > 0
            ? [
                {
                  id: "oh",
                  label: "Facility overhead",
                  monthly: st.overheadMonthly,
                  sharePct: st.overheadSharePct,
                },
              ]
            : [],
        indirectLabor: [],
        other: [],
        workingDaysPerMonth: st.workingDaysPerMonth,
      },
      labTestingTotal: st.labTestingTotal,
      pricing: {
        marginPct: st.marginPct,
        marginMode: st.marginMode,
        hosCommissionPct: st.hosCommissionPct,
        repCommissionPct: st.repCommissionPct,
      },
    }),
    [st, quantity],
  );

  const r = useMemo(() => computeBottleCosting(inputs), [inputs]);

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
        quantity: quantity ?? 0,
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
  }, [r, productName, quantity, workflowId, customerName, quoteNumber]);

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
          <ParamBlock label="QTY (Bottles)" nowrap>
            <ReadOnly>
              {quantity ? quantity.toLocaleString("en-US") : "—"}
            </ReadOnly>
          </ParamBlock>
          <ParamBlock label="Bottles / minute" nowrap>
            <NumField
              value={st.bottlesPerMinute}
              onChange={(v) => set("bottlesPerMinute", v)}
              placeholder="required"
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
          <ParamBlock label="Bottles / master box" nowrap>
            <NumField
              value={st.bottlesPerMasterBox}
              onChange={(v) => set("bottlesPerMasterBox", v)}
            />
          </ParamBlock>
          <ParamBlock label="Master boxes" nowrap>
            <ReadOnly>
              {quantity && st.bottlesPerMasterBox
                ? Math.ceil(quantity / st.bottlesPerMasterBox).toLocaleString(
                    "en-US",
                  )
                : "—"}
            </ReadOnly>
          </ParamBlock>
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
                        {line.slot !== "master_box" && "1 per"}
                        <input
                          type="number"
                          min={1}
                          step="1"
                          placeholder="?"
                          value={
                            line.qtyPerUnit !== null && line.qtyPerUnit > 0
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
                              set("bottlesPerMasterBox", per);
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
                          ? "bottles per box"
                          : "bottles"}
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
      </div>

      {/* ---------- Line crew ---------- */}
      <div style={shell}>
        <div style={band}>Line Crew &amp; Labor</div>
        <div style={{ padding: 14, display: "grid", gap: 14 }}>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "130px repeat(4, 1fr)",
              gap: 10,
              alignItems: "end",
            }}
          >
            <div />
            <ParamBlock label="Days" nowrap>
              <span />
            </ParamBlock>
            <ParamBlock label="Hours / day" nowrap>
              <span />
            </ParamBlock>
            <ParamBlock label="Leaders" nowrap>
              <span />
            </ParamBlock>
            <ParamBlock label="Operators" nowrap>
              <span />
            </ParamBlock>

            <PhaseLabel>Setup</PhaseLabel>
            <NumField value={st.setupDays} onChange={(v) => set("setupDays", v)} />
            <NumField
              value={st.setupHours}
              onChange={(v) => set("setupHours", v)}
            />
            <NumField
              value={st.setupLeaders}
              onChange={(v) => set("setupLeaders", v)}
            />
            <NumField
              value={st.setupOperators}
              onChange={(v) => set("setupOperators", v)}
            />

            <PhaseLabel>Production</PhaseLabel>
            <div style={{ paddingTop: 8 }}>
              <ReadOnly>
                {r.productionHours !== null
                  ? `${r.productionHours.toFixed(2)} h`
                  : "—"}
              </ReadOnly>
            </div>
            <div style={{ paddingTop: 8, fontSize: 12, opacity: 0.7 }}>
              from bottles / minute
            </div>
            <NumField
              value={st.prodLeaders}
              onChange={(v) => set("prodLeaders", v)}
            />
            <NumField
              value={st.prodOperators}
              onChange={(v) => set("prodOperators", v)}
            />

            <PhaseLabel>Cleaning</PhaseLabel>
            <NumField
              value={st.cleaningDays}
              onChange={(v) => set("cleaningDays", v)}
              placeholder="auto"
            />
            <NumField
              value={st.cleaningHours}
              onChange={(v) => set("cleaningHours", v)}
            />
            <NumField
              value={st.cleaningLeaders}
              onChange={(v) => set("cleaningLeaders", v)}
            />
            <NumField
              value={st.cleaningOperators}
              onChange={(v) => set("cleaningOperators", v)}
            />
          </div>

          <div style={metricGrid}>
            <ParamBlock label="Leader rate ($/hr)" nowrap>
              <NumField
                value={st.leaderRate}
                onChange={(v) => set("leaderRate", v)}
              />
            </ParamBlock>
            <ParamBlock label="Operator rate ($/hr)" nowrap>
              <NumField
                value={st.operatorRate}
                onChange={(v) => set("operatorRate", v)}
              />
            </ParamBlock>
            <ParamBlock label="Burden" nowrap>
              <ReadOnly>8.5% tax + 4% WC</ReadOnly>
            </ParamBlock>
          </div>
        </div>
      </div>

      {/* ---------- Overhead ---------- */}
      <div style={shell}>
        <div style={band}>Overhead &amp; Testing</div>
        <div style={metricGrid}>
          <ParamBlock label="Facility overhead / month" nowrap>
            <NumField
              value={st.overheadMonthly}
              onChange={(v) => set("overheadMonthly", v)}
            />
          </ParamBlock>
          <ParamBlock label="Share for this job (%)" nowrap>
            <NumField
              value={st.overheadSharePct}
              onChange={(v) => set("overheadSharePct", v)}
            />
          </ParamBlock>
          <ParamBlock label="Working days / month" nowrap>
            <NumField
              value={st.workingDaysPerMonth}
              onChange={(v) => set("workingDaysPerMonth", v)}
            />
          </ParamBlock>
          <ParamBlock label="Lab testing (job total)" nowrap>
            <NumField
              value={st.labTestingTotal}
              onChange={(v) => set("labTestingTotal", v)}
            />
          </ParamBlock>
        </div>
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
