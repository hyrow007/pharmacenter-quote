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

  const addToMonday = () => {
    // TODO: POST to /api/monday/create-item once the monday.com API key,
    // workspace, board, and column mapping are configured.
    setToast("Monday integration is wired up next — needs board + API key.");
    window.setTimeout(() => setToast(null), 4200);
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

  // Back link returns to the product picker preserving all upstream selections.
  const backQS = new URLSearchParams();
  if (params.type) backQS.set("type", params.type);
  if (params.form) backQS.set("form", params.form);
  if (params.source) backQS.set("source", params.source);
  if (params.customer) backQS.set("customer", params.customer);
  const backHref = `/start/bulk/product?${backQS.toString()}`;

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
          <div style={params.notes || attachmentMeta.length > 0 ? sectionStyle : lastSectionStyle}>
            <span style={labelStyle}>Product</span>
            {renderProduct()}
          </div>
          {params.notes ? (
            <div style={attachmentMeta.length > 0 ? sectionStyle : lastSectionStyle}>
              <span style={labelStyle}>Relevant info</span>
              <div style={{ ...valueStyle, fontSize: 14, whiteSpace: "pre-wrap", lineHeight: 1.5 }}>{params.notes}</div>
            </div>
          ) : null}
          {attachmentMeta.length > 0 ? (
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
        </div>

        <h2 style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--ink-3)", marginBottom: 12 }}>
          Next step
        </h2>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 28 }}>
          <button type="button" style={primaryAction} onClick={addToMonday}>
            <span>Add to Monday →</span>
            <span style={{ fontSize: 12, fontWeight: 400, opacity: 0.85 }}>Push this workflow as an item on monday.com</span>
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

        <a href={backHref} className="backlink">← Back</a>

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
