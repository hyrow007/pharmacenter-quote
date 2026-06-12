"use client";

import { useState, useEffect, type CSSProperties } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase";
import type { WorkflowAttachment } from "@/lib/storage";

// Mirrors the shape defined in /start/page.tsx. We don't import from there
// because Next.js page modules shouldn't export non-page symbols, and the
// shape is small enough to keep in sync by hand.
type Mode = "existing" | "new";
type ProductEntry = {
  uid: string;
  mode: Mode;
  productId: string | null;
  newProduct: { name_desc: string; notes: string };
  quantities: string[];
  attachments: WorkflowAttachment[];
};
type WorkflowState = {
  workflowUid: string;
  customerMode: Mode;
  customerId: string | null;
  newCustomer: { name: string; contact: string; email: string };
  type: string | null;
  form: string | null;
  source: string | null;
  products: ProductEntry[];
};

type CustomerRow = { id: string; name: string; default_ship_to: string | null };
type ProductRow = { id: string; name: string; fp_code: string | null; default_unit: string | null };

const STORAGE_KEY = "quote.workflow.v1";

const TYPE_LABELS: Record<string, string> = {
  "bulk": "Bulk",
  "contract-packaging": "Contract Packaging",
  "finished-product": "Finished Product",
  "other": "Other",
};
const FORM_LABELS: Record<string, string> = {
  "softgel": "Softgels", "gummy": "Gummies", "tablet": "Tablets", "capsule": "Capsules", "other": "Other",
};
const SOURCE_LABELS: Record<string, string> = {
  "third-party": "Third party",
  "pharmacenter": "Manufactured at PharmaCenter",
  "other": "Other source",
};

