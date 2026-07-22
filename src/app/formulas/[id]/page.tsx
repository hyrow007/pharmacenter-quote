import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/auth/server";
import AppHeader from "../../_components/AppHeader";
import { I18nProvider } from "@/lib/i18n/context";
import { getLangFromCookie } from "@/lib/i18n/server";
import { makeT } from "@/lib/i18n/dict";
import { makeTr } from "@/lib/i18n/labels";
import FormulaEditor, {
  type PcBkProductOption,
  type RawMaterialOption,
} from "./FormulaEditor";
import {
  recordFromRow,
  versionFromRow,
  type GummyFormulaRecord,
  type GummyFormulaVersion,
  type SavedSolution,
  type SolutionComponent,
} from "@/lib/formulas";

// /formulas/[id] — three-tab formula editor.
//
// Server-fetches the formula row + its latest version + the raw-materials
// catalog (so the ingredient picker can render without a second round
// trip), then hands off to the client island.

// v51.5: tab title for the editor. Static "Formulas" branding — the
// page itself renders the formula number prominently.
export const metadata = { title: "PharmaCenter — Formulas" };

export default async function FormulaEditorPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const lang = await getLangFromCookie();
  const t = makeT(lang);
  const tr = makeTr(lang);
  const { id } = await params;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user || !user.email?.endsWith("@pharmacenterusa.com")) {
    redirect("/");
  }

  // Fetch formula + latest version + raw materials + PC-BK Fishbowl
  // products + PC-RW raw-material Fishbowl products in parallel. PC-BK
  // powers the identity header's Product Code picker; PC-RW powers the
  // ingredient-row picker in each blend section. Raw material rows already
  // in raw_materials get their overlay fields (cost / solids / category);
  // Fishbowl-only PC-RW products still appear in the picker but with
  // null cost until an admin or Fishbowl sync fills them in.
  const [formulaRes, versionRes, rmRes, pcBkRes, pcRwRes, solRes, issueRes] = await Promise.all([
    supabase
      .from("gummy_formulas")
      .select(
        "id, formula_number, pc_bk_code, name, shape, flavor, customer_id, active, latest_version_num, created_at, updated_at, created_by_email, updated_by_email",
      )
      .eq("id", id)
      .maybeSingle(),
    supabase
      .from("gummy_formula_versions")
      .select(
        "id, formula_id, version_num, bench_batch_g, batch_kg, batches_per_day, fixed_loss_kg_per_day, gummy_piece_weight_g, wet_cast_piece_weight_g, target_yield_units, cfa_batch_kg, yield_pct, ingredients, process_notes, label_claims, costing, notes, created_at, created_by_email",
      )
      .eq("formula_id", id)
      .order("version_num", { ascending: false })
      .limit(1)
      .maybeSingle(),
    supabase
      .from("raw_materials")
      .select("id, fp_code, name, default_unit, default_cost_per_kg, inventory_cost_per_kg, last_order_cost_per_kg, inventory_cost_uom, last_order_cost_uom, default_solids, category, active")
      .eq("active", true)
      .order("category", { ascending: true, nullsFirst: false })
      .order("name", { ascending: true }),
    supabase
      .from("products")
      .select("id, fp_code, name")
      .eq("active", true)
      .ilike("fp_code", "PC-BK-%")
      .order("fp_code", { ascending: true }),
    supabase
      .from("products")
      .select("id, fp_code, name, default_unit")
      .eq("active", true)
      .ilike("fp_code", "PC-RW-%")
      .order("fp_code", { ascending: true }),
    // Saved solutions library — every active row from public.gummy_solutions.
    // Powers the "load from library" dropdown when the rep clicks + Add
    // solution in a blend section.
    supabase
      .from("gummy_solutions")
      .select(
        "id, name, components, active, created_at, updated_at, created_by_email, updated_by_email",
      )
      .eq("active", true)
      .order("name", { ascending: true }),
    // v54: latest ISSUED version. Errors (e.g. migration not yet run)
    // fall back to the old behavior below — issued = latest revision.
    supabase
      .from("gummy_formula_issues")
      .select("issue_num, revision_num")
      .eq("formula_id", id)
      .order("issue_num", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);

  if (formulaRes.error || !formulaRes.data) {
    notFound();
  }

  const formula: GummyFormulaRecord = recordFromRow(formulaRes.data);
  const latestVersion: GummyFormulaVersion | null =
    versionRes.data ? versionFromRow(versionRes.data) : null;

  // v54: issued number + the revision it stamps. Pre-migration (table
  // missing or no baseline row) falls back to the save-per-version
  // behavior so nothing breaks: issued = latest revision, no draft.
  const issue =
    !issueRes.error && issueRes.data
      ? {
          issueNum: Number(issueRes.data.issue_num),
          revisionNum: Number(issueRes.data.revision_num),
        }
      : {
          issueNum: formula.latestVersionNum,
          revisionNum: formula.latestVersionNum,
        };
  const isDraft = formula.latestVersionNum > issue.revisionNum;

  // Curated raw_materials rows — full data (cost, solids, category, notes).
  const curatedRawMaterials: RawMaterialOption[] = (rmRes.data ?? []).map((r) => ({
    id: r.id,
    fpCode: r.fp_code,
    name: r.name,
    defaultUnit: r.default_unit,
    defaultCostPerKg:
      r.default_cost_per_kg === null ? null : Number(r.default_cost_per_kg),
    inventoryCostPerKg:
      r.inventory_cost_per_kg === null || r.inventory_cost_per_kg === undefined
        ? null
        : Number(r.inventory_cost_per_kg),
    lastOrderCostPerKg:
      r.last_order_cost_per_kg === null || r.last_order_cost_per_kg === undefined
        ? null
        : Number(r.last_order_cost_per_kg),
    inventoryCostUom: (r.inventory_cost_uom as string | null) ?? null,
    lastOrderCostUom: (r.last_order_cost_uom as string | null) ?? null,
    defaultSolids: Number(r.default_solids),
    category: r.category,
    source: "raw_material" as const,
  }));

  // Fishbowl PC-RW products — every raw material that exists in Fishbowl,
  // whether or not it's been imported into raw_materials yet. Any product
  // whose fp_code already appears in curatedRawMaterials is skipped
  // (curated data wins). Everything else shows up with null cost / default
  // solids so the rep can still pick it and enter overrides.
  const curatedFpCodes = new Set(
    curatedRawMaterials.map((r) => (r.fpCode ?? "").toUpperCase()).filter(Boolean),
  );
  const fishbowlPcRw: RawMaterialOption[] = (pcRwRes.data ?? [])
    .filter((p) => p.fp_code && p.name)
    .filter((p) => !curatedFpCodes.has((p.fp_code as string).toUpperCase()))
    .map((p) => ({
      id: `fb:${p.fp_code}`,
      fpCode: p.fp_code as string,
      name: p.name as string,
      defaultUnit: p.default_unit ?? "kg",
      defaultCostPerKg: null,
      defaultSolids: 1,
      category: null,
      source: "fishbowl" as const,
    }));

  const rawMaterials: RawMaterialOption[] = [
    ...curatedRawMaterials,
    ...fishbowlPcRw,
  ].sort((a, b) => (a.fpCode ?? "").localeCompare(b.fpCode ?? ""));

  const pcBkProducts: PcBkProductOption[] = (pcBkRes.data ?? [])
    .filter((p) => p.fp_code && p.name)
    .map((p) => ({
      id: p.id,
      fpCode: p.fp_code as string,
      name: p.name as string,
    }));

  // Saved solutions library. Ignore errors quietly — if the table hasn't
  // been created yet (SQL migration not run), the editor still works, the
  // library dropdown just shows empty.
  const savedSolutions: SavedSolution[] = (solRes?.data ?? []).map(
    (row: Record<string, unknown>) => ({
      id: String(row.id),
      name: String(row.name),
      components: Array.isArray(row.components)
        ? (row.components as SolutionComponent[])
        : [],
      active: row.active === true,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      createdByEmail: (row.created_by_email as string | null) ?? null,
      updatedByEmail: (row.updated_by_email as string | null) ?? null,
    }),
  );

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
        {/* Use the wider standard container (1240px) so the 5-field
            identity header + Save button fit on a single row without
            wrapping Flavor to a second line. */}
        <div className="page__inner">
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
            <span aria-hidden="true">&larr;</span> {t("backToFormulas").replace("← ", "")}
          </a>

          {/* Version / Updated / by strip. Sits between the Back pill and
              the sticky identity header so it doesn't scroll away with the
              editor and doesn't clutter the identity card. */}
          <div
            className="fe-meta-strip-page"
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
            {/* Sequential formula identifier ("F0001"). Assigned by the DB
                sequence on insert (see sql/gummy_formulas.sql). Left-most
                in the meta strip so operators have a scannable handle for
                each formula in addition to the version + updated-by info. */}
            <span>
              {tr("Formula")}{" "}
              <strong style={{ color: "var(--teal-900, #0f4a56)" }}>
                F{String(formula.formulaNumber).padStart(4, "0")}
              </strong>
            </span>
            <span aria-hidden="true">·</span>
            <span>
              {tr("Version")}{" "}
              <strong style={{ color: "var(--teal-900, #0f4a56)" }}>
                v{issue.issueNum}
              </strong>
              {isDraft ? (
                <strong
                  style={{
                    marginLeft: 6,
                    padding: "1px 7px",
                    borderRadius: 999,
                    background: "#f4e9d4",
                    border: "1px solid #d9c48f",
                    color: "#8a6d1a",
                  }}
                >
                  {tr("draft")}
                </strong>
              ) : null}
            </span>
            <span aria-hidden="true">·</span>
            <span>
              {tr("Updated ").trim()}{" "}
              {new Date(formula.updatedAt).toLocaleDateString("en-US", {
                year: "numeric",
                month: "short",
                day: "numeric",
              })}
            </span>
            {updatedByDisplay ? (
              <>
                <span aria-hidden="true">·</span>
                <span>{tr("by ")}{updatedByDisplay}</span>
              </>
            ) : null}
          </div>

          <I18nProvider lang={lang}>
            <FormulaEditor
              initialFormula={formula}
              initialVersion={latestVersion}
              rawMaterials={rawMaterials}
              pcBkProducts={pcBkProducts}
              initialSavedSolutions={savedSolutions}
              currentUserEmail={user.email!}
              initialIssue={issue}
            />
          </I18nProvider>
        </div>
      </main>
    </div>
  );
}
