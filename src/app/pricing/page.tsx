import { redirect } from "next/navigation";
import { createClient } from "@/lib/auth/server";
import {
  formatQuoteNumber,
  type PricingSnapshot,
  type WorkflowRow,
  type WorkflowState,
} from "@/lib/workflows";
import AppHeader from "../_components/AppHeader";
import PricingCalculator, { type WorkflowProductOption } from "./PricingCalculator";

// Standalone pricing calculator. Server shell handles auth + (optionally)
// hydrates the workflow whose products show up in the product dropdown.
// The interactive form is a client component below.

type Ctx = {
  searchParams: Promise<{ from?: string }>;
};

export default async function PricingPage({ searchParams }: Ctx) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user || !user.email?.endsWith("@pharmacenterusa.com")) {
    redirect("/");
  }

  const { from } = await searchParams;
  const backHref = from ? `/workflow/${from}` : "/workflows";
  const backLabel = from ? "Back to workflow" : "Back to all workflows";

  // Hydrate workflow products when we have ?from=<id>. Each entry becomes
  // a dropdown option in the calculator. We resolve existing-product names
  // through the products table so the dropdown label matches what shows up
  // on the workflow detail page.
  let workflowProducts: WorkflowProductOption[] = [];
  let workflowLabel: string | null = null;
  let workflowState: WorkflowState | null = null;
  // Initial tab snapshots — normalised to an array even if an older row used
  // the keyed-by-product shape (Record<productUid, snapshot>).
  let initialPricingTabs: PricingSnapshot[] = [];
  if (from) {
    const { data: workflowRow } = await supabase
      .from("workflows")
      .select("id, quote_number, state")
      .eq("id", from)
      .maybeSingle();
    if (workflowRow) {
      const w = workflowRow as Pick<WorkflowRow, "id" | "quote_number" | "state">;
      workflowLabel = formatQuoteNumber(w.quote_number);
      workflowState = w.state;
      // Accept both shapes for backward compatibility:
      //   - PricingSnapshot[] (current)
      //   - Record<productUid, PricingSnapshot> (legacy) → map to array,
      //     synthesising a tabId from the key if the snapshot doesn't carry one.
      const rawPricing = w.state.pricing as
        | PricingSnapshot[]
        | Record<string, PricingSnapshot>
        | undefined;
      if (Array.isArray(rawPricing)) {
        initialPricingTabs = rawPricing;
      } else if (rawPricing && typeof rawPricing === "object") {
        initialPricingTabs = Object.entries(rawPricing).map(([key, snap]) => ({
          ...snap,
          tabId: snap.tabId || `legacy-${key}`,
          label: snap.label ?? null,
          workflowProductUid: snap.workflowProductUid || key,
        }));
      }
      const products = w.state.products ?? [];

      // Hydrate names for existing products via one bulk SELECT.
      const productIds = products
        .map((p) => p.productId)
        .filter((id): id is string => !!id && id !== "new");
      const productNameMap: Record<string, { name: string; code: string | null }> = {};
      if (productIds.length > 0) {
        const { data: pRows } = await supabase
          .from("products")
          .select("id, name, fp_code")
          .in("id", productIds);
        for (const row of (pRows ?? []) as Array<{ id: string; name: string; fp_code: string | null }>) {
          productNameMap[row.id] = { name: row.name, code: row.fp_code };
        }
      }

      workflowProducts = products.map((p, idx) => {
        let label = `Product ${idx + 1}`;
        let sub: string | null = null;
        if (p.mode === "new") {
          label = p.newProduct?.name_desc?.trim() || label;
          sub = "New product";
        } else if (p.productId && productNameMap[p.productId]) {
          const info = productNameMap[p.productId];
          label = info.name;
          sub = info.code ? `Code ${info.code}` : null;
        }
        // First non-empty quantity wins — usually a workflow only has one
        // quantity per product anyway, but we accept multiples.
        const firstQty = (p.quantities ?? []).find(
          (q) => q.replace(/,/g, "").trim().length > 0,
        );
        return {
          uid: p.uid,
          label,
          sub,
          quantity: firstQty || null,
        };
      });
    }
  }

  return (
    <div className="app-shell">
      <AppHeader user={{ email: user.email! }} />
      <main className="page">
        <div className="page__inner--narrow">
          <div style={{ marginBottom: 22 }}>
            <p className="eyebrow" style={{ marginBottom: 6 }}>
              PharmaCenter · Tools
              {workflowLabel ? ` · ${workflowLabel}` : ""}
            </p>
            <h1 className="page-header__title" style={{ marginBottom: 6 }}>
              Pricing Calculator
            </h1>
            <p className="lede" style={{ marginTop: 4, marginBottom: 0 }}>
              Start with your unit cost, layer on inbound costs to get a landed
              cost in our warehouse, then add a margin to get a sale price.
            </p>
          </div>

          <PricingCalculator
            workflowProducts={workflowProducts}
            workflowLabel={workflowLabel}
            workflowId={from ?? null}
            workflowState={workflowState}
            initialPricingTabs={initialPricingTabs}
          />

          <a href={backHref} className="backlink">
            &larr; {backLabel}
          </a>
        </div>
      </main>
    </div>
  );
}
