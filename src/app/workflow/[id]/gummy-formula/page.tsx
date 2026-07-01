import { redirect, notFound } from "next/navigation";
import { createClient } from "@/lib/auth/server";
import {
  formatQuoteNumber,
  type GummyFormula,
  type WorkflowRow,
} from "@/lib/workflows";
import AppHeader from "../../../_components/AppHeader";
import GummyFormulaBoard, {
  type RawMaterialOption,
} from "./GummyFormulaBoard";

// /workflow/[id]/gummy-formula
//
// Batch-COGS calculator for the "gummies manufactured at PharmaCenter" case.
// Hydrates the raw_materials catalogue (name + default cost + default solids)
// and the saved formula (if any) off the workflow's JSONB state.
//
// The formula gets persisted back onto the workflow via PUT /api/workflows/:id
// (same endpoint the pricing calculator saves through — it accepts a partial
// state and merges into the existing row).

type Ctx = {
  params: Promise<{ id: string }>;
};

export default async function GummyFormulaPage({ params }: Ctx) {
  const { id } = await params;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user || !user.email?.endsWith("@pharmacenterusa.com")) {
    redirect("/");
  }

  const { data: workflowRow, error } = await supabase
    .from("workflows")
    .select("id, quote_number, state")
    .eq("id", id)
    .maybeSingle();
  if (error || !workflowRow) {
    notFound();
  }
  const w = workflowRow as Pick<WorkflowRow, "id" | "quote_number" | "state">;

  const { data: rmRows } = await supabase
    .from("raw_materials")
    .select(
      "id, fp_code, name, default_unit, default_cost_per_kg, default_solids, category, active",
    )
    .eq("active", true)
    .order("category", { ascending: true, nullsFirst: false })
    .order("name", { ascending: true });

  const catalogue: RawMaterialOption[] = ((rmRows ?? []) as RawMaterialOption[]);

  const initialFormula: GummyFormula | null = w.state?.gummyFormula ?? null;

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
              Gummy Formula
            </h1>
            <p className="lede" style={{ marginTop: 4, marginBottom: 0 }}>
              Build up the raw-material cost per gummy, then let the calculator
              apply the 20&nbsp;kg/day fixed material loss to give you the
              effective per-gummy COGS. Pull ingredients from the shared
              catalogue or drop in a one-off.
            </p>
          </div>

          <GummyFormulaBoard
            workflowId={w.id}
            catalogue={catalogue}
            initialFormula={initialFormula}
            preparerEmail={user.email!}
          />
        </div>
      </main>
    </div>
  );
}