function loadState(): WorkflowState | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as WorkflowState;
    if (!parsed.workflowUid || !Array.isArray(parsed.products)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function cleanQty(q: string): string {
  const t = q.replace(/,/g, "").trim();
  return /^\d+(\.\d+)?$/.test(t) ? t : "";
}

export default function WorkflowReview() {
  const router = useRouter();
  const [state, setState] = useState<WorkflowState | null>(null);
  const [hydrated, setHydrated] = useState(false);
  const [customer, setCustomer] = useState<CustomerRow | null>(null);
  const [productMap, setProductMap] = useState<Record<string, ProductRow>>({});
  const [toast, setToast] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [mondayUrl, setMondayUrl] = useState<string | null>(null);

  useEffect(() => {
    const s = loadState();
    setState(s);
    setHydrated(true);
    if (!s) return;

    const sb = supabase;
    if (sb && s.customerMode === "existing" && s.customerId) {
      sb.from("customers").select("id, name, default_ship_to").eq("id", s.customerId).maybeSingle()
        .then(({ data }) => { if (data) setCustomer(data as CustomerRow); });
    }
    if (sb) {
      const ids = s.products.map((p) => p.productId).filter((id): id is string => !!id && id !== "new");
      if (ids.length > 0) {
        sb.from("products").select("id, name, fp_code, default_unit").in("id", ids)
          .then(({ data }) => {
            const m: Record<string, ProductRow> = {};
            for (const row of (data ?? []) as ProductRow[]) m[row.id] = row;
            setProductMap(m);
          });
      }
    }
  }, []);

  // If there's no state at all (user navigated here directly), bounce back.
  useEffect(() => {
    if (hydrated && !state) router.replace("/start");
  }, [hydrated, state, router]);

  if (!hydrated) return <main className="hero"><div className="card card--wide"><p className="lede">Loading…</p></div></main>;
  if (!state) return null;

  const addToMonday = async () => {
    if (submitting || mondayUrl) return;
    setSubmitting(true);
    try {
      // Build the payload from the in-memory workflow state. Attachments are
      // passed by storage path + public URL — the server downloads and
      // re-uploads to monday's file column.
      const products = state.products.map((p) => ({
        productId: p.productId,
        productName: p.mode === "new" ? p.newProduct.name_desc : (productMap[p.productId ?? ""]?.name ?? null),
        productCode: p.mode === "new" ? null : (productMap[p.productId ?? ""]?.fp_code ?? null),
        notes: p.mode === "new" ? p.newProduct.notes : "",
        quantities: p.quantities.map(cleanQty).filter((q) => q.length > 0),
        attachments: p.attachments,
      }));

      const customerName = state.customerMode === "existing"
        ? (customer?.name ?? null)
        : state.newCustomer.name;

      const payload = {
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
          setToast("You need to sign in first. Redirecting…");
          window.setTimeout(() => { window.location.assign("/"); }, 1200);
          return;
        }
        if (reason === "wrong_domain") {
          setToast("Only @pharmacenterusa.com accounts can push to monday.");
          window.setTimeout(() => setToast(null), 5000);
          return;
        }
        setToast(`monday push failed: ${reason}`);
        window.setTimeout(() => setToast(null), 6000);
        return;
      }
      setMondayUrl(data.item.url);
      const totalFiles = products.reduce((n, p) => n + p.attachments.length, 0);
      const uploaded = data.uploaded ?? 0;
      const fileMsg = totalFiles === 0
        ? "Added to monday — opening the item in a new tab."
        : uploaded === totalFiles
          ? `Added to monday with ${uploaded} attachment${uploaded === 1 ? "" : "s"}.`
          : `Added to monday, but only ${uploaded}/${totalFiles} attachments uploaded. Check the item.`;
      setToast(fileMsg);
      // Workflow is done — clear sessionStorage so the next visit starts fresh.
      window.sessionStorage.removeItem(STORAGE_KEY);
      window.open(data.item.url, "_blank", "noopener,noreferrer");
      window.setTimeout(() => setToast(null), 5500);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setToast(`monday push errored: ${msg}`);
      window.setTimeout(() => setToast(null), 6000);
    } finally {
      setSubmitting(false);
    }
  };

  // ----- styles --------------------------------------------------------
  const sectionStyle: CSSProperties = {
    display: "grid", gridTemplateColumns: "150px 1fr", gap: 12,
    padding: "14px 18px", borderBottom: "1px solid #e3dcc9", alignItems: "baseline",
  };
  const lastSectionStyle: CSSProperties = { ...sectionStyle, borderBottom: "none" };
  const labelStyle: CSSProperties = {
    fontSize: 10, fontWeight: 700, letterSpacing: "0.08em",
    textTransform: "uppercase", color: "var(--ink-3)",
  };
  const valueStyle: CSSProperties = { fontSize: 15, color: "var(--ink-1)", fontWeight: 500 };
  const subValueStyle: CSSProperties = { fontSize: 13, color: "var(--ink-3)", marginTop: 2 };

  const primaryAction: CSSProperties = {
    display: "flex", flexDirection: "column", gap: 4,
    padding: "16px 18px", borderRadius: 10, border: "1.5px solid var(--teal-900)",
    background: "var(--teal-900)", color: "#fff", cursor: "pointer",
    fontFamily: "inherit", fontSize: 15, fontWeight: 700, textAlign: "left",
    transition: "transform 0.12s ease, box-shadow 0.12s ease",
  };
  const blankAction: CSSProperties = {
    display: "flex", flexDirection: "column", gap: 4,
    padding: "16px 18px", borderRadius: 10, border: "1.5px dashed #e3dcc9",
    background: "#fffdf8", color: "var(--ink-3)", cursor: "not-allowed",
    fontFamily: "inherit", fontSize: 15, fontWeight: 700, textAlign: "left",
  };
  const productRow: CSSProperties = {
    padding: "12px 14px", border: "1px solid #d8d3c1", borderRadius: 8,
    background: "#fff", marginBottom: 8,
  };

  // ----- renderers -----------------------------------------------------
  const renderCustomer = () => {
    if (state.customerMode === "new") {
      return (
        <div>
          <div style={valueStyle}>{state.newCustomer.name || "New customer"}</div>
          {state.newCustomer.contact ? <div style={subValueStyle}>{state.newCustomer.contact}</div> : null}
          {state.newCustomer.email ? <div style={subValueStyle}>{state.newCustomer.email}</div> : null}
        </div>
      );
    }
    if (customer) {
      return (
        <div>
          <div style={valueStyle}>{customer.name}</div>
          {customer.default_ship_to ? <div style={subValueStyle}>{customer.default_ship_to}</div> : null}
        </div>
      );
    }
    return <div style={valueStyle}>Loading…</div>;
  };

  return (
    <main className="hero">
      <div className="card card--wide" style={{ position: "relative" }}>
        <p className="eyebrow">PharmaCenter · Workflow</p>
        <h1>Review &amp; continue</h1>
        <p className="lede">Here&rsquo;s what you&rsquo;ve assembled. Pick where to send this workflow next.</p>

        <div style={{ border: "1.5px solid #e3dcc9", borderRadius: 12, background: "#fffdf8", marginBottom: 28, overflow: "hidden" }}>
          <div style={sectionStyle}>
            <span style={labelStyle}>Customer</span>
            {renderCustomer()}
          </div>
          <div style={sectionStyle}>
            <span style={labelStyle}>Quote type</span>
            <div style={valueStyle}>{state.type ? TYPE_LABELS[state.type] || state.type : "—"}</div>
          </div>
          {state.form ? (
            <div style={sectionStyle}>
              <span style={labelStyle}>Dosage form</span>
              <div style={valueStyle}>{FORM_LABELS[state.form] || state.form}</div>
            </div>
          ) : null}
          {state.source ? (
            <div style={sectionStyle}>
              <span style={labelStyle}>Source</span>
              <div style={valueStyle}>{SOURCE_LABELS[state.source] || state.source}</div>
            </div>
          ) : null}
          <div style={lastSectionStyle}>
            <span style={labelStyle}>Products</span>
            <div>
              {state.products.map((p, idx) => {
                const isNew = p.mode === "new";
                const pr = p.productId ? productMap[p.productId] : null;
                const name = isNew ? (p.newProduct.name_desc || "New product") : (pr?.name ?? "Loading…");
                const code = isNew ? null : pr?.fp_code ?? null;
                const cleanQs = p.quantities.map(cleanQty).filter((q) => q.length > 0);
                return (
                  <div key={p.uid} style={productRow}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 4 }}>
                      <div style={{ fontSize: 14, fontWeight: 700, color: "var(--ink-1)" }}>{name}</div>
                      <div style={{ fontSize: 11, color: "var(--ink-3)", letterSpacing: "0.06em", textTransform: "uppercase" }}>Product {idx + 1}</div>
                    </div>
                    {code ? (
                      <div style={{ fontSize: 12, marginBottom: 6 }}>
                        <span style={{ fontFamily: '"IBM Plex Mono", ui-monospace, monospace', color: 'var(--teal-700)', fontWeight: 700 }}>Product Code: {code}</span>
                        {pr?.default_unit ? <span style={{ marginLeft: 8, color: "var(--ink-3)" }}>· {pr.default_unit}</span> : null}
                      </div>
                    ) : null}
                    {isNew && p.newProduct.notes ? (
                      <div style={{ fontSize: 13, color: "var(--ink-2)", whiteSpace: "pre-wrap", lineHeight: 1.5, margin: "6px 0" }}>
                        {p.newProduct.notes}
                      </div>
                    ) : null}
                    {cleanQs.length > 0 ? (
                      <div style={{ fontSize: 13, color: "var(--ink-2)", marginTop: 6 }}>
                        <span style={{ color: "var(--ink-3)" }}>Quantities: </span>
                        {cleanQs.map((q, i) => (
                          <span key={i}>
                            {i > 0 ? <span style={{ color: "var(--ink-3)", margin: "0 6px" }}>·</span> : null}
                            {Number(q).toLocaleString()} units
                          </span>
                        ))}
                      </div>
                    ) : null}
                    {p.attachments.length > 0 ? (
                      <div style={{ fontSize: 13, color: "var(--ink-3)", marginTop: 6 }}>
                        {p.attachments.length} attachment{p.attachments.length === 1 ? "" : "s"}:
                        <ul style={{ listStyle: "none", padding: 0, margin: "4px 0 0 0", display: "flex", flexDirection: "column", gap: 2 }}>
                          {p.attachments.map((a) => (
                            <li key={a.path} style={{ fontSize: 12 }}>{a.name} · {(a.size / 1024).toFixed(1)} KB</li>
                          ))}
                        </ul>
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        <h2 style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--ink-3)", marginBottom: 12 }}>
          Next step
        </h2>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 28 }}>
          <button type="button" style={primaryAction} onClick={addToMonday} disabled={submitting}>
            <span>
              {mondayUrl ? "Added to Monday ✓" : submitting ? "Adding…" : "Add to Monday →"}
            </span>
            <span style={{ fontSize: 12, fontWeight: 400, opacity: 0.85 }}>
              {mondayUrl
                ? "Click the toast link or check monday.com → Quotes board."
                : "Push this workflow as an item on monday.com"}
            </span>
          </button>
          <button type="button" style={blankAction} disabled aria-label="Coming soon">
            <span>—</span>
            <span style={{ fontSize: 12, fontWeight: 400 }}>Coming soon</span>
          </button>
          <button type="button" style={blankAction} disabled aria-label="Coming soon">
            <span>—</span>
            <span style={{ fontSize: 12, fontWeight: 400 }}>Coming soon</span>
          </button>
          <button type="button" style={blankAction} disabled aria-label="Coming soon">
            <span>—</span>
            <span style={{ fontSize: 12, fontWeight: 400 }}>Coming soon</span>
          </button>
        </div>

        <a href="/start" className="backlink">&larr; Back to edit</a>

        {toast ? (
          <div style={{
            position: "fixed", bottom: 24, left: "50%", transform: "translateX(-50%)",
            background: "var(--teal-900)", color: "#fff",
            padding: "12px 20px", borderRadius: 10, fontSize: 14,
            boxShadow: "0 4px 12px rgba(0,0,0,0.15)", maxWidth: 480, textAlign: "center",
            zIndex: 100,
          }}>
            {toast}
          </div>
        ) : null}
      </div>
    </main>
  );
}
