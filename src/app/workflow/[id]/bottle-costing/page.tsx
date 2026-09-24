import { redirect, notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import {
  formatQuoteNumber,
  type PricingSnapshot,
  type WorkflowRow,
} from "@/lib/workflows";
import FinishedProductTabs from "../../../_components/FinishedProductTabs";
import AppHeader from "../../../_components/AppHeader";
import BottleCostingBoard, {
  type BoardProduct,
  type SavedState,
} from "./BottleCostingBoard";

// /workflow/[id]/bottle-costing
//
// Builds the cost of ONE finished bottle from its bill of materials, the line
// crew, and a share of overhead — the Contract-Packaging counterpart to the
// gummy Costing tab, and the input the Pricing Calculator has until now had to
// be told by hand.
//
// Saves back onto the workflow through PUT /api/workflows/:id, the same
// partial-state merge the pricing calculator and gummy formula use.

type Ctx = { params: Promise<{ id: string }> };

export default async function BottleCostingPage({ params }: Ctx) {
  const { id } = await params;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user || !user.email?.endsWith("@pharmacenterusa.com")) redirect("/");

  const { data: row, error } = await supabase
    .from("workflows")
    .select("id, quote_number, state")
    .eq("id", id)
    .maybeSingle();
  if (error || !row) notFound();

  const w = row as Pick<WorkflowRow, "id" | "quote_number" | "state">;
  const state = (w.state ?? {}) as Record<string, unknown>;

  // This board only makes sense for contract-packaged bottles. Anything else
  // gets sent back rather than shown a form that cannot describe its job.
  const type = String(state.type ?? "");
  const form = String(state.form ?? "");
  // A Finished Product quote with this packaging type uses the same board
  // as its Packaging tab (bulk priced on the Bulk tab).
  const isFinishedProduct =
    type === "finished-product" &&
    String(state.packagingType ?? "") === "bottles";
  if (!isFinishedProduct && (type !== "contract-packaging" || form !== "bottles")) {
    redirect(`/workflow/${w.id}`);
  }
  // Bulk-tab pricing, matched to each product by its uid. The first tab
  // for a product wins, as on the Bulk tab's own quote document.
  const pricingTabs = Array.isArray(state.pricing)
    ? (state.pricing as PricingSnapshot[])
    : [];

  const rawProducts = Array.isArray(state.products)
    ? (state.products as Record<string, unknown>[])
    : [];
  // A malformed workflow with no products still gets one (blank) Base tab
  // rather than a board that cannot render at all.
  const productRows = rawProducts.length > 0 ? rawProducts : [{}];

  // The workflow stores an existing customer as an ID, not a name — the name
  // lives in the customers table. Resolving it here is what puts the real
  // customer on the board header and the print sheet instead of "—".
  let customerName =
    (state.customerName as string) ??
    ((state.newCustomer as Record<string, string> | undefined)?.name ?? "—");
  const customerId = state.customerId as string | undefined;
  if (customerId) {
    const { data: c } = await supabase
      .from("customers")
      .select("name")
      .eq("id", customerId)
      .maybeSingle();
    if (c?.name) customerName = c.name;
  }

  // Same story for the products: an existing pick is an ID into products,
  // a new one carries its name on newProduct. One `.in()` query resolves
  // every picked name; the generic fallback only remains for a malformed
  // record. Each product on the workflow becomes one Base tab on the board.
  const pickedIds = productRows
    .map((p) => p.productId as string | undefined)
    .filter((id): id is string => Boolean(id) && id !== "new");
  const namesById = new Map<string, string>();
  if (pickedIds.length > 0) {
    const { data: rows } = await supabase
      .from("products")
      .select("id, name")
      .in("id", pickedIds);
    for (const r of rows ?? []) {
      if (r?.id && r?.name) namesById.set(String(r.id), String(r.name));
    }
  }

  // bottleCosting keeps its historical meaning — the FIRST product's cost
  // build-up — so every reader of single-product workflows still works.
  // Products 2..n ride in bottleCostingMore, index-aligned.
  const more = Array.isArray(state.bottleCostingMore)
    ? (state.bottleCostingMore as (SavedState | null)[])
    : [];
  const products: BoardProduct[] = productRows.map((product, i) => {
    const spec =
      (product.packagingSpec as Record<string, string> | undefined) ?? null;
    const quantities = Array.isArray(product.quantities)
      ? (product.quantities as unknown[])
      : [];
    const firstQty = Number(
      String(quantities[0] ?? "").toString().replace(/[^0-9.]/g, ""),
    );
    const quantity =
      Number.isFinite(firstQty) && firstQty > 0 ? firstQty : null;
    const productId = product.productId as string | undefined;
    const name =
      (productId && productId !== "new"
        ? namesById.get(productId)
        : undefined) ??
      ((product.newProduct as Record<string, string> | undefined)?.name_desc ||
        null) ??
      (product.productName as string) ??
      (product.name as string) ??
      "Bottled product";
    const initial =
      i === 0
        ? ((state.bottleCosting as SavedState | undefined) ?? null)
        : (more[i - 1] ?? null);
    const uid = product.uid as string | undefined;
    const bulkSnapshot = isFinishedProduct
      ? (pricingTabs.find((t) => uid && t.workflowProductUid === uid) ?? null)
      : null;
    // Read the answer the calculator saved rather than re-deriving it: a
    // stock product Fishbowl shows as empty is quoted as a PURCHASE, so its
    // inbound costs are real and zeroing them here would hand the Bulk row a
    // cost the Bulk tab never showed. Pre-flag snapshots fall back to
    // sourceMode, which was correct when they were written.
    const bulkNoInbound =
      bulkSnapshot?.noInboundCosts ??
      (product.sourceMode === "stock" || Boolean(product.pinnedFormula));
    return { name, quantity, spec, initial, bulkSnapshot, bulkNoInbound };
  });

  return (
    <div className="app-shell">
      <AppHeader user={{ email: user.email! }} />
      <main className="page">
        {/*
          Full 1240px shell, not the 880px --narrow one. This IS the pricing
          calculator for CP-bottles, so it should read at the same width as the
          formula catalog and editor rather than looking like a side panel.
          The Material Costs grid is 573px of fixed columns plus one 1fr, so the
          extra width lands entirely on the Fishbowl part name — the column that
          was actually running out of room.
        */}
        <div className="page__inner">
          <a
            href={`/workflow/${w.id}`}
            className="bc-noprint"
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
              marginBottom: 12,
              whiteSpace: "nowrap",
            }}
          >
            <span aria-hidden="true">&larr;</span> Back to workflow (
            {formatQuoteNumber(w.quote_number)})
          </a>

          <div style={{ marginBottom: 22 }}>
            <p className="eyebrow" style={{ marginBottom: 6 }}>
              PharmaCenter · Tools · {formatQuoteNumber(w.quote_number)}
            </p>
            <h1 className="page-header__title" style={{ marginBottom: 6 }}>
              {isFinishedProduct
                ? "Pricing Calculator · Finished Product"
                : "Pricing Calculator · Bottles"}
            </h1>
            <p className="lede" style={{ marginTop: 4, marginBottom: 0 }}>
              Build the price of one finished bottle from its components, the
              line crew, a share of overhead and your margin. Components are
              suggested from the packaging spec, but every pick is yours to
              confirm — and any cost we cannot resolve leaves the total blank
              rather than quietly counting as zero.
            </p>
          </div>

          {isFinishedProduct ? (
            <FinishedProductTabs
              workflowId={w.id}
              packagingType="bottles"
              active="packaging"
            />
          ) : null}

          <BottleCostingBoard
            finishedProduct={
              isFinishedProduct
                ? { dosageForm: (state.form as string | null) ?? null }
                : null
            }
            workflowId={w.id}
            quoteNumber={formatQuoteNumber(w.quote_number)}
            customerName={customerName}
            products={products}
          />
        </div>
      </main>
    </div>
  );
}
