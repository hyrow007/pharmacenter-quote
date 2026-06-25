"use client";

import { useState, useEffect, useRef, Suspense, type ChangeEvent, type FormEvent, type CSSProperties } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { supabase, type Product } from "@/lib/supabase";
import { uploadAttachment, removeAttachment, type WorkflowAttachment } from "@/lib/storage";
import type { WorkflowRow, WorkflowState as SharedWorkflowState, ProductEntry as SharedProductEntry } from "@/lib/workflows";
import { useEffectiveAdmin } from "@/lib/access";

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

// Gummies are only sourced as Third party or Manufactured at PharmaCenter.
// We don't have an "Other" source for gummies — keeping the list tight
// avoids the UX of presenting a pointless option.
const SOURCES = [
  { id: "third-party", name: "Third party" },
  { id: "pharmacenter", name: "Manufactured at PharmaCenter" },
];

const PAGE_SIZE = 50;
const STORAGE_KEY = "quote.workflow.v1";

// ----- types --------------------------------------------------------------

type CustomerRow = { id: string; name: string; default_ship_to: string | null };
type ProductRow = Pick<Product, "id" | "name" | "fp_code" | "default_unit">;
type Mode = "existing" | "new";

// Re-export the shared shapes under local names so the existing JSX (which
// references `ProductEntry` / `WorkflowState`) keeps compiling.
type ProductEntry = SharedProductEntry;
type WorkflowState = SharedWorkflowState;

// Lightweight uuid for React keys + storage prefix.
function uid(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function newProductEntry(): ProductEntry {
  return {
    uid: uid(),
    mode: "existing",
    productId: null,
    newProduct: { name_desc: "", notes: "" },
    quantities: [""],
    attachments: [],
    // Default to "purchase" — most workflows need sourcing. Users flip to
    // "stock" when they confirm we already have inventory on hand.
    sourceMode: "purchase",
  };
}

function blankState(): WorkflowState {
  return {
    workflowUid: uid(),
    customerMode: "existing",
    customerId: null,
    newCustomer: { name: "", contact: "", email: "" },
    type: null,
    form: null,
    source: null,
    products: [newProductEntry()],
  };
}

function loadState(): WorkflowState {
  if (typeof window === "undefined") return blankState();
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return blankState();
    const parsed = JSON.parse(raw) as Partial<WorkflowState>;
    // Be defensive — if older shape is present, fall back to blank.
    if (!parsed.workflowUid || !Array.isArray(parsed.products) || parsed.products.length === 0) {
      return blankState();
    }
    return { ...blankState(), ...parsed } as WorkflowState;
  } catch {
    return blankState();
  }
}

// ----- shared styles ------------------------------------------------------

