"use client";

// FormulaEditor — the three-tab spec authoring surface for a single
// gummy formula.
//
// Identity header (Name / PC-BK / Shape / Flavor) floats above all three
// tabs. The tabs are three lenses on the same underlying recipe:
//
//   Bench top      — 250g reference batch, ingredient % + derived grams
//   Scale up       — production batch params + scaled kg amounts, with
//                    the daily-fixed-loss yield surfaced
//   Material cost  — same table plus $/kg and $/gummy contribution; a
//                    "Copy $/gummy" affordance for pricing hand-off
//
// Saves split by intent:
//   - Identity-only changes (name, PC-BK, shape, flavor) → PUT
//     /api/formulas/[id]. No new version created — presentation metadata.
//   - Recipe / batch param changes → POST /api/formulas/[id]/versions.
//     Immutable snapshot, so historical workflow pins stay reproducible.
//
// The Save button figures out which of the two calls to make (or both)
// by comparing the current state to the loaded snapshot.

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  FORMULA_SHAPES,
  FORMULA_VERSION_DEFAULTS,
  computeMaterialCostPerGummy,
  emptyIngredient,
  ingredientGramsForBench,
  ingredientKgForScaleUp,
  type GummyFormulaAuditRecord,
  type GummyFormulaIngredient,
  type GummyFormulaRecord,
  type GummyFormulaVersion,
  type IdentityDiff,
  type VersionDiff,
  type RawMaterialCostLookup,
} from "@/lib/formulas";

// Raw-material catalog option surfaced to the editor. Serialised from
// server so the client doesn't need a separate fetch.
export type RawMaterialOption = {
  id: string;
  fpCode: string | null;
  name: string;
  defaultUnit: string | null;
  defaultCostPerKg: number | null;
  defaultSolids: number;
  category: "primary" | "secondary" | "final" | "other" | null;
};

type Props = {
  initialFormula: GummyFormulaRecord;
  initialVersion: GummyFormulaVersion | null;
  rawMaterials: RawMaterialOption[];
};

type Tab = "bench" | "scale" | "cost";

const usd = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 4,
  maximumFractionDigits: 4,
});
const usdShort = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

