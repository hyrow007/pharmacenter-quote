import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/auth/server";
import type { WorkflowRow } from "@/lib/workflows";
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
      "id, created_by_email, created_at, updated_at, state, monday_item_id, monday_item_url, monday_last_pushed_at",
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
    let productLabel = "";
    let productSearchBlob = "";
    if (products.length === 1) {
      const p = products[0];
      if (p.mode === "new") {
        productLabel = p.newProduct?.name_desc || "New product";
      } else if (p.productId && productInfo[p.productId]) {
        const info = productInfo[p.productId];
        productLabel = info.code ? `${info.name} (${info.code})` : info.name;
      } else {
        productLabel = "Product";
      }
      productSearchBlob = productLabel;
    } else if (products.length > 1) {
      productLabel = `${products.length} products`;
      productSearchBlob = products
        .map((p) => {
          if (p.mode === "new") return p.newProduct?.name_desc || "";
          if (p.productId && productInfo[p.productId]) {
            const info = productInfo[p.productId];
            return `${info.name} ${info.code || ""}`;
          }
          return "";
        })
        .join(" ");
    }

    return {
      id: row.id,
      customerName,
      customerSub,
      typeLabel,
      productLabel,
      productSearchBlob,
      submitterFull: row.created_by_email,
      submitterShort: localPart(row.created_by_email),
      updatedRelative: relativeTime(row.updated_at),
      updatedSort: new Date(row.updated_at).getTime(),
      pushed: !!row.monday_item_id,
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
