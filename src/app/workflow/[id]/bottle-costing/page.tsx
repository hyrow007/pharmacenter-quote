import { redirect, notFound } from "next/navigation";
import { createClient } from "@/lib/auth/server";
import { formatQuoteNumber, type WorkflowRow } from "@/lib/workflows";
import AppHeader from "../../../_components/AppHeader";
import BottleCostingBoard, { type SavedState } from "./BottleCostingBoard";

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
  if (type !== "contract-packaging" || form !== "bottles") {
    redirect(`/workflow/${w.id}`);
  }

  const products = Array.isArray(state.products)
    ? (state.products as Record<string, unknown>[])
    : [];
  const product = products[0] ?? {};
  const spec =
    (product.packagingSpec as Record<string, string> | undefined) ?? null;

  const quantities = Array.isArray(product.quantities)
    ? (product.quantities as unknown[])
    : [];
  const firstQty = Number(
    String(quantities[0] ?? "").toString().replace(/[^0-9.]/g, ""),
  );
  const quantity = Number.isFinite(firstQty) && firstQty > 0 ? firstQty : null;

  const customerName =
    (state.customerName as string) ??
    ((state.newCustomer as Record<string, string> | undefined)?.name ?? "—");
  const productName =
    (product.productName as string) ??
    (product.name as string) ??
    "Bottled product";

  const initial = (state.bottleCosting as SavedState | undefined) ?? null;

  return (
    <div className="app-shell">
      <AppHeader user={{ email: user.email! }} />
      <main className="page">
        <div className="page__inner--narrow">
          <a
            href={`/workflow/${w.id}`}
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
              Pricing Calculator · Bottles
            </h1>
            <p className="lede" style={{ marginTop: 4, marginBottom: 0 }}>
              Build the price of one finished bottle from its components, the
              line crew, a share of overhead and your margin. Components are
              suggested from the packaging spec, but every pick is yours to
              confirm — and any cost we cannot resolve leaves the total blank
              rather than quietly counting as zero.
            </p>
          </div>

          <BottleCostingBoard
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
