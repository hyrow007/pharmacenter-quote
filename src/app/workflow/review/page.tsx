"use client";

import { useState, useEffect, useMemo, type CSSProperties } from "react";
import { supabase } from "@/lib/supabase";

type CustomerRow = { id: string; name: string; default_ship_to: string | null };
type ProductRow = { id: string; name: string; fp_code: string | null; default_unit: string | null };
type AttachmentMeta = { name: string; size: number; type: string };

function readParams() {
  if (typeof window === "undefined") return null;
  const sp = new URLSearchParams(window.location.search);
  return {
    type: sp.get("type"),
    form: sp.get("form"),
    source: sp.get("source"),
    customer: sp.get("customer"),
    product: sp.get("product"),
    product_name: sp.get("product_name"),
    notes: sp.get("notes"),
    attachments: sp.get("attachments"),
    quantities: sp.getAll("qty"),
  };
}

const TYPE_LABELS: Record<string, string> = {
  "bulk": "Bulk",
  "contract-packaging": "Contract Packaging",
  "finished-product": "Finished Product",
  "other": "Other",
};
const FORM_LABELS: Record<string, string> = {
  "softgel": "Softgels",
  "gummy": "Gummies",
  "tablet": "Tablets",
  "capsule": "Capsules",
  "other": "Other",
};
const SOURCE_LABELS: Record<string, string> = {
  "third-party": "Third party",
  "pharmacenter": "Manufactured at PharmaCenter",
  "other": "Other source",
};

