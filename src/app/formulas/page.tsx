import { redirect } from "next/navigation";
import { createClient } from "@/lib/auth/server";
import AppHeader from "../_components/AppHeader";
import FormulasCatalog from "./FormulasCatalog";
import { recordFromRow, type GummyFormulaRecord } from "@/lib/formulas";

// /formulas — top-level gummy formula catalog.
//
// Anyone signed in can browse, search, and create formulas. Individual
// formulas open at /formulas/[id] into the three-tab editor. Workflows
// picking a formula for their quote use the same list via the picker
// on /workflow/[id]/gummy-formula.
//
// Server-renders the initial list; the client island (FormulasCatalog)
// owns search + shape filter + "+ New formula" and refetches on demand.

export default async function FormulasPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user || !user.email?.endsWith("@pharmacenterusa.com")) {
    redirect("/");
  }

  // Initial list — active rows only, most-recently-touched first. The
  // client can flip an "includeInactive" toggle to see soft-deleted rows
  // when needed.
  const { data, error } = await supabase
    .from("gummy_formulas")
    .select(
      "id, formula_number, pc_bk_code, name, shape, flavor, customer_id, active, latest_version_num, created_at, updated_at, created_by_email, updated_by_email",
    )
    .eq("active", true)
    .order("updated_at", { ascending: false });

  const initialFormulas: GummyFormulaRecord[] = error
    ? []
    : (data ?? []).map(recordFromRow);

  return (
    <div className="app-shell">
      <AppHeader user={{ email: user.email! }} />
      <main className="page">
        <div className="page__inner--narrow">
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
          <div style={{ marginBottom: 18 }}>
            <p className="eyebrow" style={{ marginBottom: 6 }}>
              PharmaCenter · Formulas
            </p>
            <h1 className="page-header__title" style={{ marginBottom: 6 }}>
              Gummy Formula Catalog
            </h1>
            <p className="lede" style={{ marginTop: 4, marginBottom: 0 }}>
              Every gummy design PharmaCenter has authored, indexed by
              PC-BK code (or held as <em>TBD</em> until R&amp;D assigns one).
              Open a formula to view or edit its bench-top recipe,
              scale-up, and material costing.
            </p>
          </div>

          <FormulasCatalog initialFormulas={initialFormulas} />
        </div>
      </main>
    </div>
  );
}
