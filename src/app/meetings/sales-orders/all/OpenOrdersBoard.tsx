"use client";

import { Fragment, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";

// Client-side board for /meetings/sales-orders/all.
//
// UX cloned from the /formulas catalog (broad search, sortable
// headers, pagination) so the two sibling tables feel identical.
// Adds: "Include closed & estimates" toggle (calls /api/sales-orders
// ?all=1), a freshness stamp with a >26h red banner, and a Print
// button that renders a clean B/W letter page.

export type SoItem = {
  line: number | null;
  type_id: number | null;
  status_id: number | null;
  product_num: string | null;
  description: string | null;
  qty_ordered: number | null;
  qty_fulfilled: number | null;
  qty_picked: number | null;
  unit_price: number | null;
  total_price: number | null;
  date_scheduled: string | null;
};

export type SalesOrderRow = {
  fb_so_id: number;
  so_number: string;
  status_id: number | null;
  status_name: string | null;
  is_open: boolean;
  customer_name: string | null;
  customer_po: string | null;
  salesman: string | null;
  note: string | null;
  date_issued: string | null;
  date_created: string | null;
  date_first_ship: string | null;
  date_last_modified: string | null;
  subtotal: number | null;
  total_price: number | null;
  items: SoItem[];
  synced_at: string | null;
};

type SortKey =
  | "so_number"
  | "customer_name"
  | "customer_po"
  | "status_name"
  | "salesman"
  | "date_issued"
  | "date_first_ship"
  | "total_price"
  | "sale_items_count";
type SortDir = "asc" | "desc";
const PAGE_SIZE_OPTIONS = [10, 25, 50, 100] as const;
type PageSize = (typeof PAGE_SIZE_OPTIONS)[number];

// Storage keys — every meetings-namespaced local setting lives under
// "pharmacenter-quote-meetings-…" per quote/CLAUDE.md house rules. Never
// reuse a packing-list key.
const STORAGE_SORT = "pharmacenter-quote-meetings-so-sort";
const STORAGE_PAGE_SIZE = "pharmacenter-quote-meetings-so-page-size";
const STORAGE_INCLUDE_CLOSED =
  "pharmacenter-quote-meetings-so-include-closed";

const SALE_TYPE_IDS = new Set([10, 30]); // 10 sale, 30 drop ship

export default function OpenOrdersBoard({
  initialRows,
  initialSyncedAt,
}: {
  initialRows: SalesOrderRow[];
  initialSyncedAt: string | null;
}) {
  const router = useRouter();
  const [rows, setRows] = useState<SalesOrderRow[]>(initialRows);
  const [syncedAt, setSyncedAt] = useState<string | null>(initialSyncedAt);
  const [query, setQuery] = useState("");
  const [includeClosed, setIncludeClosed] = useState(false);
  const [loading, setLoading] = useState(false);
  const [sortKey, setSortKey] = useState<SortKey>("so_number");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [pageSize, setPageSize] = useState<PageSize>(25);
  const [page, setPage] = useState(1);
  const [expandedSo, setExpandedSo] = useState<string | null>(null);

  // Hydrate persisted UI settings on mount. Never touched by anything
  // packing-list-related — see CLAUDE.md storage table.
  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_SORT);
      if (raw) {
        const parsed = JSON.parse(raw) as { key: SortKey; dir: SortDir };
        if (parsed?.key) setSortKey(parsed.key);
        if (parsed?.dir) setSortDir(parsed.dir);
      }
      const ps = localStorage.getItem(STORAGE_PAGE_SIZE);
      if (ps) {
        const n = Number(ps) as PageSize;
        if (PAGE_SIZE_OPTIONS.includes(n)) setPageSize(n);
      }
      const ic = localStorage.getItem(STORAGE_INCLUDE_CLOSED);
      if (ic === "1") {
        setIncludeClosed(true);
        // Fire refetch on mount so the restored toggle shows real data.
        void refetch(true);
      }
    } catch {
      // localStorage disabled / private mode — fall through to defaults.
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(
        STORAGE_SORT,
        JSON.stringify({ key: sortKey, dir: sortDir }),
      );
    } catch {}
  }, [sortKey, sortDir]);
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_PAGE_SIZE, String(pageSize));
    } catch {}
  }, [pageSize]);

  async function refetch(all: boolean) {
    setLoading(true);
    try {
      const url = all
        ? "/api/sales-orders?all=1"
        : "/api/sales-orders";
      const res = await fetch(url, { cache: "no-store" });
      const json = await res.json();
      if (res.ok && json?.ok) {
        setRows(json.sales_orders as SalesOrderRow[]);
        setSyncedAt((json.synced_at as string | null) ?? null);
      }
    } catch {
      // Silent — the existing rows stay on screen and the user can
      // retry the toggle.
    } finally {
      setLoading(false);
    }
  }

  function toggleIncludeClosed(next: boolean) {
    setIncludeClosed(next);
    try {
      localStorage.setItem(STORAGE_INCLUDE_CLOSED, next ? "1" : "0");
    } catch {}
    void refetch(next);
  }

  // Derived: sale item count per row (excludes shipping/tax/discount).
  const withCounts = useMemo(
    () =>
      rows.map((r) => ({
        row: r,
        saleItems: (r.items ?? []).filter((it) =>
          it.type_id ? SALE_TYPE_IDS.has(it.type_id) : false,
        ),
      })),
    [rows],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return withCounts;
    return withCounts.filter(({ row: r }) => {
      const hay = [
        r.so_number,
        r.customer_name ?? "",
        r.customer_po ?? "",
        r.salesman ?? "",
        r.status_name ?? "",
      ]
        .join("\n")
        .toLowerCase();
      return hay.includes(q);
    });
  }, [withCounts, query]);

  const sorted = useMemo(() => {
    const dir = sortDir === "asc" ? 1 : -1;
    const cmpStr = (a: string, b: string) =>
      a.localeCompare(b, undefined, { sensitivity: "base" });
    const cmpNum = (a: number, b: number) => a - b;
    const val = (r: SalesOrderRow, saleCount: number): string | number => {
      switch (sortKey) {
        case "so_number":
          return Number(r.so_number) || 0;
        case "customer_name":
          return r.customer_name ?? "";
        case "customer_po":
          return r.customer_po ?? "";
        case "status_name":
          return r.status_name ?? "";
        case "salesman":
          return r.salesman ?? "";
        case "date_issued":
          return r.date_issued ?? "";
        case "date_first_ship":
          return r.date_first_ship ?? "";
        case "total_price":
          return Number(r.total_price) || 0;
        case "sale_items_count":
          return saleCount;
      }
    };
    const list = [...filtered];
    list.sort((a, b) => {
      const va = val(a.row, a.saleItems.length);
      const vb = val(b.row, b.saleItems.length);
      let base: number;
      if (typeof va === "number" && typeof vb === "number") {
        base = cmpNum(va, vb);
      } else {
        base = cmpStr(String(va), String(vb));
      }
      if (base !== 0) return base * dir;
      // Stable tie-break: SO number desc.
      return (Number(b.row.so_number) || 0) - (Number(a.row.so_number) || 0);
    });
    return list;
  }, [filtered, sortKey, sortDir]);

  const totalRows = sorted.length;
  const totalPages = Math.max(1, Math.ceil(totalRows / pageSize));
  useEffect(() => {
    if (page > totalPages) setPage(totalPages);
  }, [page, totalPages]);
  useEffect(() => {
    setPage(1);
  }, [query, sortKey, sortDir, pageSize, includeClosed]);
  const pageStart = (page - 1) * pageSize;
  const pageRows = sorted.slice(pageStart, pageStart + pageSize);

  function handleHeaderClick(key: SortKey) {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      // Numeric / date columns default to desc.
      setSortDir(
        key === "so_number" ||
          key === "date_issued" ||
          key === "date_first_ship" ||
          key === "total_price" ||
          key === "sale_items_count"
          ? "desc"
          : "asc",
      );
    }
  }

  const freshness = describeFreshness(syncedAt);

  return (
    <div>
      {/* Freshness banner ------------------------------------------- */}
      {freshness.stale ? (
        <div
          role="alert"
          className="meetings-print-friendly"
          style={{
            marginBottom: 12,
            padding: "10px 14px",
            background: "#fdecec",
            border: "1px solid #f5c2c2",
            color: "#8b2f2f",
            borderRadius: 6,
            fontSize: 13,
            fontWeight: 600,
          }}
        >
          Last night&rsquo;s Fishbowl sync did not run — this data is{" "}
          {freshness.relative}. Check the sync job.
        </div>
      ) : null}

      {/* Toolbar --------------------------------------------------- */}
      <div
        className="meetings-noprint"
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
          placeholder="Search SO #, customer, PO, salesman, or status…"
          className="pricing__input"
          style={{ flex: "1 1 260px", minWidth: 240 }}
          autoComplete="off"
        />
        <label
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 8,
            padding: "8px 12px",
            border: "1px solid var(--stone, #e3dcc9)",
            borderRadius: 8,
            background: "var(--paper, #fffdf8)",
            fontSize: 13,
            fontWeight: 600,
            color: "var(--ink-2, #415056)",
            whiteSpace: "nowrap",
            cursor: "pointer",
          }}
        >
          <input
            type="checkbox"
            checked={includeClosed}
            onChange={(e) => toggleIncludeClosed(e.target.checked)}
            disabled={loading}
          />
          Include closed &amp; estimates
        </label>
        <button
          type="button"
          onClick={() => window.print()}
          style={{
            padding: "10px 18px",
            background: "var(--teal-700, #1d6c7b)",
            color: "#fff",
            border: "1px solid var(--teal-900, #0f4a56)",
            borderRadius: 8,
            fontSize: 13,
            fontWeight: 700,
            cursor: "pointer",
            whiteSpace: "nowrap",
          }}
        >
          Print / Save PDF
        </button>
      </div>

      {/* Freshness stamp (always visible, prints black-on-white) --- */}
      <div
        style={{
          fontSize: 12,
          color: "var(--ink-3, #8a9498)",
          marginBottom: 10,
        }}
      >
        {includeClosed ? "Showing all orders · " : "Open orders · "}
        {totalRows.toLocaleString()} row{totalRows === 1 ? "" : "s"} ·{" "}
        Synced {freshness.relative}
        {loading ? " · loading…" : null}
      </div>

      {/* Table ----------------------------------------------------- */}
      {sorted.length === 0 ? (
        <div
          style={{
            padding: "32px 16px",
            border: "1px dashed var(--stone, #e3dcc9)",
            borderRadius: 8,
            textAlign: "center",
            color: "var(--ink-3, #8a9498)",
            fontSize: 14,
            background: "var(--cream-soft, #fbf6ec)",
          }}
        >
          {includeClosed
            ? "No orders match those filters. History begins Sep 15, 2026 — closed-order rows fill in nightly from that date forward."
            : "No open orders match those filters."}
        </div>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table
            style={{
              width: "100%",
              tableLayout: "fixed",
              borderCollapse: "collapse",
              fontSize: 13,
              background: "var(--paper, #fffdf8)",
              border: "1px solid var(--stone, #e3dcc9)",
              borderRadius: 8,
              overflow: "hidden",
            }}
          >
            <colgroup>
              <col style={{ width: 90 }} />
              <col />
              <col style={{ width: 110 }} />
              <col style={{ width: 100 }} />
              <col style={{ width: 110 }} />
              <col style={{ width: 100 }} />
              <col style={{ width: 100 }} />
              <col style={{ width: 100 }} />
              <col style={{ width: 60 }} />
            </colgroup>
            <thead>
              <tr style={{ background: "var(--cream, #f6efe3)" }}>
                <SortableTh
                  label="SO #"
                  colKey="so_number"
                  activeKey={sortKey}
                  activeDir={sortDir}
                  onSort={handleHeaderClick}
                />
                <SortableTh
                  label="Customer"
                  colKey="customer_name"
                  activeKey={sortKey}
                  activeDir={sortDir}
                  onSort={handleHeaderClick}
                />
                <SortableTh
                  label="PO"
                  colKey="customer_po"
                  activeKey={sortKey}
                  activeDir={sortDir}
                  onSort={handleHeaderClick}
                />
                <SortableTh
                  label="Status"
                  colKey="status_name"
                  activeKey={sortKey}
                  activeDir={sortDir}
                  onSort={handleHeaderClick}
                />
                <SortableTh
                  label="Salesman"
                  colKey="salesman"
                  activeKey={sortKey}
                  activeDir={sortDir}
                  onSort={handleHeaderClick}
                />
                <SortableTh
                  label="Issued"
                  colKey="date_issued"
                  activeKey={sortKey}
                  activeDir={sortDir}
                  onSort={handleHeaderClick}
                />
                <SortableTh
                  label="Scheduled ship"
                  colKey="date_first_ship"
                  activeKey={sortKey}
                  activeDir={sortDir}
                  onSort={handleHeaderClick}
                />
                <SortableTh
                  label="Total"
                  colKey="total_price"
                  activeKey={sortKey}
                  activeDir={sortDir}
                  onSort={handleHeaderClick}
                  align="right"
                />
                <SortableTh
                  label="Items"
                  colKey="sale_items_count"
                  activeKey={sortKey}
                  activeDir={sortDir}
                  onSort={handleHeaderClick}
                  align="right"
                />
              </tr>
            </thead>
            <tbody>
              {pageRows.map(({ row: r, saleItems }) => {
                const isExpanded = expandedSo === r.so_number;
                return (
                  <Fragment key={r.so_number}>
                    <tr
                      onClick={() =>
                        setExpandedSo(isExpanded ? null : r.so_number)
                      }
                      style={{
                        cursor: "pointer",
                        borderTop: "1px solid var(--stone-2, #efe9da)",
                        background: isExpanded
                          ? "var(--cream-soft, #fbf6ec)"
                          : "transparent",
                      }}
                    >
                      <Td>
                        <code
                          style={{
                            fontSize: 12.5,
                            fontWeight: 700,
                            color: "var(--teal-900, #0f4a56)",
                            fontVariantNumeric: "tabular-nums",
                          }}
                        >
                          {r.so_number}
                        </code>
                      </Td>
                      <Td>
                        <div
                          style={{
                            fontWeight: 600,
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          }}
                          title={r.customer_name ?? ""}
                        >
                          {r.customer_name || (
                            <em style={{ color: "#8a9498" }}>—</em>
                          )}
                        </div>
                      </Td>
                      <Td style={{ fontSize: 12 }}>
                        {r.customer_po || (
                          <em style={{ color: "#8a9498" }}>—</em>
                        )}
                      </Td>
                      <Td>
                        <StatusPill
                          statusId={r.status_id}
                          statusName={r.status_name}
                          isOpen={r.is_open}
                        />
                      </Td>
                      <Td style={{ fontSize: 12 }}>
                        {r.salesman || (
                          <em style={{ color: "#8a9498" }}>—</em>
                        )}
                      </Td>
                      <Td style={{ fontSize: 12 }}>
                        {formatDate(r.date_issued)}
                      </Td>
                      <Td style={{ fontSize: 12 }}>
                        {formatDate(r.date_first_ship)}
                      </Td>
                      <Td
                        style={{
                          textAlign: "right",
                          fontVariantNumeric: "tabular-nums",
                          fontFamily:
                            "'IBM Plex Mono', ui-monospace, monospace",
                          fontSize: 12.5,
                        }}
                      >
                        {formatMoney(r.total_price)}
                      </Td>
                      <Td
                        style={{
                          textAlign: "right",
                          fontVariantNumeric: "tabular-nums",
                          fontSize: 12.5,
                        }}
                      >
                        {saleItems.length.toLocaleString()}
                      </Td>
                    </tr>
                    {isExpanded ? (
                      <tr>
                        <td
                          colSpan={9}
                          style={{
                            padding: 0,
                            background: "var(--cream-soft, #fbf6ec)",
                            borderTop:
                              "1px solid var(--stone-2, #efe9da)",
                          }}
                        >
                          <ExpandedRow
                            row={r}
                            saleItems={saleItems}
                            onOpen={() =>
                              router.push(
                                `/meetings/sales-orders/orders/${r.so_number}`,
                              )
                            }
                          />
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Pagination ------------------------------------------------ */}
      {sorted.length > 0 ? (
        <div
          className="meetings-noprint"
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 16,
            marginTop: 18,
            fontSize: 13,
            color: "var(--ink-2, #415056)",
            flexWrap: "wrap",
          }}
        >
          <label
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 8,
            }}
          >
            <span>Per page:</span>
            <select
              value={pageSize}
              onChange={(e) =>
                setPageSize(Number(e.target.value) as PageSize)
              }
              className="pricing__input"
              style={{ minWidth: 72, padding: "6px 8px" }}
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
            style={pagerButton(page <= 1)}
          >
            &larr; Previous
          </button>
          <span
            style={{
              fontVariantNumeric: "tabular-nums",
              whiteSpace: "nowrap",
            }}
          >
            Page {page} of {totalPages}
          </span>
          <button
            type="button"
            onClick={() =>
              setPage((p) => Math.min(totalPages, p + 1))
            }
            disabled={page >= totalPages}
            style={pagerButton(page >= totalPages)}
          >
            Next &rarr;
          </button>
        </div>
      ) : null}
    </div>
  );
}

// --- expanded row ---------------------------------------------------------

function ExpandedRow({
  row,
  saleItems,
  onOpen,
}: {
  row: SalesOrderRow;
  saleItems: SoItem[];
  onOpen: () => void;
}) {
  return (
    <div style={{ padding: "14px 18px" }}>
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          gap: 12,
          marginBottom: 8,
        }}
      >
        <div style={{ fontSize: 12, color: "var(--ink-3, #8a9498)" }}>
          <strong style={{ color: "var(--teal-900, #0f4a56)" }}>
            SO {row.so_number}
          </strong>
          {" · "}
          {row.customer_name}
          {row.customer_po ? ` · PO ${row.customer_po}` : ""}
        </div>
        <button
          type="button"
          onClick={onOpen}
          className="meetings-noprint"
          style={{
            padding: "4px 10px",
            background: "transparent",
            color: "var(--teal-700, #1d6c7b)",
            border: "1px solid var(--stone, #e3dcc9)",
            borderRadius: 999,
            fontSize: 11,
            fontWeight: 700,
            letterSpacing: "0.06em",
            textTransform: "uppercase",
            cursor: "pointer",
          }}
        >
          Open detail &rarr;
        </button>
      </div>
      {row.note ? (
        <div
          style={{
            fontSize: 12.5,
            color: "var(--ink-2, #415056)",
            background: "var(--paper, #fffdf8)",
            border: "1px solid var(--stone, #e3dcc9)",
            borderRadius: 6,
            padding: "8px 10px",
            marginBottom: 10,
            whiteSpace: "pre-wrap",
          }}
        >
          <strong style={{ fontSize: 10.5, letterSpacing: "0.14em" }}>
            NOTE
          </strong>
          <div style={{ marginTop: 4 }}>{row.note}</div>
        </div>
      ) : null}
      {saleItems.length === 0 ? (
        <div style={{ fontSize: 12, color: "var(--ink-3, #8a9498)" }}>
          No sale/drop-ship line items.
        </div>
      ) : (
        <table
          style={{
            width: "100%",
            fontSize: 12,
            borderCollapse: "collapse",
            background: "var(--paper, #fffdf8)",
            border: "1px solid var(--stone, #e3dcc9)",
            borderRadius: 6,
          }}
        >
          <thead>
            <tr style={{ background: "var(--cream, #f6efe3)" }}>
              <ItemsTh>Product #</ItemsTh>
              <ItemsTh>Description</ItemsTh>
              <ItemsTh align="right">Ordered</ItemsTh>
              <ItemsTh align="right">Picked</ItemsTh>
              <ItemsTh align="right">Fulfilled</ItemsTh>
              <ItemsTh align="right">Unit $</ItemsTh>
              <ItemsTh align="right">Ext $</ItemsTh>
              <ItemsTh>Scheduled</ItemsTh>
            </tr>
          </thead>
          <tbody>
            {saleItems.map((it, i) => {
              const ordered = Number(it.qty_ordered) || 0;
              const picked = Number(it.qty_picked) || 0;
              const fulfilled = Number(it.qty_fulfilled) || 0;
              const pctFulfilled =
                ordered > 0
                  ? Math.min(100, Math.round((fulfilled / ordered) * 100))
                  : 0;
              return (
                <tr
                  key={i}
                  style={{
                    borderTop: "1px solid var(--stone-2, #efe9da)",
                  }}
                >
                  <ItemsTd
                    style={{
                      fontFamily:
                        "'IBM Plex Mono', ui-monospace, monospace",
                      fontWeight: 700,
                    }}
                  >
                    {it.product_num}
                  </ItemsTd>
                  <ItemsTd>{it.description}</ItemsTd>
                  <ItemsTd align="right">
                    {ordered.toLocaleString()}
                  </ItemsTd>
                  <ItemsTd align="right">
                    {picked.toLocaleString()}
                  </ItemsTd>
                  <ItemsTd align="right">
                    <div
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 8,
                      }}
                    >
                      <span>{fulfilled.toLocaleString()}</span>
                      <span
                        aria-hidden="true"
                        title={`${pctFulfilled}% fulfilled`}
                        style={{
                          display: "inline-block",
                          width: 40,
                          height: 6,
                          background: "var(--stone-2, #efe9da)",
                          borderRadius: 3,
                          overflow: "hidden",
                        }}
                      >
                        <span
                          style={{
                            display: "block",
                            width: `${pctFulfilled}%`,
                            height: "100%",
                            background: "var(--sage-500, #7fb04f)",
                          }}
                        />
                      </span>
                    </div>
                  </ItemsTd>
                  <ItemsTd align="right">
                    {formatMoney(it.unit_price)}
                  </ItemsTd>
                  <ItemsTd align="right">
                    {formatMoney(it.total_price)}
                  </ItemsTd>
                  <ItemsTd>{formatDate(it.date_scheduled)}</ItemsTd>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

// --- helpers --------------------------------------------------------------

function SortableTh({
  label,
  colKey,
  activeKey,
  activeDir,
  onSort,
  align,
}: {
  label: string;
  colKey: SortKey;
  activeKey: SortKey;
  activeDir: SortDir;
  onSort: (k: SortKey) => void;
  align?: "left" | "right";
}) {
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
      }}
    >
      {label}
      {arrow ? (
        <span
          style={{
            marginLeft: 6,
            fontSize: 9,
            color: "var(--teal-700, #1d6c7b)",
          }}
        >
          {arrow}
        </span>
      ) : null}
    </th>
  );
}

function Td({
  children,
  style,
}: {
  children: React.ReactNode;
  style?: React.CSSProperties;
}) {
  return (
    <td
      style={{
        padding: "10px 12px",
        verticalAlign: "middle",
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
        ...style,
      }}
    >
      {children}
    </td>
  );
}

function ItemsTh({
  children,
  align,
}: {
  children: React.ReactNode;
  align?: "left" | "right";
}) {
  return (
    <th
      style={{
        textAlign: align ?? "left",
        padding: "8px 10px",
        fontSize: 10,
        fontWeight: 700,
        letterSpacing: "0.14em",
        textTransform: "uppercase",
        color: "var(--ink-3, #8a9498)",
        borderBottom: "1px solid var(--stone, #e3dcc9)",
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </th>
  );
}

function ItemsTd({
  children,
  align,
  style,
}: {
  children: React.ReactNode;
  align?: "left" | "right";
  style?: React.CSSProperties;
}) {
  return (
    <td
      style={{
        textAlign: align ?? "left",
        padding: "8px 10px",
        verticalAlign: "middle",
        ...style,
      }}
    >
      {children}
    </td>
  );
}

function StatusPill({
  statusId,
  statusName,
  isOpen,
}: {
  statusId: number | null;
  statusName: string | null;
  isOpen: boolean;
}) {
  // Fishbowl statuses we care about: 10 Estimate, 20 Issued, 25 In Progress.
  // Closed rows (is_open=false) get a neutral treatment regardless of id.
  const label = statusName || "—";
  let bg = "var(--cream, #f6efe3)";
  let color = "var(--teal-900, #0f4a56)";
  let border = "var(--stone, #e3dcc9)";
  if (!isOpen) {
    bg = "#efe9da";
    color = "#7a7364";
  } else if (statusId === 10) {
    bg = "#fff8e1";
    color = "#8a6d1e";
    border = "#e7d59a";
  } else if (statusId === 25) {
    bg = "#eef4ee";
    color = "var(--sage-700, #5f8e3a)";
    border = "var(--sage-300, #bcd596)";
  }
  return (
    <span
      style={{
        display: "inline-block",
        padding: "1px 8px",
        background: bg,
        border: `1px solid ${border}`,
        borderRadius: 999,
        fontSize: 11,
        color,
        fontWeight: 700,
        whiteSpace: "nowrap",
      }}
    >
      {label}
    </span>
  );
}

function pagerButton(disabled: boolean): React.CSSProperties {
  return {
    padding: "6px 14px",
    background: "transparent",
    color: disabled
      ? "var(--ink-3, #8a9498)"
      : "var(--teal-900, #0f4a56)",
    border: "1px solid var(--stone, #e3dcc9)",
    borderRadius: 6,
    fontSize: 12.5,
    fontWeight: 700,
    cursor: disabled ? "not-allowed" : "pointer",
    whiteSpace: "nowrap",
  };
}

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "—";
  return d.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function formatMoney(n: number | null): string {
  if (n == null || !Number.isFinite(Number(n))) return "—";
  return `$${Number(n).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

// Freshness: how long ago did the sync run, and is it >26h old (i.e.
// last night's job failed)? Threshold matches the spec.
function describeFreshness(iso: string | null): {
  relative: string;
  stale: boolean;
} {
  if (!iso) return { relative: "never", stale: true };
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return { relative: "never", stale: true };
  const ageMs = Date.now() - t;
  const ageH = ageMs / (60 * 60 * 1000);
  const stale = ageH > 26;
  let relative: string;
  if (ageMs < 60_000) relative = "just now";
  else if (ageMs < 60 * 60_000)
    relative = `${Math.floor(ageMs / 60_000)} min ago`;
  else if (ageH < 24) relative = `${Math.floor(ageH)}h ago`;
  else relative = `${Math.floor(ageH / 24)}d ago`;
  return { relative, stale };
}