export default function WorkflowReview() {
  const params = useMemo(() => readParams(), []);
  const [customer, setCustomer] = useState<CustomerRow | null>(null);
  const [product, setProduct] = useState<ProductRow | null>(null);
  const [attachmentMeta, setAttachmentMeta] = useState<AttachmentMeta[]>([]);
  const [toast, setToast] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [mondayUrl, setMondayUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!params) return;
    const sb = supabase;
    if (sb && params.customer && params.customer !== "new") {
      sb.from("customers").select("id, name, default_ship_to").eq("id", params.customer).maybeSingle()
        .then(({ data }) => { if (data) setCustomer(data as CustomerRow); });
    }
    if (sb && params.product && params.product !== "new") {
      sb.from("products").select("id, name, fp_code, default_unit").eq("id", params.product).maybeSingle()
        .then(({ data }) => { if (data) setProduct(data as ProductRow); });
    }
    if (typeof window !== "undefined" && params.attachments) {
      const raw = window.sessionStorage.getItem("quote.newProduct.attachments");
      if (raw) {
        try { setAttachmentMeta(JSON.parse(raw) as AttachmentMeta[]); } catch { /* ignore */ }
      }
    }
  }, [params]);

  if (!params) return null;

  const addToMonday = async () => {
    if (submitting || mondayUrl) return;
    setSubmitting(true);
    try {
      const res = await fetch("/api/monday/create-item", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: params?.type ?? null,
          form: params?.form ?? null,
          source: params?.source ?? null,
          customer: params?.customer ?? null,
          customerName: customer?.name ?? null,
          product: params?.product ?? null,
          productName: params?.product_name ?? null,
          notes: params?.notes ?? null,
          quantities: params?.quantities ?? [],
        }),
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
      setToast("Added to monday — opening the item in a new tab.");
      window.open(data.item.url, "_blank", "noopener,noreferrer");
      window.setTimeout(() => setToast(null), 4200);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setToast(`monday push errored: ${msg}`);
      window.setTimeout(() => setToast(null), 6000);
    } finally {
      setSubmitting(false);
    }
  };

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

  const renderCustomer = () => {
    if (customer) {
      return (
        <div>
          <div style={valueStyle}>{customer.name}</div>
          {customer.default_ship_to ? <div style={subValueStyle}>{customer.default_ship_to}</div> : null}
        </div>
      );
    }
    if (params.customer === "new") return <div style={valueStyle}>New customer</div>;
    if (!params.customer) return <div style={valueStyle}>—</div>;
    return <div style={valueStyle}>Loading…</div>;
  };

  const renderProduct = () => {
    if (params.product === "new") {
      return (
        <div>
          <div style={valueStyle}>{params.product_name || "New product"}</div>
          <div style={subValueStyle}>New — not in Fishbowl yet</div>
        </div>
      );
    }
    if (product) {
      return (
        <div>
          <div style={valueStyle}>{product.name}</div>
          <div style={subValueStyle}>
            <span style={{ fontFamily: '"IBM Plex Mono", ui-monospace, monospace', color: 'var(--teal-700)' }}>
              Product Code: {product.fp_code}
            </span>
            {product.default_unit ? <span style={{ marginLeft: 8 }}>· {product.default_unit}</span> : null}
          </div>
        </div>
      );
    }
    return <div style={valueStyle}>Loading…</div>;
  };

  const backQS = new URLSearchParams();
  if (params.type) backQS.set("type", params.type);
  if (params.form) backQS.set("form", params.form);
  if (params.source) backQS.set("source", params.source);
  if (params.customer) backQS.set("customer", params.customer);
  if (params.product) backQS.set("product", params.product);
  if (params.product_name) backQS.set("product_name", params.product_name);
  if (params.notes) backQS.set("notes", params.notes);
  if (params.attachments) backQS.set("attachments", params.attachments);
  for (const q of params.quantities ?? []) backQS.append("qty", q);
  const backHref = `/start?${backQS.toString()}`;

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
            <div style={valueStyle}>{params.type ? TYPE_LABELS[params.type] || params.type : "—"}</div>
          </div>
          {params.form ? (
            <div style={sectionStyle}>
              <span style={labelStyle}>Dosage form</span>
              <div style={valueStyle}>{FORM_LABELS[params.form] || params.form}</div>
            </div>
          ) : null}
          {params.source ? (
            <div style={sectionStyle}>
              <span style={labelStyle}>Source</span>
              <div style={valueStyle}>{SOURCE_LABELS[params.source] || params.source}</div>
            </div>
          ) : null}
          {(() => {
            const hasQty = (params.quantities?.length ?? 0) > 0;
            const hasNotes = !!params.notes;
            const hasAttachments = attachmentMeta.length > 0;
            const isLast = (name: "product" | "qty" | "notes" | "attach") => {
              if (name === "attach") return true;
              if (name === "notes") return !hasAttachments;
              if (name === "qty") return !hasNotes && !hasAttachments;
              if (name === "product") return !hasQty && !hasNotes && !hasAttachments;
              return false;
            };
            return (
              <>
                <div style={isLast("product") ? lastSectionStyle : sectionStyle}>
                  <span style={labelStyle}>Product</span>
                  {renderProduct()}
                </div>
                {hasQty ? (
                  <div style={isLast("qty") ? lastSectionStyle : sectionStyle}>
                    <span style={labelStyle}>Quantities</span>
                    <div>
                      <div style={valueStyle}>
                        {params.quantities!.map((q, i) => (
                          <span key={i}>
                            {i > 0 ? <span style={{ color: "var(--ink-3)", margin: "0 8px" }}>·</span> : null}
                            {Number(q).toLocaleString()} units
                          </span>
                        ))}
                      </div>
                      <div style={subValueStyle}>1 unit = 1,000</div>
                    </div>
                  </div>
                ) : null}
                {hasNotes ? (
                  <div style={isLast("notes") ? lastSectionStyle : sectionStyle}>
                    <span style={labelStyle}>Relevant info</span>
                    <div style={{ ...valueStyle, fontSize: 14, whiteSpace: "pre-wrap", lineHeight: 1.5 }}>{params.notes}</div>
                  </div>
                ) : null}
                {hasAttachments ? (
                  <div style={lastSectionStyle}>
                    <span style={labelStyle}>Attachments</span>
                    <div>
                      <div style={valueStyle}>{attachmentMeta.length} file{attachmentMeta.length === 1 ? "" : "s"} staged</div>
                      <ul style={{ listStyle: "none", padding: 0, margin: "6px 0 0 0", display: "flex", flexDirection: "column", gap: 4 }}>
                        {attachmentMeta.map((f, i) => (
                          <li key={i} style={{ ...subValueStyle, marginTop: 0 }}>
                            {f.name} · {(f.size / 1024).toFixed(1)} KB
                          </li>
                        ))}
                      </ul>
                    </div>
                  </div>
                ) : null}
              </>
            );
          })()}
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

        <a href={backHref} className="backlink">&larr; Back</a>

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
