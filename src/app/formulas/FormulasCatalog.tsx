"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  FORMULA_SHAPES,
  type GummyFormulaRecord,
} from "@/lib/formulas";

// Client-side board for the /formulas catalog. Owns:
//   - free-text search across PC-BK code, name, flavor
//   - shape filter
//   - "+ New formula" (creates a stub via POST /api/formulas, then navigates
//     to the editor at /formulas/[id])
//
// The list itself just renders the server-fetched initialFormulas —
// filtering is client-side because the catalog is expected to be small
// (dozens, not thousands). If it grows past ~500 rows we'll flip to
// server-side filtering via the existing GET /api/formulas params.

type Props = {
  initialFormulas: GummyFormulaRecord[];
  /** id → name lookup used to render the Customer column. */
  customersById: Record<string, string>;
  /** Admins see a Delete affordance per row; everyone else sees data only. */
  isAdmin: boolean;
};

export default function FormulasCatalog({
  initialFormulas,
  customersById,
  isAdmin,
}: Props) {
  const router = useRouter();
  const [formulas, setFormulas] = useState<GummyFormulaRecord[]>(initialFormulas);
  const [query, setQuery] = useState("");
  const [shapeFilter, setShapeFilter] = useState<string>("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  async function handleDelete(id: string) {
    setDeletingId(id);
    setDeleteError(null);
    try {
      const res = await fetch(`/api/formulas/${id}`, { method: "DELETE" });
      const json = await res.json();
      if (!res.ok || !json.ok) {
        setDeleteError(json.error || `delete_failed_${res.status}`);
        setDeletingId(null);
        return;
      }
      setFormulas((prev) => prev.filter((f) => f.id !== id));
      setDeletingId(null);
      setConfirmDeleteId(null);
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : "delete_failed");
      setDeletingId(null);
    }
  }

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return formulas.filter((f) => {
      if (shapeFilter && f.shape !== shapeFilter) return false;
      if (!q) return true;
      const hay = [f.pcBkCode ?? "", f.name, f.flavor ?? ""]
        .join("\n")
        .toLowerCase();
      return hay.includes(q);
    });
  }, [formulas, query, shapeFilter]);

  async function handleNewFormula() {
    setCreating(true);
    setCreateError(null);
    try {
      const res = await fetch("/api/formulas", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "Untitled gummy",
          shape: "TBD",
          // pcBkCode omitted → TBD
        }),
      });
      const json = await res.json();
      if (!res.ok || !json.ok) {
        setCreateError(json.error || `create_failed_${res.status}`);
        setCreating(false);
        return;
      }
      router.push(`/formulas/${json.formula.id}`);
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : "create_failed");
      setCreating(false);
    }
  }

  return (
    <div>
      {/* Toolbar: search, shape filter, + New formula ---------------- */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          flexWrap: "wrap",
          marginBottom: 14,
        }}
      >
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search by product code, name, or flavor…"
          className="pricing__input"
          style={{ flex: "1 1 260px", minWidth: 240 }}
          autoComplete="off"
        />
        <select
          value={shapeFilter}
          onChange={(e) => setShapeFilter(e.target.value)}
          className="pricing__input"
          style={{ flex: "0 0 auto", minWidth: 140 }}
        >
          <option value="">All shapes</option>
          {FORMULA_SHAPES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={handleNewFormula}
          disabled={creating}
          style={{
            padding: "10px 18px",
            background: "var(--teal-700, #1d6c7b)",
            color: "#fff",
            border: "1px solid var(--teal-900, #0f4a56)",
            borderRadius: 8,
            fontSize: 13,
            fontWeight: 700,
            cursor: creating ? "wait" : "pointer",
            whiteSpace: "nowrap",
          }}
        >
          {creating ? "Creating…" : "+ New formula"}
        </button>
      </div>

      {createError ? (
        <div
          role="alert"
          style={{
            marginBottom: 12,
            padding: "8px 12px",
            background: "#fdecec",
            border: "1px solid #f5c2c2",
            color: "#8b2f2f",
            borderRadius: 6,
            fontSize: 12,
          }}
        >
          Couldn&apos;t create formula: {createError}
        </div>
      ) : null}
      {deleteError ? (
        <div
          role="alert"
          style={{
            marginBottom: 12,
            padding: "8px 12px",
            background: "#fdecec",
            border: "1px solid #f5c2c2",
            color: "#8b2f2f",
            borderRadius: 6,
            fontSize: 12,
          }}
        >
          Couldn&apos;t delete formula: {deleteError}
        </div>
      ) : null}

      {/* Table --------------------------------------------------------- */}
      {filtered.length === 0 ? (
        <div
          style={{
            padding: "32px 16px",
            border: "1px dashed var(--line, #e3dcc9)",
            borderRadius: 8,
            textAlign: "center",
            color: "var(--ink-3, #8a9498)",
            fontSize: 14,
            background: "var(--cream-soft, #fbf6ec)",
          }}
        >
          {formulas.length === 0
            ? "No formulas yet. Click + New formula to author the first one."
            : "No formulas match those filters."}
        </div>
      ) : (
        <table
          style={{
            width: "100%",
            borderCollapse: "collapse",
            fontSize: 13,
            background: "var(--paper, #fffdf8)",
            border: "1px solid var(--line, #e3dcc9)",
            borderRadius: 8,
            overflow: "hidden",
          }}
        >
          <thead>
            <tr style={{ background: "var(--cream, #f6efe3)" }}>
              {/* Sequential formula identifier ("F0001") — DB-assigned so
                  operators have a scannable, catalog-stable handle. */}
              <Th>Formula</Th>
              <Th>Product Code</Th>
              <Th>Name</Th>
              <Th>Customer</Th>
              <Th>Shape</Th>
              <Th>Flavor</Th>
              <Th style={{ textAlign: "right" }}>Version</Th>
              <Th>Updated</Th>
              {isAdmin ? <Th style={{ textAlign: "right", width: 90 }}>Actions</Th> : null}
            </tr>
          </thead>
          <tbody>
            {filtered.map((f) => (
              <tr
                key={f.id}
                onClick={() => router.push(`/formulas/${f.id}`)}
                style={{
                  cursor: "pointer",
                  borderTop: "1px solid var(--line-2, #efe9da)",
                }}
                onMouseEnter={(e) =>
                  (e.currentTarget.style.background = "var(--cream-soft, #fbf6ec)")
                }
                onMouseLeave={(e) =>
                  (e.currentTarget.style.background = "transparent")
                }
              >
                <Td>
                  <code
                    style={{
                      fontSize: 12,
                      fontWeight: 700,
                      color: "var(--teal-900, #0f4a56)",
                      fontVariantNumeric: "tabular-nums",
                    }}
                  >
                    F{String(f.formulaNumber).padStart(4, "0")}
                  </code>
                </Td>
                <Td>
                  {f.pcBkCode ? (
                    <code
                      style={{
                        fontSize: 12,
                        fontWeight: 700,
                        color: "var(--teal-900, #0f4a56)",
                      }}
                    >
                      {f.pcBkCode}
                    </code>
                  ) : (
                    <span
                      style={{
                        display: "inline-block",
                        padding: "1px 8px",
                        border: "1px dashed var(--line, #e3dcc9)",
                        borderRadius: 999,
                        fontSize: 11,
                        color: "var(--ink-3, #8a9498)",
                        fontWeight: 700,
                      }}
                    >
                      TBD
                    </span>
                  )}
                </Td>
                <Td>
                  <span style={{ fontWeight: 600 }}>{f.name}</span>
                </Td>
                <Td>
                  {f.customerId && customersById[f.customerId] ? (
                    customersById[f.customerId]
                  ) : (
                    <em style={{ color: "#8a9498" }}>—</em>
                  )}
                </Td>
                <Td>
                  <span
                    style={{
                      display: "inline-block",
                      padding: "1px 8px",
                      background: "var(--cream, #f6efe3)",
                      border: "1px solid var(--line, #e3dcc9)",
                      borderRadius: 999,
                      fontSize: 11,
                      color: "var(--teal-900, #0f4a56)",
                      fontWeight: 700,
                    }}
                  >
                    {f.shape}
                  </span>
                </Td>
                <Td>{f.flavor || <em style={{ color: "#8a9498" }}>—</em>}</Td>
                <Td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                  {f.latestVersionNum > 0 ? `v${f.latestVersionNum}` : "—"}
                </Td>
                <Td style={{ color: "var(--ink-3, #8a9498)", fontSize: 12 }}>
                  {formatDate(f.updatedAt)}
                </Td>
                {isAdmin ? (
                  <Td
                    style={{ textAlign: "right", whiteSpace: "nowrap" }}
                    // Stop the row click (which opens the editor) from
                    // firing when the admin interacts with the delete
                    // controls in this cell.
                    onClick={(e) => e.stopPropagation()}
                  >
                    {confirmDeleteId === f.id ? (
                      <span style={{ display: "inline-flex", gap: 4, alignItems: "center" }}>
                        <button
                          type="button"
                          onClick={() => handleDelete(f.id)}
                          disabled={deletingId === f.id}
                          style={{
                            padding: "3px 10px",
                            background: "#a13a2a",
                            color: "#fff",
                            border: "none",
                            borderRadius: 4,
                            fontSize: 11,
                            fontWeight: 700,
                            letterSpacing: "0.04em",
                            textTransform: "uppercase",
                            cursor: deletingId === f.id ? "not-allowed" : "pointer",
                          }}
                        >
                          {deletingId === f.id ? "…" : "Delete"}
                        </button>
                        <button
                          type="button"
                          onClick={() => setConfirmDeleteId(null)}
                          disabled={deletingId === f.id}
                          style={{
                            padding: "3px 10px",
                            background: "transparent",
                            color: "var(--ink-2, #4a5c60)",
                            border: "1px solid var(--line, #e3dcc9)",
                            borderRadius: 4,
                            fontSize: 11,
                            fontWeight: 600,
                            cursor: "pointer",
                          }}
                        >
                          Keep
                        </button>
                      </span>
                    ) : (
                      <button
                        type="button"
                        onClick={() => setConfirmDeleteId(f.id)}
                        title="Admin only"
                        style={{
                          padding: "3px 8px",
                          background: "transparent",
                          color: "#a13a2a",
                          border: "none",
                          fontSize: 11,
                          fontWeight: 700,
                          letterSpacing: "0.04em",
                          textTransform: "uppercase",
                          cursor: "pointer",
                        }}
                      >
                        Delete
                      </button>
                    )}
                  </Td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

// --- helpers ---------------------------------------------------------------

function Th({
  children,
  style,
}: {
  children: React.ReactNode;
  style?: React.CSSProperties;
}) {
  return (
    <th
      style={{
        textAlign: "left",
        padding: "10px 12px",
        fontSize: 10.5,
        fontWeight: 700,
        letterSpacing: "0.14em",
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

function Td({
  children,
  style,
  onClick,
}: {
  children: React.ReactNode;
  style?: React.CSSProperties;
  onClick?: (e: React.MouseEvent) => void;
}) {
  return (
    <td
      style={{ padding: "10px 12px", verticalAlign: "middle", ...style }}
      onClick={onClick}
    >
      {children}
    </td>
  );
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "";
  return d.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}
