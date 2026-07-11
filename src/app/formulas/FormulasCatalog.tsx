"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useLang } from "@/lib/i18n/context";
import { makeTr } from "@/lib/i18n/labels";
import {
  FORMULA_SHAPES,
  type GummyFormulaRecord,
} from "@/lib/formulas";

// Client-side board for the /formulas catalog. Owns:
//   - free-text search across Formula #, Product Code, Name, Customer, Flavor, Preparer
//   - shape filter
//   - clickable column headers → sort asc/desc with ▲/▼ arrow indicator
//   - pagination: per-page dropdown + Previous/Next + "Page X of Y"
//   - "+ New formula" (creates a stub via POST /api/formulas, then navigates
//     to the editor at /formulas/[id])
//
// The list itself just renders the server-fetched initialFormulas —
// filtering / sorting / paging are all client-side because the catalog
// is expected to be small (dozens, not thousands). If it grows past
// ~500 rows we'll flip to server-side filtering via the existing
// GET /api/formulas params.

type Props = {
  initialFormulas: GummyFormulaRecord[];
  /** id → name lookup used to render the Customer column. */
  customersById: Record<string, string>;
  /** Admins see a Delete affordance per row; everyone else sees data only. */
  isAdmin: boolean;
};

// Sortable columns — keyed to header labels so the header rendering
// can drive sort state in one place. `label` is what appears in the
// header cell; `key` is the internal sort discriminator. Any header
// with `sortable: false` renders without the click behavior + arrow.
type SortKey =
  | "formulaNumber"
  | "pcBkCode"
  | "name"
  | "customer"
  | "shape"
  | "flavor"
  | "latestVersionNum"
  | "updatedAt";
type SortDir = "asc" | "desc";

type ColumnConfig = {
  key: SortKey | null;
  label: string;
  align?: "left" | "right";
  width?: number;
};

