import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/auth/server";
import { formatQuoteNumber, type WorkflowRow } from "@/lib/workflows";
import AppHeader from "../_components/AppHeader";
import WorkflowTable, { type WorkflowDisplayRow } from "./WorkflowTable";

// Workflow inbox — every quote workflow visible to the signed-in user.
// Server component so the customer/product joins happen on the server in one
// round-trip instead of N debounced fetches in the browser. The live-filter
// search box is delegated to <WorkflowTable/> (client) which receives the
// pre-shaped rows.

const TYPE_LABELS: Record<string, string> = {
  "bulk": "Bulk",
  "contract-packaging": "Contract Packaging",
  "finished-product": "Finished Product",
  "other": "Other",
};
const FORM_LABELS: Record<string, string> = {
  softgel: "Softgels", gummy: "Gummies", tablet: "Tablets", capsule: "Capsules", other: "Other",
};

function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  const now = Date.now();
  const diff = Math.max(0, now - then);
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return "now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d ago`;
  if (day < 30) return `${Math.floor(day / 7)}w ago`;
  if (day < 365) return `${Math.floor(day / 30)}mo ago`;
  return `${Math.floor(day / 365)}y ago`;
}

function localPart(email: string): string {
  const at = email.indexOf("@");
  return at > 0 ? email.slice(0, at) : email;
}

// Title-case a string like "jairo osorno" → "Jairo Osorno".
function titleCase(s: string): string {
  return s
    .split(" ")
    .filter((w) => w.length > 0)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(" ");
}

const usdFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
});

export default async function WorkflowsPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user || !user.email?.endsWith("@pharmacenterusa.com")) {
    redirect("/");
  }

  const { data: rawRows } = await supabase
    .from("workflows")
    .select(
      "id, quote_number, created_by_email, created_at, updated_at, state, status, sales_orders, monday_item_id, monday_item_url, monday_last_pushed_at",
    )
    .order("updated_at", { ascending: false });

  const rows: WorkflowRow[] = (rawRows ?? []) as WorkflowRow[];

  // Resolve customer names (+ ship-to subtitle) in one query.
  const customerIds = Array.from(
    new Set(
      rows
        .map((r) => (r.state.customerMode === "existing" ? r.state.customerId : null))
        .filter((id): id is string => !!id),
    ),
  );
  const customerInfo: Record<string, { name: string; ship: string | null }> = {};
  if (customerIds.length > 0) {
    const { data } = await supabase
      .from("customers")
      .select("id, name, default_ship_to")
      .in("id", customerIds);
    for (const c of (data ?? []) as Array<{ id: string; name: string; default_ship_to: string | null }>) {
      customerInfo[c.id] = { name: c.name, ship: c.default_ship_to };
    }
  }

  // Resolve submitter display names. The user_directory view (SQL migration)
  // exposes the Google SSO full_name from auth.users for any signed-in user.
  // Fallback to a title-cased local-part of the email if the view doesn't
  // have an entry yet (e.g. a service account or an email that's never signed in).
  const submitterEmails = Array.from(new Set(rows.map((r) => r.created_by_email)));
  const submitterNames: Record<string, string> = {};
  if (submitterEmails.length > 0) {
    const { data: directoryRows } = await supabase
      .from("user_directory")
      .select("email, display_name")
      .in("email", submitterEmails);
    for (const d of (directoryRows ?? []) as Array<{ email: string; display_name: string | null }>) {
      if (d.display_name) submitterNames[d.email] = d.display_name;
    }
  }

  // Resolve product names (for single-product label "Name (CODE)").
  const productIds = Array.from(
    new Set(
      rows.flatMap((r) =>
        r.state.products
          .map((p) => p.productId)
          .filter((pid): pid is string => !!pid && pid !== "new"),
      ),
    ),
  );
  const productInfo: Record<string, { name: string; code: string | null }> = {};
  if (productIds.length > 0) {
    const { data } = await supabase
      .from("products")
      .select("id, name, fp_code")
      .in("id", productIds);
    for (const p of (data ?? []) as Array<{ id: string; name: string; fp_code: string | null }>) {
      productInfo[p.id] = { name: p.name, code: p.fp_code };
    }
  }

  const display: WorkflowDisplayRow[] = rows.map((row) => {
    const state = row.state;
    const customerName =
      state.customerMode === "new"
        ? state.newCustomer?.name || "New customer"
        : (state.customerId && customerInfo[state.customerId]?.name) || "Unknown customer";
    const customerSub =
      state.customerMode === "new"
        ? state.newCustomer?.contact || ""
        : (state.customerId && customerInfo[state.customerId]?.ship) || "";
    const typeLabel = [
      state.type ? TYPE_LABELS[state.type] || state.type : null,
      state.form ? FORM_LABELS[state.form] || state.form : null,
    ]
      .filter(Boolean)
      .join(" · ");
    const products = state.products ?? [];
    // Build a list of human-readable per-product labels so the Products
    // column can stack each name (one per line) instead of collapsing a
    // multi-product workflow to "N products".
    const productLabels: string[] = products.map((p) => {
      if (p.mode === "new") return p.newProduct?.name_desc || "New product";
      if (p.productId && productInfo[p.productId]) {
        const info = productInfo[p.productId];
        return info.code ? `${info.name} (${info.code})` : info.name;
      }
      return "Product";
    });
    const productSearchBlob = productLabels.join(" ");

    // Precompute the won-total dollar label on the server so the client
    // table doesn't need any extra deps to format currency. Only meaningful
    // when status is won; empty string otherwise.
    const status = row.status ?? "in_progress";
    const sos = Array.isArray(row.sales_orders) ? row.sales_orders : [];
    const total = sos.reduce((sum, so) => sum + (Number(so.value) || 0), 0);
    const salesOrdersTotalLabel =
      status === "won" && sos.length > 0 ? usdFormatter.format(total) : "";

    return {
      id: row.id,
      quoteNumberLabel: formatQuoteNumber(row.quote_number),
      customerName,
      customerSub,
      typeLabel,
      productLabels,
      productSearchBlob,
      submitterFull: row.created_by_email,
      submitterShort: submitterNames[row.created_by_email] || titleCase(localPart(row.created_by_email)),
      updatedRelative: relativeTime(row.updated_at),
      updatedSort: new Date(row.updated_at).getTime(),
      pushed: !!row.monday_item_id,
      status,
      salesOrdersTotalLabel,
    };
  });

  return (
    <div className="app-shell">
      <AppHeader user={{ email: user.email! }} />
      <main className="page">
        <div className="page__inner">
          <div className="page-header">
            <div>
              <h1 className="page-header__title">Work Flows</h1>
              <p className="page-header__subtitle">
                Your drafts and every pushed workflow across the workspace.
              </p>
            </div>
            <div className="page-header__action">
              <Link href="/start" className="button-primary">
                + New workflow
              </Link>
            </div>
          </div>

          <WorkflowTable rows={display} />
        </div>
      </main>
    </div>
  );
}