export default function FormulaEditor({
  initialFormula,
  initialVersion,
  rawMaterials,
}: Props) {
  const router = useRouter();

  // -- Identity state ---------------------------------------------------------
  const [name, setName] = useState(initialFormula.name);
  const [pcBkCode, setPcBkCode] = useState<string>(initialFormula.pcBkCode ?? "");
  const [pcBkTbd, setPcBkTbd] = useState<boolean>(initialFormula.pcBkCode == null);
  const [shape, setShape] = useState(initialFormula.shape);
  const [flavor, setFlavor] = useState(initialFormula.flavor ?? "");

  // -- Version state ----------------------------------------------------------
  // Fall back to defaults if the formula somehow has no version yet
  // (shouldn't happen — POST /formulas creates v1 atomically).
  const seedVersion = initialVersion ?? {
    id: "",
    formulaId: initialFormula.id,
    versionNum: 0,
    benchBatchG: FORMULA_VERSION_DEFAULTS.benchBatchG,
    batchKg: FORMULA_VERSION_DEFAULTS.batchKg,
    batchesPerDay: FORMULA_VERSION_DEFAULTS.batchesPerDay,
    fixedLossKgPerDay: FORMULA_VERSION_DEFAULTS.fixedLossKgPerDay,
    gummyPieceWeightG: FORMULA_VERSION_DEFAULTS.gummyPieceWeightG,
    yieldPct: FORMULA_VERSION_DEFAULTS.yieldPct,
    ingredients: [emptyIngredient()],
    notes: null,
    createdAt: new Date().toISOString(),
    createdByEmail: null,
  };

  const [benchBatchG, setBenchBatchG] = useState<number>(seedVersion.benchBatchG);
  const [batchKg, setBatchKg] = useState<number>(seedVersion.batchKg);
  const [batchesPerDay, setBatchesPerDay] = useState<number>(seedVersion.batchesPerDay);
  const [fixedLossKgPerDay, setFixedLossKgPerDay] = useState<number>(
    seedVersion.fixedLossKgPerDay,
  );
  const [gummyPieceWeightG, setGummyPieceWeightG] = useState<number>(
    seedVersion.gummyPieceWeightG,
  );
  const [yieldPct, setYieldPct] = useState<number>(seedVersion.yieldPct);
  const [ingredients, setIngredients] = useState<GummyFormulaIngredient[]>(
    seedVersion.ingredients.length > 0
      ? seedVersion.ingredients
      : [emptyIngredient()],
  );
  const [versionNotes, setVersionNotes] = useState<string>("");

  // Loaded snapshot — used to compute whether version fields actually
  // changed vs. the currently-pinned version. This is what decides
  // whether Save writes a new version row.
  const loadedSnapshot = useMemo(
    () => JSON.stringify(seedVersion),
    // Snapshot is fixed once mounted; ignoring reactive drift.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  // Dirty flags derived from state.
  const identityDirty =
    name.trim() !== initialFormula.name ||
    (pcBkTbd ? initialFormula.pcBkCode !== null : pcBkCode.trim() !== (initialFormula.pcBkCode ?? "")) ||
    shape !== initialFormula.shape ||
    (flavor.trim() || null) !== (initialFormula.flavor ?? null);

  const versionDirty = useMemo(() => {
    // Build a version-shape blob and compare against the loaded snapshot.
    const current = {
      benchBatchG,
      batchKg,
      batchesPerDay,
      fixedLossKgPerDay,
      gummyPieceWeightG,
      yieldPct,
      ingredients,
    };
    try {
      const seed = JSON.parse(loadedSnapshot);
      const seedCore = {
        benchBatchG: seed.benchBatchG,
        batchKg: seed.batchKg,
        batchesPerDay: seed.batchesPerDay,
        fixedLossKgPerDay: seed.fixedLossKgPerDay,
        gummyPieceWeightG: seed.gummyPieceWeightG,
        yieldPct: seed.yieldPct,
        ingredients: seed.ingredients,
      };
      return JSON.stringify(current) !== JSON.stringify(seedCore);
    } catch {
      return true;
    }
  }, [
    benchBatchG,
    batchKg,
    batchesPerDay,
    fixedLossKgPerDay,
    gummyPieceWeightG,
    yieldPct,
    ingredients,
    loadedSnapshot,
  ]);

  const anyDirty = identityDirty || versionDirty;

  // Warn on tab close if unsaved. Standard beforeunload.
  useEffect(() => {
    if (!anyDirty) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [anyDirty]);

  // -- Tabs -------------------------------------------------------------------
  const [tab, setTab] = useState<Tab>("bench");

  // -- Raw material lookup (for cost math) ------------------------------------
  const rmById = useMemo(() => {
    const m = new Map<string, RawMaterialOption>();
    for (const r of rawMaterials) m.set(r.id, r);
    return m;
  }, [rawMaterials]);

  const costLookup = useMemo(
    () =>
      (rawMaterialId: string): RawMaterialCostLookup | null => {
        const r = rmById.get(rawMaterialId);
        if (!r) return null;
        return { costPerKg: r.defaultCostPerKg, solids: r.defaultSolids };
      },
    [rmById],
  );

  // -- Derived math -----------------------------------------------------------
  const totalPct = useMemo(
    () => ingredients.reduce((s, r) => s + (Number(r.pctInFinished) || 0), 0),
    [ingredients],
  );

  const benchGrams = useMemo(
    () => ingredientGramsForBench({ ingredients, benchBatchG }),
    [ingredients, benchBatchG],
  );
  const benchGramById = useMemo(() => {
    const m = new Map<string, number>();
    benchGrams.forEach((row) => m.set(row.id, row.grams));
    return m;
  }, [benchGrams]);

  const scaleKg = useMemo(
    () => ingredientKgForScaleUp({ ingredients, batchKg }),
    [ingredients, batchKg],
  );
  const scaleKgById = useMemo(() => {
    const m = new Map<string, number>();
    scaleKg.forEach((row) => m.set(row.id, row.kg));
    return m;
  }, [scaleKg]);

  const cost = useMemo(
    () =>
      computeMaterialCostPerGummy(
        {
          ingredients,
          gummyPieceWeightG,
          yieldPct,
          batchKg,
          batchesPerDay,
          fixedLossKgPerDay,
        },
        costLookup,
      ),
    [
      ingredients,
      gummyPieceWeightG,
      yieldPct,
      batchKg,
      batchesPerDay,
      fixedLossKgPerDay,
      costLookup,
    ],
  );

  // -- Audit timeline --------------------------------------------------------
  const [auditEvents, setAuditEvents] = useState<GummyFormulaAuditRecord[]>([]);
  const [auditLoading, setAuditLoading] = useState(true);

  async function refetchAudit() {
    setAuditLoading(true);
    try {
      const res = await fetch(`/api/formulas/${initialFormula.id}/audit`, {
        headers: { accept: "application/json" },
      });
      const json = await res.json();
      if (res.ok && json.ok) {
        setAuditEvents(Array.isArray(json.events) ? json.events : []);
      }
    } catch {
      // Silent — timeline is auxiliary; a failure shouldn't disrupt the editor.
    } finally {
      setAuditLoading(false);
    }
  }

  // Fetch once on mount.
  useEffect(() => {
    refetchAudit();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // -- Save -------------------------------------------------------------------
  const [saving, setSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState<
    | { kind: "ok"; text: string }
    | { kind: "err"; text: string }
    | null
  >(null);

  async function handleSave() {
    setSaving(true);
    setSaveStatus(null);
    try {
      // 1. Identity PUT (if identity dirty).
      if (identityDirty) {
        const res = await fetch(`/api/formulas/${initialFormula.id}`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            name: name.trim(),
            pcBkCode: pcBkTbd ? null : pcBkCode.trim() || null,
            shape,
            flavor: flavor.trim() || null,
          }),
        });
        const json = await res.json();
        if (!res.ok || !json.ok) {
          setSaveStatus({
            kind: "err",
            text: json.error || `identity_save_failed_${res.status}`,
          });
          setSaving(false);
          return;
        }
      }
      // 2. Version POST (if version dirty).
      if (versionDirty) {
        const res = await fetch(
          `/api/formulas/${initialFormula.id}/versions`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              benchBatchG,
              batchKg,
              batchesPerDay,
              fixedLossKgPerDay,
              gummyPieceWeightG,
              yieldPct,
              ingredients,
              notes: versionNotes.trim() || null,
            }),
          },
        );
        const json = await res.json();
        if (!res.ok || !json.ok) {
          setSaveStatus({
            kind: "err",
            text: json.error || `version_save_failed_${res.status}`,
          });
          setSaving(false);
          return;
        }
      }
      setSaveStatus({ kind: "ok", text: "Saved" });
      // Server-render is now stale — refresh so the loaded snapshot
      // resets and dirty flags clear. Also refetch the audit log so the
      // new event appears at the top of the timeline immediately.
      router.refresh();
      refetchAudit();
    } catch (err) {
      setSaveStatus({
        kind: "err",
        text: err instanceof Error ? err.message : "save_failed",
      });
    } finally {
      setSaving(false);
    }
  }

  // -- Row helpers ------------------------------------------------------------
  function updateRow(id: string, patch: Partial<GummyFormulaIngredient>) {
    setIngredients((prev) =>
      prev.map((r) => (r.id === id ? { ...r, ...patch } : r)),
    );
  }
  function addRow() {
    setIngredients((prev) => [...prev, emptyIngredient()]);
  }
  function removeRow(id: string) {
    setIngredients((prev) => (prev.length <= 1 ? prev : prev.filter((r) => r.id !== id)));
  }

  return (
    <div>
      {/* ============ Identity header (sticky top) ============ */}
      <div
        style={{
          position: "sticky",
          top: 0,
          zIndex: 5,
          background: "var(--cream-soft, #fbf6ec)",
          border: "1px solid var(--line, #e3dcc9)",
          borderRadius: 10,
          padding: "14px 16px",
          marginBottom: 14,
          boxShadow: "0 2px 6px rgba(15,74,86,0.06)",
        }}
      >
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "2fr 1.4fr 1fr 1.4fr auto",
            gap: 12,
            alignItems: "end",
          }}
        >
          <Field label="Name">
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="pricing__input"
              placeholder="e.g. Nuro-Brocc Bear Gummy"
              autoComplete="off"
            />
          </Field>

          <Field label="PC-BK code">
            <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <input
                type="text"
                value={pcBkTbd ? "" : pcBkCode}
                onChange={(e) => setPcBkCode(e.target.value)}
                disabled={pcBkTbd}
                className="pricing__input"
                placeholder="PC-BK-247"
                autoComplete="off"
                style={{ flex: 1 }}
              />
              <label
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 4,
                  fontSize: 11,
                  fontWeight: 700,
                  color: "var(--ink-3, #8a9498)",
                  whiteSpace: "nowrap",
                }}
              >
                <input
                  type="checkbox"
                  checked={pcBkTbd}
                  onChange={(e) => {
                    setPcBkTbd(e.target.checked);
                    if (e.target.checked) setPcBkCode("");
                  }}
                  style={{ margin: 0 }}
                />
                TBD
              </label>
            </div>
          </Field>

          <Field label="Shape">
            <select
              value={shape}
              onChange={(e) => setShape(e.target.value)}
              className="pricing__input"
            >
              {FORMULA_SHAPES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Flavor">
            <input
              type="text"
              value={flavor}
              onChange={(e) => setFlavor(e.target.value)}
              className="pricing__input"
              placeholder="e.g. Sour Green Apple"
              autoComplete="off"
            />
          </Field>

          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <button
              type="button"
              onClick={handleSave}
              disabled={saving || !anyDirty}
              style={{
                padding: "10px 18px",
                background: anyDirty ? "var(--teal-700, #1d6c7b)" : "#c7d2d6",
                color: "#fff",
                border: "1px solid",
                borderColor: anyDirty ? "var(--teal-900, #0f4a56)" : "#b6c1c5",
                borderRadius: 8,
                fontSize: 13,
                fontWeight: 700,
                cursor: saving ? "wait" : anyDirty ? "pointer" : "not-allowed",
                whiteSpace: "nowrap",
              }}
            >
              {saving
                ? "Saving…"
                : versionDirty
                  ? `Save (v${(initialFormula.latestVersionNum || 0) + 1})`
                  : identityDirty
                    ? "Save"
                    : "Saved"}
            </button>
            {saveStatus ? (
              <span
                style={{
                  fontSize: 11,
                  fontWeight: 700,
                  color: saveStatus.kind === "ok" ? "var(--teal-700, #1d6c7b)" : "#8b2f2f",
                  textAlign: "right",
                }}
              >
                {saveStatus.text}
              </span>
            ) : null}
          </div>
        </div>

        {/* Version / Updated / by meta strip now lives above the identity
            card, inside /formulas/[id]/page.tsx — it renders identically
            regardless of the tab you're on and doesn't scroll with the
            sticky header. */}
      </div>

      {/* ============ Tab bar ============ */}
      <div
        role="tablist"
        style={{
          display: "flex",
          gap: 4,
          borderBottom: "2px solid var(--line, #e3dcc9)",
          marginBottom: 16,
        }}
      >
        <TabButton active={tab === "bench"} onClick={() => setTab("bench")}>
          Bench top
        </TabButton>
        <TabButton active={tab === "scale"} onClick={() => setTab("scale")}>
          Scale up
        </TabButton>
        <TabButton active={tab === "cost"} onClick={() => setTab("cost")}>
          Material costing
        </TabButton>
      </div>

      {/* ============ Tab content ============ */}
      {tab === "bench" ? (
        <BenchTopTab
          benchBatchG={benchBatchG}
          setBenchBatchG={setBenchBatchG}
          totalPct={totalPct}
        />
      ) : tab === "scale" ? (
        <ScaleUpTab
          batchKg={batchKg}
          setBatchKg={setBatchKg}
          batchesPerDay={batchesPerDay}
          setBatchesPerDay={setBatchesPerDay}
          fixedLossKgPerDay={fixedLossKgPerDay}
          setFixedLossKgPerDay={setFixedLossKgPerDay}
          gummyPieceWeightG={gummyPieceWeightG}
          setGummyPieceWeightG={setGummyPieceWeightG}
          yieldPct={yieldPct}
          setYieldPct={setYieldPct}
          effectiveYield={cost.dailyEffectiveYield}
        />
      ) : (
        <CostTab
          cost={cost}
          gummyPieceWeightG={gummyPieceWeightG}
          batchKg={batchKg}
          batchesPerDay={batchesPerDay}
        />
      )}

      {/* ============ Ingredient table (shared) ============ */}
      <IngredientTable
        tab={tab}
        ingredients={ingredients}
        rawMaterials={rawMaterials}
        benchGramById={benchGramById}
        scaleKgById={scaleKgById}
        onUpdate={updateRow}
        onAdd={addRow}
        onRemove={removeRow}
        rmById={rmById}
        yieldPct={yieldPct}
        gummyPieceWeightG={gummyPieceWeightG}
      />

      {/* Activity timeline (audit log). Renders below the ingredient
          table on every tab so users can always see history without
          leaving what they were editing. */}
      <AuditTimeline events={auditEvents} loading={auditLoading} />

      {/* Version notes (only relevant when writing a new version) */}
      {versionDirty ? (
        <div style={{ marginTop: 18 }}>
          <label style={{ display: "block", marginBottom: 6 }}>
            <span
              style={{
                fontSize: 11,
                fontWeight: 700,
                letterSpacing: "0.08em",
                textTransform: "uppercase",
                color: "var(--ink-3, #8a9498)",
              }}
            >
              What changed in this version? <em style={{ fontWeight: 400 }}>(optional)</em>
            </span>
            <textarea
              rows={2}
              value={versionNotes}
              onChange={(e) => setVersionNotes(e.target.value)}
              className="pricing__input"
              style={{ resize: "vertical", width: "100%", marginTop: 4 }}
              placeholder="e.g. Bumped pectin from 1.9% to 2.1% to improve set."
            />
          </label>
        </div>
      ) : null}
    </div>
  );
}