const PAGE_SIZE_OPTIONS = [10, 25, 50, 100] as const;
type PageSize = (typeof PAGE_SIZE_OPTIONS)[number];

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
  const lang = useLang();
  const tr = makeTr(lang);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  // Sort state — default to most-recently-updated first, matching how
  // the server hydrates the initial list.
  const [sortKey, setSortKey] = useState<SortKey>("updatedAt");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  // Pagination state. `page` is 1-indexed for user-facing labels.
  const [pageSize, setPageSize] = useState<PageSize>(10);
  const [page, setPage] = useState(1);

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

  // Preparer display — the audit trail carries the creator email; the
  // catalog uses the local-part as a compact "preparer" identity in
  // search matches. Falls back to the raw email when a name can't be
  // parsed. Matches the Packing List behavior where operators search
  // by their own email prefix.
  function preparerHandle(f: GummyFormulaRecord): string {
    const email = (f.createdByEmail ?? "").trim();
    if (!email) return "";
    const at = email.indexOf("@");
    return at > 0 ? email.slice(0, at) : email;
  }

  function customerName(f: GummyFormulaRecord): string {
    if (f.customerId && customersById[f.customerId]) {
      return customersById[f.customerId];
    }
    return "";
  }

  // Filter first (search + shape) — then sort. The search field looks
  // across every operator-facing string on the row: Formula #, Product
  // Code, Name, Customer name, Flavor, and Preparer handle.
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return formulas.filter((f) => {
      if (shapeFilter && f.shape !== shapeFilter) return false;
      if (!q) return true;
      const formulaLabel = `F${String(f.formulaNumber).padStart(4, "0")}`;
      const hay = [
        formulaLabel,
        f.pcBkCode ?? "",
        f.name,
        customerName(f),
        f.flavor ?? "",
        preparerHandle(f),
      ]
        .join("\n")
        .toLowerCase();
      return hay.includes(q);
    });
  }, [formulas, query, shapeFilter, customersById]);

  // Sort — pure comparator over the filtered slice. String columns
  // compare case-insensitively; the numeric columns (formulaNumber,
  // latestVersionNum) compare as numbers; updatedAt compares as an
  // ISO timestamp string (lexicographic works because the ISO format
  // is stable). Ties fall through to updatedAt desc so the display is
  // stable across identical-sort-value rows.
  const sorted = useMemo(() => {
    const dir = sortDir === "asc" ? 1 : -1;
    const cmpStr = (a: string, b: string) =>
      a.localeCompare(b, undefined, { sensitivity: "base" });
    const cmpNum = (a: number, b: number) => a - b;
    const getVal = (f: GummyFormulaRecord): string | number => {
      switch (sortKey) {
        case "formulaNumber":
          return f.formulaNumber;
        case "pcBkCode":
          return f.pcBkCode ?? "";
        case "name":
          return f.name;
        case "customer":
          return customerName(f);
        case "shape":
          return f.shape;
        case "flavor":
          return f.flavor ?? "";
        case "latestVersionNum":
          return f.latestVersionNum;
        case "updatedAt":
          return f.updatedAt;
      }
    };
    const rows = [...filtered];
    rows.sort((a, b) => {
      const va = getVal(a);
      const vb = getVal(b);
      let base: number;
      if (typeof va === "number" && typeof vb === "number") {
        base = cmpNum(va, vb);
      } else {
        base = cmpStr(String(va), String(vb));
      }
      if (base !== 0) return base * dir;
      // Stable tie-break: most-recent-first.
      return b.updatedAt.localeCompare(a.updatedAt);
    });
    return rows;
  }, [filtered, sortKey, sortDir, customersById]);

  // Pagination — clamp to a valid page whenever the filtered/sorted
  // list shrinks (e.g. after a search that returns fewer pages than
  // the current page number).
  const totalRows = sorted.length;
  const totalPages = Math.max(1, Math.ceil(totalRows / pageSize));
  useEffect(() => {
    if (page > totalPages) setPage(totalPages);
  }, [page, totalPages]);
  // Reset to page 1 when the operator changes search / filter / sort
  // so they land on the first page of the new result set.
  useEffect(() => {
    setPage(1);
  }, [query, shapeFilter, sortKey, sortDir, pageSize]);

  const pageStart = (page - 1) * pageSize;
  const pageRows = sorted.slice(pageStart, pageStart + pageSize);

  function handleHeaderClick(key: SortKey) {
    if (sortKey === key) {
      // Toggle direction on the same column.
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      // First click on a new column: string columns default to asc,
      // numeric / date columns default to desc (newest / largest first,
      // matching what operators usually want).
      setSortKey(key);
      setSortDir(
        key === "updatedAt" ||
          key === "formulaNumber" ||
          key === "latestVersionNum"
          ? "desc"
          : "asc",
      );
    }
  }

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

  // Header config — order determines the on-screen column order. Add
  // sortable keys here to include them in the click-to-sort behavior.
  const columns: ColumnConfig[] = [
    { key: "formulaNumber", label: "Formula" },
    { key: "pcBkCode", label: "Product Code" },
    { key: "name", label: "Name" },
    { key: "customer", label: "Customer" },
    { key: "shape", label: "Shape" },
    { key: "flavor", label: "Flavor" },
    { key: "latestVersionNum", label: "Version", align: "right" },
    { key: "updatedAt", label: "Updated" },
  ];

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
          placeholder={tr("Search customer, product code, name, flavor, or preparer…")}
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
          <option value="">{tr("All shapes")}</option>
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
          {creating ? tr("Creating…") : tr("+ New formula")}
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
      {sorted.length === 0 ? (
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
            ? tr("No formulas yet. Click + New formula to author the first one.")
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
              {columns.map((col) => (
                <SortableTh
                  key={col.label}
                  label={col.label}
                  colKey={col.key}
                  activeKey={sortKey}
                  activeDir={sortDir}
                  onSort={handleHeaderClick}
                  align={col.align}
                  width={col.width}
                />
              ))}
              {isAdmin ? <Th style={{ textAlign: "right", width: 90 }}>{tr("Actions")}</Th> : null}
            </tr>
          </thead>
          <tbody>
            {pageRows.map((f) => (
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
                        {tr("Delete")}
                      </button>
                    )}
                  </Td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {/* Pagination controls — Per page / Previous / Page X of Y / Next.
          Mirrors the Packing List catalog so operators moving between
          apps get the same footer treatment. Only rendered when there
          are enough rows to warrant paging so an empty catalog stays
          clean. */}
      {sorted.length > 0 ? (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 16,
            marginTop: 18,
            fontSize: 13,
            color: "var(--ink-2, #4a5c60)",
            flexWrap: "wrap",
          }}
        >
          <label
            style={{ display: "inline-flex", alignItems: "center", gap: 8 }}
          >
            <span>{tr("Per page:")}</span>
            <select
              value={pageSize}
              onChange={(e) => setPageSize(Number(e.target.value) as PageSize)}
              className="pricing__input"
              style={{ flex: "0 0 auto", minWidth: 72, padding: "6px 8px" }}
            >
              {PAGE_SIZE_OPTIONS.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={page <= 1}
            style={{
              padding: "6px 14px",
              background: "transparent",
              color:
                page <= 1
                  ? "var(--ink-3, #8a9498)"
                  : "var(--teal-900, #0f4a56)",
              border: "1px solid var(--line, #e3dcc9)",
              borderRadius: 6,
              fontSize: 12.5,
              fontWeight: 700,
              cursor: page <= 1 ? "not-allowed" : "pointer",
              whiteSpace: "nowrap",
            }}
          >
            &larr; {tr("Previous")}
          </button>
          <span
            style={{
              fontVariantNumeric: "tabular-nums",
              whiteSpace: "nowrap",
            }}
          >
            {lang === "es" ? <>Página {page} de {totalPages}</> : <>Page {page} of {totalPages}</>}
          </span>
          <button
            type="button"
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            disabled={page >= totalPages}
            style={{
              padding: "6px 14px",
              background: "transparent",
              color:
                page >= totalPages
                  ? "var(--ink-3, #8a9498)"
                  : "var(--teal-900, #0f4a56)",
              border: "1px solid var(--line, #e3dcc9)",
              borderRadius: 6,
              fontSize: 12.5,
              fontWeight: 700,
              cursor: page >= totalPages ? "not-allowed" : "pointer",
              whiteSpace: "nowrap",
            }}
          >
            {tr("Next")} &rarr;
          </button>
        </div>
      ) : null}
    </div>
  );
}

