"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import type { WorkflowStatus } from "@/lib/workflows";
import { WORKFLOW_STATUS_LABELS } from "@/lib/workflows";

// Client child of /workflows. Owns the search box + live filtering. The
// parent (server) page does the data fetching + customer-name join, then
// hands us a flat list of pre-shaped rows.

export type WorkflowDisplayRow = {
  id: string;
  customerName: string;
  customerSub: string;
  typeLabel: string;
  productLabel: string;
  productSearchBlob: string;
  submitterFull: string;
  submitterShort: string;
  updatedRelative: string;
  updatedSort: number;
  pushed: boolean;
  status: WorkflowStatus;
};

type Props = {
  rows: WorkflowDisplayRow[];
};

export default function WorkflowTable({ rows }: Props) {
  const [search, setSearch] = useState("");

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) => {
      const hay = [
        r.customerName,
        r.customerSub,
        r.typeLabel,
        r.productLabel,
        r.productSearchBlob,
        r.submitterFull,
        r.submitterShort,
      ]
        .join(" ")
        .toLowerCase();
      return hay.includes(q);
    });
  }, [rows, search]);

  return (
    <>
      <input
        type="text"
        placeholder="Search customer, product, type, or submitter…"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        className="search-input"
      />

      {rows.length === 0 ? (
        <div className="table">
          <div className="table__empty">
            <div className="table__empty-title">No workflows yet</div>
            <Link href="/start" className="button-primary">
              + Create your first
            </Link>
          </div>
        </div>
      ) : (
        <div className="table">
          <div className="table__head">
            <div className="table__head-cell">Customer</div>
            <div className="table__head-cell">Quote type</div>
            <div className="table__head-cell">Products</div>
            <div className="table__head-cell">Submitter</div>
            <div className="table__head-cell">Updated &#x25BC;</div>
            <div className="table__head-cell">Status</div>
          </div>
          {filtered.length === 0 ? (
            <div className="table__empty">
              <div style={{ fontSize: 14 }}>No workflows match &ldquo;{search}&rdquo;.</div>
            </div>
          ) : (
            filtered.map((row) => (
              <Link key={row.id} href={`/workflow/${row.id}`} className="table__row">
                <div className="table__cell">
                  <span className="table__cell--strong">{row.customerName}</span>
                  {row.customerSub ? (
                    <span className="table__cell-sub">{row.customerSub}</span>
                  ) : null}
                </div>
                <div className="table__cell">{row.typeLabel || "—"}</div>
                <div className="table__cell">{row.productLabel || "—"}</div>
                <div className="table__cell" title={row.submitterFull}>
                  {row.submitterShort}
                </div>
                <div className="table__cell" style={{ color: "var(--ink-3)" }}>
                  {row.updatedRelative}
                </div>
                <div className="table__cell">
                  <span className={`status-pill status-pill--${row.status.replace("_", "-")}`}>
                    {WORKFLOW_STATUS_LABELS[row.status]}
                  </span>
                </div>
              </Link>
            ))
          )}
        </div>
      )}
    </>
  );
}