// -----------------------------------------------------------------------------
// Sub-components
// -----------------------------------------------------------------------------

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <span
        style={{
          fontSize: 10.5,
          fontWeight: 700,
          letterSpacing: "0.1em",
          textTransform: "uppercase",
          color: "var(--ink-3, #8a9498)",
        }}
      >
        {label}
      </span>
      {children}
    </label>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      style={{
        padding: "10px 20px",
        background: active ? "var(--paper, #fffdf8)" : "transparent",
        color: active ? "var(--teal-900, #0f4a56)" : "var(--ink-3, #8a9498)",
        border: "1px solid var(--line, #e3dcc9)",
        borderBottom: active ? "2px solid var(--paper, #fffdf8)" : "1px solid var(--line, #e3dcc9)",
        borderRadius: "8px 8px 0 0",
        marginBottom: -2,
        fontSize: 13,
        fontWeight: 700,
        cursor: "pointer",
      }}
    >
      {children}
    </button>
  );
}

function NumberInput({
  value,
  onChange,
  suffix,
  step,
  min,
}: {
  value: number;
  onChange: (n: number) => void;
  suffix?: string;
  step?: string;
  min?: number;
}) {
  return (
    <div style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
      <input
        type="number"
        value={Number.isFinite(value) ? value : 0}
        onChange={(e) => {
          const n = Number(e.target.value);
          onChange(Number.isFinite(n) ? n : 0);
        }}
        step={step ?? "any"}
        min={min}
        className="pricing__input"
        style={{ width: 100, textAlign: "right", fontVariantNumeric: "tabular-nums" }}
      />
      {suffix ? (
        <span style={{ fontSize: 12, color: "var(--ink-3, #8a9498)" }}>{suffix}</span>
      ) : null}
    </div>
  );
}

