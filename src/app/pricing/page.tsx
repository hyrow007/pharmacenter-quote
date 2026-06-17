import { redirect } from "next/navigation";
import { createClient } from "@/lib/auth/server";
import AppHeader from "../_components/AppHeader";
import PricingCalculator from "./PricingCalculator";

// Standalone pricing calculator. Server shell handles auth, the actual
// interactive form is a client component below. We accept an optional
// ?from=<workflowId> query so the "back" link can return to the workflow
// the user launched the calculator from — when absent we fall back to
// the workflows listing.

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

  return (
    <div className="app-shell">
      <AppHeader user={{ email: user.email! }} />
      <main className="page">
        <div className="page__inner--narrow">
          <div style={{ marginBottom: 22 }}>
            <p className="eyebrow" style={{ marginBottom: 6 }}>
              PharmaCenter · Tools
            </p>
            <h1 className="page-header__title" style={{ marginBottom: 6 }}>
              Pricing Calculator
            </h1>
            <p className="lede" style={{ marginTop: 4, marginBottom: 0 }}>
              Start with your unit cost, layer on inbound costs to get a landed
              cost in our warehouse, then add a margin to get a sale price.
            </p>
          </div>

          <PricingCalculator />

          <a href={backHref} className="backlink">
            &larr; {backLabel}
          </a>
        </div>
      </main>
    </div>
  );
}
