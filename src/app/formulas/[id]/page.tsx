import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/auth/server";
import AppHeader from "../../_components/AppHeader";
import FormulaEditor, { type RawMaterialOption } from "./FormulaEditor";
import {
  recordFromRow,
  versionFromRow,
  type GummyFormulaRecord,
  type GummyFormulaVersion,
} from "@/lib/formulas";

// /formulas/[id] — three-tab formula editor.
//
// Server-fetches the formula row + its latest version + the raw-materials
// catalog (so the ingredient picker can render without a second round
// trip), then hands off to the client island.

export default async function FormulaEditorPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user || !user.email?.endsWith("@pharmacenterusa.com")) {
    redirect("/");
  }

  // Fetch formula + latest version + raw materials in parallel.
  const [formulaRes, versionRes, rmRes] = await Promise.all([
    supabase
      .from("gummy_formulas")
      .select(
        "id, pc_bk_code, name, shape, flavor, active, latest_version_num, created_at, updated_at, created_by_email, updated_by_email",
      )
      .eq("id", id)
      .maybeSingle(),
    // Latest version — we don't yet know the version_num, so we ask
    // ordered by version_num desc and take one.
    supabase
      .from("gummy_formula_versions")
      .select(
        "id, formula_id, version_num, bench_batch_g, batch_kg, batches_per_day, fixed_loss_kg_per_day, gummy_piece_weight_g, yield_pct, ingredients, notes, created_at, created_by_email",
      )
      .eq("formula_id", id)
      .order("version_num", { ascending: false })
      .limit(1)
      .maybeSingle(),
    supabase
      .from("raw_materials")
      .select("id, fp_code, name, default_unit, default_cost_per_kg, default_solids, category, active")
      .eq("active", true)
      .order("category", { ascending: true, nullsFirst: false })
      .order("name", { ascending: true }),
  ]);

  if (formulaRes.error || !formulaRes.data) {
    notFound();
  }

  const formula: GummyFormulaRecord = recordFromRow(formulaRes.data);
  const latestVersion: GummyFormulaVersion | null =
    versionRes.data ? versionFromRow(versionRes.data) : null;

  const rawMaterials: RawMaterialOption[] = (rmRes.data ?? []).map((r) => ({
    id: r.id,
    fpCode: r.fp_code,
    name: r.name,
    defaultUnit: r.default_unit,
    defaultCostPerKg:
      r.default_cost_per_kg === null ? null : Number(r.default_cost_per_kg),
    defaultSolids: Number(r.default_solids),
    category: r.category,
  }));

  // Resolve the "updated by" email to a display name so the meta strip
  // reads "by Jairo Osorno" instead of "by josorno@pharmacenterusa.com".
  // Mirrors the pattern used on /workflow/[id]/page.tsx.
  let updatedByDisplay: string | null = formula.updatedByEmail;
  if (formula.updatedByEmail) {
    const { data: dir } = await supabase
      .from("user_directory")
      .select("display_name")
      .eq("email", formula.updatedByEmail)
      .maybeSingle();
    if (dir?.display_name) updatedByDisplay = dir.display_name;
  }

  return (
    <div className="app-shell">
      <AppHeader user={{ email: user.email! }} />
      <main className="page">
        <div className="page__inner--narrow">
          <a
            href="/formulas"
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
              marginBottom: 10,
              whiteSpace: "nowrap",
            }}
          >
            <span aria-hidden="true">&larr;</span> Back to formulas
          </a>

          {/* Version / Updated / by strip. Sits between the Back pill and
              the sticky identity header so it doesn't scroll away with the
              editor and doesn't clutter the identity card. */}
          <div
            style={{
              marginBottom: 12,
              display: "flex",
              gap: 12,
              alignItems: "center",
              flexWrap: "wrap",
              fontSize: 10.5,
              fontWeight: 700,
              letterSpacing: "0.14em",
              textTransform: "uppercase",
              color: "var(--ink-3, #8a9498)",
            }}
          >
            <span>
              Version{" "}
              <strong style={{ color: "var(--teal-900, #0f4a56)" }}>
                v{formula.latestVersionNum}
              </strong>
            </span>
            <span aria-hidden="true">·</span>
            <span>
              Updated{" "}
              {new Date(formula.updatedAt).toLocaleDateString("en-US", {
                year: "numeric",
                month: "short",
                day: "numeric",
              })}
            </span>
            {updatedByDisplay ? (
              <>
                <span aria-hidden="true">·</span>
                <span>by {updatedByDisplay}</span>
              </>
            ) : null}
          </div>

          <FormulaEditor
            initialFormula={formula}
            initialVersion={latestVersion}
            rawMaterials={rawMaterials}
          />
        </div>
      </main>
    </div>
  );
}
