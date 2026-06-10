"use client";

import { useState, useMemo, type FormEvent, type ChangeEvent, type CSSProperties } from "react";

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

type Tier = { value: string };

export default function BulkQuantity() {
  const params = useMemo(() => readParams(), []);
  const [tiers, setTiers] = useState<Tier[]>([{ value: "" }]);

  const formLabel = params?.form ? FORM_LABELS[params.form] || params.form : null;
  const sourceLabel = params?.source ? SOURCE_LABELS[params.source] || params.source : null;
  const kicker = ["Bulk", formLabel, sourceLabel].filter(Boolean).join(" · ");

  const setTier = (i: number, v: string) => {
    setTiers((prev) => prev.map((t, j) => (j === i ? { value: v } : t)));
  };
  const addTier = () => setTiers((prev) => [...prev, { value: "" }]);
  const removeTier = (i: number) => setTiers((prev) => prev.filter((_, j) => j !== i));

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    const valid = tiers
      .map((t) => t.value.trim())
      .filter((v) => v.length > 0 && /^[\d,]+(\.\d+)?$/.test(v))
      .map((v) => v.replace(/,/g, ""));
    if (valid.length === 0) return;

    const qs = new URLSearchParams();
    if (params?.type) qs.set("type", params.type);
    if (params?.form) qs.set("form", params.form);
    if (params?.source) qs.set("source", params.source);
    if (params?.customer) qs.set("customer", params.customer);
    if (params?.product) qs.set("product", params.product);
    if (params?.product_name) qs.set("product_name", params.product_name);
    if (params?.notes) qs.set("notes", params.notes);
    if (params?.attachments) qs.set("attachments", params.attachments);
    for (const q of valid) qs.append("qty", q);

    window.location.href = `/workflow/review?${qs.toString()}`;
  };

  const backHref = (() => {
    if (!params) return "/start/bulk/product";
    const back = new URLSearchParams();
    if (params.type) back.set("type", params.type);
    if (params.form) back.set("form", params.form);
    if (params.source) back.set("source", params.source);
    if (params.customer) back.set("customer", params.customer);
    return `/start/bulk/product?${back.toString()}`;
  })();

  const inputStyle: CSSProperties = {
    flex: 1, padding: "10px 14px", border: "1.5px solid #e3dcc9",
    borderRadius: 8, fontSize: 14, background: "#fff",
    color: "var(--ink-1)", boxSizing: "border-box", fontFamily: "inherit",
  };

  const unitBadgeStyle: CSSProperties = {
    padding: "10px 14px", background: "#fffdf8", border: "1.5px solid #e3dcc9",
    borderRadius: 8, fontSize: 13, color: "var(--ink-2)", fontWeight: 600,
    display: "flex", alignItems: "center", whiteSpace: "nowrap",
  };

  const removeBtn: CSSProperties = {
    background: "transparent", border: "none", color: "var(--ink-3)",
    fontSize: 20, lineHeight: 1, cursor: "pointer", padding: "0 6px",
  };

  const addTierBtn: CSSProperties = {
    display: "inline-flex", alignItems: "center", gap: 6,
    padding: "8px 14px", background: "#fffdf8",
    border: "1.5px dashed #bcd596", borderRadius: 8,
    fontSize: 13, fontWeight: 700, color: "var(--teal-700)",
    cursor: "pointer", fontFamily: "inherit", marginTop: 6, alignSelf: "flex-start",
  };

  return (
    <main className="hero">
      <div className="card card--wide">
        <p className="eyebrow">{kicker || "Bulk Quote"}</p>
        <h1>How much are we quoting?</h1>
        <p className="lede">
          Enter the quantity. For bulk, <strong>1 unit = 1,000</strong>. Add tiers to capture volume-break pricing.
        </p>

        <form onSubmit={onSubmit} style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 28 }}>
          {tiers.map((tier, i) => (
            <div key={i} style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <input
                type="text"
                inputMode="numeric"
                placeholder={i === 0 ? "e.g. 500" : "additional tier"}
                value={tier.value}
                onChange={(e: ChangeEvent<HTMLInputElement>) => setTier(i, e.target.value)}
                style={inputStyle}
                autoFocus={i === 0}
              />
              <div style={unitBadgeStyle}>units</div>
              {tiers.length > 1 ? (
                <button type="button" onClick={() => removeTier(i)} style={removeBtn} aria-label={`Remove tier ${i + 1}`}>×</button>
              ) : null}
            </div>
          ))}
          <button type="button" onClick={addTier} style={addTierBtn}>+ Add another tier</button>

          <button type="submit" className="cta" style={{ alignSelf: "flex-start", marginTop: 16, marginBottom: 0, border: "none", cursor: "pointer", fontFamily: "inherit" }}>
            Continue &rarr;
          </button>
        </form>

        <a href={backHref} className="backlink">&larr; Back</a>
      </div>
    </main>
  );
}
