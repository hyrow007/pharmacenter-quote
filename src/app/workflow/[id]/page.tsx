import { redirect } from "next/navigation";
import type { CSSProperties } from "react";
import { createClient } from "@/lib/auth/server";
import {
  buildAutoDescription,
  formatQuoteNumber,
  isAdmin,
  type WorkflowRow,
} from "@/lib/workflows";
import AppHeader from "../../_components/AppHeader";
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

// Page is server-rendered, which means toLocaleString without an explicit
// timeZone option picks up the Vercel runtime's timezone (UTC). Pin to
// PharmaCenter's HQ timezone (US Eastern) so everyone in the company sees
// the same wall-clock time on every screen.
const TIMESTAMP_TZ = "America/New_York";
function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString("en-US", {
    month: "short", day: "numeric", year: "numeric",
    hour: "numeric", minute: "2-digit",
    timeZone: TIMESTAMP_TZ,
    timeZoneName: "short",
  });
}

const usdFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
});

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
      "id, quote_number, created_by_email, created_at, updated_at, state, status, sales_orders, description_override, monday_item_id, monday_item_url, monday_last_pushed_at",
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

  // Auto-computed "Description" label — matches the one shown in the
  // /workflows listing. Used as the placeholder in the inline description
  // editor so the user can see what the listing would show by default.
  const productNameMap: Record<string, string> = {};
  for (const [pid, info] of Object.entries(productMap)) {
    productNameMap[pid] = info.name;
  }
  const autoDescription = buildAutoDescription(workflow.state, productNameMap);

  // Resolve "Created by" to a Google-SSO full name via the user_directory
  // view. Falls back to the raw email if the user has never signed in (so
  // there's no auth.users row to read full_name from).
  let createdByDisplay = workflow.created_by_email;
  {
    const { data: dir } = await supabase
      .from("user_directory")
      .select("display_name")
      .eq("email", workflow.created_by_email)
      .maybeSingle();
    if (dir?.display_name) createdByDisplay = dir.display_name;
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

  const customerHeading = (() => {
    if (state.customerMode === "new") return state.newCustomer.name || "New customer";
    if (customer) return customer.name;
    return "Workflow";
  })();

  return (
    <div className="app-shell">
      <AppHeader user={{ email: user.email! }} />
      <main className="page">
        <div className="page__inner--narrow" style={{ position: "relative" }}>
        {/* Top-left Back to workflows pill — kept consistent with the
            same pill on /pricing and /start so navigation feels uniform
            across the app. Sits above the eyebrow so it's the first
            thing the eye lands on when the page loads. */}
        <a
          href="/workflows"
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            padding: "8px 14px",
            background: "var(--paper, #fffdf8)",
            border: "1px solid var(--line, #e3dcc9)",
            borderRadius: 999,
            fontSize: 13,
            fontWeight: 700,
            color: "var(--teal-900, #0f4a56)",
            textDecoration: "none",
            marginBottom: 16,
            whiteSpace: "nowrap",
          }}
        >
          <span aria-hidden="true">&larr;</span> Back to workflows
        </a>
        <div style={{ marginBottom: 22 }}>
          <p className="eyebrow" style={{ marginBottom: 6 }}>
            PharmaCenter · Workflow ·{" "}
            <span
              style={{
                fontFamily: '"IBM Plex Mono", ui-monospace, monospace',
                letterSpacing: "0.04em",
                color: "var(--teal-700)",
              }}
            >
              {formatQuoteNumber(workflow.quote_number)}
            </span>
          </p>
          <div style={{ display: "flex", alignItems: "baseline", gap: 14, flexWrap: "wrap" }}>
            <h1 className="page-header__title" style={{ marginBottom: 0 }}>
              Work Flow
            </h1>
            <span
              className={
                workflow.monday_item_id
                  ? "status-pill status-pill--pushed"
                  : "status-pill status-pill--draft"
              }
            >
              {workflow.monday_item_id ? "Pushed" : "Draft"}
            </span>
          </div>
          <div
            style={{
              fontFamily: '"Cormorant Garamond", Georgia, serif',
              fontSize: 26,
              color: "var(--teal-700)",
              marginTop: 6,
              fontWeight: 500,
            }}
          >
            {customerHeading}
          </div>
          <p className="lede" style={{ marginTop: 10, marginBottom: 0 }}>
            Snapshot of this quote workflow. Push it to monday, edit, or hand it off.
          </p>
        </div>

        {/* ----- Meta strip ----- */}
        <div
          style={{
            display: "flex", flexWrap: "wrap", gap: 18,
            padding: "12px 0", marginBottom: 18,
            borderTop: "1px solid #e3dcc9", borderBottom: "1px solid #e3dcc9",
            fontSize: 12, color: "var(--ink-3)",
          }}
        >
          <span title={workflow.created_by_email}>
            <strong style={{ color: "var(--ink-1)" }}>Created by:</strong> {createdByDisplay}
          </span>
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
          <div style={workflow.status === "won" && workflow.sales_orders?.length ? sectionStyle : lastSectionStyle}>
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
                        <ul className="attachment-list">
                          {p.attachments.map((a) => (
                            <li key={a.path} className="attachment-list__item">
                              {a.url ? (
                                <a
                                  href={a.url}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="attachment-list__link"
                                  // The browser uses the response's
                                  // Content-Disposition when the link is
                                  // opened in the same tab. Supabase Storage
                                  // returns inline by default, which is what
                                  // we want for previewable types (PDF,
                                  // images). Users can right-click → save.
                                  title={`Open ${a.name}`}
                                >
                                  <span className="attachment-list__icon" aria-hidden="true">
                                    &#x1F4CE;
                                  </span>
                                  <span className="attachment-list__name">{a.name}</span>
                                  <span className="attachment-list__size">
                                    {(a.size / 1024).toFixed(1)} KB
                                  </span>
                                </a>
                              ) : (
                                <span className="attachment-list__name attachment-list__name--missing">
                                  {a.name} · {(a.size / 1024).toFixed(1)} KB
                                </span>
                              )}
                            </li>
                          ))}
                        </ul>
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </div>
          {workflow.status === "won" && workflow.sales_orders?.length ? (
            <div style={lastSectionStyle}>
              <span style={labelStyle}>Sales orders</span>
              <div className="sales-orders-summary">
                {workflow.sales_orders.map((so, idx) => (
                  <div key={`${so.so_number}-${idx}`} className="sales-orders-summary__row">
                    <span className="sales-orders-summary__so">SO# {so.so_number}</span>
                    <span className="sales-orders-summary__sep">—</span>
                    <span className="sales-orders-summary__val">{usdFormatter.format(so.value)}</span>
                  </div>
                ))}
                <div className="sales-orders-summary__total">
                  Total{" "}
                  <strong>
                    {usdFormatter.format(
                      workflow.sales_orders.reduce((sum, so) => sum + (Number(so.value) || 0), 0),
                    )}
                  </strong>
                </div>
              </div>
            </div>
          ) : null}
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
          autoDescription={autoDescription}
        />

        </div>
      </main>
    </div>
  );
}
