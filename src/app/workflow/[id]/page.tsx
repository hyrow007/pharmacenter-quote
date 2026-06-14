import { redirect } from "next/navigation";
import type { CSSProperties } from "react";
import { createClient } from "@/lib/auth/server";
import { isAdmin, type WorkflowRow } from "@/lib/workflows";
import WorkflowActions from "./actions";

// Workflow management page. Replaces the role formerly played by
// /workflow/review — we now have a durable DB row to anchor everything to,
// so this is the home for "look at the snapshot, then act on it".

const TYPE_LABELS: Record<string, string> = {
  "bulk": "Bulk",
  "contract-packaging": "Contract Packaging",
  "finished-product": "Finished Product",
  "other": "Other",
};
const FORM_LABELS: Record<string, string> = {
  softgel: "Softgels", gummy: "Gummies", tablet: "Tablets", capsule: "Capsules", other: "Other",
};
const SOURCE_LABELS: Record<string, string> = {
  "third-party": "Third party",
  "pharmacenter": "Manufactured at PharmaCenter",
  "other": "Other source",
};

function cleanQty(q: string): string {
  const t = q.replace(/,/g, "").trim();
  return /^\d+(\.\d+)?$/.test(t) ? t : "";
}

function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString("en-US", {
    month: "short", day: "numeric", year: "numeric",
    hour: "numeric", minute: "2-digit",
  });
}

type Ctx = { params: Promise<{ id: string }> };

export default async function WorkflowPage({ params }: Ctx) {
  const { id } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // Domain gate: callback ensures only @pharmacenterusa.com users land here,
  // but if someone manually navigates we bounce them out the front door.
  if (!user || !user.email?.endsWith("@pharmacenterusa.com")) {
    redirect("/");
  }

  const { data } = await supabase
    .from("workflows")
    .select(
      "id, created_by_email, created_at, updated_at, state, monday_item_id, monday_item_url, monday_last_pushed_at",
    )
    .eq("id", id)
    .maybeSingle();

  if (!data) redirect("/workflows");
  const workflow = data as WorkflowRow;
  const admin = await isAdmin(supabase, user.email);
  const owner = workflow.created_by_email === user.email;

  // Hydrate customer + product display data with the same anon client used
  // by the rest of the app — these tables are not RLS-gated for reads.
  let customer: { id: string; name: string; default_ship_to: string | null } | null = null;
  if (workflow.state.customerMode === "existing" && workflow.state.customerId) {
    const { data: c } = await supabase
      .from("customers")
      .select("id, name, default_ship_to")
      .eq("id", workflow.state.customerId)
      .maybeSingle();
    if (c) customer = c;
  }

  const productIds = workflow.state.products
    .map((p) => p.productId)
    .filter((pid): pid is string => !!pid && pid !== "new");
  const productMap: Record<string, { id: string; name: string; fp_code: string | null; default_unit: string | null }> = {};
  if (productIds.length > 0) {
    const { data: rows } = await supabase
      .from("products")
      .select("id, name, fp_code, default_unit")
      .in("id", productIds);
    for (const r of (rows ?? []) as Array<{ id: string; name: string; fp_code: string | null; default_unit: string | null }>) {
      productMap[r.id] = r;
    }
  }

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
  const productRow: CSSProperties = {
    padding: "12px 14px", border: "1px solid #d8d3c1", borderRadius: 8,
    background: "#fff", marginBottom: 8,
  };

  const state = workflow.state;
  const customerBlock = (() => {
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
    return <div style={valueStyle}>—</div>;
  })();

  return (
    <main className="hero">
      <div className="card card--wide" style={{ position: "relative" }}>
        <p className="eyebrow">PharmaCenter · Workflow</p>
        <h1>Workflow</h1>
        <p className="lede">
          Snapshot of this quote workflow. Push it to monday, edit, or hand it off.
        </p>

        {/* ----- Meta strip ----- */}
        <div
          style={{
            display: "flex", flexWrap: "wrap", gap: 18,
            padding: "12px 0", marginBottom: 18,
            borderTop: "1px solid #e3dcc9", borderBottom: "1px solid #e3dcc9",
            fontSize: 12, color: "var(--ink-3)",
          }}
        >
          <span><strong style={{ color: "var(--ink-1)" }}>Created by:</strong> {workflow.created_by_email}</span>
          <span><strong style={{ color: "var(--ink-1)" }}>Created:</strong> {formatTimestamp(workflow.created_at)}</span>
          <span><strong style={{ color: "var(--ink-1)" }}>Updated:</strong> {formatTimestamp(workflow.updated_at)}</span>
          {workflow.monday_item_url ? (
            <span>
              <strong style={{ color: "var(--ink-1)" }}>Monday:</strong>{" "}
              <a href={workflow.monday_item_url} target="_blank" rel="noopener noreferrer"
                style={{ color: "var(--teal-700)", fontWeight: 700 }}>
                Open item ↗
              </a>
              {workflow.monday_last_pushed_at
                ? ` · last pushed ${formatTimestamp(workflow.monday_last_pushed_at)}`
                : null}
            </span>
          ) : (
            <span style={{ color: "var(--ink-3)" }}>
              <strong style={{ color: "var(--ink-1)" }}>Monday:</strong> not pushed yet
            </span>
          )}
        </div>

        {/* ----- Summary card ----- */}
        <div style={{ border: "1.5px solid #e3dcc9", borderRadius: 12, background: "#fffdf8", marginBottom: 28, overflow: "hidden" }}>
          <div style={sectionStyle}>
            <span style={labelStyle}>Customer</span>
            {customerBlock}
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
                const name = isNew ? (p.newProduct.name_desc || "New product") : (pr?.name ?? "—");
                const code = isNew ? null : pr?.fp_code ?? null;
                const cleanQs = p.quantities.map(cleanQty).filter((q) => q.length > 0);
                return (
                  <div key={p.uid} style={productRow}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 4 }}>
                      <div style={{ fontSize: 14, fontWeight: 700, color: "var(--ink-1)" }}>{name}</div>
                      <div style={{ fontSize: 11, color: "var(--ink-3)", letterSpacing: "0.06em", textTransform: "uppercase" }}>
                        Product {idx + 1}
                      </div>
                    </div>
                    {code ? (
                      <div style={{ fontSize: 12, marginBottom: 6 }}>
                        <span style={{ fontFamily: '"IBM Plex Mono", ui-monospace, monospace', color: "var(--teal-700)", fontWeight: 700 }}>
                          Product Code: {code}
                        </span>
                        {pr?.default_unit ? (
                          <span style={{ marginLeft: 8, color: "var(--ink-3)" }}>· {pr.default_unit}</span>
                        ) : null}
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
          Actions
        </h2>

        <WorkflowActions
          workflow={workflow}
          customer={customer ? { id: customer.id, name: customer.name } : null}
          productMap={Object.fromEntries(
            Object.entries(productMap).map(([k, v]) => [k, { id: v.id, name: v.name, fp_code: v.fp_code }]),
          )}
          isOwner={owner}
          isAdmin={admin}
        />

        <a href="/workflows" className="backlink">&larr; Back to all workflows</a>
      </div>
    </main>
  );
}
