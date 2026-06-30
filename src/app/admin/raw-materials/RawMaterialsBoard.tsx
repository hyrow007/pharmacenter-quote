"use client";

import { useMemo, useState, type CSSProperties, type FormEvent } from "react";

// Interactive island for the /admin/raw-materials page.
// Responsibilities:
//   - Search box (filters on name + fp_code, case-insensitive)
//   - Show / hide inactive toggle
//   - Inline edit per row for cost/solids/category/notes/active
//   - "+ New manual material" inline form
//   - Calls /api/raw-materials (GET / POST / PATCH / DELETE)

export type RawMaterialRow = {
  id: string;
  fp_code: string | null;
  name: string;
  default_unit: string;
  default_cost_per_kg: number | null;
  default_solids: number;
  category: string | null; // primary | secondary | final | other | null
  notes: string | null;
  active: boolean;
  source: "fishbowl" | "manual";
  synced_at: string | null;
  updated_at: string | null;
};

type Props = {
  initialRows: RawMaterialRow[];
};

const CATEGORY_OPTIONS = [
  { id: "", label: "—" },
  { id: "primary", label: "Primary" },
  { id: "secondary", label: "Secondary" },
  { id: "final", label: "Final" },
  { id: "other", label: "Other" },
];

const SOLIDS_PRESETS = [
  { value: 1.0, label: "1.0 (neat)" },
  { value: 0.8, label: "0.8 (80% solids syrup)" },
  { value: 0.5, label: "0.5 (50/50 solution)" },
  { value: 0.25, label: "0.25 (25% solution)" },
];

const inputStyle: CSSProperties = {
  padding: "6px 8px",
  border: "1px solid #e3dcc9",
  borderRadius: 6,
  fontSize: 13,
  fontFamily: "inherit",
  background: "transparent",
  width: "100%",
  outline: "none",
};

const cellLabelStyle: CSSProperties = {
  display: "block",
  fontSize: 10,
  fontWeight: 700,
  letterSpacing: "0.12em",
  textTransform: "uppercase",
  color: "var(--ink-3, #8a9498)",
  marginBottom: 4,
};

