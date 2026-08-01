import { NextResponse } from "next/server";
import { createClient } from "@/lib/auth/server";
import { isAdmin } from "@/lib/workflows";
import {
  diffIdentity,
  recordFromRow,
  versionFromRow,
  type GummyFormulaRecord,
  type GummyFormulaVersion,
} from "@/lib/formulas";
import {
  LINE_LEADER_ADP_ID,
  LINE_OPERATOR_ADP_ID,
  computeCostingComputed,
  type CostingComputed,
  type CostingRawMaterial,
} from "@/lib/formulaCosting";

// GET  /api/formulas/[id]        — formula + latest version (plus a
//                                  server-computed `costingComputed`
//                                  per-piece cost block when the version
//                                  has a Costing tab set up — consumed by
//                                  the quote-side PricingCalculator)
// PUT  /api/formulas/[id]        — edit identity only (name / pc_bk_code /
//                                  shape / flavor / active). Recipe changes
//                                  go through POST /versions instead.

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

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const gated = await gatedClient();
  if (gated.error) return gated.error;
  const { supabase } = gated;
  const { id } = await params;

  const { data: formulaRow, error: formulaErr } = await supabase
    .from("gummy_formulas")
    .select(
      "id, formula_number, pc_bk_code, name, shape, flavor, customer_id, active, latest_version_num, created_at, updated_at, created_by_email, updated_by_email",
    )
    .eq("id", id)
    .maybeSingle();

  if (formulaErr) {
    return NextResponse.json({ ok: false, error: formulaErr.message }, { status: 500 });
  }
  if (!formulaRow) {
    return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  }

  // Latest version (versionNum = latest_version_num). If no versions yet
  // (should never happen because POST /formulas writes v1 atomically),
  // return null and let the client render the editor empty.
  let latestVersion: GummyFormulaVersion | null = null;
  if (formulaRow.latest_version_num > 0) {
    const { data: versionRow, error: versionErr } = await supabase
      .from("gummy_formula_versions")
      .select(
        "id, formula_id, version_num, bench_batch_g, batch_kg, batches_per_day, fixed_loss_kg_per_day, gummy_piece_weight_g, wet_cast_piece_weight_g, target_yield_units, cfa_batch_kg, yield_pct, ingredients, process_notes, label_claims, costing, notes, created_at, created_by_email",
      )
      .eq("formula_id", id)
      .eq("version_num", formulaRow.latest_version_num)
      .maybeSingle();
    if (versionErr) {
      return NextResponse.json({ ok: false, error: versionErr.message }, { status: 500 });
    }
    if (versionRow) latestVersion = versionFromRow(versionRow);
  }

  // v69: per-piece cost breakdown for the quote-side PricingCalculator.
  // Null when the version has no Costing tab data. Only fetch the extra
  // inputs (raw-material costs + ADP labor rates) when there's actually
  // costing to compute. The raw-material list is assembled EXACTLY like
  // /formulas/[id]/page.tsx does for the editor (curated rows + Fishbowl-
  // only PC-RW products deduped by fp_code) so the computed figures match
  // what the operator sees on screen.
  let costingComputed: CostingComputed | null = null;
  if (latestVersion?.costing) {
    const [rmRes, pcRwRes, lrRes] = await Promise.all([
      supabase
        .from("raw_materials")
        .select("id, fp_code, name, inventory_cost_per_kg, last_order_cost_per_kg")
        .eq("active", true),
      supabase
        .from("products")
        .select("fp_code, name")
        .eq("active", true)
        .ilike("fp_code", "PC-RW-%"),
      supabase
        .from("labor_rates")
        .select("adp_id, hourly_rate")
        .in("adp_id", [LINE_LEADER_ADP_ID, LINE_OPERATOR_ADP_ID]),
    ]);

    const curated: CostingRawMaterial[] = (rmRes.data ?? []).map((r) => ({
      id: r.id as string,
      name: r.name as string,
      inventoryCostPerKg:
        r.inventory_cost_per_kg === null || r.inventory_cost_per_kg === undefined
          ? null
          : Number(r.inventory_cost_per_kg),
      lastOrderCostPerKg:
        r.last_order_cost_per_kg === null || r.last_order_cost_per_kg === undefined
          ? null
          : Number(r.last_order_cost_per_kg),
    }));
    const curatedFpCodes = new Set(
      (rmRes.data ?? [])
        .map((r) => ((r.fp_code as string | null) ?? "").toUpperCase())
        .filter(Boolean),
    );
    // Fishbowl-only PC-RW products: same `fb:<fp_code>` ids the editor's
    // picker stores on ingredient rows; costs stay null until the row is
    // imported into raw_materials (so they blank the material total, just
    // like on screen).
    const fishbowl: CostingRawMaterial[] = (pcRwRes.data ?? [])
      .filter((p) => p.fp_code && p.name)
      .filter((p) => !curatedFpCodes.has((p.fp_code as string).toUpperCase()))
      .map((p) => ({
        id: `fb:${p.fp_code}`,
        name: p.name as string,
        inventoryCostPerKg: null,
        lastOrderCostPerKg: null,
      }));

    const laborRateDefaults: { leader: number | null; operator: number | null } = {
      leader: null,
      operator: null,
    };
    for (const r of lrRes.data ?? []) {
      const rate = r.hourly_rate === null ? null : Number(r.hourly_rate);
      if (r.adp_id === LINE_LEADER_ADP_ID) laborRateDefaults.leader = rate;
      if (r.adp_id === LINE_OPERATOR_ADP_ID) laborRateDefaults.operator = rate;
    }

    costingComputed = computeCostingComputed({
      version: latestVersion,
      rawMaterials: [...curated, ...fishbowl],
      laborRateDefaults,
    });
  }

  const formula: GummyFormulaRecord = recordFromRow(formulaRow);
  return NextResponse.json({
    ok: true,
    formula,
    latestVersion: latestVersion ? { ...latestVersion, costingComputed } : null,
  });
}

