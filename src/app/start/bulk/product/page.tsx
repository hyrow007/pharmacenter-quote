"use client";

import { useState, useEffect, useMemo, type FormEvent, type ChangeEvent, type CSSProperties } from "react";
import { supabase, type Product } from "@/lib/supabase";

type Mode = "existing" | "new";

const PAGE_SIZE = 50;

function readParams() {
  if (typeof window === "undefined") return { form: null as string | null, source: null as string | null, customer: null as string | null };
  const sp = new URLSearchParams(window.location.search);
  return { form: sp.get("form"), source: sp.get("source"), customer: sp.get("customer") };
}

export default function BulkProduct() {
  const [mode, setMode] = useState<Mode>("existing");
  const [search, setSearch] = useState("");
  const [products, setProducts] = useState<Product[]>([]);
  const [status, setStatus] = useState<"loading" | "ok" | "mock" | "empty">("loading");
  const [newForm, setNewForm] = useState({ fp_code: "", name: "", default_unit: "ea" });

  const params = useMemo(() => readParams(), []);

  useEffect(() => {
    const sb = supabase;
    if (!sb) { setProducts([]); setStatus("mock"); return; }
    const term = search.trim();
    const handle = setTimeout(async () => {
      let q = sb
        .from("products")
        .select("id, fp_code, name, default_unit, source, external_id")
        .eq("active", true);
      if (term.length > 0) {
        q = q.or(`fp_code.ilike.%${term}%,name.ilike.%${term}%`);
      }
      const { data, error } = await q.order("name").limit(PAGE_SIZE);
      if (error || !data) { setProducts([]); setStatus("empty"); return; }
      setProducts(data as Product[]);
      setStatus(data.length === 0 ? "empty" : "ok");
    }, 180);
    return () => clearTimeout(handle);
  }, [search]);

  const buildEditorUrl = (productId: string) => {
    const qs = new URLSearchParams();
    qs.set("type", "bulk");
    if (params.form) qs.set("form", params.form);
    if (params.source) qs.set("source", params.source);
    if (params.customer) qs.set("customer", params.customer);
    qs.set("product", productId);
    return `/generator.html?${qs.toString()}`;
  };

  const submitNew = (e: FormEvent) => {
    e.preventDefault();
    if (!newForm.name.trim()) return;
    const qs = new URLSearchParams();
    qs.set("type", "bulk");
    if (params.form) qs.set("form", params.form);
    if (params.source) qs.set("source", params.source);
    if (params.customer) qs.set("customer", params.customer);
    qs.set("product", "new");
    qs.set("product_code", newForm.fp_code);
    qs.set("product_name", newForm.name);
    qs.set("product_unit", newForm.default_unit);
    window.location.href = `/generator.html?${qs.toString()}`;
  };

  const backHref = params.form === "gummy" && params.source
    ? `/start/bulk/gummies?${new URLSearchParams({ source: params.source }).toString()}`
    : "/start/bulk";

  const tabBtn = (active: boolean): CSSProperties => ({
    flex: 1, padding: "10px 16px", border: "none", borderRadius: 7,
    background: active ? "var(--teal-900)" : "transparent",
    color: active ? "#fff" : "var(--teal-700)",
    fontWeight: 700, fontSize: 13, cursor: "pointer",
    transition: "all 0.15s ease", fontFamily: "inherit",
  });

  const inputStyle: CSSProperties = {
    width: "100%", padding: "10px 14px", border: "1.5px solid #e3dcc9",
    borderRadius: 8, fontSize: 14, background: "#fff",
    color: "var(--ink-1)", boxSizing: "border-box", fontFamily: "inherit",
  };

  const labelText: CSSProperties = {
    fontSize: 11, fontWeight: 700, letterSpacing: "0.08em",
    textTransform: "uppercase", color: "var(--ink-3)",
  };

  const formLabel = params.form ? params.form.charAt(0).toUpperCase() + params.form.slice(1) : null;
  const sourceLabel = params.source ? params.source.replace(/-/g, " ") : null;
  const kicker = ["Bulk", formLabel, sourceLabel].filter(Boolean).join(" · ");

  return (
    <main className="hero">
      <div className="card card--wide">
        <p className="eyebrow">{kicker || "Bulk Quote"}</p>
        <h1>Which product?</h1>
        <p className="lede">Pick an existing product from Fishbowl (search by code or name), or add a new one.</p>

        <div style={{ display: "flex", gap: 0, marginBottom: 20, border: "1.5px solid #e3dcc9", borderRadius: 10, padding: 4, background: "#fffdf8" }}>
          <button type="button" style={tabBtn(mode === "existing")} onClick={() => setMode("existing")}>Existing product</button>
          <button type="button" style={tabBtn(mode === "new")} onClick={() => setMode("new")}>New product</button>
        </div>

        {mode === "existing" ? (
          <div>
            <input type="text" placeholder="Search by code or name…" value={search}
              onChange={(e: ChangeEvent<HTMLInputElement>) => setSearch(e.target.value)}
              style={{ ...inputStyle, marginBottom: 14 }} />
            <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 12, maxHeight: 360, overflowY: "auto" }}>
              {products.map((p) => (
                <a key={p.id} className="opt" href={buildEditorUrl(p.id)}>
                  <span className="opt__name">{p.name}</span>
                  <span className="opt__desc">
                    <span style={{ fontFamily: '"IBM Plex Mono", ui-monospace, monospace', fontWeight: 700, color: 'var(--teal-700)' }}>Product Code: {p.fp_code}</span>
                    {p.default_unit ? <span style={{ marginLeft: 8 }}>· {p.default_unit}</span> : null}
                  </span>
                </a>
              ))}
              {status === "empty" && search.trim() ? (
                <p style={{ color: "var(--ink-3)", textAlign: "center", padding: "20px", fontSize: 14 }}>No products match &quot;{search}&quot;.</p>
              ) : null}
              {status === "loading" ? (
                <p style={{ color: "var(--ink-3)", textAlign: "center", padding: "20px", fontSize: 14 }}>Loading…</p>
              ) : null}
            </div>
            <p style={{ fontSize: 10, color: "var(--ink-3)", letterSpacing: "0.06em", textTransform: "uppercase", fontWeight: 700, marginBottom: 20 }}>
              {status === "mock" ? "Source · Supabase not configured"
                : status === "loading" ? "Loading…"
                : `Source · Fishbowl (via Supabase) · showing ${products.length}${products.length === PAGE_SIZE ? "+ — refine your search" : ""}`}
            </p>
          </div>
        ) : (
          <form onSubmit={submitNew} style={{ display: "flex", flexDirection: "column", gap: 14, marginBottom: 24 }}>
            <label style={{ display: "flex", flexDirection: "column", gap: 5 }}>
              <span style={labelText}>Product code (fp_code)</span>
              <input type="text" placeholder="leave blank if not assigned yet" value={newForm.fp_code}
                onChange={(e: ChangeEvent<HTMLInputElement>) => setNewForm({ ...newForm, fp_code: e.target.value })} style={inputStyle} />
            </label>
            <label style={{ display: "flex", flexDirection: "column", gap: 5 }}>
              <span style={labelText}>Product name *</span>
              <input type="text" required placeholder="e.g. Vitamin D3 5000 IU softgel" value={newForm.name}
                onChange={(e: ChangeEvent<HTMLInputElement>) => setNewForm({ ...newForm, name: e.target.value })} style={inputStyle} />
            </label>
            <label style={{ display: "flex", flexDirection: "column", gap: 5 }}>
              <span style={labelText}>Default unit</span>
              <input type="text" placeholder="ea / kg / case" value={newForm.default_unit}
                onChange={(e: ChangeEvent<HTMLInputElement>) => setNewForm({ ...newForm, default_unit: e.target.value })} style={inputStyle} />
            </label>
            <button type="submit" className="cta" style={{ alignSelf: "flex-start", marginBottom: 0, border: "none", cursor: "pointer", fontFamily: "inherit" }}>Continue →</button>
          </form>
        )}

        <a href={backHref} className="backlink">← Back</a>
      </div>
    </main>
  );
}
