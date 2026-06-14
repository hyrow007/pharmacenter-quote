"use client";

// Interactive bits for /workflow/[id]: the Push/Update Monday button, the
// Delete button, and the toast. Lives in its own client module so the parent
// server component can do `auth.getUser()` + Supabase fetches without dragging
// the whole page over the client boundary.

import { useState, type CSSProperties } from "react";
import { useRouter } from "next/navigation";
import {
  WORKFLOW_STATUS_LABELS,
  type SalesOrder,
  type WorkflowRow,
  type WorkflowStatus,
} from "@/lib/workflows";
import type { Customer } from "@/lib/supabase";

// Draft row used by the inline Won form. Both fields are strings until we
// validate-and-coerce on save (numbers via parseFloat). Keeps controlled
// inputs predictable and avoids "" → 0 surprises while the user types.
type SalesOrderDraft = { so_number: string; value: string };

function draftsFromSalesOrders(rows: SalesOrder[]): SalesOrderDraft[] {
  if (!rows || rows.length === 0) return [{ so_number: "", value: "" }];
  return rows.map((r) => ({ so_number: r.so_number, value: String(r.value) }));
}

type ProductRow = { id: string; name: string; fp_code: string | null };

type Props = {
  workflow: WorkflowRow;
  customer: Pick<Customer, "id" | "name"> | null;
  productMap: Record<string, ProductRow>;
  isOwner: boolean;
  isAdmin: boolean;
};

const primaryAction: CSSProperties = {
  display: "flex", flexDirection: "column", gap: 4,
  padding: "16px 18px", borderRadius: 10, border: "1.5px solid var(--teal-900)",
  background: "var(--teal-900)", color: "#fff", cursor: "pointer",
  fontFamily: "inherit", fontSize: 15, fontWeight: 700, textAlign: "left",
  transition: "transform 0.12s ease, box-shadow 0.12s ease",
};
const editAction: CSSProperties = {
  display: "flex", flexDirection: "column", gap: 4,
  padding: "16px 18px", borderRadius: 10, border: "1.5px solid #e3dcc9",
  background: "#fffdf8", color: "var(--teal-900)", cursor: "pointer",
  fontFamily: "inherit", fontSize: 15, fontWeight: 700, textAlign: "left",
  textDecoration: "none",
};
const deleteAction: CSSProperties = {
  display: "flex", flexDirection: "column", gap: 4,
  padding: "16px 18px", borderRadius: 10, border: "1.5px solid #d8b3b3",
  background: "#fffdf8", color: "#8b2f2f", cursor: "pointer",
  fontFamily: "inherit", fontSize: 15, fontWeight: 700, textAlign: "left",
};
const blankAction: CSSProperties = {
  display: "flex", flexDirection: "column", gap: 4,
  padding: "16px 18px", borderRadius: 10, border: "1.5px dashed #e3dcc9",
  background: "#fffdf8", color: "var(--ink-3)", cursor: "not-allowed",
  fontFamily: "inherit", fontSize: 15, fontWeight: 700, textAlign: "left",
};

function cleanQty(q: string): string {
  const t = q.replace(/,/g, "").trim();
  return /^\d+(\.\d+)?$/.test(t) ? t : "";
}

