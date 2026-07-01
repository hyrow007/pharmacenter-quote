"use client";

// Gummy-formula calculator (client island).
//
// Per-ingredient per-gummy cost math:
//   cost_per_gummy_line
//     = (cost_per_kg / 1000)          // dollars per gram
//       * piece_g                     // grams in a finished piece
//       * (pctInFinished / 100)       // ingredient share of the finished blend
//       * solids                      // fraction of the added weight that's raw material
//       * (yieldPct / 100)            // process yield BEFORE the daily fixed loss
//
// Total ingredient cost per gummy = sum of the lines.
//
// The 20 kg/day fixed material loss is applied as a scaler on top of the total:
//   total_kg_per_day = batchesPerDay * batchKg
//   effective_yield  = (total_kg_per_day - fixedLossKgPerDay) / total_kg_per_day
//   effective_cost_per_gummy = cost_per_gummy / effective_yield
//
// State is persisted to the workflow row's JSONB state.gummyFormula via PUT
// /api/workflows/:id — same endpoint the pricing calculator saves through.

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type {
  GummyFormula,
  GummyFormulaRow,
} from "@/lib/workflows";

// Payload the server page builds from the raw_materials table. We only need
// the fields the picker + defaults reader consume.
export type RawMaterialOption = {
  id: string;
  fp_code: string | null;
  name: string;
  default_unit: string | null;
  default_cost_per_kg: number | null;
  default_solids: number | null;
  category: "primary" | "secondary" | "final" | "other" | null;
  active: boolean;
};

type Props = {
  workflowId: string;
  catalogue: RawMaterialOption[];
  initialFormula: GummyFormula | null;
  preparerEmail: string;
};

// Default batch parameters straight from the NB-26 formula sheet.
const DEFAULTS: Omit<GummyFormula, "rows" | "savedAt" | "savedByEmail"> = {
  batchKg: 100,
  batchesPerDay: 6,
  fixedLossKgPerDay: 20,
  gummyPieceWeightG: 3.0,
  yieldPct: 100,
};

// Presets used in the row's solids dropdown when overriding. Matches the
// admin/raw-materials board so admins and formula authors speak the same
// language.
const SOLIDS_PRESETS: { value: number; label: string }[] = [
  { value: 1.0, label: "1.00 (neat)" },
  { value: 0.8, label: "0.80 (80% syrup)" },
  { value: 0.5, label: "0.50 (50/50 sol.)" },
  { value: 0.25, label: "0.25 (25% sol.)" },
];

function newRowId(): string {
  return `row_${Math.random().toString(36).slice(2, 10)}`;
}

function emptyRow(): GummyFormulaRow {
  return {
    id: newRowId(),
    rawMaterialId: null,
    customName: null,
    pctInFinished: 0,
    costPerKgOverride: null,
    solidsOverride: null,
    notes: null,
  };
}

function formatMoney(n: number, digits = 4): string {
  if (!Number.isFinite(n)) return "—";
  return `$${n.toFixed(digits)}`;
}

function formatPct(fraction: number): string {
  if (!Number.isFinite(fraction)) return "—";
  return `${(fraction * 100).toFixed(2)}%`;
}

// Look up a raw material by id (null-tolerant).
function findRm(catalogue: RawMaterialOption[], id: string | null): RawMaterialOption | null {
  if (!id) return null;
  return catalogue.find((r) => r.id === id) ?? null;
}

