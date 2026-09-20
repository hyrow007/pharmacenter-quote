"use client";

import {
  useCallback,
  useMemo,
  useState,
  type KeyboardEvent,
  type MouseEvent,
} from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import type { WorkflowStatus } from "@/lib/workflows";
import { WORKFLOW_STATUS_LABELS } from "@/lib/workflows";

// Client child of /workflows. Owns the search box + live filtering. The
// parent (server) page does the data fetching + customer-name join, then
// hands us a flat list of pre-shaped rows.

export type WorkflowDisplayRow = {
  id: string;
  // Already-formatted quote number, e.g. "Q0001".
  quoteNumberLabel: string;
  customerName: string;
  customerSub: string;
  typeLabel: string;
  // One-line summary of the workflow's products — e.g. "Omega 3 Softgels"
  // or "Omega 3 + Vitamin D3 Softgels". Built on the server in page.tsx.
  // Kept around for the search blob (lets users search by the auto-label
  // even if they typed an override that doesn't mention it).
  descriptionLabel: string;
  // Auto-generated label with no override applied. Used as the inline
  // editor's placeholder so the user can see the default before deciding
  // whether to type their own.
  autoDescription: string;
  // Trimmed user-typed override, or "" when none is stored. Drives the
  // initial input value for the inline editor.
  descriptionOverride: string;
  productSearchBlob: string;
  submitterFull: string;
  submitterShort: string;
  updatedRelative: string;
  updatedSort: number;
  pushed: boolean;
  status: WorkflowStatus;
  // Server-formatted USD total of the row's sales_orders, e.g. "$12,400.00".
  // Empty string when status !== "won" or there are no recorded SOs.
  salesOrdersTotalLabel: string;
  // True when the signed-in user is the workflow's creator or a member of
  // the admins table. Mirrors the RLS DELETE policy — used to decide whether
  // to render the inline trash button. RLS still enforces the rule server
  // side, this is purely a UI signal.
  canDelete: boolean;
};

type Props = {
  rows: WorkflowDisplayRow[];
};

// Per-row local edit state for the description editor. We track the live
// input value separately from the committed baseline so blur-save can
// short-circuit no-op edits and so we can roll back on a server error.
type DescDraft = { value: string; baseline: string; saving: boolean };