// --- PUT ---------------------------------------------------------------------
//
// Identity-only edits. Recipe changes go to POST /formulas/[id]/versions so
// they get their own version row and workflows can pin.
//
// Body:
// {
//   name?: string,
//   pcBkCode?: string | null,   // set to null to clear (mark as TBD)
//   shape?: string,
//   flavor?: string | null,
//   active?: boolean,
// }

type PutBody = {
  name?: string;
  pcBkCode?: string | null;
  shape?: string;
  flavor?: string | null;
  // Customer this formula is designed for. Set to null explicitly to
  // clear the reference; omit the field entirely to leave it untouched.
  customerId?: string | null;
  active?: boolean;
};

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const gated = await gatedClient();
  if (gated.error) return gated.error;
  const { supabase, user } = gated;
  const { id } = await params;

  let body: PutBody;
  try {
    body = (await request.json()) as PutBody;
  } catch {
    return NextResponse.json({ ok: false, error: "bad_json" }, { status: 400 });
  }

  // Fetch the current row first so we can diff before/after for the audit
  // log. If the row doesn't exist, bail with 404.
  const { data: beforeRow, error: beforeErr } = await supabase
    .from("gummy_formulas")
    .select(
      "id, formula_number, pc_bk_code, name, shape, flavor, customer_id, active, latest_version_num, created_at, updated_at, created_by_email, updated_by_email",
    )
    .eq("id", id)
    .maybeSingle();
  if (beforeErr) {
    return NextResponse.json({ ok: false, error: beforeErr.message }, { status: 500 });
  }
  if (!beforeRow) {
    return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  }
  const before = recordFromRow(beforeRow);

  const patch: Record<string, unknown> = {
    updated_by_email: user.email,
  };
  if (body.name !== undefined) {
    const trimmed = body.name.trim();
    if (!trimmed) {
      return NextResponse.json({ ok: false, error: "empty_name" }, { status: 400 });
    }
    patch.name = trimmed;
  }
  if (body.pcBkCode !== undefined) {
    patch.pc_bk_code = body.pcBkCode?.trim() || null;
  }
  if (body.shape !== undefined) patch.shape = body.shape.trim() || "TBD";
  if (body.flavor !== undefined) patch.flavor = body.flavor?.trim() || null;
  if (body.customerId !== undefined) {
    // Empty string coerces to null so the FK stays clean. A real uuid
    // is trusted through — Supabase will reject a malformed one at the
    // insert boundary with a 400 the caller can surface.
    const trimmed = typeof body.customerId === "string" ? body.customerId.trim() : body.customerId;
    patch.customer_id = trimmed ? trimmed : null;
  }
  if (body.active !== undefined) patch.active = !!body.active;

  const { data, error } = await supabase
    .from("gummy_formulas")
    .update(patch)
    .eq("id", id)
    .select(
      "id, formula_number, pc_bk_code, name, shape, flavor, customer_id, active, latest_version_num, created_at, updated_at, created_by_email, updated_by_email",
    )
    .maybeSingle();

  if (error) {
    const status = /duplicate|unique/i.test(error.message) ? 409 : 500;
    return NextResponse.json({ ok: false, error: error.message }, { status });
  }
  if (!data) {
    return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  }
  const after = recordFromRow(data);

  // Audit-log the identity change. Skip when the effective diff is empty
  // (e.g. the caller PUT the same values back — no user-visible change).
  const { diff, summary } = diffIdentity(before, after);
  if (diff.changes.length > 0) {
    await supabase.from("gummy_formula_audit").insert({
      formula_id: after.id,
      by_email: user.email,
      kind: "identity",
      version_num: null,
      summary,
      diff,
    });
  }

  return NextResponse.json({ ok: true, formula: after });
}

// --- DELETE ------------------------------------------------------------------
// Admin-only. Hard-deletes the formula row; the versions / audit / notes rows
// cascade off it via the `on delete cascade` FKs. Non-admins get a 403 so the
// UI's delete affordance stays admin-gated end-to-end (client hides the
// button; server rejects even a hand-rolled request).

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const gated = await gatedClient();
  if (gated.error) return gated.error;
  const { supabase, user } = gated;
  const { id } = await params;

  const admin = await isAdmin(supabase, user.email);
  if (!admin) {
    return NextResponse.json({ ok: false, error: "not_admin" }, { status: 403 });
  }

  const { error } = await supabase
    .from("gummy_formulas")
    .delete()
    .eq("id", id);
  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