export default function WorkflowActions({ workflow, customer, productMap, isOwner, isAdmin }: Props) {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  // Local mirror of the monday URL so the button can flip its label without
  // a full page refresh (server-rendered URL is the source of truth on load).
  const [mondayUrl, setMondayUrl] = useState<string | null>(workflow.monday_item_url);
  const alreadyPushed = !!mondayUrl;

  // Optimistic status — the API roundtrips and we render the new pill
  // immediately. Falls back to the server value on next render.
  const [status, setStatus] = useState<WorkflowStatus>(workflow.status ?? "in_progress");
  const [statusSaving, setStatusSaving] = useState<WorkflowStatus | null>(null);

  // Inline Sales Order form. Opens when the user clicks the Won pill (either
  // to flip *into* Won, or to edit the SOs while already Won). We hold the
  // current SOs locally so the summary card can re-render after a save
  // without waiting for the router refresh roundtrip.
  const [salesOrders, setSalesOrders] = useState<SalesOrder[]>(workflow.sales_orders ?? []);
  const [soFormOpen, setSoFormOpen] = useState(false);
  const [soDrafts, setSoDrafts] = useState<SalesOrderDraft[]>(
    draftsFromSalesOrders(workflow.sales_orders ?? []),
  );
  const [soError, setSoError] = useState<string | null>(null);
  const [soSaving, setSoSaving] = useState(false);

  const showToast = (msg: string, ms = 5500) => {
    setToast(msg);
    window.setTimeout(() => setToast((prev) => (prev === msg ? null : prev)), ms);
  };

  const openSoForm = (initial: SalesOrder[]) => {
    setSoDrafts(draftsFromSalesOrders(initial));
    setSoError(null);
    setSoFormOpen(true);
  };

  const closeSoForm = () => {
    setSoFormOpen(false);
    setSoError(null);
  };

  // Won click: either open the form (to enter SOs) or, if already won, open
  // it pre-populated with the current SOs so the user can tweak them.
  const onWonClick = () => {
    if (statusSaving || soSaving) return;
    openSoForm(salesOrders);
  };

  // In-progress / Lost click. If we're leaving Won, warn first — server will
  // clear sales_orders, and we don't want that to be a silent surprise.
  const onNonWonClick = async (next: WorkflowStatus) => {
    if (status === next || statusSaving || soSaving) return;
    if (status === "won") {
      const ok = window.confirm(
        "Changing away from Won will clear the recorded sales orders. Continue?",
      );
      if (!ok) return;
    }
    const prev = status;
    const prevSos = salesOrders;
    setStatus(next);
    setSalesOrders([]);
    setStatusSaving(next);
    try {
      const res = await fetch(`/api/workflows/${workflow.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: next }),
      });
      const data = await res.json();
      if (!res.ok || !data?.ok) {
        setStatus(prev);
        setSalesOrders(prevSos);
        showToast(`Couldn't change status: ${data?.error || res.status}`, 6500);
        return;
      }
      showToast(`Marked as ${WORKFLOW_STATUS_LABELS[next]}.`);
      router.refresh();
    } catch (err) {
      setStatus(prev);
      setSalesOrders(prevSos);
      const msg = err instanceof Error ? err.message : String(err);
      showToast(`Status save errored: ${msg}`, 6500);
    } finally {
      setStatusSaving(null);
    }
  };

  const setDraftField = (idx: number, field: keyof SalesOrderDraft, val: string) => {
    setSoDrafts((rows) => rows.map((r, i) => (i === idx ? { ...r, [field]: val } : r)));
  };
  const addDraftRow = () => {
    setSoDrafts((rows) => [...rows, { so_number: "", value: "" }]);
  };
  const removeDraftRow = (idx: number) => {
    setSoDrafts((rows) => (rows.length <= 1 ? rows : rows.filter((_, i) => i !== idx)));
  };

  const submitSoForm = async () => {
    if (soSaving) return;
    // Validate: at least one row, every row has a non-empty SO + value > 0.
    const cleaned: SalesOrder[] = [];
    for (const d of soDrafts) {
      const so = d.so_number.trim();
      const val = parseFloat(d.value);
      if (!so) {
        setSoError("Every row needs an SO number.");
        return;
      }
      if (!Number.isFinite(val) || val <= 0) {
        setSoError("Every row needs a dollar value greater than zero.");
        return;
      }
      cleaned.push({ so_number: so, value: val });
    }
    if (cleaned.length === 0) {
      setSoError("Add at least one sales order.");
      return;
    }

    // Optimistic: flip status + SOs immediately, roll back on error.
    const wasWon = status === "won";
    const prevStatus = status;
    const prevSos = salesOrders;
    setStatus("won");
    setSalesOrders(cleaned);
    setSoError(null);
    setSoSaving(true);
    try {
      const body = wasWon
        ? { sales_orders: cleaned }
        : { status: "won" as const, sales_orders: cleaned };
      const res = await fetch(`/api/workflows/${workflow.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok || !data?.ok) {
        setStatus(prevStatus);
        setSalesOrders(prevSos);
        showToast(`Couldn't save sales orders: ${data?.error || res.status}`, 6500);
        return;
      }
      showToast(wasWon ? "Sales orders updated." : "Marked as Won.");
      setSoFormOpen(false);
      router.refresh();
    } catch (err) {
      setStatus(prevStatus);
      setSalesOrders(prevSos);
      const msg = err instanceof Error ? err.message : String(err);
      showToast(`Sales order save errored: ${msg}`, 6500);
    } finally {
      setSoSaving(false);
    }
  };

  const pushToMonday = async () => {
    if (submitting) return;
    setSubmitting(true);
    try {
      const state = workflow.state;
      const products = state.products.map((p) => ({
        productId: p.productId,
        productName:
          p.mode === "new"
            ? p.newProduct.name_desc
            : productMap[p.productId ?? ""]?.name ?? null,
        productCode:
          p.mode === "new" ? null : productMap[p.productId ?? ""]?.fp_code ?? null,
        notes: p.mode === "new" ? p.newProduct.notes : "",
        quantities: p.quantities.map(cleanQty).filter((q) => q.length > 0),
        attachments: p.attachments,
      }));
      const customerName =
        state.customerMode === "existing" ? customer?.name ?? null : state.newCustomer.name;

      const mode: "create" | "update" = alreadyPushed ? "update" : "create";

      const payload = {
        workflowId: workflow.id,
        mode,
        type: state.type,
        form: state.form,
        source: state.source,
        customer: state.customerMode === "existing" ? state.customerId : "new",
        customerName,
        newCustomer: state.customerMode === "new" ? state.newCustomer : null,
        products,
      };

      const res = await fetch("/api/monday/create-item", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok || !data?.ok) {
        const reason = data?.error || `HTTP ${res.status}`;
        if (reason === "not_signed_in") {
          showToast("You need to sign in first.");
          return;
        }
        if (reason === "wrong_domain") {
          showToast("Only @pharmacenterusa.com accounts can push to monday.");
          return;
        }
        showToast(`monday push failed: ${reason}`, 6500);
        return;
      }
      const url = data.item?.url || mondayUrl;
      if (url) setMondayUrl(url);
      const totalFiles = products.reduce((n, p) => n + p.attachments.length, 0);
      const uploaded = data.uploaded ?? 0;
      const skipped = data.skipped ?? 0;
      const verb = mode === "update" ? "Update posted to monday" : "Added to monday";
      // For an update push we want the user to know that files already on the
      // monday item weren't re-uploaded (that's the point of dedup). For a
      // create push, skipped should be zero so we don't mention it.
      const fileMsg =
        totalFiles === 0
          ? `${verb} — opening the item in a new tab.`
          : uploaded === 0 && skipped > 0
            ? `${verb}. No new files — ${skipped} already on the item.`
            : skipped > 0
              ? `${verb} with ${uploaded} new attachment${uploaded === 1 ? "" : "s"} (${skipped} already on the item).`
              : uploaded === totalFiles
                ? `${verb} with ${uploaded} attachment${uploaded === 1 ? "" : "s"}.`
                : `${verb}, but only ${uploaded}/${totalFiles} attachments uploaded.`;
      showToast(fileMsg);
      if (url) window.open(url, "_blank", "noopener,noreferrer");
      // Refresh server-side data so the "Last pushed" timestamp is current.
      router.refresh();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      showToast(`monday push errored: ${msg}`, 6500);
    } finally {
      setSubmitting(false);
    }
  };

  const deleteWorkflow = async () => {
    if (deleting) return;
    const ok = window.confirm(
      "Delete this workflow? This cannot be undone. Files in storage will remain.",
    );
    if (!ok) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/workflows/${workflow.id}`, { method: "DELETE" });
      const data = await res.json();
      if (!res.ok || !data?.ok) {
        const reason = data?.error || `HTTP ${res.status}`;
        showToast(
          reason === "forbidden"
            ? "Only the workflow owner or an admin can delete this."
            : `Delete failed: ${reason}`,
          6500,
        );
        setDeleting(false);
        return;
      }
      router.push("/workflows");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      showToast(`Delete errored: ${msg}`, 6500);
      setDeleting(false);
    }
  };

  const canDelete = isOwner || isAdmin;

  const STATUS_ORDER: WorkflowStatus[] = ["in_progress", "won", "lost"];

  return (
    <>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          marginBottom: 16,
          flexWrap: "wrap",
        }}
      >
        <span
          style={{
            fontSize: 11,
            fontWeight: 700,
            letterSpacing: "0.08em",
            textTransform: "uppercase",
            color: "var(--ink-3)",
            marginRight: 4,
          }}
        >
          Status
        </span>
        {STATUS_ORDER.map((s) => {
          const active = status === s;
          const saving = statusSaving === s;
          // Won is special: clicking it never PUTs directly — it opens the SO
          // form. Whether the form turns into a "create" or an "edit" save is
          // decided inside submitSoForm based on the current status.
          const onClick = s === "won" ? onWonClick : () => onNonWonClick(s);
          // We allow clicking Won even when active so users can edit SOs.
          const isDisabled = s === "won"
            ? !!statusSaving || soSaving
            : active || !!statusSaving || soSaving;
          return (
            <button
              key={s}
              type="button"
              onClick={onClick}
              disabled={isDisabled}
              className={`status-pill status-pill--${s.replace("_", "-")} status-pill--button ${active ? "status-pill--active" : ""}`}
            >
              {saving ? "Saving…" : WORKFLOW_STATUS_LABELS[s]}
            </button>
          );
        })}
        {status === "won" && !soFormOpen ? (
          <button
            type="button"
            onClick={() => openSoForm(salesOrders)}
            className="so-edit-link"
            disabled={soSaving}
          >
            Edit sales orders
          </button>
        ) : null}
      </div>

      {soFormOpen ? (
        <div className="so-form">
          <div className="so-form__header">
            <span className="so-form__title">
              {status === "won" ? "Edit sales orders" : "Record sales orders for this win"}
            </span>
            <span className="so-form__hint">
              At least one SO number and a dollar value greater than zero.
            </span>
          </div>
          <div className="so-form__rows">
            {soDrafts.map((d, idx) => (
              <div key={idx} className="so-form__row">
                <input
                  type="text"
                  className="so-form__input so-form__input--so"
                  placeholder="SO # (e.g. 12345)"
                  value={d.so_number}
                  onChange={(e) => setDraftField(idx, "so_number", e.target.value)}
                  disabled={soSaving}
                />
                <div className="so-form__value-wrap">
                  <span className="so-form__value-prefix">$</span>
                  <input
                    type="number"
                    inputMode="decimal"
                    step="0.01"
                    min="0"
                    className="so-form__input so-form__input--value"
                    placeholder="Value"
                    value={d.value}
                    onChange={(e) => setDraftField(idx, "value", e.target.value)}
                    disabled={soSaving}
                  />
                </div>
                <button
                  type="button"
                  className="so-form__remove"
                  onClick={() => removeDraftRow(idx)}
                  aria-label="Remove sales order"
                  disabled={soDrafts.length <= 1 || soSaving}
                  title={soDrafts.length <= 1 ? "Keep at least one row" : "Remove this row"}
                >
                  &times;
                </button>
              </div>
            ))}
          </div>
          <button
            type="button"
            className="so-form__add"
            onClick={addDraftRow}
            disabled={soSaving}
          >
            + Add another sales order
          </button>
          {soError ? <div className="so-form__error">{soError}</div> : null}
          <div className="so-form__actions">
            <button
              type="button"
              className="so-form__cancel"
              onClick={closeSoForm}
              disabled={soSaving}
            >
              Cancel
            </button>
            <button
              type="button"
              className="so-form__save"
              onClick={submitSoForm}
              disabled={soSaving}
            >
              {soSaving ? "Saving…" : "Save as Won"}
            </button>
          </div>
        </div>
      ) : null}

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 28 }}>
        <button type="button" style={primaryAction} onClick={pushToMonday} disabled={submitting}>
          <span>
            {submitting
              ? alreadyPushed
                ? "Updating…"
                : "Pushing…"
              : alreadyPushed
                ? "Update Monday →"
                : "Push to Monday →"}
          </span>
          <span style={{ fontSize: 12, fontWeight: 400, opacity: 0.85 }}>
            {alreadyPushed
              ? "Post a fresh comment. Only files added since the last push are uploaded."
              : "Create the Quotes-board item and ping Rosy."}
          </span>
        </button>

        <a href={`/start?workflow=${workflow.id}`} style={editAction}>
          <span>Edit workflow →</span>
          <span style={{ fontSize: 12, fontWeight: 400, color: "var(--ink-3)" }}>
            Tweak any field, then push again.
          </span>
        </a>

        {canDelete ? (
          <button type="button" style={deleteAction} onClick={deleteWorkflow} disabled={deleting}>
            <span>{deleting ? "Deleting…" : "Delete workflow"}</span>
            <span style={{ fontSize: 12, fontWeight: 400, color: "var(--ink-3)" }}>
              {isAdmin && !isOwner
                ? "Admin override — created by someone else."
                : "Owner-only action."}
            </span>
          </button>
        ) : (
          <button type="button" style={blankAction} disabled aria-label="Coming soon">
            <span>—</span>
            <span style={{ fontSize: 12, fontWeight: 400 }}>Coming soon</span>
          </button>
        )}

        <button type="button" style={blankAction} disabled aria-label="Coming soon">
          <span>—</span>
          <span style={{ fontSize: 12, fontWeight: 400 }}>Coming soon</span>
        </button>
      </div>

      {toast ? (
        <div
          style={{
            position: "fixed", bottom: 24, left: "50%", transform: "translateX(-50%)",
            background: "var(--teal-900)", color: "#fff",
            padding: "12px 20px", borderRadius: 10, fontSize: 14,
            boxShadow: "0 4px 12px rgba(0,0,0,0.15)", maxWidth: 480, textAlign: "center",
            zIndex: 100,
          }}
        >
          {toast}
        </div>
      ) : null}
    </>
  );
}