// --- helpers ---------------------------------------------------------------

// Clickable header cell — reused for every sortable column. Shows an
// up/down arrow when it owns the current sort. Non-sortable columns
// pass colKey={null} and render as a plain <Th>.
function SortableTh({
  label,
  colKey,
  activeKey,
  activeDir,
  onSort,
  align,
  width,
}: {
  label: string;
  colKey: SortKey | null;
  activeKey: SortKey;
  activeDir: SortDir;
  onSort: (key: SortKey) => void;
  align?: "left" | "right";
  width?: number;
}) {
  const tr = makeTr(useLang());
  if (colKey === null) {
    return (
      <Th style={{ textAlign: align, width }}>{tr(label)}</Th>
    );
  }
  const isActive = activeKey === colKey;
  const arrow = isActive ? (activeDir === "asc" ? "▲" : "▼") : "";
  return (
    <th
      onClick={() => onSort(colKey)}
      style={{
        textAlign: align ?? "left",
        padding: "10px 12px",
        fontSize: 10.5,
        fontWeight: 700,
        letterSpacing: "0.14em",
        textTransform: "uppercase",
        color: isActive
          ? "var(--teal-900, #0f4a56)"
          : "var(--ink-3, #8a9498)",
        borderBottom: "1.5px solid var(--teal-700, #1d6c7b)",
        cursor: "pointer",
        userSelect: "none",
        whiteSpace: "nowrap",
        width,
      }}
      title={`Sort by ${label}`}
    >
      {label}
      {arrow ? (
        <span
          style={{
            marginLeft: 6,
            fontSize: 9,
            color: "var(--teal-700, #1d6c7b)",
          }}
          aria-hidden="true"
        >
          {arrow}
        </span>
      ) : null}
    </th>
  );
}

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
