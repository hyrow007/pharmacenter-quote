import { NextResponse } from "next/server";
import { createClient } from "@/lib/auth/server";
import {
  isAdmin,
  type WorkflowRow,
  type WorkflowState,
  type WorkflowStatus,
} from "@/lib/workflows";

// GET /api/workflows/[id]
//   → { ok: true, workflow, isAdmin, isOwner }
//
// PUT /api/workflows/[id]
// Body: { state?: WorkflowState, status?: WorkflowStatus }
//   → { ok: true, workflow }
// Either or both fields may be present. Sending neither is a 400.
//
// DELETE /api/workflows/[id]
//   → { ok: true } or 403 if RLS rejects.

const COLS =
  "id, created_by_email, created_at, updated_at, state, status, monday_item_id, monday_item_url, monday_last_pushed_at";

const VALID_STATUSES: WorkflowStatus[] = ["in_progress", "won", "lost"];

type PutBody = { state?: WorkflowState; status?: WorkflowStatus };

type Ctx = { params: Promise<{ id: string }> };

type GateResult =
  | { error: NextResponse; supabase?: undefined; user?: undefined }
  | { error?: undefined; supabase: Awaited<ReturnType<typeof createClient>>; user: { email: string } };

async function gated(): Promise<GateResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return { error: NextResponse.json({ ok: false, error: "not_signed_in" }, { status: 401 }) };
  }
  if (!user.email?.endsWith("@pharmacenterusa.com")) {
    return { error: NextResponse.json({ ok: false, error: "wrong_domain" }, { status: 403 }) };
  }
  return { supabase, user: { email: user.email } };
}

export async function GET(_req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const g = await gated();
  if (g.error) return g.error;
  const { supabase, user } = g;

  const { data, error } = await supabase.from("workflows").select(COLS).eq("id", id).maybeSingle();
  if (error) {
    console.error("workflow fetch failed:", error.message);
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }
  if (!data) {
    return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  }
  const row = data as WorkflowRow;
  const admin = await isAdmin(supabase, user.email);
  return NextResponse.json({
    ok: true,
    workflow: row,
    isAdmin: admin,
    isOwner: row.created_by_email === user.email,
  });
}

export async function PUT(request: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const g = await gated();
  if (g.error) return g.error;
  const { supabase } = g;

  let body: PutBody;
  try {
    body = (await request.json()) as PutBody;
  } catch {
    return NextResponse.json({ ok: false, error: "bad_json" }, { status: 400 });
  }

  const patch: { state?: WorkflowState; status?: WorkflowStatus } = {};
  if (body.state && typeof body.state === "object") {
    patch.state = body.state;
  }
  if (body.status !== undefined) {
    if (!VALID_STATUSES.includes(body.status)) {
      return NextResponse.json({ ok: false, error: "invalid_status" }, { status: 400 });
    }
    patch.status = body.status;
  }
  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ ok: false, error: "nothing_to_update" }, { status: 400 });
  }

  const { data, error } = await supabase
    .from("workflows")
    // updated_at has a DB trigger to bump itself; we only send the diff.
    .update(patch)
    .eq("id", id)
    .select(COLS)
    .single();

  if (error || !data) {
    console.error("workflow update failed:", error?.message);
    return NextResponse.json(
      { ok: false, error: error?.message || "update_failed" },
      { status: 500 },
    );
  }
  return NextResponse.json({ ok: true, workflow: data as WorkflowRow });
}

export async function DELETE(_req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const g = await gated();
  if (g.error) return g.error;
  const { supabase } = g;

  // RLS enforces owner-or-admin. If it rejects we get an empty count back —
  // surface that as a 403 rather than a silent 200.
  const { error, count } = await supabase
    .from("workflows")
    .delete({ count: "exact" })
    .eq("id", id);

  if (error) {
    console.error("workflow delete failed:", error.message);
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }
  if (!count || count === 0) {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }
  return NextResponse.json({ ok: true });
}