export default function GummyFormulaBoard({
  workflowId,
  catalogue,
  initialFormula,
  preparerEmail,
}: Props) {
  const router = useRouter();

  // -- Batch params (top card) ------------------------------------------------
  const [batchKg, setBatchKg] = useState<number>(
    initialFormula?.batchKg ?? DEFAULTS.batchKg,
  );
  const [batchesPerDay, setBatchesPerDay] = useState<number>(
    initialFormula?.batchesPerDay ?? DEFAULTS.batchesPerDay,
  );
  const [fixedLossKgPerDay, setFixedLossKgPerDay] = useState<number>(
    initialFormula?.fixedLossKgPerDay ?? DEFAULTS.fixedLossKgPerDay,
  );
  const [gummyPieceWeightG, setGummyPieceWeightG] = useState<number>(
    initialFormula?.gummyPieceWeightG ?? DEFAULTS.gummyPieceWeightG,
  );
  const [yieldPct, setYieldPct] = useState<number>(
    initialFormula?.yieldPct ?? DEFAULTS.yieldPct,
  );

  // -- Rows -------------------------------------------------------------------
  const [rows, setRows] = useState<GummyFormulaRow[]>(
    initialFormula?.rows && initialFormula.rows.length > 0
      ? initialFormula.rows
      : [emptyRow()],
  );

  // -- Save state -------------------------------------------------------------
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const showToast = (msg: string, ms = 4500) => {
    setToast(msg);
    window.setTimeout(() => setToast((t) => (t === msg ? null : t)), ms);
  };

  // -- Derived math -----------------------------------------------------------
  const lineResults = useMemo(() => {
    return rows.map((r) => {
      const rm = findRm(catalogue, r.rawMaterialId);
      const cost = r.costPerKgOverride ?? rm?.default_cost_per_kg ?? 0;
      const solids = r.solidsOverride ?? rm?.default_solids ?? 1;
      const pct = Number.isFinite(r.pctInFinished) ? r.pctInFinished : 0;
      const gPerGummy = gummyPieceWeightG * (pct / 100) * (yieldPct / 100);
      // Only the raw-material portion of what's added counts as cost. The
      // water/carrier part (1 - solids) is free.
      const dollarsPerGummy = (cost / 1000) * gPerGummy * solids;
      return {
        rm,
        cost,
        solids,
        gPerGummy,
        dollarsPerGummy,
      };
    });
  }, [rows, catalogue, gummyPieceWeightG, yieldPct]);

  const totalCostPerGummy = useMemo(
    () => lineResults.reduce((s, r) => s + r.dollarsPerGummy, 0),
    [lineResults],
  );

  const totalPct = useMemo(
    () => rows.reduce((s, r) => s + (Number.isFinite(r.pctInFinished) ? r.pctInFinished : 0), 0),
    [rows],
  );

  const totalKgPerDay = batchKg * batchesPerDay;
  const effectiveYield =
    totalKgPerDay > 0 ? Math.max(0, (totalKgPerDay - fixedLossKgPerDay) / totalKgPerDay) : 0;
  const effectiveCostPerGummy =
    effectiveYield > 0 ? totalCostPerGummy / effectiveYield : Infinity;

  // Rough per-batch / per-day sanity numbers.
  const gummiesPerBatch =
    gummyPieceWeightG > 0 ? (batchKg * 1000 * (yieldPct / 100)) / gummyPieceWeightG : 0;
  const gummiesPerDay = gummiesPerBatch * batchesPerDay * effectiveYield;
  const dollarsPerBatch = gummiesPerBatch * totalCostPerGummy;
  const dollarsPerDay = gummiesPerDay * effectiveCostPerGummy;

  // -- Row mutators -----------------------------------------------------------
  const updateRow = (id: string, patch: Partial<GummyFormulaRow>) => {
    setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  };
  const addRow = () => setRows((rs) => [...rs, emptyRow()]);
  const removeRow = (id: string) => {
    setRows((rs) => (rs.length <= 1 ? rs : rs.filter((r) => r.id !== id)));
  };

  // -- Save -------------------------------------------------------------------
  const onSave = async () => {
    if (saving) return;
    setSaving(true);
    try {
      const formula: GummyFormula = {
        batchKg,
        batchesPerDay,
        fixedLossKgPerDay,
        gummyPieceWeightG,
        yieldPct,
        rows,
        savedAt: new Date().toISOString(),
        savedByEmail: preparerEmail,
      };
      // The workflow API accepts partial state via body.state. We fetch the
      // current state, merge in gummyFormula, and PUT the merged state so we
      // don't clobber pricing / issuedQuotes / etc.
      const getRes = await fetch(`/api/workflows/${workflowId}`, {
        method: "GET",
      });
      const getData = await getRes.json();
      const currentState = getData?.workflow?.state ?? {};
      const patched = { ...currentState, gummyFormula: formula };

      const res = await fetch(`/api/workflows/${workflowId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ state: patched }),
      });
      const data = await res.json();
      if (!res.ok || !data?.ok) {
        showToast(`Save failed: ${data?.error || res.status}`, 6500);
        return;
      }
      showToast("Formula saved.");
      router.refresh();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      showToast(`Save errored: ${msg}`, 6500);
    } finally {
      setSaving(false);
    }
  };

  // -- Presentation helpers ---------------------------------------------------
  const cardStyle = {
    background: "var(--paper, #fffdf8)",
    border: "1px solid var(--line, #e3dcc9)",
    borderRadius: 12,
    padding: 18,
    marginBottom: 18,
  } as const;

  const labelStyle = {
    display: "block",
    fontSize: 11,
    fontWeight: 700,
    letterSpacing: "0.06em",
    textTransform: "uppercase" as const,
    color: "var(--ink-3, #8a9498)",
    marginBottom: 4,
  };

  const inputStyle = {
    width: "100%",
    padding: "8px 10px",
    border: "1px solid var(--line, #e3dcc9)",
    borderRadius: 8,
    fontSize: 14,
    fontFamily: "inherit",
    background: "#fff",
  } as const;

  const summaryTileStyle = {
    background: "#fff",
    border: "1px solid var(--line, #e3dcc9)",
    borderRadius: 10,
    padding: "12px 14px",
    flex: "1 1 160px",
    minWidth: 140,
  } as const;

  const bigNumberStyle = {
    fontSize: 22,
    fontWeight: 700,
    color: "var(--teal-900, #0f4a56)",
    lineHeight: 1.1,
    marginTop: 4,
  } as const;

  // Sort the catalogue by category first, then name — makes the picker feel
  // like the admin table.
  const groupedCatalogue = useMemo(() => {
    const bins: Record<string, RawMaterialOption[]> = {
      primary: [],
      secondary: [],
      final: [],
      other: [],
      "": [],
    };
    for (const r of catalogue) {
      const key = r.category ?? "";
      (bins[key] ?? bins[""]).push(r);
    }
    for (const k of Object.keys(bins)) bins[k].sort((a, b) => a.name.localeCompare(b.name));
    return bins;
  }, [catalogue]);

  return (
    <div>
      {/* ---------------- Batch parameters ---------------- */}
      <div style={cardStyle}>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 14, marginBottom: 10 }}>
          <div style={{ flex: "1 1 130px", minWidth: 120 }}>
            <label style={labelStyle}>Batch size (kg)</label>
            <input
              style={inputStyle}
              type="number"
              step="0.1"
              min={0}
              value={batchKg}
              onChange={(e) => setBatchKg(Number(e.target.value))}
            />
          </div>
          <div style={{ flex: "1 1 130px", minWidth: 120 }}>
            <label style={labelStyle}>Batches / day</label>
            <input
              style={inputStyle}
              type="number"
              step="1"
              min={0}
              value={batchesPerDay}
              onChange={(e) => setBatchesPerDay(Number(e.target.value))}
            />
          </div>
          <div style={{ flex: "1 1 130px", minWidth: 120 }}>
            <label style={labelStyle}>Fixed loss (kg/day)</label>
            <input
              style={inputStyle}
              type="number"
              step="0.1"
              min={0}
              value={fixedLossKgPerDay}
              onChange={(e) => setFixedLossKgPerDay(Number(e.target.value))}
            />
          </div>
          <div style={{ flex: "1 1 130px", minWidth: 120 }}>
            <label style={labelStyle}>Gummy weight (g)</label>
            <input
              style={inputStyle}
              type="number"
              step="0.1"
              min={0}
              value={gummyPieceWeightG}
              onChange={(e) => setGummyPieceWeightG(Number(e.target.value))}
            />
          </div>
          <div style={{ flex: "1 1 130px", minWidth: 120 }}>
            <label style={labelStyle}>Yield % (pre-loss)</label>
            <input
              style={inputStyle}
              type="number"
              step="1"
              min={0}
              max={100}
              value={yieldPct}
              onChange={(e) => setYieldPct(Number(e.target.value))}
            />
          </div>
        </div>
        <p style={{ margin: 0, fontSize: 12, color: "var(--ink-3, #8a9498)" }}>
          Effective yield after {fixedLossKgPerDay} kg/day fixed loss:{" "}
          <strong style={{ color: "var(--teal-900, #0f4a56)" }}>
            {formatPct(effectiveYield)}
          </strong>{" "}
          (across {batchesPerDay} × {batchKg} kg = {totalKgPerDay} kg/day).
        </p>
      </div>

      {/* ---------------- Ingredient table ---------------- */}
      <div style={cardStyle}>
        <div style={{ display: "flex", alignItems: "center", marginBottom: 10 }}>
          <strong style={{ fontSize: 15, color: "var(--teal-900, #0f4a56)" }}>
            Ingredients ({rows.length})
          </strong>
          <span style={{ marginLeft: "auto", fontSize: 12, color: "var(--ink-3, #8a9498)" }}>
            % in finished total:{" "}
            <strong
              style={{
                color:
                  Math.abs(totalPct - 100) < 0.5
                    ? "var(--teal-900, #0f4a56)"
                    : "#b8560c",
              }}
            >
              {totalPct.toFixed(2)}%
            </strong>
          </span>
        </div>

        <div style={{ overflowX: "auto" }}>
          <table
            style={{
              width: "100%",
              borderCollapse: "collapse",
              fontSize: 13,
              minWidth: 900,
            }}
          >
            <thead>
              <tr style={{ background: "#f5efe0", color: "var(--ink-3, #8a9498)" }}>
                <th style={{ padding: "8px 8px", textAlign: "left", fontWeight: 700 }}>Ingredient</th>
                <th style={{ padding: "8px 6px", textAlign: "right", fontWeight: 700 }}>% in finished</th>
                <th style={{ padding: "8px 6px", textAlign: "right", fontWeight: 700 }}>Cost / kg</th>
                <th style={{ padding: "8px 6px", textAlign: "right", fontWeight: 700 }}>Solids</th>
                <th style={{ padding: "8px 6px", textAlign: "right", fontWeight: 700 }}>g / gummy</th>
                <th style={{ padding: "8px 6px", textAlign: "right", fontWeight: 700 }}>$/gummy</th>
                <th style={{ padding: "8px 6px", width: 40 }}></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, idx) => {
                const line = lineResults[idx];
                const rm = line.rm;
                return (
                  <tr key={r.id} style={{ borderBottom: "1px solid var(--line, #e3dcc9)" }}>
                    <td style={{ padding: "6px 8px" }}>
                      <select
                        value={r.rawMaterialId ?? ""}
                        onChange={(e) =>
                          updateRow(r.id, {
                            rawMaterialId: e.target.value || null,
                            // Reset overrides so we pick up the new raw
                            // material's defaults on first look.
                            costPerKgOverride: null,
                            solidsOverride: null,
                            customName: null,
                          })
                        }
                        style={{
                          ...inputStyle,
                          padding: "5px 6px",
                          fontSize: 13,
                          minWidth: 200,
                        }}
                      >
                        <option value="">— pick raw material —</option>
                        {(["primary", "secondary", "final", "other", ""] as const).map((cat) => {
                          const list = groupedCatalogue[cat] ?? [];
                          if (list.length === 0) return null;
                          const label =
                            cat === ""
                              ? "Uncategorised"
                              : cat.charAt(0).toUpperCase() + cat.slice(1);
                          return (
                            <optgroup key={cat || "none"} label={label}>
                              {list.map((opt) => (
                                <option key={opt.id} value={opt.id}>
                                  {opt.name}
                                  {opt.fp_code ? ` (${opt.fp_code})` : ""}
                                </option>
                              ))}
                            </optgroup>
                          );
                        })}
                      </select>
                    </td>
                    <td style={{ padding: "6px 6px", textAlign: "right" }}>
                      <input
                        style={{
                          ...inputStyle,
                          textAlign: "right",
                          padding: "5px 6px",
                          fontSize: 13,
                          width: 90,
                        }}
                        type="number"
                        step="0.01"
                        min={0}
                        value={r.pctInFinished}
                        onChange={(e) =>
                          updateRow(r.id, { pctInFinished: Number(e.target.value) })
                        }
                      />
                    </td>
                    <td style={{ padding: "6px 6px", textAlign: "right" }}>
                      <input
                        style={{
                          ...inputStyle,
                          textAlign: "right",
                          padding: "5px 6px",
                          fontSize: 13,
                          width: 100,
                          background:
                            r.costPerKgOverride === null ? "#fbf7ec" : "#fff",
                        }}
                        type="number"
                        step="0.01"
                        min={0}
                        placeholder={
                          rm?.default_cost_per_kg != null
                            ? String(rm.default_cost_per_kg)
                            : "0.00"
                        }
                        value={r.costPerKgOverride ?? ""}
                        onChange={(e) =>
                          updateRow(r.id, {
                            costPerKgOverride:
                              e.target.value === "" ? null : Number(e.target.value),
                          })
                        }
                      />
                    </td>
                    <td style={{ padding: "6px 6px", textAlign: "right" }}>
                      <select
                        value={
                          r.solidsOverride === null ? "" : String(r.solidsOverride)
                        }
                        onChange={(e) =>
                          updateRow(r.id, {
                            solidsOverride:
                              e.target.value === "" ? null : Number(e.target.value),
                          })
                        }
                        style={{
                          ...inputStyle,
                          padding: "5px 6px",
                          fontSize: 13,
                          minWidth: 130,
                          background:
                            r.solidsOverride === null ? "#fbf7ec" : "#fff",
                        }}
                      >
                        <option value="">
                          default{" "}
                          {rm?.default_solids != null
                            ? `(${rm.default_solids.toFixed(2)})`
                            : "(1.00)"}
                        </option>
                        {SOLIDS_PRESETS.map((p) => (
                          <option key={p.value} value={p.value}>
                            {p.label}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td
                      style={{
                        padding: "6px 6px",
                        textAlign: "right",
                        fontVariantNumeric: "tabular-nums",
                      }}
                    >
                      {line.gPerGummy.toFixed(4)}
                    </td>
                    <td
                      style={{
                        padding: "6px 6px",
                        textAlign: "right",
                        fontVariantNumeric: "tabular-nums",
                        fontWeight: 600,
                        color: "var(--teal-900, #0f4a56)",
                      }}
                    >
                      {formatMoney(line.dollarsPerGummy)}
                    </td>
                    <td style={{ padding: "6px 6px", textAlign: "center" }}>
                      <button
                        type="button"
                        onClick={() => removeRow(r.id)}
                        disabled={rows.length <= 1}
                        aria-label="Remove ingredient"
                        style={{
                          border: "none",
                          background: "transparent",
                          fontSize: 18,
                          color: rows.length <= 1 ? "#c8c8c8" : "#8b2f2f",
                          cursor: rows.length <= 1 ? "not-allowed" : "pointer",
                        }}
                        title={
                          rows.length <= 1
                            ? "Keep at least one ingredient"
                            : "Remove this ingredient"
                        }
                      >
                        &times;
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <button
          type="button"
          onClick={addRow}
          style={{
            marginTop: 12,
            padding: "8px 14px",
            border: "1px dashed var(--line, #e3dcc9)",
            borderRadius: 8,
            background: "#fffdf8",
            color: "var(--teal-900, #0f4a56)",
            fontFamily: "inherit",
            fontSize: 13,
            fontWeight: 600,
            cursor: "pointer",
          }}
        >
          + Add ingredient
        </button>
      </div>

      {/* ---------------- Results ---------------- */}
      <div style={cardStyle}>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
          <div style={summaryTileStyle}>
            <div style={{ fontSize: 11, color: "var(--ink-3, #8a9498)" }}>Cost / gummy (ideal)</div>
            <div style={bigNumberStyle}>{formatMoney(totalCostPerGummy)}</div>
            <div style={{ fontSize: 11, color: "var(--ink-3, #8a9498)", marginTop: 2 }}>
              Sum of ingredient lines.
            </div>
          </div>
          <div style={summaryTileStyle}>
            <div style={{ fontSize: 11, color: "var(--ink-3, #8a9498)" }}>Effective cost / gummy</div>
            <div style={bigNumberStyle}>{formatMoney(effectiveCostPerGummy)}</div>
            <div style={{ fontSize: 11, color: "var(--ink-3, #8a9498)", marginTop: 2 }}>
              After {formatPct(1 - effectiveYield)} daily loss.
            </div>
          </div>
          <div style={summaryTileStyle}>
            <div style={{ fontSize: 11, color: "var(--ink-3, #8a9498)" }}>Gummies / batch</div>
            <div style={bigNumberStyle}>
              {Math.round(gummiesPerBatch).toLocaleString("en-US")}
            </div>
            <div style={{ fontSize: 11, color: "var(--ink-3, #8a9498)", marginTop: 2 }}>
              ${dollarsPerBatch.toFixed(2)} in ingredients.
            </div>
          </div>
          <div style={summaryTileStyle}>
            <div style={{ fontSize: 11, color: "var(--ink-3, #8a9498)" }}>Gummies / day</div>
            <div style={bigNumberStyle}>
              {Math.round(gummiesPerDay).toLocaleString("en-US")}
            </div>
            <div style={{ fontSize: 11, color: "var(--ink-3, #8a9498)", marginTop: 2 }}>
              ${dollarsPerDay.toFixed(2)} in ingredients.
            </div>
          </div>
        </div>
      </div>

      {/* ---------------- Save ---------------- */}
      <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
        <button
          type="button"
          onClick={onSave}
          disabled={saving}
          style={{
            padding: "10px 22px",
            borderRadius: 999,
            border: "1.5px solid var(--teal-900)",
            background: "var(--teal-900)",
            color: "#fff",
            fontFamily: "inherit",
            fontSize: 14,
            fontWeight: 700,
            cursor: saving ? "not-allowed" : "pointer",
          }}
        >
          {saving ? "Saving…" : "Save formula"}
        </button>
        {initialFormula?.savedAt ? (
          <span style={{ fontSize: 12, color: "var(--ink-3, #8a9498)" }}>
            Last saved {new Date(initialFormula.savedAt).toLocaleString()} by{" "}
            {initialFormula.savedByEmail}
          </span>
        ) : (
          <span style={{ fontSize: 12, color: "var(--ink-3, #8a9498)" }}>Not saved yet.</span>
        )}
      </div>

      {toast ? (
        <div
          style={{
            position: "fixed",
            bottom: 24,
            left: "50%",
            transform: "translateX(-50%)",
            background: "var(--teal-900)",
            color: "#fff",
            padding: "12px 20px",
            borderRadius: 10,
            fontSize: 14,
            boxShadow: "0 4px 12px rgba(0,0,0,0.15)",
            maxWidth: 480,
            textAlign: "center",
            zIndex: 100,
          }}
        >
          {toast}
        </div>
      ) : null}
    </div>
  );
}