const sectionStyle: CSSProperties = {
  border: "1.5px solid #e3dcc9", borderRadius: 12, background: "#fffdf8",
  padding: "16px 18px", marginBottom: 14,
};
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
// Greyed-out pill for features the current user can't access yet (e.g.
// non-admins seeing Contract Packaging or "Manufactured at PharmaCenter"
// gummies). Looks visually similar to disabled native form controls but
// stays consistent with the surrounding pill style.
const pillMuted: CSSProperties = {
  ...pillBase,
  background: "#f5f1e6",
  color: "var(--ink-3)",
  borderColor: "#e3dcc9",
  cursor: "not-allowed",
  opacity: 0.7,
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
const productCardStyle: CSSProperties = {
  border: "1.5px solid #d8d3c1", borderRadius: 10, background: "#fff",
  padding: "14px 16px", marginBottom: 10,
};

// ----- component ----------------------------------------------------------

// Next 14 requires components using `useSearchParams` to sit inside a
// Suspense boundary; otherwise the whole page bails out of static rendering.
export default function StartWorkflowPage() {
  return (
    <Suspense fallback={<main className="hero"><div className="card card--wide"><p className="lede">Loading…</p></div></main>}>
      <StartWorkflow />
    </Suspense>
  );
}

function StartWorkflow() {
  const router = useRouter();
  const searchParams = useSearchParams();
  // ?workflow=<uuid> → editing an existing workflow row.
  const editingId = searchParams.get("workflow");
  // ?fresh=1 → user clicked "+ New workflow". Wipe any leftover draft
  // before hydrating so they don't inherit fields from the last quote
  // they were working on.
  const fresh = searchParams.get("fresh") === "1";

  // Effective-admin gate. Non-admins (and admins in "view as user" mode)
  // are temporarily restricted to creating Bulk workflows in any dosage
  // form EXCEPT gummies sourced from PharmaCenter. Everything else on the
  // /start page renders as muted/disabled pills until the admin promotes
  // the user or flips back to admin view.
  const { effectiveAdmin } = useEffectiveAdmin();

  // Per-rule helpers — pulled out as functions so the JSX stays readable.
  function isTypeAllowed(typeId: string): boolean {
    if (effectiveAdmin) return true;
    return typeId === "bulk";
  }
  function isFormAllowed(_formId: string): boolean {
    // All dosage forms are allowed for users — the gummy + PharmaCenter
    // combo is blocked at the source step instead.
    return true;
  }
  function isSourceAllowed(sourceId: string, formId: string | null): boolean {
    if (effectiveAdmin) return true;
    // The one feature we're holding back from users right now.
    if (formId === "gummy" && sourceId === "pharmacenter") return false;
    return true;
  }

  // If the user is currently sitting on a now-disallowed selection (e.g.
  // they had a Contract Packaging draft and we flipped them to user mode),
  // clear it so the form doesn't carry a hidden disallowed value to submit.
  useEffect(() => {
    setState((s) => {
      const next = { ...s };
      let touched = false;
      if (s.type && !isTypeAllowed(s.type)) {
        next.type = null;
        next.form = null;
        next.source = null;
        touched = true;
      }
      if (s.source && !isSourceAllowed(s.source, s.form)) {
        next.source = null;
        touched = true;
      }
      return touched ? next : s;
    });
    // We deliberately exclude isTypeAllowed/isSourceAllowed from deps —
    // they close over `effectiveAdmin` which IS the dep we care about.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveAdmin]);

  // Single source of truth for the workflow form.
  const [state, setState] = useState<WorkflowState>(() => blankState());
  const [hydrated, setHydrated] = useState(false);
  // Tracks the DB id when we're editing — null for a fresh workflow.
  const [workflowId, setWorkflowId] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Hydrate either from the DB (if editing) or from sessionStorage (drafts).
  useEffect(() => {
    let cancelled = false;
    async function hydrate() {
      if (editingId) {
        // Loading an existing workflow row. Skip sessionStorage entirely so
        // a stale draft from a previous workflow can't bleed in.
        try {
          const res = await fetch(`/api/workflows/${editingId}`, { cache: "no-store" });
          const data = await res.json();
          if (!cancelled && res.ok && data?.ok && data.workflow) {
            const row = data.workflow as WorkflowRow;
            setWorkflowId(row.id);
            setState(row.state);
            setHydrated(true);
            return;
          }
          // Fall through to draft on any failure — better than a blank screen.
        } catch (err) {
          console.error("workflow hydrate failed:", err);
        }
      }
      if (!cancelled) {
        if (fresh) {
          // Explicit new-workflow entry. Drop any stale draft so the form
          // starts blank — the user shouldn't see fields from a quote they
          // already pushed/edited last.
          if (typeof window !== "undefined") {
            window.sessionStorage.removeItem(STORAGE_KEY);
          }
          setState(blankState());
        } else {
          setState(loadState());
        }
        setHydrated(true);
      }
    }
    hydrate();
    return () => { cancelled = true; };
  }, [editingId, fresh]);

  // Auto-save the in-progress draft to sessionStorage on every change. We
  // skip persisting hydrated `_name` / `_code` — those are display-only and
  // get re-fetched on remount from product IDs. When editing an existing
  // workflow we still mirror to sessionStorage so an accidental tab close
  // doesn't lose the pending edits before submit.
  useEffect(() => {
    if (!hydrated || typeof window === "undefined") return;
    const toSave: WorkflowState = {
      ...state,
      products: state.products.map((p) => ({
        ...p, _name: undefined, _code: undefined,
      })),
    };
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(toSave));
  }, [state, hydrated]);

  // Convenience updaters -------------------------------------------------
  const setField = <K extends keyof WorkflowState>(k: K, v: WorkflowState[K]) =>
    setState((s) => ({ ...s, [k]: v }));

  const setProduct = (uid: string, updater: (p: ProductEntry) => ProductEntry) =>
    setState((s) => ({ ...s, products: s.products.map((p) => (p.uid === uid ? updater(p) : p)) }));

  const addProduct = () =>
    setState((s) => ({ ...s, products: [...s.products, newProductEntry()] }));

  const removeProduct = (uid: string) =>
    setState((s) => ({ ...s, products: s.products.length > 1 ? s.products.filter((p) => p.uid !== uid) : s.products }));

  // ----- customer search ---------------------------------------------
  const [customerName, setCustomerName] = useState<string | null>(null);
  const [customerShipTo, setCustomerShipTo] = useState<string | null>(null);
  const [editingCustomer, setEditingCustomer] = useState(true);
  const [customerSearch, setCustomerSearch] = useState("");
  const [customers, setCustomers] = useState<CustomerRow[]>([]);

  useEffect(() => {
    // Once we hydrate, collapse the customer section if we have a picked customer.
    if (hydrated && state.customerId) setEditingCustomer(false);
  }, [hydrated, state.customerId]);

  useEffect(() => {
    const sb = supabase;
    if (!sb) return;
    const term = customerSearch.trim();
    if (term.length === 0) { setCustomers([]); return; }
    const handle = setTimeout(async () => {
      const { data } = await sb.from("customers")
        .select("id, name, default_ship_to")
        .eq("active", true)
        .ilike("name", `%${term}%`)
        .order("name")
        .limit(PAGE_SIZE);
      setCustomers((data ?? []) as CustomerRow[]);
    }, 180);
    return () => clearTimeout(handle);
  }, [customerSearch]);

  // Hydrate customer name from ID (when coming back from review).
  useEffect(() => {
    if (!state.customerId || customerName) return;
    const sb = supabase;
    if (!sb) return;
    sb.from("customers").select("id, name, default_ship_to").eq("id", state.customerId).maybeSingle()
      .then(({ data }) => {
        if (data) { setCustomerName(data.name); setCustomerShipTo(data.default_ship_to); }
      });
  }, [state.customerId, customerName]);

  // ----- per-product product search -----------------------------------
  // One search state per product card, keyed by product.uid.
  const [productSearches, setProductSearches] = useState<Record<string, string>>({});
  const [productResults, setProductResults] = useState<Record<string, ProductRow[]>>({});

  const setProductSearch = (uid: string, v: string) =>
    setProductSearches((m) => ({ ...m, [uid]: v }));

  // Debounced search per product card.
  useEffect(() => {
    const sb = supabase;
    if (!sb) return;
    const handles: ReturnType<typeof setTimeout>[] = [];
    for (const p of state.products) {
      if (p.mode !== "existing") continue;
      const term = (productSearches[p.uid] ?? "").trim();
      if (term.length === 0) {
        setProductResults((m) => ({ ...m, [p.uid]: [] }));
        continue;
      }
      const t = setTimeout(async () => {
        const { data } = await sb.from("products")
          .select("id, fp_code, name, default_unit")
          .eq("active", true)
          .or(`fp_code.ilike.%${term}%,name.ilike.%${term}%`)
          .order("name")
          .limit(PAGE_SIZE);
        setProductResults((m) => ({ ...m, [p.uid]: (data ?? []) as ProductRow[] }));
      }, 180);
      handles.push(t);
    }
    return () => { for (const h of handles) clearTimeout(h); };
  // We intentionally key on the search-term map and the products' uids/modes only.
  }, [productSearches, state.products]);

  // Hydrate product display names from IDs (when coming back from review).
  useEffect(() => {
    const sb = supabase;
    if (!sb) return;
    for (const p of state.products) {
      if (!p.productId || p._name) continue;
      sb.from("products").select("id, name, fp_code").eq("id", p.productId).maybeSingle()
        .then(({ data }) => {
          if (data) setProduct(p.uid, (cur) => ({ ...cur, _name: data.name, _code: data.fp_code }));
        });
    }
  // We want this to re-run when the product list shape changes.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.products.map((p) => p.productId).join("|")]);

  // ----- derived flags -------------------------------------------------
  const isBulk = state.type === "bulk";
  const showFormSection = isBulk;
  const showSourceSection = isBulk && state.form === "gummy";

  const customerOk = state.customerMode === "existing"
    ? !!state.customerId
    : !!state.newCustomer.name.trim();
  const formOk = !showFormSection || !!state.form;
  const sourceOk = !showSourceSection || !!state.source;

  const productsOk = state.products.every((p) => {
    const productPicked = p.mode === "existing" ? !!p.productId : !!p.newProduct.name_desc.trim();
    const qtyOk = p.quantities.some((q) => q.trim().length > 0 && /^\d+(\.\d+)?$/.test(q.replace(/,/g, "")));
    return productPicked && qtyOk;
  });

  const missing: string[] = [];
  if (!customerOk) missing.push("Customer");
  if (!state.type) missing.push("Quote type");
  if (!formOk) missing.push("Dosage form");
  if (!sourceOk) missing.push("Source");
  if (!productsOk) missing.push("Each product needs a name and at least one quantity");

  const canSubmit = missing.length === 0;

  // ----- file pickers --------------------------------------------------
  // Refs are keyed per product so multiple uploads can fire concurrently.
  const fileInputs = useRef<Record<string, HTMLInputElement | null>>({});
  const [uploading, setUploading] = useState<Record<string, number>>({});

  const onFilesPicked = async (productUid: string, e: ChangeEvent<HTMLInputElement>) => {
    const picked = Array.from(e.target.files || []);
    if (picked.length === 0) return;
    e.target.value = "";
    setUploading((m) => ({ ...m, [productUid]: (m[productUid] ?? 0) + picked.length }));
    for (const file of picked) {
      const att = await uploadAttachment(state.workflowUid, file);
      if (att) {
        setProduct(productUid, (p) => ({ ...p, attachments: [...p.attachments, att] }));
      }
      setUploading((m) => ({ ...m, [productUid]: Math.max(0, (m[productUid] ?? 0) - 1) }));
    }
  };

  const onRemoveAttachment = async (productUid: string, path: string) => {
    setProduct(productUid, (p) => ({ ...p, attachments: p.attachments.filter((a) => a.path !== path) }));
    // Fire-and-forget storage cleanup.
    void removeAttachment(path);
  };

  // ----- submit --------------------------------------------------------
  // Strip the display-only `_name` / `_code` from products before sending —
  // they get re-resolved server-side from `productId` anyway.
  const serializableState = (): WorkflowState => ({
    ...state,
    products: state.products.map((p) => ({
      ...p, _name: undefined, _code: undefined,
    })),
  });

  const submit = async (e?: FormEvent) => {
    if (e) e.preventDefault();
    if (!canSubmit || saving) return;
    setSaveError(null);
    setSaving(true);
    try {
      const payload = { state: serializableState() };
      const url = workflowId ? `/api/workflows/${workflowId}` : "/api/workflows";
      const method = workflowId ? "PUT" : "POST";
      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok || !data?.ok || !data.workflow?.id) {
        const reason = data?.error || `HTTP ${res.status}`;
        if (reason === "not_signed_in") {
          setSaveError("You need to sign in first. Redirecting…");
          window.setTimeout(() => router.push("/"), 1200);
          return;
        }
        setSaveError(`Save failed: ${reason}`);
        return;
      }
      const savedId = data.workflow.id as string;
      // Workflow now lives in the DB — drop the draft so the next /start
      // visit starts clean.
      if (typeof window !== "undefined") {
        window.sessionStorage.removeItem(STORAGE_KEY);
      }
      router.push(`/workflow/${savedId}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setSaveError(`Save errored: ${msg}`);
    } finally {
      setSaving(false);
    }
  };

  // ----- pickers -------------------------------------------------------
  const pickType = (id: string) => {
    setState((s) => ({
      ...s,
      type: id,
      // Clear downstream state when leaving bulk.
      form: id === "bulk" ? s.form : null,
      source: id === "bulk" ? s.source : null,
    }));
  };

  const pickCustomer = (c: CustomerRow) => {
    setField("customerId", c.id);
    setCustomerName(c.name);
    setCustomerShipTo(c.default_ship_to);
    setEditingCustomer(false);
  };

  const pickProductFor = (uid: string, p: ProductRow) =>
    setProduct(uid, (cur) => ({ ...cur, productId: p.id, _name: p.name, _code: p.fp_code }));

  // ----- render --------------------------------------------------------
  if (!hydrated) {
    return (
      <main className="hero">
        <div className="card card--wide"><p className="lede">Loading…</p></div>
      </main>
    );
  }

  // "Looks like a draft" heuristic — we only show the "Discard draft" link
  // when we hydrated from sessionStorage AND there's something to discard.
  // (No workflowId means we're not editing a saved row.)
  const looksLikeDraft =
    !workflowId &&
    !fresh &&
    (!!state.customerId ||
      !!state.type ||
      !!state.form ||
      state.products.some(
        (p) => p.productId || (p.newProduct?.name_desc ?? "").trim().length > 0,
      ));

  const discardDraft = () => {
    if (typeof window !== "undefined") {
      window.sessionStorage.removeItem(STORAGE_KEY);
    }
    // Hard navigate so the URL gains ?fresh=1 and the page rehydrates blank.
    window.location.href = "/start?fresh=1";
  };

  return (
    <main className="hero">
      <div className="card card--wide">
        <p className="eyebrow">PharmaCenter · Workflow</p>
        <h1>{workflowId ? "Editing workflow" : "Start a quote workflow"}</h1>
        <p className="lede">Pull together everything we need to quote this, then send it where it needs to go.</p>

        {looksLikeDraft ? (
          <div
            style={{
              marginTop: 14,
              padding: "10px 14px",
              background: "#fffdf8",
              border: "1px dashed #e3dcc9",
              borderRadius: 8,
              fontSize: 13,
              color: "var(--ink-2)",
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              gap: 12,
              flexWrap: "wrap",
            }}
          >
            <span>
              Resumed an in-progress draft. Need to quote something different?
            </span>
            <button
              type="button"
              onClick={discardDraft}
              style={{
                background: "transparent",
                border: "1px solid var(--stone)",
                color: "var(--teal-700)",
                fontFamily: "inherit",
                fontSize: 11,
                fontWeight: 700,
                letterSpacing: "0.06em",
                textTransform: "uppercase",
                padding: "6px 12px",
                borderRadius: 8,
                cursor: "pointer",
              }}
            >
              Discard draft
            </button>
          </div>
        ) : null}

        <form onSubmit={submit} style={{ marginTop: 18 }}>

          {/* ----- Customer ----- */}
          <div style={sectionStyle}>
            <p style={sectionLabelStyle}>Customer</p>
            {!editingCustomer && state.customerMode === "existing" && state.customerId && customerName ? (
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
                  <button type="button" style={tabBtn(state.customerMode === "existing")}
                    onClick={() => setField("customerMode", "existing")}>Existing</button>
                  <button type="button" style={tabBtn(state.customerMode === "new")}
                    onClick={() => setField("customerMode", "new")}>New customer</button>
                </div>
                {state.customerMode === "existing" ? (
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
                      <input type="text" required value={state.newCustomer.name}
                        onChange={(e) => setField("newCustomer", { ...state.newCustomer, name: e.target.value })} style={inputStyle} />
                    </label>
                    <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                      <span style={labelText}>Primary contact</span>
                      <input type="text" value={state.newCustomer.contact}
                        onChange={(e) => setField("newCustomer", { ...state.newCustomer, contact: e.target.value })} style={inputStyle} />
                    </label>
                    <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                      <span style={labelText}>Email</span>
                      <input type="email" value={state.newCustomer.email}
                        onChange={(e) => setField("newCustomer", { ...state.newCustomer, email: e.target.value })} style={inputStyle} />
                    </label>
                  </div>
                )}
              </>
            )}
          </div>

          {/* ----- Quote type ----- */}
          <div style={sectionStyle}>
            <p style={sectionLabelStyle}>Quote type</p>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              {TYPES.map((t) => {
                const allowed = isTypeAllowed(t.id);
                const active = state.type === t.id;
                return (
                  <button
                    key={t.id}
                    type="button"
                    disabled={!allowed}
                    onClick={() => allowed && pickType(t.id)}
                    title={allowed ? "" : "Admin only — coming soon for users."}
                    style={
                      !allowed
                        ? pillMuted
                        : active
                          ? pillActive
                          : pillBase
                    }
                  >
                    {t.name}
                    {!allowed ? " 🔒" : ""}
                  </button>
                );
              })}
            </div>
          </div>

          {/* ----- Dosage form (bulk only) ----- */}
          {showFormSection ? (
            <div style={sectionStyle}>
              <p style={sectionLabelStyle}>Dosage form</p>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                {FORMS.map((f) => {
                  const allowed = isFormAllowed(f.id);
                  const active = state.form === f.id;
                  return (
                    <button
                      key={f.id}
                      type="button"
                      disabled={!allowed}
                      onClick={() =>
                        allowed &&
                        setState((s) => ({
                          ...s,
                          form: f.id,
                          source: f.id === "gummy" ? s.source : null,
                        }))
                      }
                      title={allowed ? "" : "Admin only — coming soon for users."}
                      style={
                        !allowed
                          ? pillMuted
                          : active
                            ? pillActive
                            : pillBase
                      }
                    >
                      {f.name}
                      {!allowed ? " 🔒" : ""}
                    </button>
                  );
                })}
              </div>
            </div>
          ) : null}

          {/* ----- Source (bulk + gummies only) ----- */}
          {showSourceSection ? (
            <div style={sectionStyle}>
              <p style={sectionLabelStyle}>Source</p>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                {SOURCES.map((s) => {
                  const allowed = isSourceAllowed(s.id, state.form);
                  const active = state.source === s.id;
                  return (
                    <button
                      key={s.id}
                      type="button"
                      disabled={!allowed}
                      onClick={() => allowed && setField("source", s.id)}
                      title={allowed ? "" : "Admin only — coming soon for users."}
                      style={
                        !allowed
                          ? pillMuted
                          : active
                            ? pillActive
                            : pillBase
                      }
                    >
                      {s.name}
                      {!allowed ? " 🔒" : ""}
                    </button>
                  );
                })}
              </div>
            </div>
          ) : null}

          {/* ----- Products (multi) ----- */}
          <div style={sectionStyle}>
            <p style={sectionLabelStyle}>
              Products <span style={{ color: "var(--ink-3)", fontWeight: 500, textTransform: "none", letterSpacing: 0 }}>
                ({state.products.length})
              </span>
            </p>
            {state.products.map((p, idx) => (
              <div key={p.uid} style={productCardStyle}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: "var(--teal-700)", letterSpacing: "0.06em", textTransform: "uppercase" }}>
                    Product {idx + 1}
                  </div>
                  {state.products.length > 1 ? (
                    <button type="button" onClick={() => removeProduct(p.uid)}
                      style={{ background: "transparent", border: "none", color: "var(--ink-3)", fontSize: 13, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>
                      Remove
                    </button>
                  ) : null}
                </div>
                {/* Source toggle — Purchase vs Existing stock. Stock items
                    skip the monday push (no need to source) and skip inbound
                    costs in the pricing calculator (landed cost already in
                    Fishbowl). Default is Purchase. */}
                <div style={{ marginBottom: 12 }}>
                  <span style={labelText}>Source</span>
                  <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
                    {(["purchase", "stock"] as const).map((mode) => {
                      const active = (p.sourceMode ?? "purchase") === mode;
                      return (
                        <button
                          key={mode}
                          type="button"
                          onClick={() =>
                            setProduct(p.uid, (cur) => ({
                              ...cur,
                              sourceMode: mode,
                              // Existing-stock products can't be "new" by
                              // definition (we don't stock products that
                              // don't exist yet) — force the entry back to
                              // "existing" mode and wipe any in-progress
                              // new-product fields so they don't bleed back
                              // if the user flips Source again.
                              ...(mode === "stock"
                                ? {
                                    mode: "existing" as const,
                                    newProduct: { name_desc: "", notes: "" },
                                  }
                                : {}),
                            }))
                          }
                          style={{
                            flex: 1,
                            padding: "10px 12px",
                            borderRadius: 8,
                            border: active
                              ? "2px solid var(--teal-700)"
                              : "1.5px solid #e3dcc9",
                            background: active ? "#f0fdfa" : "#fffdf8",
                            color: active ? "var(--teal-700)" : "var(--ink-2)",
                            fontWeight: active ? 700 : 600,
                            fontSize: 13,
                            cursor: "pointer",
                            fontFamily: "inherit",
                            textAlign: "left",
                          }}
                        >
                          <div>
                            {mode === "purchase" ? "Purchase needed" : "Existing stock"}
                          </div>
                          <div
                            style={{
                              fontSize: 11,
                              fontWeight: 500,
                              color: "var(--ink-3)",
                              marginTop: 2,
                            }}
                          >
                            {mode === "purchase"
                              ? "Source via monday + add inbound costs"
                              : "We have it — skip sourcing + inbound costs"}
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </div>

                <ProductPicker
                  entry={p}
                  results={productResults[p.uid] ?? []}
                  search={productSearches[p.uid] ?? ""}
                  onSearch={(v) => setProductSearch(p.uid, v)}
                  onPick={(pr) => pickProductFor(p.uid, pr)}
                  onSetMode={(m) => setProduct(p.uid, (cur) => ({ ...cur, mode: m }))}
                  onChangeProduct={() => setProduct(p.uid, (cur) => ({ ...cur, productId: null, _name: null, _code: null }))}
                  onNewNameChange={(v) => setProduct(p.uid, (cur) => ({ ...cur, newProduct: { ...cur.newProduct, name_desc: v } }))}
                  onNewNotesChange={(v) => setProduct(p.uid, (cur) => ({ ...cur, newProduct: { ...cur.newProduct, notes: v } }))}
                />

                {/* Quantities */}
                <div style={{ marginTop: 14 }}>
                  <span style={labelText}>Quantities</span>
                  <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 6 }}>
                    {p.quantities.map((tier, i) => (
                      <div key={i} style={{ display: "flex", gap: 8, alignItems: "center" }}>
                        <input type="text" inputMode="numeric" placeholder={i === 0 ? "e.g. 500" : "additional tier"}
                          value={tier}
                          onChange={(e) => setProduct(p.uid, (cur) => ({ ...cur, quantities: cur.quantities.map((q, j) => (j === i ? e.target.value : q)) }))}
                          style={inputStyle} />
                        <div style={{ padding: "10px 14px", background: "#fffdf8", border: "1.5px solid #e3dcc9", borderRadius: 8, fontSize: 13, color: "var(--ink-2)", fontWeight: 600, whiteSpace: "nowrap" }}>units</div>
                        {p.quantities.length > 1 ? (
                          <button type="button"
                            onClick={() => setProduct(p.uid, (cur) => ({ ...cur, quantities: cur.quantities.filter((_, j) => j !== i) }))}
                            style={{ background: "transparent", border: "none", color: "var(--ink-3)", fontSize: 18, cursor: "pointer", padding: "0 6px" }}>×</button>
                        ) : null}
                      </div>
                    ))}
                    <button type="button"
                      onClick={() => setProduct(p.uid, (cur) => ({ ...cur, quantities: [...cur.quantities, ""] }))}
                      style={addTierStyle}>+ Add another tier</button>
                  </div>
                </div>

                {/* Attachments */}
                <div style={{ marginTop: 14 }}>
                  <span style={labelText}>Attachments</span>
                  <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 6 }}>
                    <label style={uploadBtnStyle}>
                      + Upload file
                      <input ref={(el) => { fileInputs.current[p.uid] = el; }} type="file" multiple style={{ display: "none" }}
                        onChange={(e) => onFilesPicked(p.uid, e)} />
                    </label>
                    <span style={{ fontSize: 12, color: "var(--ink-3)" }}>
                      {p.attachments.length === 0 && !uploading[p.uid] ? "Spec sheets, COAs, artwork." : null}
                      {(uploading[p.uid] ?? 0) > 0 ? `Uploading ${uploading[p.uid]}…` : null}
                      {p.attachments.length > 0 && !uploading[p.uid] ? `${p.attachments.length} file${p.attachments.length === 1 ? "" : "s"} ready.` : null}
                    </span>
                  </div>
                  {p.attachments.length > 0 ? (
                    <ul style={{ listStyle: "none", padding: 0, margin: "8px 0 0 0", display: "flex", flexDirection: "column", gap: 4 }}>
                      {p.attachments.map((a) => (
                        <li key={a.path} style={{ fontSize: 13, color: "var(--ink-2)", padding: "6px 10px", background: "#fffdf8", border: "1px solid #e3dcc9", borderRadius: 6, display: "flex", justifyContent: "space-between" }}>
                          <span>{a.name} <span style={{ color: "var(--ink-3)" }}>· {(a.size / 1024).toFixed(1)} KB</span></span>
                          <button type="button" onClick={() => onRemoveAttachment(p.uid, a.path)}
                            style={{ border: "none", background: "transparent", color: "var(--ink-3)", cursor: "pointer" }}>×</button>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              </div>
            ))}
            <button type="button" onClick={addProduct}
              style={{ ...addTierStyle, marginTop: 4 }}>+ Add another product</button>
            {isBulk ? (
              <p style={{ fontSize: 12, color: "var(--ink-3)", margin: "10px 0 0" }}>
                For bulk, <strong>1 unit = 1,000</strong>.
              </p>
            ) : null}
          </div>

          {/* ----- CTA ----- */}
          <button type="submit" disabled={!canSubmit || saving}
            style={{
              display: "block", width: "100%", marginTop: 8,
              padding: "14px 16px", background: canSubmit && !saving ? "var(--teal-900)" : "#cdd5cc",
              color: "#fff", border: "none", borderRadius: 10,
              fontSize: 15, fontWeight: 700, cursor: canSubmit && !saving ? "pointer" : "not-allowed",
              fontFamily: "inherit", letterSpacing: "0.01em",
            }}>
            {saving ? "Saving…" : workflowId ? "Save changes →" : "Save & continue →"}
          </button>
          {!canSubmit ? (
            <p style={{ fontSize: 12, color: "var(--ink-3)", marginTop: 10, textAlign: "center" }}>
              Still need: {missing.join(", ")}.
            </p>
          ) : null}
          {saveError ? (
            <p style={{ fontSize: 12, color: "#8b2f2f", marginTop: 10, textAlign: "center" }}>
              {saveError}
            </p>
          ) : null}
        </form>
      </div>
    </main>
  );
}

// ----- ProductPicker (sub-component) ------------------------------------

function ProductPicker(props: {
  entry: ProductEntry;
  results: ProductRow[];
  search: string;
  onSearch: (v: string) => void;
  onPick: (p: ProductRow) => void;
  onSetMode: (m: Mode) => void;
  onChangeProduct: () => void;
  onNewNameChange: (v: string) => void;
  onNewNotesChange: (v: string) => void;
}) {
  const { entry: p, results, search, onSearch, onPick, onSetMode, onChangeProduct, onNewNameChange, onNewNotesChange } = props;
  const showSelected = p.mode === "existing" && p.productId && p._name;

  return (
    <>
      {showSelected ? (
        <div style={selectedRow}>
          <div>
            <div style={{ fontSize: 15, fontWeight: 700, color: "var(--ink-1)" }}>{p._name}</div>
            {p._code ? (
              <div style={{ fontSize: 13, marginTop: 2 }}>
                <span style={{ fontFamily: '"IBM Plex Mono", ui-monospace, monospace', color: 'var(--teal-700)', fontWeight: 700 }}>Product Code: {p._code}</span>
              </div>
            ) : null}
          </div>
          <button type="button" style={changeBtn} onClick={onChangeProduct}>Change</button>
        </div>
      ) : (
        <>
          {/* Hide the Existing/New tabs entirely when this entry is marked
              as "Existing stock" — by definition we only have inventory of
              products that already exist, so "New product" doesn't apply. */}
          {(p.sourceMode ?? "purchase") === "stock" ? null : (
            <div style={tabsStyle}>
              <button type="button" style={tabBtn(p.mode === "existing")} onClick={() => onSetMode("existing")}>Existing</button>
              <button type="button" style={tabBtn(p.mode === "new")} onClick={() => onSetMode("new")}>New product</button>
            </div>
          )}
          {p.mode === "existing" ? (
            <>
              <input type="text" placeholder="Search by code or name…" value={search}
                onChange={(e) => onSearch(e.target.value)} style={inputStyle} />
              <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 6 }}>
                {results.map((pr) => (
                  <button key={pr.id} type="button" onClick={() => onPick(pr)}
                    style={{ textAlign: "left", padding: "10px 12px", background: "#fff", border: "1px solid #e3dcc9", borderRadius: 8, cursor: "pointer", fontFamily: "inherit" }}>
                    <div style={{ fontSize: 14, fontWeight: 700, color: "var(--ink-1)" }}>{pr.name}</div>
                    {pr.fp_code ? (
                      <div style={{ fontSize: 12, marginTop: 2 }}>
                        <span style={{ fontFamily: '"IBM Plex Mono", ui-monospace, monospace', color: 'var(--teal-700)', fontWeight: 700 }}>Product Code: {pr.fp_code}</span>
                        {pr.default_unit ? <span style={{ marginLeft: 8, color: "var(--ink-3)" }}>· {pr.default_unit}</span> : null}
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
                <input type="text" required placeholder="e.g. Vitamin D3 5000 IU softgel"
                  value={p.newProduct.name_desc}
                  onChange={(e) => onNewNameChange(e.target.value)} style={inputStyle} />
              </label>
              <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <span style={labelText}>Relevant information</span>
                <textarea placeholder="Specs, target dosage, run size, packaging notes, deadlines."
                  value={p.newProduct.notes} rows={4}
                  onChange={(e) => onNewNotesChange(e.target.value)}
                  style={textareaStyle} />
              </label>
            </div>
          )}
        </>
      )}
    </>
  );
}