export default function WorkflowTable({ rows }: Props) {
  const router = useRouter();
  const [search, setSearch] = useState("");

  // Local state map keyed by row id. Seeded lazily on first edit per row so
  // we don't allocate state for rows the user never touches.
  const [drafts, setDrafts] = useState<Record<string, DescDraft>>({});
  // A small toast/status banner anchored at the bottom of the table when a
  // save errors. Successful saves are silent — the input retains the value.
  const [error, setError] = useState<string | null>(null);
  // Rows the user just deleted. We hide them optimistically while the API
  // round-trips so the UI feels instant. router.refresh() will eventually
  // re-fetch and the row will be gone from the server payload too.
  const [removedIds, setRemovedIds] = useState<Set<string>>(() => new Set());
  // While a delete is in flight we want to disable the button (and dim it)
  // to prevent double-fires; failing that we'd send two DELETEs back to back.
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const visibleRows = useMemo(
    () => (removedIds.size === 0 ? rows : rows.filter((r) => !removedIds.has(r.id))),
    [rows, removedIds],
  );

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return visibleRows;
    return visibleRows.filter((r) => {
      const draft = drafts[r.id];
      const liveDescription = draft ? draft.value : r.descriptionOverride;
      const hay = [
        r.quoteNumberLabel,
        r.customerName,
        r.customerSub,
        r.typeLabel,
        r.descriptionLabel,
        liveDescription,
        r.productSearchBlob,
        r.submitterFull,
        r.submitterShort,
      ]
        .join(" ")
        .toLowerCase();
      return hay.includes(q);
    });
  }, [visibleRows, search, drafts]);

  const setDraftValue = useCallback((id: string, baseline: string, value: string) => {
    setDrafts((prev) => ({
      ...prev,
      [id]: { value, baseline, saving: prev[id]?.saving ?? false },
    }));
  }, []);

  // Inline delete from the row's trash button. The browser confirm() is the
  // standard "are you sure" — we keep it lightweight, matching the detail
  // page's affordance. RLS enforces owner-or-admin on the API side, so a
  // forbidden response (which shouldn't happen since canDelete is server-
  // computed) still bounces gracefully.
  const deleteRow = useCallback(
    async (id: string, label: string) => {
      if (deletingId) return;
      const ok = window.confirm(
        `Delete ${label}? This cannot be undone. Files in storage will remain.`,
      );
      if (!ok) return;
      setError(null);
      setDeletingId(id);
      // Optimistic hide.
      setRemovedIds((prev) => {
        const next = new Set(prev);
        next.add(id);
        return next;
      });
      try {
        const res = await fetch(`/api/workflows/${id}`, { method: "DELETE" });
        const data = await res.json().catch(() => null);
        if (!res.ok || !data?.ok) {
          const reason = data?.error || `HTTP ${res.status}`;
          // Roll back the optimistic hide.
          setRemovedIds((prev) => {
            const next = new Set(prev);
            next.delete(id);
            return next;
          });
          setError(
            reason === "forbidden"
              ? "Only the workflow owner or an admin can delete this."
              : `Delete failed: ${reason}`,
          );
          return;
        }
        // Refresh server data so the row is gone from the next render too.
        router.refresh();
      } catch (err) {
        setRemovedIds((prev) => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
        const msg = err instanceof Error ? err.message : String(err);
        setError(`Delete errored: ${msg}`);
      } finally {
        setDeletingId(null);
      }
    },
    [deletingId, router],
  );

  const commitDraft = useCallback(
    async (id: string, baseline: string, autoLabel: string, raw: string) => {
      const next = raw.trim();
      if (next === baseline) return; // no-op
      setError(null);
      setDrafts((prev) => ({
        ...prev,
        [id]: { value: next, baseline: next, saving: true },
      }));
      try {
        const res = await fetch(`/api/workflows/${id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ description_override: next === "" ? null : next }),
        });
        const data = await res.json();
        if (!res.ok || !data?.ok) {
          const reason = data?.error || `HTTP ${res.status}`;
          setError(
            reason === "description_too_long"
              ? "Description is too long — keep it under 200 characters."
              : `Couldn't save description: ${reason}`,
          );
          // Roll back: restore the previous baseline so the row reverts.
          setDrafts((prev) => ({
            ...prev,
            [id]: { value: baseline, baseline, saving: false },
          }));
          return;
        }
        setDrafts((prev) => ({
          ...prev,
          [id]: { value: next, baseline: next, saving: false },
        }));
        // Refresh server data so the auto-label / search blob update if the
        // override now matches something else and so the "Updated" cell ticks.
        router.refresh();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setError(`Description save errored: ${msg}`);
        setDrafts((prev) => ({
          ...prev,
          [id]: { value: baseline, baseline, saving: false },
        }));
      }
    },
    [router],
  );

  return (
    <>
      <input
        type="text"
        placeholder="Search quote #, customer, description, type, or submitter…"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        className="search-input"
      />

      {rows.length === 0 ? (
        <div className="table">
          <div className="table__empty">
            <div className="table__empty-title">No workflows yet</div>
            <Link href="/start?fresh=1" className="button-primary">
              + Create your first
            </Link>
          </div>
        </div>
      ) : (
        <div className="table">
          <div className="table__head">
            <div className="table__head-cell">Customer</div>
            <div className="table__head-cell">Quote #</div>
            <div className="table__head-cell">Quote type</div>
            <div className="table__head-cell">Description</div>
            <div className="table__head-cell">Submitter</div>
            <div className="table__head-cell">Updated &#x25BC;</div>
            <div className="table__head-cell">Status</div>
          </div>
          {filtered.length === 0 ? (
            <div className="table__empty">
              <div style={{ fontSize: 14 }}>No workflows match &ldquo;{search}&rdquo;.</div>
            </div>
          ) : (
            filtered.map((row) => {
              const draft = drafts[row.id];
              const value = draft ? draft.value : row.descriptionOverride;
              const baseline = draft ? draft.baseline : row.descriptionOverride;
              const saving = !!draft?.saving;
              return (
                <Link key={row.id} href={`/workflow/${row.id}`} className="table__row">
                  <div className="table__cell">
                    <span className="table__cell--strong">{row.customerName}</span>
                  </div>
                  <div className="table__cell">
                    <span className="table__cell-quote-number">{row.quoteNumberLabel}</span>
                  </div>
                  <div className="table__cell">{row.typeLabel || "—"}</div>
                  <DescriptionCell
                    value={value}
                    baseline={baseline}
                    saving={saving}
                    autoLabel={row.autoDescription}
                    onChange={(v) => setDraftValue(row.id, baseline, v)}
                    onCommit={(raw) => commitDraft(row.id, baseline, row.autoDescription, raw)}
                  />
                  <div className="table__cell" title={row.submitterFull}>
                    {row.submitterShort}
                  </div>
                  <div className="table__cell" style={{ color: "var(--ink-3)" }}>
                    {row.updatedRelative}
                  </div>
                  <div className="table__cell table__cell--status">
                    <span className={`status-pill status-pill--${row.status.replace("_", "-")}`}>
                      {WORKFLOW_STATUS_LABELS[row.status]}
                    </span>
                    {row.salesOrdersTotalLabel ? (
                      <span className="table__cell-sub table__cell-sub--won">
                        {row.salesOrdersTotalLabel}
                      </span>
                    ) : null}
                    {row.canDelete ? (
                      <button
                        type="button"
                        className="row-delete"
                        aria-label={`Delete ${row.quoteNumberLabel}`}
                        title="Delete workflow"
                        disabled={deletingId === row.id}
                        // Stop the click from reaching the parent <Link>;
                        // otherwise Next would navigate to /workflow/[id]
                        // before our handler even runs.
                        onMouseDown={(e) => e.stopPropagation()}
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          deleteRow(
                            row.id,
                            `${row.quoteNumberLabel} (${row.customerName})`,
                          );
                        }}
                      >
                        {deletingId === row.id ? "…" : "✕"}
                      </button>
                    ) : null}
                  </div>
                </Link>
              );
            })
          )}
        </div>
      )}

      {error ? (
        <div className="table__inline-error" role="alert" onClick={() => setError(null)}>
          {error} <span style={{ marginLeft: 8, opacity: 0.7 }}>(dismiss)</span>
        </div>
      ) : null}
    </>
  );
}

