import { NextResponse } from "next/server";
import { createClient } from "@/lib/auth/server";
import {
  FORMULA_VERSION_DEFAULTS,
  diffVersion,
  versionFromRow,
  type GummyFormulaIngredient,
  type GummyFormulaVersion,
  type LabelClaim,
} from "@/lib/formulas";

// GET  /api/formulas/[id]/versions           — list version history (metadata only)
// POST /api/formulas/[id]/versions           — cut a new version (recipe change)
//
// New versions are immutable once written (DB trigger enforces). The
// latest_version_num convenience pointer on gummy_formulas gets bumped by
// a DB trigger too.

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

// --- GET ---------------------------------------------------------------------
// Version list for the history sidebar in the editor. Excludes the full
// ingredients JSONB blob so a formula with a long revision history stays
// snappy; fetch a specific version via /versions/[versionNum] to see its
// recipe.

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const gated = await gatedClient();
  if (gated.error) return gated.error;
  const { supabase } = gated;
  const { id } = await params;

  const { data, error } = await supabase
    .from("gummy_formula_versions")
    .select(
      "id, formula_id, version_num, bench_batch_g, batch_kg, batches_per_day, fixed_loss_kg_per_day, gummy_piece_weight_g, yield_pct, notes, created_at, created_by_email",
    )
    .eq("formula_id", id)
    .order("version_num", { ascending: false });

  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }
  // Fill ingredients with [] on the way out — the list view doesn't need
  // them and callers who do fetch a specific version.
  const versions: Omit<GummyFormulaVersion, "ingredients">[] = (data ?? []).map(
    (row) => {
      const full = versionFromRow({ ...row, ingredients: [] });
      // Strip the empty array out of the payload to be explicit about intent.
      // (The TS type on the return is already Omit<..., "ingredients">.)
      const { ingredients: _drop, ...rest } = full;
      return rest;
    },
  );
  return NextResponse.json({ ok: true, versions });
}

// --- POST --------------------------------------------------------------------
//
// Body: (any subset — omitted fields inherit from the current latest version)
// {
//   benchBatchG?: number,
//   batchKg?: number,
//   batchesPerDay?: number,
//   fixedLossKgPerDay?: number,
//   gummyPieceWeightG?: number,
//   yieldPct?: number,
//   ingredients?: GummyFormulaIngredient[],
//   notes?: string | null,
// }
// → { ok: true, version: GummyFormulaVersion }

