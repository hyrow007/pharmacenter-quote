import { NextResponse } from "next/server";
import { createClient } from "@/lib/auth/server";
import { versionFromRow } from "@/lib/formulas";

// GET /api/formulas/[id]/versions/[versionNum]
//   → { ok: true, version: GummyFormulaVersion }
//
// Fetch a specific pinned snapshot. Used by:
//   - the workflow-side view, which pins (formulaId, versionNum) on
//     state.gummyFormulaRef and needs to hydrate the recipe
//   - the "Import material $" hand-off on PricingCalculator
//   - the version-history sidebar in the editor when you click "view v3"

type GateResult =
  | { error: NextResponse; supabase?: undefined }
  | { error?: undefined; supabase: Awaited<ReturnType<typeof createClient>> };

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
  return { supabase };
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string; versionNum: string }> },
) {
  const gated = await gatedClient();
  if (gated.error) return gated.error;
  const { supabase } = gated;
  const { id, versionNum } = await params;
  const versionNumParsed = Number(versionNum);
  if (!Number.isInteger(versionNumParsed) || versionNumParsed <= 0) {
    return NextResponse.json({ ok: false, error: "bad_version" }, { status: 400 });
  }

  const { data, error } = await supabase
    .from("gummy_formula_versions")
    .select(
      "id, formula_id, version_num, bench_batch_g, batch_kg, batches_per_day, fixed_loss_kg_per_day, gummy_piece_weight_g, wet_cast_piece_weight_g, yield_pct, ingredients, process_notes, label_claims, notes, created_at, created_by_email",
    )
    .eq("formula_id", id)
    .eq("version_num", versionNumParsed)
    .maybeSingle();

  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }
  if (!data) {
    return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  }
  return NextResponse.json({ ok: true, version: versionFromRow(data) });
}
