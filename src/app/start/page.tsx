"use client";

import { useState, useEffect, useMemo, useRef, type ChangeEvent, type FormEvent, type CSSProperties } from "react";
import { supabase, type Product } from "@/lib/supabase";

// ----- catalogue ----------------------------------------------------------

const TYPES = [
  { id: "bulk", name: "Bulk" },
  { id: "contract-packaging", name: "Contract Packaging" },
  { id: "finished-product", name: "Finished Product" },
  { id: "other", name: "Other" },
];

const FORMS = [
  { id: "softgel", name: "Softgels" },
  { id: "gummy", name: "Gummies" },
  { id: "tablet", name: "Tablets" },
  { id: "capsule", name: "Capsules" },
  { id: "other", name: "Other" },
];

const SOURCES = [
  { id: "third-party", name: "Third party" },
  { id: "pharmacenter", name: "Manufactured at PharmaCenter" },
  { id: "other", name: "Other" },
];

const PAGE_SIZE = 50;

// ----- types --------------------------------------------------------------

type CustomerRow = { id: string; name: string; default_ship_to: string | null };
type ProductRow = Pick<Product, "id" | "name" | "fp_code" | "default_unit">;
type ProductMode = "existing" | "new";

function readInitialParams() {
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
    quantities: sp.getAll("qty"),
  };
}

// ----- shared styles ------------------------------------------------------

const sectionStyle: CSSProperties = {
  border: "1.5px solid #e3dcc9", borderRadius: 12, background: "#fffdf8",
  padding: "16px 18px", marginBottom: 14,
};
const sectionDisabledStyle: CSSProperties = { ...sectionStyle, opacity: 0.55 };
const sectionLabelStyle: CSSProperties = {
  fontSize: 11, fontWeight: 700, letterSpacing: "0.08em",
  textTransform: "uppercase", color: "var(--ink-3)", marginBottom: 10,
};
const pillBase: CSSProperties = {
  padding: "8px 14px", border: "1.5px solid #e3dcc9", borderRadius: 999,
  background: "transparent", fontSize: 13, fontWeight: 600, cursor: "pointer",
  color: "var(--ink-1)", fontFamily: "inherit",
};
const pillActive: CSSProperties = {
  ...pillBase, background: "var(--teal-900)", color: "#fff", borderColor: "var(--teal-900)",
};
const inputStyle: CSSProperties = {
  width: "100%", padding: "10px 14px", border: "1.5px solid #e3dcc9",
  borderRadius: 8, fontSize: 14, background: "#fff",
  color: "var(--ink-1)", boxSizing: "border-box", fontFamily: "inherit",
};
const textareaStyle: CSSProperties = { ...inputStyle, resize: "vertical", minHeight: 90, lineHeight: 1.5 };
const selectedRow: CSSProperties = {
  display: "flex", justifyContent: "space-between", alignItems: "flex-start",
  padding: "12px 14px", background: "#fff", border: "1.5px solid #e3dcc9",
  borderRadius: 8, gap: 12,
};
const changeBtn: CSSProperties = {
  background: "transparent", border: "none", color: "var(--teal-700)",
  fontWeight: 700, fontSize: 12, cursor: "pointer", padding: "2px 6px",
  fontFamily: "inherit",
};
const labelText: CSSProperties = {
  fontSize: 11, fontWeight: 700, letterSpacing: "0.08em",
  textTransform: "uppercase", color: "var(--ink-3)",
};
const tabsStyle: CSSProperties = {
  display: "inline-flex", gap: 0, marginBottom: 12, border: "1.5px solid #e3dcc9",
  borderRadius: 10, padding: 4, background: "#fffdf8",
};
const tabBtn = (active: boolean): CSSProperties => ({
  padding: "6px 16px", border: "none", borderRadius: 6,
  background: active ? "var(--teal-900)" : "transparent",
  color: active ? "#fff" : "var(--teal-700)",
  fontWeight: 700, fontSize: 12, cursor: "pointer", fontFamily: "inherit",
});
const addTierStyle: CSSProperties = {
  display: "inline-flex", alignItems: "center", gap: 6,
  padding: "8px 14px", background: "#fffdf8",
  border: "1.5px dashed #bcd596", borderRadius: 8,
  fontSize: 13, fontWeight: 700, color: "var(--teal-700)",
  cursor: "pointer", fontFamily: "inherit", marginTop: 6, alignSelf: "flex-start",
};
const uploadBtnStyle: CSSProperties = {
  display: "inline-flex", alignItems: "center", gap: 8,
  padding: "10px 16px", background: "#fffdf8",
  border: "1.5px dashed #bcd596", borderRadius: 8,
  fontSize: 13, fontWeight: 700, color: "var(--teal-700)",
  cursor: "pointer", fontFamily: "inherit",
};

