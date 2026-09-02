import { redirect, notFound } from "next/navigation";
import { createClient } from "@/lib/auth/server";
import { formatQuoteNumber, type WorkflowRow } from "@/lib/workflows";
import AppHeader from "../../../_components/AppHeader";
import BlisterCostingBoard, { type SavedState } from "./BlisterCostingBoard";

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
  if (type !== "contract-packaging" || form !== "blisters") {
    redirect(`/workflow/${w.id}`);
  }

  const products = Array.isArray(state.products)
    ? (state.products as Record<string, unknown>[])
    : [];
  const product = products[0] ?? {};
  const spec =
    (product.blisterSpec as Record<string, string> | undefined) ?? null;

  const quantities = Array.isArray(product.quantities)
    ? (product.quantities as unknown[])
    : [];
  const firstQty = Number(
    String(quantities[0] ?? "").toString().replace(/[^0-9.]/g, ""),
  );
  const quantity = Number.isFinite(firstQty) && firstQty > 0 ? firstQty : null;

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

  // Same story for the product: an existing pick is an ID into products, a
  // new one carries its name on newProduct. The generic fallback only
  // remains for a malformed record.
  let productName =
    ((product.newProduct as Record<string, string> | undefined)?.name_desc ||
      null) ??
    (product.productName as string) ??
    (product.name as string) ??
    "Blistered product";
  const productId = product.productId as string | undefined;
  if (productId && productId !== "new") {
    const { data: p } = await supabase
      .from("products")
      .select("name")
      .eq("id", productId)
      .maybeSingle();
    if (p?.name) productName = p.name;
  }

  const initial = (state.blisterCosting as SavedState | undefined) ?? null;

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
              Pricing Calculator · Blisters
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

          <BlisterCostingBoard
            workflowId={w.id}
            quoteNumber={formatQuoteNumber(w.quote_number)}
            customerName={customerName}
            productName={productName}
            quantity={quantity}
            spec={spec}
            initial={initial}
          />
        </div>
      </main>
    </div>
  );
}