// Inline description cell with an always-visible input. Lives inside the
// row's <Link>, so we have to suppress clicks/keydowns from bubbling to the
// anchor — otherwise focusing the input would navigate to /workflow/[id].
// We mirror the row-cell look (no borders) until the user focuses in, at
// which point we draw the standard editor outline.
function DescriptionCell({
  value,
  baseline,
  saving,
  autoLabel,
  onChange,
  onCommit,
}: {
  value: string;
  baseline: string;
  saving: boolean;
  autoLabel: string;
  onChange: (next: string) => void;
  onCommit: (raw: string) => void;
}) {
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    // Don't let space, enter, etc. propagate up — the anchor element treats
    // Enter/Space as "activate" which would navigate.
    e.stopPropagation();
    if (e.key === "Enter") {
      e.preventDefault();
      e.currentTarget.blur(); // triggers onBlur → commit
    } else if (e.key === "Escape") {
      e.preventDefault();
      onChange(baseline);
      e.currentTarget.blur();
    }
  };

  // Both mouse + pointer events must be stopped or the parent Link will
  // navigate. preventDefault on the anchor click is what Next.Link uses to
  // intercept and route — stopping propagation here means that handler
  // never sees the event.
  const stop = (e: MouseEvent) => {
    e.stopPropagation();
  };

  return (
    <div
      className="table__cell table__cell--description"
      onClick={stop}
      onMouseDown={stop}
    >
      <input
        type="text"
        className="description-cell__input"
        value={value}
        placeholder={autoLabel || "Add a short description"}
        onChange={(e) => onChange(e.target.value)}
        onBlur={(e) => onCommit(e.currentTarget.value)}
        onKeyDown={onKeyDown}
        onClick={stop}
        onMouseDown={stop}
        maxLength={200}
        disabled={saving}
        autoComplete="off"
        aria-label="Workflow description"
      />
      {saving ? (
        <span className="description-cell__status">Saving…</span>
      ) : null}
    </div>
  );
}
