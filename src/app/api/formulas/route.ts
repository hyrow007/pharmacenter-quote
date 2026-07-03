import { NextResponse } from "next/server";
import { createClient } from "@/lib/auth/server";
import {
  FORMULA_VERSION_DEFAULTS,
  emptyIngredient,
  recordFromRow,
  versionFromRow,
  type GummyFormulaIngredient,
  type GummyFormulaRecord,
  type GummyFormulaVersion,
} from "@/lib/formulas";

// GET  /api/formulas             — list active catalog rows (identity only)
// POST /api/formulas             — create new formula + version 1 in one shot
//
// Auth: any signed-in @pharmacenterusa.com user. RLS re-enforces this
// server-side; the gate here just short-circuits with a nicer error.

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

export async function GET(request: Request) {
  const gated = await gatedClient();
  if (gated.error) return gated.error;
  const { supabase } = gated;

  const url = new URL(request.url);
  const includeInactive = url.searchParams.get("includeInactive") === "1";
  const shape = url.searchParams.get("shape");        // optional filter
  const q = url.searchParams.get("q")?.trim();        // free-text search

  let query = supabase
    .from("gummy_formulas")
    .select(
      "id, pc_bk_code, name, shape, flavor, active, latest_version_num, created_at, updated_at, created_by_email, updated_by_email",
    )
    .order("updated_at", { ascending: false });

  if (!includeInactive) query = query.eq("active", true);
  if (shape) query = query.eq("shape", shape);
  if (q) {
    // Simple OR against the searchable text columns. pc_bk_code and name
    // cover the two things reps type into search.
    query = query.or(
      `pc_bk_code.ilike.%${q}%,name.ilike.%${q}%,flavor.ilike.%${q}%`,
    );
  }

  const { data, error } = await query;
  if (error) {
    console.error("formulas list failed:", error.message);
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  const formulas: GummyFormulaRecord[] = (data ?? []).map(recordFromRow);
  return NextResponse.json({ ok: true, formulas });
}

// --- POST --------------------------------------------------------------------
//
// Body: {
//   name: string,
//   pcBkCode?: string | null,      // null / omitted = TBD
//   shape: string,                 // canonical picklist string
//   flavor?: string | null,
//   // Optional overrides for the first version — otherwise defaults are used.
//   benchBatchG?: number,
//   batchKg?: number,
//   batchesPerDay?: number,
//   fixedLossKgPerDay?: number,
//   gummyPieceWeightG?: number,
//   yieldPct?: number,
//   ingredients?: GummyFormulaIngredient[],
//   notes?: string | null,
// }
// → { ok: true, formula: GummyFormulaRecord, version: GummyFormulaVersion }

type PostBody = {
  name?: string;
  pcBkCode?: string | null;
  shape?: string;
  flavor?: string | null;
  benchBatchG?: number;
  batchKg?: number;
  batchesPerDay?: number;
  fixedLossKgPerDay?: number;
  gummyPieceWeightG?: number;
  yieldPct?: number;
  ingredients?: GummyFormulaIngredient[];
  notes?: string | null;
};

export async function POST(request: Request) {
  const gated = await gatedClient();
  if (gated.error) return gated.error;
  const { supabase, user } = gated;

  let body: PostBody;
  try {
    body = (await request.json()) as PostBody;
  } catch {
    return NextResponse.json({ ok: false, error: "bad_json" }, { status: 400 });
  }
  const name = body.name?.trim();
  if (!name) {
    return NextResponse.json({ ok: false, error: "missing_name" }, { status: 400 });
  }
  // Default to TBD so R&D can spin up a new formula without pre-committing
  // to a shape — the shape is often decided after benchtop trials.
  const shape = body.shape?.trim() || "TBD";
  const pcBkCode = body.pcBkCode?.trim() || null;
  const flavor = body.flavor?.trim() || null;

  // Insert the catalog row first. If pc_bk_code collides with an existing
  // (non-null) row we bounce the caller with 409.
  const { data: formulaRow, error: formulaErr } = await supabase
    .from("gummy_formulas")
    .insert({
      pc_bk_code: pcBkCode,
      name,
      shape,
      flavor,
      created_by_email: user.email,
      updated_by_email: user.email,
    })
    .select(
      "id, pc_bk_code, name, shape, flavor, active, latest_version_num, created_at, updated_at, created_by_email, updated_by_email",
    )
    .single();

  if (formulaErr || !formulaRow) {
    const msg = formulaErr?.message || "insert_failed";
    const status = /duplicate|unique/i.test(msg) ? 409 : 500;
    return NextResponse.json({ ok: false, error: msg }, { status });
  }

  // Then insert version 1 with either the caller's overrides or the
  // FORMULA_VERSION_DEFAULTS. Ingredients default to [] if not supplied.
  const ingredients: GummyFormulaIngredient[] = Array.isArray(body.ingredients)
    ? body.ingredients
    : [emptyIngredient()];

  const { data: versionRow, error: versionErr } = await supabase
    .from("gummy_formula_versions")
    .insert({
      formula_id: formulaRow.id,
      version_num: 1,
      bench_batch_g: body.benchBatchG ?? FORMULA_VERSION_DEFAULTS.benchBatchG,
      batch_kg: body.batchKg ?? FORMULA_VERSION_DEFAULTS.batchKg,
      batches_per_day: body.batchesPerDay ?? FORMULA_VERSION_DEFAULTS.batchesPerDay,
      fixed_loss_kg_per_day:
        body.fixedLossKgPerDay ?? FORMULA_VERSION_DEFAULTS.fixedLossKgPerDay,
      gummy_piece_weight_g:
        body.gummyPieceWeightG ?? FORMULA_VERSION_DEFAULTS.gummyPieceWeightG,
      yield_pct: body.yieldPct ?? FORMULA_VERSION_DEFAULTS.yieldPct,
      ingredients,
      notes: body.notes ?? null,
      created_by_email: user.email,
    })
    .select(
      "id, formula_id, version_num, bench_batch_g, batch_kg, batches_per_day, fixed_loss_kg_per_day, gummy_piece_weight_g, yield_pct, ingredients, notes, created_at, created_by_email",
    )
    .single();

  if (versionErr || !versionRow) {
    // Roll back the catalog row so the user can retry without a phantom
    // formula sitting around with latest_version_num = 0.
    await supabase.from("gummy_formulas").delete().eq("id", formulaRow.id);
    console.error("formula version 1 insert failed:", versionErr?.message);
    return NextResponse.json(
      { ok: false, error: versionErr?.message || "version_insert_failed" },
      { status: 500 },
    );
  }

  const formula: GummyFormulaRecord = recordFromRow({
    ...formulaRow,
    latest_version_num: 1, // trigger will have set this too but we already know
  });
  const version: GummyFormulaVersion = versionFromRow(versionRow);

  // Audit-log the creation. Best-effort — a failure here shouldn't fail
  // the POST since the formula + v1 are already committed. The audit
  // route is read-only and the client can still write more entries on
  // subsequent saves.
  await supabase.from("gummy_formula_audit").insert({
    formula_id: formula.id,
    by_email: user.email,
    kind: "created",
    version_num: 1,
    summary: `Formula created — ${formula.pcBkCode ?? "TBD"} "${formula.name}"`,
    diff: {
      seed: {
        name: formula.name,
        shape: formula.shape,
        pcBkCode: formula.pcBkCode,
        flavor: formula.flavor,
      },
    },
  });

  return NextResponse.json({ ok: true, formula, version }, { status: 201 });
}