// ----- component ----------------------------------------------------------

export default function StartWorkflow() {
  const initial = useMemo(() => readInitialParams(), []);

  // Customer state -------------------------------------------------------
  const [customerId, setCustomerId] = useState<string | null>(initial?.customer ?? null);
  const [customerName, setCustomerName] = useState<string | null>(null);
  const [customerShipTo, setCustomerShipTo] = useState<string | null>(null);
  const [editingCustomer, setEditingCustomer] = useState(!initial?.customer);
  const [customerSearch, setCustomerSearch] = useState("");
  const [customers, setCustomers] = useState<CustomerRow[]>([]);
  const [customerMode, setCustomerMode] = useState<"existing" | "new">("existing");
  const [newCustomerForm, setNewCustomerForm] = useState({ name: "", contact: "", email: "" });

  // Type / form / source ------------------------------------------------
  const [type, setType] = useState<string | null>(initial?.type ?? null);
  const [form, setForm] = useState<string | null>(initial?.form ?? null);
  const [source, setSource] = useState<string | null>(initial?.source ?? null);

  // Product state --------------------------------------------------------
  const [productMode, setProductMode] = useState<ProductMode>(initial?.product === "new" ? "new" : "existing");
  const [productId, setProductId] = useState<string | null>(initial?.product && initial.product !== "new" ? initial.product : null);
  const [productName, setProductName] = useState<string | null>(null);
  const [productCode, setProductCode] = useState<string | null>(null);
  const [editingProduct, setEditingProduct] = useState(!productId);
  const [productSearch, setProductSearch] = useState("");
  const [products, setProducts] = useState<ProductRow[]>([]);
  const [newProductForm, setNewProductForm] = useState({ name_desc: initial?.product_name ?? "", notes: initial?.notes ?? "" });
  const [files, setFiles] = useState<File[]>([]);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Quantities -----------------------------------------------------------
  const [tiers, setTiers] = useState<string[]>(initial?.quantities?.length ? initial.quantities : [""]);

  // ----- data fetch: customers ----------------------------------------
  useEffect(() => {
    const sb = supabase;
    if (!sb) return;
    const term = customerSearch.trim();
    const handle = setTimeout(async () => {
      let q = sb.from("customers").select("id, name, default_ship_to").eq("active", true);
      if (term.length === 0) { setCustomers([]); return; } q = q.ilike("name", `%${term}%`);
      const { data } = await q.order("name").limit(PAGE_SIZE);
      setCustomers((data ?? []) as CustomerRow[]);
    }, 180);
    return () => clearTimeout(handle);
  }, [customerSearch]);

  useEffect(() => {
    if (!customerId || customerName) return;
    const sb = supabase;
    if (!sb) return;
    sb.from("customers").select("id, name, default_ship_to").eq("id", customerId).maybeSingle()
      .then(({ data }) => {
        if (data) {
          setCustomerName(data.name);
          setCustomerShipTo(data.default_ship_to);
        }
      });
  }, [customerId, customerName]);

  // ----- data fetch: products ------------------------------------------
  useEffect(() => {
    const sb = supabase;
    if (!sb || productMode !== "existing") return;
    const term = productSearch.trim();
    const handle = setTimeout(async () => {
      let q = sb.from("products").select("id, fp_code, name, default_unit").eq("active", true);
      if (term.length === 0) { setProducts([]); return; } q = q.or(`fp_code.ilike.%${term}%,name.ilike.%${term}%`);
      const { data } = await q.order("name").limit(PAGE_SIZE);
      setProducts((data ?? []) as ProductRow[]);
    }, 180);
    return () => clearTimeout(handle);
  }, [productSearch, productMode]);

  useEffect(() => {
    if (!productId || productName) return;
    const sb = supabase;
    if (!sb) return;
    sb.from("products").select("id, name, fp_code").eq("id", productId).maybeSingle()
      .then(({ data }) => {
        if (data) {
          setProductName(data.name);
          setProductCode(data.fp_code);
        }
      });
  }, [productId, productName]);

  // ----- derived flags --------------------------------------------------
  const isBulk = type === "bulk";
  const showFormSection = isBulk;
  const showSourceSection = isBulk && form === "gummy";

  const cleanTiers = tiers
    .map((t) => t.replace(/,/g, "").trim())
    .filter((t) => t.length > 0 && /^\d+(\.\d+)?$/.test(t));

  const customerOk = customerMode === "existing" ? !!customerId : !!newCustomerForm.name.trim();
  const productOk = productMode === "existing" ? !!productId : !!newProductForm.name_desc.trim();
  const formOk = !showFormSection || !!form;
  const sourceOk = !showSourceSection || !!source;
  const quantityOk = cleanTiers.length > 0;

  const missing: string[] = [];
  if (!customerOk) missing.push("Customer");
  if (!type) missing.push("Quote type");
  if (!formOk) missing.push("Dosage form");
  if (!sourceOk) missing.push("Source");
  if (!productOk) missing.push("Product");
  if (!quantityOk) missing.push("Quantity");

  const canSubmit = missing.length === 0;

  // ----- handlers -------------------------------------------------------
  const pickType = (id: string) => {
    setType(id);
    if (id !== "bulk") {
      setForm(null);
      setSource(null);
    }
  };
  const pickForm = (id: string) => {
    setForm(id);
    if (id !== "gummy") setSource(null);
  };

  const pickCustomer = (c: CustomerRow) => {
    setCustomerId(c.id);
    setCustomerName(c.name);
    setCustomerShipTo(c.default_ship_to);
    setEditingCustomer(false);
  };
  const pickProduct = (p: ProductRow) => {
    setProductId(p.id);
    setProductName(p.name);
    setProductCode(p.fp_code);
    setEditingProduct(false);
  };

  const setTier = (i: number, v: string) => setTiers((prev) => prev.map((t, j) => (j === i ? v : t)));
  const addTier = () => setTiers((prev) => [...prev, ""]);
  const removeTier = (i: number) => setTiers((prev) => prev.filter((_, j) => j !== i));

  const onFilesPicked = (e: ChangeEvent<HTMLInputElement>) => {
    const picked = Array.from(e.target.files || []);
    if (picked.length === 0) return;
    setFiles((prev) => [...prev, ...picked]);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const submit = (e?: FormEvent) => {
    if (e) e.preventDefault();
    if (!canSubmit) return;

    const qs = new URLSearchParams();
    qs.set("type", type!);
    if (form) qs.set("form", form);
    if (source) qs.set("source", source);

    if (customerMode === "existing" && customerId) {
      qs.set("customer", customerId);
    } else {
      qs.set("customer", "new");
      if (newCustomerForm.name) qs.set("customer_name", newCustomerForm.name);
      if (newCustomerForm.contact) qs.set("customer_contact", newCustomerForm.contact);
      if (newCustomerForm.email) qs.set("customer_email", newCustomerForm.email);
    }

    if (productMode === "existing" && productId) {
      qs.set("product", productId);
    } else {
      qs.set("product", "new");
      qs.set("product_name", newProductForm.name_desc);
      if (newProductForm.notes.trim()) qs.set("notes", newProductForm.notes);
      if (typeof window !== "undefined" && files.length > 0) {
        const meta = files.map((f) => ({ name: f.name, size: f.size, type: f.type }));
        window.sessionStorage.setItem("quote.newProduct.attachments", JSON.stringify(meta));
        qs.set("attachments", String(files.length));
      }
    }

    for (const t of cleanTiers) qs.append("qty", t);

    window.location.href = `/workflow/review?${qs.toString()}`;
  };

  // ----- render ---------------------------------------------------------
  return (
    <main className="hero">
      <div className="card card--wide">
        <p className="eyebrow">PharmaCenter · Workflow</p>
        <h1>Start a quote workflow</h1>
        <p className="lede">Pull together everything we need to quote this, then send it where it needs to go.</p>

        <form onSubmit={submit} style={{ marginTop: 18 }}>

          <div style={sectionStyle}>
            <p style={sectionLabelStyle}>Customer</p>
            {!editingCustomer && customerMode === "existing" && customerId && customerName ? (
              <div style={selectedRow}>
                <div>
                  <div style={{ fontSize: 15, fontWeight: 700, color: "var(--ink-1)" }}>{customerName}</div>
                  {customerShipTo ? <div style={{ fontSize: 13, color: "var(--ink-3)", marginTop: 2 }}>{customerShipTo}</div> : null}
                </div>
                <button type="button" style={changeBtn} onClick={() => setEditingCustomer(true)}>Change</button>
              </div>
            ) : (
              <>
                <div style={tabsStyle}>
                  <button type="button" style={tabBtn(customerMode === "existing")} onClick={() => setCustomerMode("existing")}>Existing</button>
                  <button type="button" style={tabBtn(customerMode === "new")} onClick={() => setCustomerMode("new")}>New customer</button>
                </div>
                {customerMode === "existing" ? (
                  <>
                    <input type="text" placeholder="Search customers…" value={customerSearch}
                      onChange={(e) => setCustomerSearch(e.target.value)} style={inputStyle} />
                    <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 6 }}>
                      {customers.map((c) => (
                        <button key={c.id} type="button" onClick={() => pickCustomer(c)}
                          style={{ textAlign: "left", padding: "10px 12px", background: "#fff", border: "1px solid #e3dcc9", borderRadius: 8, cursor: "pointer", fontFamily: "inherit" }}>
                          <div style={{ fontSize: 14, fontWeight: 700, color: "var(--ink-1)" }}>{c.name}</div>
                          {c.default_ship_to ? <div style={{ fontSize: 12, color: "var(--ink-3)", marginTop: 2 }}>{c.default_ship_to}</div> : null}
                        </button>
                      ))}
                    </div>
                  </>
                ) : (
                  <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                    <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                      <span style={labelText}>Company name *</span>
                      <input type="text" required value={newCustomerForm.name}
                        onChange={(e) => setNewCustomerForm({ ...newCustomerForm, name: e.target.value })} style={inputStyle} />
                    </label>
                    <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                      <span style={labelText}>Primary contact</span>
                      <input type="text" value={newCustomerForm.contact}
                        onChange={(e) => setNewCustomerForm({ ...newCustomerForm, contact: e.target.value })} style={inputStyle} />
                    </label>
                    <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                      <span style={labelText}>Email</span>
                      <input type="email" value={newCustomerForm.email}
                        onChange={(e) => setNewCustomerForm({ ...newCustomerForm, email: e.target.value })} style={inputStyle} />
                    </label>
                  </div>
                )}
              </>
            )}
          </div>

          <div style={sectionStyle}>
            <p style={sectionLabelStyle}>Quote type</p>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              {TYPES.map((t) => (
                <button key={t.id} type="button" onClick={() => pickType(t.id)}
                  style={type === t.id ? pillActive : pillBase}>{t.name}</button>
              ))}
            </div>
          </div>

          {showFormSection ? (
            <div style={sectionStyle}>
              <p style={sectionLabelStyle}>Dosage form</p>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                {FORMS.map((f) => (
                  <button key={f.id} type="button" onClick={() => pickForm(f.id)}
                    style={form === f.id ? pillActive : pillBase}>{f.name}</button>
                ))}
              </div>
            </div>
          ) : null}

          {showSourceSection ? (
            <div style={sectionStyle}>
              <p style={sectionLabelStyle}>Source</p>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                {SOURCES.map((s) => (
                  <button key={s.id} type="button" onClick={() => setSource(s.id)}
                    style={source === s.id ? pillActive : pillBase}>{s.name}</button>
                ))}
              </div>
            </div>
          ) : null}

          <div style={sectionStyle}>
            <p style={sectionLabelStyle}>Product</p>
            {!editingProduct && productMode === "existing" && productId && productName ? (
              <div style={selectedRow}>
                <div>
                  <div style={{ fontSize: 15, fontWeight: 700, color: "var(--ink-1)" }}>{productName}</div>
                  {productCode ? (
                    <div style={{ fontSize: 13, marginTop: 2 }}>
                      <span style={{ fontFamily: '"IBM Plex Mono", ui-monospace, monospace', color: 'var(--teal-700)', fontWeight: 700 }}>Product Code: {productCode}</span>
                    </div>
                  ) : null}
                </div>
                <button type="button" style={changeBtn} onClick={() => setEditingProduct(true)}>Change</button>
              </div>
            ) : (
              <>
                <div style={tabsStyle}>
                  <button type="button" style={tabBtn(productMode === "existing")} onClick={() => { setProductMode("existing"); setEditingProduct(true); }}>Existing</button>
                  <button type="button" style={tabBtn(productMode === "new")} onClick={() => { setProductMode("new"); setEditingProduct(true); }}>New product</button>
                </div>
                {productMode === "existing" ? (
                  <>
                    <input type="text" placeholder="Search by code or name…" value={productSearch}
                      onChange={(e) => setProductSearch(e.target.value)} style={inputStyle} />
                    <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 6 }}>
                      {products.map((p) => (
                        <button key={p.id} type="button" onClick={() => pickProduct(p)}
                          style={{ textAlign: "left", padding: "10px 12px", background: "#fff", border: "1px solid #e3dcc9", borderRadius: 8, cursor: "pointer", fontFamily: "inherit" }}>
                          <div style={{ fontSize: 14, fontWeight: 700, color: "var(--ink-1)" }}>{p.name}</div>
                          {p.fp_code ? (
                            <div style={{ fontSize: 12, marginTop: 2 }}>
                              <span style={{ fontFamily: '"IBM Plex Mono", ui-monospace, monospace', color: 'var(--teal-700)', fontWeight: 700 }}>Product Code: {p.fp_code}</span>
                              {p.default_unit ? <span style={{ marginLeft: 8, color: "var(--ink-3)" }}>· {p.default_unit}</span> : null}
                            </div>
                          ) : null}
                        </button>
                      ))}
                    </div>
                  </>
                ) : (
                  <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                    <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                      <span style={labelText}>Product name / description *</span>
                      <input type="text" required placeholder="e.g. Vitamin D3 5000 IU softgel" value={newProductForm.name_desc}
                        onChange={(e) => setNewProductForm({ ...newProductForm, name_desc: e.target.value })} style={inputStyle} />
                    </label>
                    <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                      <span style={labelText}>Relevant information</span>
                      <textarea placeholder="Specs, target dosage, run size, packaging notes, deadlines."
                        value={newProductForm.notes} rows={4}
                        onChange={(e) => setNewProductForm({ ...newProductForm, notes: e.target.value })}
                        style={textareaStyle} />
                    </label>
                    <div>
                      <span style={labelText}>Attachments</span>
                      <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 6 }}>
                        <label style={uploadBtnStyle}>
                          + Upload file
                          <input ref={fileInputRef} type="file" multiple style={{ display: "none" }} onChange={onFilesPicked} />
                        </label>
                        <span style={{ fontSize: 12, color: "var(--ink-3)" }}>
                          {files.length === 0 ? "Spec sheets, COAs, artwork." : `${files.length} file${files.length === 1 ? "" : "s"} staged`}
                        </span>
                      </div>
                      {files.length > 0 ? (
                        <ul style={{ listStyle: "none", padding: 0, margin: "8px 0 0 0", display: "flex", flexDirection: "column", gap: 4 }}>
                          {files.map((f, i) => (
                            <li key={`${f.name}-${i}`} style={{ fontSize: 13, color: "var(--ink-2)", padding: "6px 10px", background: "#fffdf8", border: "1px solid #e3dcc9", borderRadius: 6, display: "flex", justifyContent: "space-between" }}>
                              <span>{f.name} <span style={{ color: "var(--ink-3)" }}>· {(f.size / 1024).toFixed(1)} KB</span></span>
                              <button type="button" onClick={() => setFiles(files.filter((_, j) => j !== i))} style={{ border: "none", background: "transparent", color: "var(--ink-3)", cursor: "pointer" }}>×</button>
                            </li>
                          ))}
                        </ul>
                      ) : null}
                    </div>
                  </div>
                )}
              </>
            )}
          </div>

          <div style={sectionStyle}>
            <p style={sectionLabelStyle}>Quantities</p>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {tiers.map((tier, i) => (
                <div key={i} style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <input type="text" inputMode="numeric" placeholder={i === 0 ? "e.g. 500" : "additional tier"}
                    value={tier} onChange={(e) => setTier(i, e.target.value)} style={inputStyle} />
                  <div style={{ padding: "10px 14px", background: "#fffdf8", border: "1.5px solid #e3dcc9", borderRadius: 8, fontSize: 13, color: "var(--ink-2)", fontWeight: 600, whiteSpace: "nowrap" }}>units</div>
                  {tiers.length > 1 ? (
                    <button type="button" onClick={() => removeTier(i)}
                      style={{ background: "transparent", border: "none", color: "var(--ink-3)", fontSize: 18, cursor: "pointer", padding: "0 6px" }}>×</button>
                  ) : null}
                </div>
              ))}
              <button type="button" onClick={addTier} style={addTierStyle}>+ Add another tier</button>
              <p style={{ fontSize: 12, color: "var(--ink-3)", margin: "8px 0 0" }}>For bulk, <strong>1 unit = 1,000</strong>.</p>
            </div>
          </div>

          <button type="submit" disabled={!canSubmit}
            style={{
              display: "block", width: "100%", marginTop: 8,
              padding: "14px 16px", background: canSubmit ? "var(--teal-900)" : "#cdd5cc",
              color: "#fff", border: "none", borderRadius: 10,
              fontSize: 15, fontWeight: 700, cursor: canSubmit ? "pointer" : "not-allowed",
              fontFamily: "inherit", letterSpacing: "0.01em",
            }}>
            Review &amp; continue →
          </button>
          {!canSubmit ? (
            <p style={{ fontSize: 12, color: "var(--ink-3)", marginTop: 10, textAlign: "center" }}>
              Still need: {missing.join(", ")}.
            </p>
          ) : null}
        </form>
      </div>
    </main>
  );
}