// --- BenchTop tab ------------------------------------------------------------

function BenchTopTab({
  benchBatchG,
  setBenchBatchG,
  totalPct,
}: {
  benchBatchG: number;
  setBenchBatchG: (n: number) => void;
  totalPct: number;
}) {
  const totalOk = Math.abs(totalPct - 100) < 0.01;
  return (
    <div
      style={{
        marginBottom: 14,
        padding: 14,
        border: "1px solid var(--line, #e3dcc9)",
        borderRadius: 8,
        background: "var(--paper, #fffdf8)",
      }}
    >
      <div style={{ display: "flex", gap: 24, alignItems: "center", flexWrap: "wrap" }}>
        <div>
          <div
            style={{
              fontSize: 10.5,
              fontWeight: 700,
              letterSpacing: "0.1em",
              textTransform: "uppercase",
              color: "var(--ink-3, #8a9498)",
              marginBottom: 4,
            }}
          >
            Bench top batch
          </div>
          <NumberInput
            value={benchBatchG}
            onChange={setBenchBatchG}
            suffix="g"
            min={1}
          />
          <div style={{ fontSize: 11, color: "var(--ink-3, #8a9498)", marginTop: 4 }}>
            Reference size for the R&amp;D lab. All grams below scale to this.
          </div>
        </div>
        <div>
          <div
            style={{
              fontSize: 10.5,
              fontWeight: 700,
              letterSpacing: "0.1em",
              textTransform: "uppercase",
              color: "var(--ink-3, #8a9498)",
              marginBottom: 4,
            }}
          >
            Ingredients total
          </div>
          <div
            style={{
              fontSize: 20,
              fontWeight: 700,
              color: totalOk ? "var(--teal-700, #1d6c7b)" : "#8b2f2f",
              fontVariantNumeric: "tabular-nums",
            }}
          >
            {totalPct.toFixed(2)}%
          </div>
          <div style={{ fontSize: 11, color: "var(--ink-3, #8a9498)", marginTop: 4 }}>
            {totalOk ? "Balances to 100%." : "Adjust rows to sum to 100%."}
          </div>
        </div>
      </div>
    </div>
  );
}

// --- Scale up tab ------------------------------------------------------------