export default function RawMaterialsBoard({ initialRows }: Props) {
  const [rows, setRows] = useState<RawMaterialRow[]>(initialRows);
  const [search, setSearch] = useState("");
  const [showInactive, setShowInactive] = useState(false);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Filter view-only — never mutates `rows`.
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter((r) => {
      if (!showInactive && !r.active) return false;
      if (q.length === 0) return true;
      return (
        r.name.toLowerCase().includes(q) ||
        (r.fp_code ?? "").toLowerCase().includes(q)
      );
    });
  }, [rows, search, showInactive]);

  function applyPatch(id: string, patch: Partial<RawMaterialRow>) {
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  }

  async function commitPatch(id: string, patch: Partial<RawMaterialRow>) {
    setSavingId(id);
    setError(null);
    try {
      const res = await fetch(`/api/raw-materials?id=${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch),
      });
      const data = (await res.json().catch(() => null)) as
        | { ok?: boolean; error?: string; raw_material?: RawMaterialRow }
        | null;
      if (!res.ok || !data?.ok || !data.raw_material) {
        throw new Error(data?.error || `http_${res.status}`);
      }
      // Re-sync the row with whatever the server returned (in case of trim,
      // null normalisation, etc.).
      applyPatch(id, data.raw_material);
    } catch (err) {
      setError(err instanceof Error ? err.message : "save_failed");
    } finally {
      setSavingId(null);
    }
  }

  async function onDeactivate(id: string) {
    if (!window.confirm("Mark this material inactive? It'll be hidden from the formula picker. You can show it again with the toggle above the search.")) {
      return;
    }
    await commitPatch(id, { active: false });
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {/* ----- Controls -------------------------------------------- */}
      <div
        style={{
          display: "flex",
          gap: 12,
          alignItems: "center",
          flexWrap: "wrap",
        }}
      >
        <input
          type="search"
          placeholder="Search by name or part #"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{
            flex: 1,
            minWidth: 240,
            padding: "10px 14px",
            border: "1.5px solid #e3dcc9",
            borderRadius: 8,
            fontSize: 14,
            fontFamily: "inherit",
            background: "transparent",
          }}
        />
        <label
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            fontSize: 12,
            color: "var(--ink-3, #8a9498)",
            userSelect: "none",
          }}
        >
          <input
            type="checkbox"
            checked={showInactive}
            onChange={(e) => setShowInactive(e.target.checked)}
          />
          Show inactive
        </label>
        <span style={{ fontSize: 12, color: "var(--ink-3, #8a9498)" }}>
          {filtered.length} of {rows.length}
        </span>
      </div>

      {error ? (
        <div
          style={{
            padding: "10px 14px",
            background: "#fff1f1",
            border: "1px solid #f5c2c2",
            color: "#7a1d1d",
            borderRadius: 8,
            fontSize: 13,
          }}
        >
          {error}
        </div>
      ) : null}

      {/* ----- New material form --------------------------------- */}
      <NewMaterialForm
        onCreated={(row) => {
          setRows((prev) => [row, ...prev]);
        }}
        onError={(msg) => setError(msg)}
      />

      {/* ----- Table --------------------------------------------- */}
      <section
        style={{
          background: "var(--paper, #fffdf8)",
          border: "1px solid var(--line, #e3dcc9)",
          borderRadius: 12,
          padding: 4,
        }}
      >
        {filtered.length === 0 ? (
          <p style={{ margin: 0, padding: 16, color: "var(--ink-3, #8a9498)", fontSize: 13 }}>
            No materials match.
          </p>
        ) : (
          <div style={{ display: "flex", flexDirection: "column" }}>
            {filtered.map((r) => (
              <RowEditor
                key={r.id}
                row={r}
                saving={savingId === r.id}
                onPatch={(patch) => applyPatch(r.id, patch)}
                onCommit={(patch) => commitPatch(r.id, patch)}
                onDeactivate={() => onDeactivate(r.id)}
              />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

// ----- New material form ------------------------------------------------

function NewMaterialForm({
  onCreated,
  onError,
}: {
  onCreated: (row: RawMaterialRow) => void;
  onError: (msg: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [name, setName] = useState("");
  const [fpCode, setFpCode] = useState("");
  const [cost, setCost] = useState("");
  const [solids, setSolids] = useState("1");
  const [category, setCategory] = useState("");

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setSubmitting(true);
    try {
      const body: Record<string, unknown> = { name: name.trim() };
      if (fpCode.trim()) body.fp_code = fpCode.trim();
      const costN = parseFloat(cost);
      if (isFinite(costN) && costN >= 0) body.default_cost_per_kg = costN;
      const solidsN = parseFloat(solids);
      if (isFinite(solidsN) && solidsN > 0 && solidsN <= 1) body.default_solids = solidsN;
      if (category) body.category = category;

      const res = await fetch("/api/raw-materials", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await res.json().catch(() => null)) as
        | { ok?: boolean; error?: string; raw_material?: RawMaterialRow }
        | null;
      if (!res.ok || !data?.ok || !data.raw_material) {
        throw new Error(data?.error || `http_${res.status}`);
      }
      onCreated(data.raw_material);
      setName("");
      setFpCode("");
      setCost("");
      setSolids("1");
      setCategory("");
      setOpen(false);
    } catch (err) {
      onError(err instanceof Error ? err.message : "create_failed");
    } finally {
      setSubmitting(false);
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        style={{
          alignSelf: "flex-start",
          padding: "8px 14px",
          background: "var(--teal-700, #1d6c7b)",
          color: "#fff",
          border: "1px solid var(--teal-900, #0f4a56)",
          borderRadius: 8,
          fontSize: 13,
          fontWeight: 700,
          cursor: "pointer",
          fontFamily: "inherit",
        }}
      >
        + New manual material
      </button>
    );
  }

  return (
    <form
      onSubmit={onSubmit}
      style={{
        background: "var(--paper, #fffdf8)",
        border: "1px solid var(--line, #e3dcc9)",
        borderRadius: 12,
        padding: 14,
        display: "grid",
        gap: 10,
        gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
      }}
    >
      <label>
        <span style={cellLabelStyle}>Name *</span>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
          style={inputStyle}
        />
      </label>
      <label>
        <span style={cellLabelStyle}>FP code</span>
        <input
          value={fpCode}
          onChange={(e) => setFpCode(e.target.value)}
          placeholder="optional"
          style={inputStyle}
        />
      </label>
      <label>
        <span style={cellLabelStyle}>Cost $/kg</span>
        <input
          type="number"
          inputMode="decimal"
          step="0.01"
          min="0"
          value={cost}
          onChange={(e) => setCost(e.target.value)}
          style={inputStyle}
        />
      </label>
      <label>
        <span style={cellLabelStyle}>Solids</span>
        <input
          type="number"
          inputMode="decimal"
          step="0.01"
          min="0.01"
          max="1"
          value={solids}
          onChange={(e) => setSolids(e.target.value)}
          style={inputStyle}
        />
      </label>
      <label>
        <span style={cellLabelStyle}>Category</span>
        <select
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          style={inputStyle}
        >
          {CATEGORY_OPTIONS.map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}
            </option>
          ))}
        </select>
      </label>
      <div
        style={{
          display: "flex",
          alignItems: "flex-end",
          gap: 8,
          gridColumn: "1 / -1",
        }}
      >
        <button
          type="submit"
          disabled={submitting || !name.trim()}
          style={{
            padding: "8px 14px",
            background: "var(--teal-700, #1d6c7b)",
            color: "#fff",
            border: "1px solid var(--teal-900, #0f4a56)",
            borderRadius: 8,
            fontSize: 13,
            fontWeight: 700,
            cursor: submitting ? "not-allowed" : "pointer",
            fontFamily: "inherit",
          }}
        >
          {submitting ? "Saving…" : "Save"}
        </button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          style={{
            padding: "8px 14px",
            background: "transparent",
            color: "var(--ink-2, #415056)",
            border: "1px solid #e3dcc9",
            borderRadius: 8,
            fontSize: 13,
            fontWeight: 600,
            cursor: "pointer",
            fontFamily: "inherit",
          }}
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

// ----- One material row -------------------------------------------------

function RowEditor({
  row,
  saving,
  onPatch,
  onCommit,
  onDeactivate,
}: {
  row: RawMaterialRow;
  saving: boolean;
  onPatch: (patch: Partial<RawMaterialRow>) => void;
  onCommit: (patch: Partial<RawMaterialRow>) => void;
  onDeactivate: () => void;
}) {
  const isFb = row.source === "fishbowl";
  const lastSync = row.synced_at
    ? new Date(row.synced_at).toLocaleDateString("en-US", {
        year: "numeric",
        month: "short",
        day: "numeric",
      })
    : null;

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "minmax(220px, 2fr) 110px 110px 110px 130px 40px",
        gap: 10,
        padding: "12px 12px",
        borderBottom: "1px solid #efe9da",
        alignItems: "center",
        opacity: row.active ? 1 : 0.55,
      }}
    >
      {/* Name + fp_code + source pill */}
      <div style={{ minWidth: 0 }}>
        <div
          style={{
            fontSize: 14,
            fontWeight: 700,
            color: "var(--teal-900, #0f4a56)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
          title={row.name}
        >
          {row.name}
        </div>
        <div
          style={{
            display: "flex",
            gap: 6,
            alignItems: "center",
            fontSize: 11,
            color: "var(--ink-3, #8a9498)",
            fontFamily: '"IBM Plex Mono", ui-monospace, monospace',
            marginTop: 2,
          }}
        >
          {row.fp_code ?? "— no FP code"}
          {isFb ? (
            <span
              style={{
                display: "inline-block",
                padding: "1px 6px",
                background: "#ecfeff",
                color: "var(--teal-700, #1d6c7b)",
                border: "1px solid #a7e3df",
                borderRadius: 999,
                fontSize: 9,
                fontWeight: 700,
                letterSpacing: "0.06em",
                textTransform: "uppercase",
                fontFamily: "inherit",
              }}
            >
              Fishbowl
            </span>
          ) : (
            <span
              style={{
                display: "inline-block",
                padding: "1px 6px",
                background: "#fff7e5",
                color: "#8a5a00",
                border: "1px solid #f0d68f",
                borderRadius: 999,
                fontSize: 9,
                fontWeight: 700,
                letterSpacing: "0.06em",
                textTransform: "uppercase",
                fontFamily: "inherit",
              }}
            >
              Manual
            </span>
          )}
          {lastSync ? <span>Synced {lastSync}</span> : null}
          {row.notes ? (
            <span title={row.notes} style={{ cursor: "help" }}>
              · 📝
            </span>
          ) : null}
        </div>
      </div>

      {/* Cost $/kg */}
      <label>
        <span style={cellLabelStyle}>$/kg</span>
        <input
          type="number"
          inputMode="decimal"
          step="0.01"
          min="0"
          value={row.default_cost_per_kg ?? ""}
          onChange={(e) => {
            const v = e.target.value;
            const n = v === "" ? null : parseFloat(v);
            onPatch({ default_cost_per_kg: Number.isFinite(n) ? n : null });
          }}
          onBlur={() => onCommit({ default_cost_per_kg: row.default_cost_per_kg })}
          disabled={saving}
          style={inputStyle}
        />
      </label>

      {/* Solids */}
      <label>
        <span style={cellLabelStyle}>Solids</span>
        <select
          value={String(row.default_solids)}
          onChange={(e) => {
            const n = parseFloat(e.target.value);
            if (Number.isFinite(n) && n > 0 && n <= 1) {
              onPatch({ default_solids: n });
              onCommit({ default_solids: n });
            }
          }}
          disabled={saving}
          style={inputStyle}
        >
          {SOLIDS_PRESETS.map((p) => (
            <option key={p.value} value={String(p.value)}>
              {p.label}
            </option>
          ))}
          {!SOLIDS_PRESETS.find((p) => p.value === row.default_solids) ? (
            <option value={String(row.default_solids)}>
              {row.default_solids} (custom)
            </option>
          ) : null}
        </select>
      </label>

      {/* Category */}
      <label>
        <span style={cellLabelStyle}>Category</span>
        <select
          value={row.category ?? ""}
          onChange={(e) => {
            const v = e.target.value || null;
            onPatch({ category: v });
            onCommit({ category: v });
          }}
          disabled={saving}
          style={inputStyle}
        >
          {CATEGORY_OPTIONS.map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}
            </option>
          ))}
        </select>
      </label>

      {/* Notes */}
      <label>
        <span style={cellLabelStyle}>Notes</span>
        <input
          value={row.notes ?? ""}
          onChange={(e) => onPatch({ notes: e.target.value })}
          onBlur={() => onCommit({ notes: row.notes })}
          disabled={saving}
          placeholder="—"
          style={inputStyle}
        />
      </label>

      {/* Actions */}
      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        {row.active ? (
          <button
            type="button"
            title="Mark inactive"
            onClick={onDeactivate}
            disabled={saving}
            style={{
              background: "transparent",
              border: "none",
              color: "var(--ink-3, #8a9498)",
              fontSize: 16,
              cursor: saving ? "not-allowed" : "pointer",
              padding: "4px 8px",
              fontFamily: "inherit",
            }}
          >
            ×
          </button>
        ) : (
          <button
            type="button"
            title="Reactivate"
            onClick={() => onCommit({ active: true })}
            disabled={saving}
            style={{
              background: "transparent",
              border: "1px solid #a7e3df",
              color: "var(--teal-700, #1d6c7b)",
              fontSize: 11,
              cursor: saving ? "not-allowed" : "pointer",
              padding: "3px 8px",
              borderRadius: 6,
              fontFamily: "inherit",
              fontWeight: 700,
            }}
          >
            Restore
          </button>
        )}
      </div>
    </div>
  );
}
