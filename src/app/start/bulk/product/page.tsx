"use client";

import { useState, useEffect, useMemo, useRef, type FormEvent, type ChangeEvent, type CSSProperties } from "react";
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
  const [newForm, setNewForm] = useState({ name_desc: "", notes: "" });
  const [files, setFiles] = useState<File[]>([]);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

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
    return `/start/bulk/quantity?${qs.toString()}`;
  };

  const submitNew = (e: FormEvent) => {
    e.preventDefault();
    if (!newForm.name_desc.trim()) return;
    const qs = new URLSearchParams();
    qs.set("type", "bulk");
    if (params.form) qs.set("form", params.form);
    if (params.source) qs.set("source", params.source);
    if (params.customer) qs.set("customer", params.customer);
    qs.set("product", "new");
    qs.set("product_name", newForm.name_desc);
    if (newForm.notes.trim()) qs.set("notes", newForm.notes);
    // TODO: upload `files` to Supabase Storage (bucket: quote-attachments)
    // and pass back the storage paths so the editor can render them.
    // Stashed in sessionStorage as a stop-gap so file names survive the navigation.
    if (typeof window !== "undefined" && files.length > 0) {
      const meta = files.map((f) => ({ name: f.name, size: f.size, type: f.type }));
      window.sessionStorage.setItem("quote.newProduct.attachments", JSON.stringify(meta));
      qs.set("attachments", String(files.length));
    }
    window.location.href = `/start/bulk/quantity?${qs.toString()}`;
  };

  const onFilesPicked = (e: ChangeEvent<HTMLInputElement>) => {
    const picked = Array.from(e.target.files || []);
    if (picked.length === 0) return;
    setFiles((prev) => [...prev, ...picked]);
    // Reset the input so picking the same file again still fires onChange.
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const removeFile = (idx: number) => {
    setFiles((prev) => prev.filter((_, i) => i !== idx));
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

  const textareaStyle: CSSProperties = {
    ...inputStyle, resize: "vertical", minHeight: 100, lineHeight: 1.5,
  };

  const labelText: CSSProperties = {
    fontSize: 11, fontWeight: 700, letterSpacing: "0.08em",
    textTransform: "uppercase", color: "var(--ink-3)",
  };

  const uploadBtnStyle: CSSProperties = {
    display: "inline-flex", alignItems: "center", gap: 8,
    padding: "10px 16px", background: "#fffdf8",
    border: "1.5px dashed #bcd596", borderRadius: 8,
    fontSize: 13, fontWeight: 700, color: "var(--teal-700)",
    cursor: "pointer", fontFamily: "inherit",
  };

  const fileRowStyle: CSSProperties = {
    display: "flex", justifyContent: "space-between", alignItems: "center",
    padding: "8px 12px", background: "#fffdf8",
    border: "1px solid #e3dcc9", borderRadius: 6, fontSize: 13,
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
          <form onSubmit={submitNew} style={{ display: "flex", flexDirection: "column", gap: 16, marginBottom: 24 }}>
            <label style={{ display: "flex", flexDirection: "column", gap: 5 }}>
              <span style={labelText}>Product name / description *</span>
              <input type="text" required placeholder="e.g. Vitamin D3 5000 IU softgel — Customer A, sugar-free" value={newForm.name_desc}
                onChange={(e: ChangeEvent<HTMLInputElement>) => setNewForm({ ...newForm, name_desc: e.target.value })} style={inputStyle} />
            </label>
            <label style={{ display: "flex", flexDirection: "column", gap: 5 }}>
              <span style={labelText}>Relevant information</span>
              <textarea placeholder="Specs, target dosage, run size, packaging notes, special handling, deadlines — anything else the quote team should know."
                value={newForm.notes} rows={5}
                onChange={(e: ChangeEvent<HTMLTextAreaElement>) => setNewForm({ ...newForm, notes: e.target.value })}
                style={textareaStyle} />
            </label>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <span style={labelText}>Attachments</span>
              <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                <label style={uploadBtnStyle}>
                  + Upload file
                  <input ref={fileInputRef} type="file" multiple style={{ display: "none" }} onChange={onFilesPicked} />
                </label>
                <span style={{ fontSize: 12, color: "var(--ink-3)" }}>
                  {files.length === 0 ? "Spec sheets, COAs, label artwork — PDF, images, anything." : `${files.length} file${files.length === 1 ? "" : "s"} staged`}
                </span>
              </div>
              {files.length > 0 ? (
                <ul style={{ listStyle: "none", padding: 0, margin: "4px 0 0 0", display: "flex", flexDirection: "column", gap: 6 }}>
                  {files.map((f, i) => (
                    <li key={`${f.name}-${i}`} style={fileRowStyle}>
                      <span style={{ color: "var(--ink-2)" }}>
                        {f.name} <span style={{ color: "var(--ink-3)" }}>· {(f.size / 1024).toFixed(1)} KB</span>
                      </span>
                      <button type="button" onClick={() => removeFile(i)}
                        style={{ border: "none", background: "transparent", color: "var(--ink-3)", cursor: "pointer", fontSize: 16, lineHeight: 1, padding: 0 }}
                        aria-label={`Remove ${f.name}`}>×</button>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
            <button type="submit" className="cta" style={{ alignSelf: "flex-start", marginBottom: 0, border: "none", cursor: "pointer", fontFamily: "inherit" }}>Continue →</button>
          </form>
        )}

        <a href={backHref} className="backlink">← Back</a>
      </div>
    </main>
  );
}