function ScaleUpTab({
  batchKg,
  setBatchKg,
  batchesPerDay,
  setBatchesPerDay,
  fixedLossKgPerDay,
  setFixedLossKgPerDay,
  gummyPieceWeightG,
  setGummyPieceWeightG,
  yieldPct,
  setYieldPct,
  effectiveYield,
}: {
  batchKg: number;
  setBatchKg: (n: number) => void;
  batchesPerDay: number;
  setBatchesPerDay: (n: number) => void;
  fixedLossKgPerDay: number;
  setFixedLossKgPerDay: (n: number) => void;
  gummyPieceWeightG: number;
  setGummyPieceWeightG: (n: number) => void;
  yieldPct: number;
  setYieldPct: (n: number) => void;
  effectiveYield: number;
}) {
  const totalDailyKg = batchKg * batchesPerDay;
  const gummiesPerBatch = gummyPieceWeightG > 0 ? (batchKg * 1000) / gummyPieceWeightG : 0;

  return (
    <div
      style={{
        marginBottom: 14,
        padding: 14,
        border: "1px solid var(--line, #e3dcc9)",
        borderRadius: 8,
        background: "var(--paper, #fffdf8)",
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
        gap: 14,
      }}
    >
      <ParamBlock label="Batch size">
        <NumberInput value={batchKg} onChange={setBatchKg} suffix="kg" min={1} />
      </ParamBlock>
      <ParamBlock label="Batches / day">
        <NumberInput value={batchesPerDay} onChange={setBatchesPerDay} min={1} />
      </ParamBlock>
      <ParamBlock label="Fixed loss / day">
        <NumberInput
          value={fixedLossKgPerDay}
          onChange={setFixedLossKgPerDay}
          suffix="kg"
          min={0}
        />
      </ParamBlock>
      <ParamBlock label="Piece weight">
        <NumberInput
          value={gummyPieceWeightG}
          onChange={setGummyPieceWeightG}
          suffix="g"
          step="0.1"
          min={0.1}
        />
      </ParamBlock>
      <ParamBlock label="Process yield">
        <NumberInput value={yieldPct} onChange={setYieldPct} suffix="%" min={1} />
      </ParamBlock>
      <ParamBlock label="Total daily kg">
        <ReadOnly>{totalDailyKg.toLocaleString("en-US", { maximumFractionDigits: 1 })} kg</ReadOnly>
      </ParamBlock>
      <ParamBlock label="Effective daily yield">
        <ReadOnly>{(effectiveYield * 100).toFixed(2)}%</ReadOnly>
      </ParamBlock>
      <ParamBlock label="Gummies / batch">
        <ReadOnly>
          {gummiesPerBatch.toLocaleString("en-US", { maximumFractionDigits: 0 })}
        </ReadOnly>
      </ParamBlock>
    </div>
  );
}

