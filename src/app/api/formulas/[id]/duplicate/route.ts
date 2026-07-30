import { NextResponse } from "next/server";
import { createClient } from "@/lib/auth/server";
import { recordFromRow, type GummyFormulaRecord } from "@/lib/formulas";

// POST /api/formulas/[id]/duplicate — clone a formula into a brand-new
// catalog entry.
//
// v67.1: copies the source's identity (name gets a "(Copy)" suffix; the
// PC-BK code is left null/TBD because it's unique) plus the LATEST
// version's full recipe payload — scale-up numbers, ingredients, process
// notes, label claims, and the costing blob — as version 1 of the new
// formula. Issues/audit history do NOT carry over: the copy starts life
// as an unissued draft.

type GateResult =
  | { error: NextResponse; supabase?: undefined; user?: undefined }
  | {
      error?: undefined;
      supabase: Awaited<ReturnType<typeof createClient>>;
      user: { email: string };
    };

async function gatedClient(): Promise<GateResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return {
      error: NextResponse.json({ ok: false, error: "not_signed_in" }, { status: 401 }),
    };
  }
  if (!user.email?.endsWith("@pharmacenterusa.com")) {
    return {
      error: NextResponse.json({ ok: false, error: "wrong_domain" }, { status: 403 }),
    };
  }
  return { supabase, user: { email: user.email } };
}

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const gated = await gatedClient();
  if (gated.error) return gated.error;
  const { supabase, user } = gated;
  const { id } = await params;

  // Source catalog row.
  const { data: source, error: sourceErr } = await supabase
    .from("gummy_formulas")
    .select(
      "id, formula_number, pc_bk_code, name, shape, flavor, customer_id, active",
    )
    .eq("id", id)
    .single();
  if (sourceErr || !source) {
    return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  }

  // Latest version — the recipe payload we clone. Selected with the
  // costing column; if that migration is missing, fall back without it.
  const versionCols =
    "bench_batch_g, batch_kg, batches_per_day, fixed_loss_kg_per_day, gummy_piece_weight_g, wet_cast_piece_weight_g, target_yield_units, cfa_batch_kg, yield_pct, ingredients, process_notes, label_claims, notes, costing";
  let latest: Record<string, unknown> | null = null;
  {
    const { data, error } = await supabase
      .from("gummy_formula_versions")
      .select(versionCols)
      .eq("formula_id", id)
      .order("version_num", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!error && data) latest = data as Record<string, unknown>;
    else if (error && /costing/.test(error.message)) {
      const { data: d2 } = await supabase
        .from("gummy_formula_versions")
        .select(versionCols.replace(", costing", ""))
        .eq("formula_id", id)
        .order("version_num", { ascending: false })
        .limit(1)
        .maybeSingle();
      latest = (d2 as Record<string, unknown> | null) ?? null;
    }
  }
  if (!latest) {
    return NextResponse.json(
      { ok: false, error: "no_version_to_copy" },
      { status: 500 },
    );
  }

  // New catalog row. PC-BK code stays null (unique per formula) — the
  // team assigns a fresh code once the copy becomes a real product.
  const { data: formulaRow, error: formulaErr } = await supabase
    .from("gummy_formulas")
    .insert({
      pc_bk_code: null,
      name: `${source.name} (Copy)`,
      shape: source.shape,
      flavor: source.flavor,
      customer_id: source.customer_id,
      created_by_email: user.email,
      updated_by_email: user.email,
    })
    .select(
      "id, formula_number, pc_bk_code, name, shape, flavor, customer_id, active, latest_version_num, created_at, updated_at, created_by_email, updated_by_email",
    )
    .single();
  if (formulaErr || !formulaRow) {
    return NextResponse.json(
      { ok: false, error: formulaErr?.message || "insert_failed" },
      { status: 500 },
    );
  }

  // Version 1 of the copy = latest version of the source, verbatim.
  const { error: versionErr } = await supabase
    .from("gummy_formula_versions")
    .insert({
      formula_id: formulaRow.id,
      version_num: 1,
      ...latest,
      created_by_email: user.email,
    });
  if (versionErr) {
    // Roll back the catalog row so a failed clone leaves nothing behind.
    await supabase.from("gummy_formulas").delete().eq("id", formulaRow.id);
    return NextResponse.json(
      { ok: false, error: versionErr.message },
      { status: 500 },
    );
  }

  const formula: GummyFormulaRecord = recordFromRow({
    ...formulaRow,
    latest_version_num: 1,
  });

  // Best-effort audit entry on the NEW formula pointing back at the source.
  await supabase.from("gummy_formula_audit").insert({
    formula_id: formula.id,
    by_email: user.email,
    kind: "created",
    version_num: 1,
    summary: `Duplicated from F${String(source.formula_number ?? 0).padStart(4, "0")} "${source.name}"`,
    diff: { duplicatedFrom: source.id },
  });

  return NextResponse.json({ ok: true, formula }, { status: 201 });
}
