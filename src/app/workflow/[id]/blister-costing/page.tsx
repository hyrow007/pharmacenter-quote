import { redirect, notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import {
  formatQuoteNumber,
  type BulkTabOption,
  type IssuedQuoteTab,
  type PricingSnapshot,
  type WorkflowRow,
} from "@/lib/workflows";
import FinishedProductTabs from "../../../_components/FinishedProductTabs";
import AppHeader from "../../../_components/AppHeader";
import BlisterCostingBoard, {
  type BoardProduct,
  type SavedState,
} from "./BlisterCostingBoard";

// /workflow/[id]/blister-costing
//
// Builds the cost of ONE finished unit (a blister card, or the carton several
// cards go into) from its bill of materials, the line and hand-station crews,
// and a share of overhead — the blister counterpart of the bottle board, and
// the replacement for Melissa's "SKU Margins Analysis For Blister Work" sheet.
//
// Saves back onto the workflow through PUT /api/workflows/:id, the same
// partial-state merge the bottle board and gummy formula use.

type Ctx = { params: Promise<{ id: string }> };

export default async function BlisterCostingPage({ params }: Ctx) {
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

  // This board only makes sense for contract-packaged blisters. Anything else
  // gets sent back rather than shown a form that cannot describe its job.
  const type = String(state.type ?? "");
  const form = String(state.form ?? "");
  // A Finished Product quote with this packaging type uses the same board
  // as its Packaging tab (bulk priced on the Bulk tab).
  const isFinishedProduct =
    type === "finished-product" &&
    String(state.packagingType ?? "") === "blisters";
  if (!isFinishedProduct && (type !== "contract-packaging" || form !== "blisters")) {
    redirect(`/workflow/${w.id}`);
  }
  // Bulk-tab pricing, matched to each product by its uid. The first tab
  // for a product wins, as on the Bulk tab's own quote document.
  const pricingTabs = Array.isArray(state.pricing)
    ? (state.pricing as PricingSnapshot[])
    : [];

  // Quotes already issued on this workflow, so one issued from this board
  // joins that history rather than replacing it.
  const initialIssuedQuotes: IssuedQuoteTab[] = Array.isArray(
    state.issuedQuotes,
  )
    ? (state.issuedQuotes as IssuedQuoteTab[]).filter(
        (t) =>
          !!t &&
          typeof t.id === "string" &&
          typeof t.label === "string" &&
          typeof t.sheetHtml === "string",
      )
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
  // Contact block for the customer-facing quote. A quote issued from this
  // board used to carry the company name and nothing else, while the same
  // quote issued from the pricing calculator carried the contact and email
  // too — the information was on the workflow either way.
  const newCustomer = state.newCustomer as
    | Record<string, string>
    | undefined;
  let customerContact = newCustomer?.contact?.trim() || null;
  let customerEmail = newCustomer?.email?.trim() || null;
  let customerAddress: string | null = null;
  const customerId = state.customerId as string | undefined;
  if (customerId) {
    const { data: c } = await supabase
      .from("customers")
      .select("name, default_ship_to")
      .eq("id", customerId)
      .maybeSingle();
    if (c?.name) customerName = c.name;
    customerAddress = (c?.default_ship_to as string | undefined) ?? null;
    // An existing customer's contact lives on the customers row, not on
    // the workflow — the typed-in pair belongs to "new customer" mode.
    customerContact = null;
    customerEmail = null;
  }

  // Same story for the products: an existing pick is an ID into products,
  // a new one carries its name on newProduct. One `.in()` query resolves
  // every picked name; the generic fallback only remains for a malformed
  // record. Each product on the workflow becomes one Base tab on the board.
  const pickedIds = productRows
    .map((p) => p.productId as string | undefined)
    .filter((id): id is string => Boolean(id) && id !== "new");
  const namesById = new Map<string, string>();
  const codesById = new Map<string, string>();
  if (pickedIds.length > 0) {
    const { data: rows } = await supabase
      .from("products")
      .select("id, name, fp_code")
      .in("id", pickedIds);
    for (const r of rows ?? []) {
      if (r?.id && r?.name) namesById.set(String(r.id), String(r.name));
      // The bulk's own Fishbowl code, so the Bulk row on a Finished
      // Product board can name the part instead of asking for it again.
      if (r?.id && r?.fp_code) codesById.set(String(r.id), String(r.fp_code));
    }
  }

  // blisterCosting keeps its historical meaning — the FIRST product's cost
  // build-up — so every reader of single-product workflows still works.
  // Products 2..n ride in blisterCostingMore, index-aligned.
  const more = Array.isArray(state.blisterCostingMore)
    ? (state.blisterCostingMore as (SavedState | null)[])
    : [];
  // Every Bulk tab on this quote, offered to the board's Bulk row so it can
  // be pointed at one explicitly. The uid match below still decides the
  // DEFAULT; this only makes the other tabs reachable, which matters once a
  // quote carries two bulk tabs that could each feed this packaging board.
  const nameByUid = new Map<string, string>();
  const noInboundByUid = new Map<string, boolean>();
  const partByUid = new Map<string, { fpCode: string; name: string }>();
  for (const row of productRows) {
    const uid = row.uid as string | undefined;
    if (!uid) continue;
    const pid = row.productId as string | undefined;
    const nm =
      (pid && pid !== "new" ? namesById.get(pid) : undefined) ??
      ((row.newProduct as Record<string, string> | undefined)?.name_desc ||
        null) ??
      (row.productName as string) ??
      (row.name as string) ??
      null;
    if (nm) nameByUid.set(uid, nm);
    noInboundByUid.set(
      uid,
      row.sourceMode === "stock" || Boolean(row.pinnedFormula),
    );
    // What the bulk IS, as a part. A PC-manufactured bulk is its pinned
    // formula's PC-BK code; anything else is the Fishbowl product picked
    // on the workflow. A product typed in by name has neither, and the
    // Bulk row keeps asking — correctly, because nothing knows the answer.
    const pinned = row.pinnedFormula as
      | { pcBkCode?: string | null; name?: string | null }
      | undefined;
    const pinnedCode = pinned?.pcBkCode?.trim() || null;
    if (pinnedCode) {
      partByUid.set(uid, {
        fpCode: pinnedCode,
        name: (pinned?.name || nm || pinnedCode) as string,
      });
    } else if (pid && pid !== "new" && codesById.get(pid)) {
      partByUid.set(uid, {
        fpCode: codesById.get(pid)!,
        name: (nm || codesById.get(pid)) as string,
      });
    }
  }
  const bulkTabs: BulkTabOption[] = isFinishedProduct
    ? pricingTabs.map((t, i) => ({
        tabId: t.tabId,
        label:
          (t.label && t.label.trim()) ||
          nameByUid.get(t.workflowProductUid) ||
          `Tab ${i + 1}`,
        snapshot: t,
        noInbound:
          t.noInboundCosts ?? (noInboundByUid.get(t.workflowProductUid) ?? false),
        partFpCode: partByUid.get(t.workflowProductUid)?.fpCode ?? null,
        partName: partByUid.get(t.workflowProductUid)?.name ?? null,
      }))
    : [];

  const products: BoardProduct[] = productRows.map((product, i) => {
    const spec =
      (product.blisterSpec as Record<string, string> | undefined) ?? null;
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
      "Blistered product";
    const initial =
      i === 0
        ? ((state.blisterCosting as SavedState | undefined) ?? null)
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
    return { name, quantity, spec, initial, bulkSnapshot, bulkNoInbound, bulkTabs };
  });

  return (
    <div className="app-shell">
      <AppHeader user={{ email: user.email! }} />
      <main className="page">
        {/* Full 1240px shell, same reasoning as the bottle board: this IS the
            pricing calculator for CP-blisters, so it reads at the same width
            as the formula catalog, and the extra width lands on the Fishbowl
            part-name column. */}
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
                : "Pricing Calculator · Blisters"}
            </h1>
            <p className="lede" style={{ marginTop: 4, marginBottom: 0 }}>
              Build the price of one finished unit from its film, foil and
              packaging, the line and hand-station crews, a share of overhead
              and your margin. Components are suggested from the packaging
              spec, but every pick is yours to confirm — and any cost we
              cannot resolve leaves the total blank rather than quietly
              counting as zero.
            </p>
          </div>

          {isFinishedProduct ? (
            <FinishedProductTabs
              workflowId={w.id}
              packagingType="blisters"
              active="packaging"
            />
          ) : null}

          <BlisterCostingBoard
            finishedProduct={
              isFinishedProduct
                ? { dosageForm: (state.form as string | null) ?? null }
                : null
            }
            workflowId={w.id}
            quoteNumber={formatQuoteNumber(w.quote_number)}
            customerName={customerName}
            customerAddress={customerAddress}
            customerContact={customerContact}
            customerEmail={customerEmail}
            initialIssuedQuotes={initialIssuedQuotes}
            products={products}
          />
        </div>
      </main>
    </div>
  );
}
