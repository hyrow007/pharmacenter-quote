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

// GET  /api/formulas/[id]        — formula + latest version
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
        "id, formula_id, version_num, bench_batch_g, batch_kg, batches_per_day, fixed_loss_kg_per_day, gummy_piece_weight_g, wet_cast_piece_weight_g, target_yield_units, yield_pct, ingredients, process_notes, label_claims, notes, created_at, created_by_email",
      )
      .eq("formula_id", id)
      .eq("version_num", formulaRow.latest_version_num)
      .maybeSingle();
    if (versionErr) {
      return NextResponse.json({ ok: false, error: versionErr.message }, { status: 500 });
    }
    if (versionRow) latestVersion = versionFromRow(versionRow);
  }

  const formula: GummyFormulaRecord = recordFromRow(formulaRow);
  return NextResponse.json({ ok: true, formula, latestVersion });
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