function ParamBlock({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div
        style={{
          fontSize: 10.5,
          fontWeight: 700,
          letterSpacing: "0.1em",
          textTransform: "uppercase",
          color: "var(--ink-3, #8a9498)",
          marginBottom: 4,
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

// --- Cost tab ----------------------------------------------------------------

function CostTab({
  cost,
  gummyPieceWeightG,
  batchKg,
  batchesPerDay,
}: {
  cost: {
    dollarsPerGummy: number;
    effectiveDollarsPerGummy: number;
    dailyEffectiveYield: number;
    hasCompleteCosts: boolean;
  };
  gummyPieceWeightG: number;
  batchKg: number;
  batchesPerDay: number;
}) {
  const dailyGummies =
    gummyPieceWeightG > 0 ? (batchKg * batchesPerDay * 1000) / gummyPieceWeightG : 0;
  const dailyEffectiveCost = cost.effectiveDollarsPerGummy * dailyGummies;

  const [copying, setCopying] = useState(false);
  async function copyToClipboard(text: string) {
    setCopying(true);
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // clipboard blocked — quietly ignore, user can still read the number
    } finally {
      setTimeout(() => setCopying(false), 600);
    }
  }

  return (
    <div
      style={{
        marginBottom: 14,
        padding: 14,
        border: "1px solid var(--line, #e3dcc9)",
        borderRadius: 8,
        background: "var(--paper, #fffdf8)",
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
        gap: 14,
      }}
    >
      <ParamBlock label="$ / gummy (raw)">
        <ReadOnly>{usd.format(cost.dollarsPerGummy)}</ReadOnly>
      </ParamBlock>
      <ParamBlock label="$ / gummy (w/ daily loss)">
        <ReadOnly>{usd.format(cost.effectiveDollarsPerGummy)}</ReadOnly>
      </ParamBlock>
      <ParamBlock label="Daily material $">
        <ReadOnly>{usdShort.format(dailyEffectiveCost)}</ReadOnly>
      </ParamBlock>
      <ParamBlock label="Complete costs?">
        <ReadOnly>
          {cost.hasCompleteCosts ? (
            <span style={{ color: "var(--teal-700, #1d6c7b)" }}>Yes</span>
          ) : (
            <span style={{ color: "#8b2f2f" }}>Missing $/kg</span>
          )}
        </ReadOnly>
      </ParamBlock>
      <div style={{ gridColumn: "1 / -1", display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button
          type="button"
          onClick={() => copyToClipboard(cost.effectiveDollarsPerGummy.toFixed(4))}
          disabled={!cost.hasCompleteCosts}
          style={{
            padding: "8px 14px",
            background: "var(--sage-700, #5f8e3a)",
            color: "#fff",
            border: "1px solid var(--sage-700, #5f8e3a)",
            borderRadius: 6,
            fontSize: 12,
            fontWeight: 700,
            cursor: cost.hasCompleteCosts ? "pointer" : "not-allowed",
            opacity: cost.hasCompleteCosts ? 1 : 0.5,
          }}
        >
          {copying ? "Copied" : "Copy $/gummy for pricing"}
        </button>
        <div style={{ fontSize: 11, color: "var(--ink-3, #8a9498)", alignSelf: "center" }}>
          Paste into the Unit cost field on /pricing for this workflow&apos;s gummy
          line item.
        </div>
      </div>
    </div>
  );
}

// --- Ingredient table (shared across all three tabs) -------------------------

function IngredientTable({
  tab,
  ingredients,
  rawMaterials,
  benchGramById,
  scaleKgById,
  onUpdate,
  onAdd,
  onRemove,
  rmById,
  yieldPct,
  gummyPieceWeightG,
}: {
  tab: Tab;
  ingredients: GummyFormulaIngredient[];
  rawMaterials: RawMaterialOption[];
  benchGramById: Map<string, number>;
  scaleKgById: Map<string, number>;
  onUpdate: (id: string, patch: Partial<GummyFormulaIngredient>) => void;
  onAdd: () => void;
  onRemove: (id: string) => void;
  rmById: Map<string, RawMaterialOption>;
  yieldPct: number;
  gummyPieceWeightG: number;
}) {
  return (
    <div>
      <table
        style={{
          width: "100%",
          borderCollapse: "collapse",
          background: "var(--paper, #fffdf8)",
          border: "1px solid var(--line, #e3dcc9)",
          borderRadius: 8,
          overflow: "hidden",
          fontSize: 12.5,
        }}
      >
        <thead>
          <tr style={{ background: "var(--cream, #f6efe3)" }}>
            <ITh>Ingredient</ITh>
            <ITh style={{ textAlign: "right", width: 90 }}>%</ITh>
            {tab === "bench" ? <ITh style={{ textAlign: "right", width: 110 }}>Grams</ITh> : null}
            {tab === "scale" ? <ITh style={{ textAlign: "right", width: 110 }}>Kg / batch</ITh> : null}
            {tab === "cost" ? <ITh style={{ textAlign: "right", width: 110 }}>$ / kg</ITh> : null}
            {tab === "cost" ? <ITh style={{ textAlign: "right", width: 90 }}>Solids</ITh> : null}
            {tab === "cost" ? <ITh style={{ textAlign: "right", width: 110 }}>$ / gummy</ITh> : null}
            <ITh style={{ width: 44 }}></ITh>
          </tr>
        </thead>
        <tbody>
          {ingredients.map((row) => {
            const rm = row.rawMaterialId ? rmById.get(row.rawMaterialId) ?? null : null;
            const effCostPerKg =
              row.costPerKgOverride !== null
                ? row.costPerKgOverride
                : rm?.defaultCostPerKg ?? null;
            const effSolids =
              row.solidsOverride !== null && row.solidsOverride !== undefined
                ? row.solidsOverride
                : rm?.defaultSolids ?? 1;

            // Contribution: this row's $/gummy piece.
            let dollarsPerGummyLine = 0;
            if (effCostPerKg !== null) {
              const yFactor = Math.max(0.0001, yieldPct / 100);
              const dollarsPerGramBlend =
                (effCostPerKg / 1000) * (row.pctInFinished / 100) * effSolids / yFactor;
              dollarsPerGummyLine = dollarsPerGramBlend * gummyPieceWeightG;
            }

            return (
              <tr
                key={row.id}
                style={{ borderTop: "1px solid var(--line-2, #efe9da)" }}
              >
                <ITd>
                  <select
                    value={row.rawMaterialId ?? ""}
                    onChange={(e) =>
                      onUpdate(row.id, {
                        rawMaterialId: e.target.value || null,
                        // Wipe overrides when switching to a fresh raw material
                        // so defaults take effect. Rep can re-set overrides
                        // deliberately if they need to.
                        costPerKgOverride: null,
                        solidsOverride: null,
                      })
                    }
                    className="pricing__input"
                    style={{ width: "100%" }}
                  >
                    <option value="">— pick a raw material —</option>
                    {rawMaterials.map((rm) => (
                      <option key={rm.id} value={rm.id}>
                        {rm.fpCode ? `${rm.fpCode} · ` : ""}
                        {rm.name}
                      </option>
                    ))}
                  </select>
                </ITd>
                <ITd style={{ textAlign: "right" }}>
                  <NumberInput
                    value={row.pctInFinished}
                    onChange={(n) => onUpdate(row.id, { pctInFinished: n })}
                    step="0.01"
                    min={0}
                  />
                </ITd>
                {tab === "bench" ? (
                  <ITd style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                    {(benchGramById.get(row.id) ?? 0).toFixed(2)} g
                  </ITd>
                ) : null}
                {tab === "scale" ? (
                  <ITd style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                    {(scaleKgById.get(row.id) ?? 0).toFixed(3)} kg
                  </ITd>
                ) : null}
                {tab === "cost" ? (
                  <ITd style={{ textAlign: "right" }}>
                    <NumberInput
                      value={effCostPerKg ?? 0}
                      onChange={(n) =>
                        onUpdate(row.id, { costPerKgOverride: n === 0 ? null : n })
                      }
                      suffix="$"
                      step="0.01"
                      min={0}
                    />
                  </ITd>
                ) : null}
                {tab === "cost" ? (
                  <ITd style={{ textAlign: "right" }}>
                    <NumberInput
                      value={effSolids}
                      onChange={(n) => onUpdate(row.id, { solidsOverride: n })}
                      step="0.01"
                      min={0}
                    />
                  </ITd>
                ) : null}
                {tab === "cost" ? (
                  <ITd style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                    {effCostPerKg === null ? "—" : usd.format(dollarsPerGummyLine)}
                  </ITd>
                ) : null}
                <ITd>
                  <button
                    type="button"
                    onClick={() => onRemove(row.id)}
                    disabled={ingredients.length <= 1}
                    title="Remove row"
                    style={{
                      background: "transparent",
                      border: "none",
                      color: "var(--ink-3, #8a9498)",
                      cursor: ingredients.length <= 1 ? "not-allowed" : "pointer",
                      fontSize: 16,
                    }}
                  >
                    ×
                  </button>
                </ITd>
              </tr>
            );
          })}
        </tbody>
      </table>

      <div style={{ marginTop: 10 }}>
        <button
          type="button"
          onClick={onAdd}
          style={{
            padding: "8px 14px",
            background: "transparent",
            color: "var(--teal-900, #0f4a56)",
            border: "1px dashed var(--line, #e3dcc9)",
            borderRadius: 6,
            fontSize: 12.5,
            fontWeight: 700,
            cursor: "pointer",
          }}
        >
          + Add ingredient
        </button>
      </div>
    </div>
  );
}

function ITh({ children, style }: { children?: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <th
      style={{
        textAlign: "left",
        padding: "8px 10px",
        fontSize: 10.5,
        fontWeight: 700,
        letterSpacing: "0.1em",
        textTransform: "uppercase",
        color: "var(--ink-3, #8a9498)",
        borderBottom: "1.5px solid var(--teal-700, #1d6c7b)",
        ...style,
      }}
    >
      {children}
    </th>
  );
}
function ITd({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <td
      style={{
        padding: "6px 10px",
        verticalAlign: "middle",
        ...style,
      }}
    >
      {children}
    </td>
  );
}

// -----------------------------------------------------------------------------
// AuditTimeline — chronological log of every save event for this formula.
// One row per audit entry with author, time, one-line summary, and an
// expandable "what changed" panel with the structured diff.
// -----------------------------------------------------------------------------

function AuditTimeline({
  events,
  loading,
}: {
  events: GummyFormulaAuditRecord[];
  loading: boolean;
}) {
  return (
    <section
      style={{
        marginTop: 24,
        border: "1px solid var(--line, #e3dcc9)",
        borderRadius: 8,
        background: "var(--paper, #fffdf8)",
        overflow: "hidden",
      }}
    >
      <header
        style={{
          padding: "10px 14px",
          background: "var(--cream, #f6efe3)",
          borderBottom: "1.5px solid var(--teal-700, #1d6c7b)",
          display: "flex",
          alignItems: "center",
          gap: 8,
        }}
      >
        <span
          style={{
            fontSize: 10.5,
            fontWeight: 700,
            letterSpacing: "0.14em",
            textTransform: "uppercase",
            color: "var(--teal-900, #0f4a56)",
          }}
        >
          Activity
        </span>
        <span
          style={{
            fontSize: 11,
            color: "var(--ink-3, #8a9498)",
          }}
        >
          {loading
            ? "loading…"
            : events.length === 0
              ? "no events yet"
              : `${events.length} event${events.length === 1 ? "" : "s"}`}
        </span>
      </header>
      {events.length === 0 && !loading ? (
        <div
          style={{
            padding: 18,
            fontSize: 12,
            color: "var(--ink-3, #8a9498)",
            textAlign: "center",
          }}
        >
          No changes recorded yet.
        </div>
      ) : (
        <ol style={{ margin: 0, padding: 0, listStyle: "none" }}>
          {events.map((ev) => (
            <AuditRow key={ev.id} event={ev} />
          ))}
        </ol>
      )}
    </section>
  );
}

function AuditRow({ event }: { event: GummyFormulaAuditRecord }) {
  const [expanded, setExpanded] = useState(false);
  const at = new Date(event.at);
  const when = at.toLocaleString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
  const who = event.byDisplay || event.byEmail || "Unknown";
  const kindLabel = {
    created: "Created",
    identity: "Identity edit",
    version: `Version v${event.versionNum ?? "?"}`,
  }[event.kind];
  const kindColor = {
    created: "var(--sage-700, #5f8e3a)",
    identity: "var(--teal-500, #3a8d9c)",
    version: "var(--teal-900, #0f4a56)",
  }[event.kind];

  const hasDiff = event.kind !== "created";

  return (
    <li
      style={{
        padding: "10px 14px",
        borderTop: "1px solid var(--line-2, #efe9da)",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "flex-start",
          gap: 12,
          flexWrap: "wrap",
        }}
      >
        <span
          style={{
            display: "inline-block",
            padding: "1px 8px",
            background: "#fff",
            border: `1px solid ${kindColor}`,
            borderRadius: 999,
            fontSize: 10.5,
            fontWeight: 700,
            letterSpacing: "0.08em",
            textTransform: "uppercase",
            color: kindColor,
            flexShrink: 0,
          }}
        >
          {kindLabel}
        </span>
        <div style={{ flex: 1, minWidth: 240 }}>
          <div style={{ fontSize: 12.5, color: "var(--ink, #1f2a2d)" }}>
            {event.summary}
          </div>
          <div
            style={{
              marginTop: 3,
              fontSize: 11,
              color: "var(--ink-3, #8a9498)",
            }}
          >
            {when} · by <strong>{who}</strong>
          </div>
        </div>
        {hasDiff ? (
          <button
            type="button"
            onClick={() => setExpanded((s) => !s)}
            style={{
              padding: "4px 10px",
              background: "transparent",
              border: "1px solid var(--line, #e3dcc9)",
              borderRadius: 6,
              fontSize: 11,
              fontWeight: 700,
              color: "var(--teal-900, #0f4a56)",
              cursor: "pointer",
              flexShrink: 0,
            }}
          >
            {expanded ? "Hide details" : "Details"}
          </button>
        ) : null}
      </div>
      {expanded && hasDiff ? <AuditDiffPanel event={event} /> : null}
    </li>
  );
}

function AuditDiffPanel({ event }: { event: GummyFormulaAuditRecord }) {
  if (event.kind === "identity") {
    const d = event.diff as IdentityDiff;
    if (!d?.changes || d.changes.length === 0) return null;
    return (
      <div
        style={{
          marginTop: 8,
          padding: "8px 12px",
          background: "var(--cream-soft, #fbf6ec)",
          borderRadius: 6,
          fontSize: 12,
        }}
      >
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <tbody>
            {d.changes.map((c, i) => (
              <tr key={i}>
                <td
                  style={{
                    padding: "3px 8px",
                    fontWeight: 700,
                    color: "var(--ink-3, #8a9498)",
                    textTransform: "capitalize",
                    width: 120,
                  }}
                >
                  {c.field}
                </td>
                <td style={{ padding: "3px 8px", color: "var(--ink-2, #415056)" }}>
                  <code style={{ background: "#fff", padding: "1px 6px", borderRadius: 4 }}>
                    {formatDiffValue(c.from)}
                  </code>{" "}
                  →{" "}
                  <code style={{ background: "#fff", padding: "1px 6px", borderRadius: 4 }}>
                    {formatDiffValue(c.to)}
                  </code>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }
  if (event.kind === "version") {
    const d = event.diff as VersionDiff;
    return (
      <div
        style={{
          marginTop: 8,
          padding: "8px 12px",
          background: "var(--cream-soft, #fbf6ec)",
          borderRadius: 6,
          fontSize: 12,
        }}
      >
        {d.paramChanges?.length > 0 ? (
          <>
            <div
              style={{
                fontSize: 10.5,
                fontWeight: 700,
                letterSpacing: "0.1em",
                textTransform: "uppercase",
                color: "var(--ink-3, #8a9498)",
                marginBottom: 4,
              }}
            >
              Batch parameters
            </div>
            <ul style={{ margin: "0 0 8px 20px", padding: 0 }}>
              {d.paramChanges.map((c, i) => (
                <li key={i} style={{ marginBottom: 2 }}>
                  <strong style={{ color: "var(--teal-900, #0f4a56)" }}>{c.field}</strong>:{" "}
                  <code style={{ background: "#fff", padding: "1px 6px", borderRadius: 4 }}>
                    {c.from}
                  </code>{" "}
                  →{" "}
                  <code style={{ background: "#fff", padding: "1px 6px", borderRadius: 4 }}>
                    {c.to}
                  </code>
                </li>
              ))}
            </ul>
          </>
        ) : null}
        {d.added?.length > 0 ? (
          <>
            <div
              style={{
                fontSize: 10.5,
                fontWeight: 700,
                letterSpacing: "0.1em",
                textTransform: "uppercase",
                color: "var(--sage-700, #5f8e3a)",
                marginBottom: 4,
              }}
            >
              Added ({d.added.length})
            </div>
            <ul style={{ margin: "0 0 8px 20px", padding: 0 }}>
              {d.added.map((r, i) => (
                <li key={i}>
                  {r.rawMaterialId ? r.rawMaterialId.slice(0, 8) + "…" : "(custom)"} @{" "}
                  {r.pctInFinished}%
                </li>
              ))}
            </ul>
          </>
        ) : null}
        {d.removed?.length > 0 ? (
          <>
            <div
              style={{
                fontSize: 10.5,
                fontWeight: 700,
                letterSpacing: "0.1em",
                textTransform: "uppercase",
                color: "#8b2f2f",
                marginBottom: 4,
              }}
            >
              Removed ({d.removed.length})
            </div>
            <ul style={{ margin: "0 0 8px 20px", padding: 0 }}>
              {d.removed.map((r, i) => (
                <li key={i}>
                  {r.rawMaterialId ? r.rawMaterialId.slice(0, 8) + "…" : "(custom)"} @{" "}
                  {r.pctInFinished}%
                </li>
              ))}
            </ul>
          </>
        ) : null}
        {d.modified?.length > 0 ? (
          <>
            <div
              style={{
                fontSize: 10.5,
                fontWeight: 700,
                letterSpacing: "0.1em",
                textTransform: "uppercase",
                color: "var(--teal-500, #3a8d9c)",
                marginBottom: 4,
              }}
            >
              Modified ({d.modified.length})
            </div>
            <ul style={{ margin: "0 0 8px 20px", padding: 0 }}>
              {d.modified.map((r, i) => (
                <li key={i} style={{ marginBottom: 4 }}>
                  <strong>
                    {r.rawMaterialId ? r.rawMaterialId.slice(0, 8) + "…" : "(custom)"}
                  </strong>
                  <ul style={{ margin: "2px 0 0 16px", padding: 0 }}>
                    {r.changes.map((c, j) => (
                      <li key={j} style={{ fontSize: 11 }}>
                        {String(c.field)}:{" "}
                        <code style={{ background: "#fff", padding: "1px 6px", borderRadius: 4 }}>
                          {formatDiffValue(c.from)}
                        </code>{" "}
                        →{" "}
                        <code style={{ background: "#fff", padding: "1px 6px", borderRadius: 4 }}>
                          {formatDiffValue(c.to)}
                        </code>
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          </>
        ) : null}
      </div>
    );
  }
  return null;
}

function formatDiffValue(v: unknown): string {
  if (v === null || v === undefined) return "∅";
  if (v === "") return "(empty)";
  if (typeof v === "boolean") return v ? "true" : "false";
  return String(v);
}