type PostBody = {
  benchBatchG?: number;
  batchKg?: number;
  batchesPerDay?: number;
  fixedLossKgPerDay?: number;
  gummyPieceWeightG?: number;
  yieldPct?: number;
  ingredients?: GummyFormulaIngredient[];
  processNotes?: Record<string, string> | null;
  labelClaims?: LabelClaim[];
  notes?: string | null;
};

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const gated = await gatedClient();
  if (gated.error) return gated.error;
  const { supabase, user } = gated;
  const { id } = await params;

  let body: PostBody;
  try {
    body = (await request.json()) as PostBody;
  } catch {
    return NextResponse.json({ ok: false, error: "bad_json" }, { status: 400 });
  }

  // Read the current latest version (if any) so unspecified fields inherit
  // rather than reverting to code defaults on every save.
  const { data: formulaRow, error: formulaErr } = await supabase
    .from("gummy_formulas")
    .select("id, latest_version_num")
    .eq("id", id)
    .maybeSingle();
  if (formulaErr) {
    return NextResponse.json({ ok: false, error: formulaErr.message }, { status: 500 });
  }
  if (!formulaRow) {
    return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  }

  let currentIngredients: GummyFormulaIngredient[] = [];
  let currentProcessNotes: Record<string, string> = {};
  let currentLabelClaims: LabelClaim[] = [];
  // Explicit `number` type on each field — spreading FORMULA_VERSION_DEFAULTS
  // (which is `as const`) narrows to literal types like `250` / `100`, and
  // then the reassignment below to `Number(prev.bench_batch_g)` (a plain
  // `number`) fails to assign back into the literal-typed field.
  let currentParams: {
    benchBatchG: number;
    batchKg: number;
    batchesPerDay: number;
    fixedLossKgPerDay: number;
    gummyPieceWeightG: number;
    yieldPct: number;
  } = { ...FORMULA_VERSION_DEFAULTS };
  if (formulaRow.latest_version_num > 0) {
    const { data: prev, error: prevErr } = await supabase
      .from("gummy_formula_versions")
      .select(
        "bench_batch_g, batch_kg, batches_per_day, fixed_loss_kg_per_day, gummy_piece_weight_g, yield_pct, ingredients, process_notes, label_claims",
      )
      .eq("formula_id", id)
      .eq("version_num", formulaRow.latest_version_num)
      .maybeSingle();
    if (prevErr) {
      return NextResponse.json({ ok: false, error: prevErr.message }, { status: 500 });
    }
    if (prev) {
      currentParams = {
        benchBatchG: Number(prev.bench_batch_g),
        batchKg: Number(prev.batch_kg),
        batchesPerDay: Number(prev.batches_per_day),
        fixedLossKgPerDay: Number(prev.fixed_loss_kg_per_day),
        gummyPieceWeightG: Number(prev.gummy_piece_weight_g),
        yieldPct: Number(prev.yield_pct),
      };
      currentIngredients = Array.isArray(prev.ingredients) ? prev.ingredients : [];
      if (prev.process_notes && typeof prev.process_notes === "object") {
        currentProcessNotes = prev.process_notes as Record<string, string>;
      }
      if (Array.isArray(prev.label_claims)) {
        currentLabelClaims = prev.label_claims as LabelClaim[];
      }
    }
  }

  const nextVersionNum = (formulaRow.latest_version_num || 0) + 1;

  const { data, error } = await supabase
    .from("gummy_formula_versions")
    .insert({
      formula_id: id,
      version_num: nextVersionNum,
      bench_batch_g: body.benchBatchG ?? currentParams.benchBatchG,
      batch_kg: body.batchKg ?? currentParams.batchKg,
      batches_per_day: body.batchesPerDay ?? currentParams.batchesPerDay,
      fixed_loss_kg_per_day: body.fixedLossKgPerDay ?? currentParams.fixedLossKgPerDay,
      gummy_piece_weight_g: body.gummyPieceWeightG ?? currentParams.gummyPieceWeightG,
      yield_pct: body.yieldPct ?? currentParams.yieldPct,
      ingredients: Array.isArray(body.ingredients) ? body.ingredients : currentIngredients,
      process_notes:
        body.processNotes && typeof body.processNotes === "object"
          ? body.processNotes
          : currentProcessNotes,
      label_claims: Array.isArray(body.labelClaims)
        ? body.labelClaims
        : currentLabelClaims,
      notes: body.notes ?? null,
      created_by_email: user.email,
    })
    .select(
      "id, formula_id, version_num, bench_batch_g, batch_kg, batches_per_day, fixed_loss_kg_per_day, gummy_piece_weight_g, yield_pct, ingredients, process_notes, label_claims, notes, created_at, created_by_email",
    )
    .single();

  if (error || !data) {
    console.error("new formula version insert failed:", error?.message);
    return NextResponse.json(
      { ok: false, error: error?.message || "insert_failed" },
      { status: 500 },
    );
  }

  const newVersion = versionFromRow(data);

  // Audit-log the version cut with a per-field diff vs. the previous
  // version. Previous is null iff this is v1 (created via POST /formulas,
  // which already writes its own 'created' audit row).
  const prevForDiff =
    formulaRow.latest_version_num > 0
      ? {
          benchBatchG: currentParams.benchBatchG,
          batchKg: currentParams.batchKg,
          batchesPerDay: currentParams.batchesPerDay,
          fixedLossKgPerDay: currentParams.fixedLossKgPerDay,
          gummyPieceWeightG: currentParams.gummyPieceWeightG,
          yieldPct: currentParams.yieldPct,
          ingredients: currentIngredients,
        }
      : null;
  if (prevForDiff) {
    const { diff, summary } = diffVersion(prevForDiff, newVersion);
    const baseSummary = `Cut v${newVersion.versionNum} — ${summary.replace(/^New version — |^New version /, "")}`;
    await supabase.from("gummy_formula_audit").insert({
      formula_id: id,
      by_email: user.email,
      kind: "version",
      version_num: newVersion.versionNum,
      summary: baseSummary,
      diff,
    });
  }

  return NextResponse.json(
    { ok: true, version: newVersion },
    { status: 201 },
  );
}
