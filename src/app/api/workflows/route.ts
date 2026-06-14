import { NextResponse } from "next/server";
import { createClient } from "@/lib/auth/server";
import type { WorkflowRow, WorkflowState } from "@/lib/workflows";

// GET /api/workflows
//   → { ok: true, workflows: WorkflowRow[] }
// Lists every workflow visible to the caller. RLS already restricts to
// pharmacenterusa.com users, but we double-check the auth gate here so a
// surprise mis-configuration doesn't leak an empty 200 to a stranger.
//
// POST /api/workflows
// Body: { state: WorkflowState }
//   → { ok: true, workflow: WorkflowRow }
// Creates a new row authored by the signed-in user.

type PostBody = { state?: WorkflowState };

type GateResult =
  | { error: NextResponse; supabase?: undefined; user?: undefined }
  | { error?: undefined; supabase: Awaited<ReturnType<typeof createClient>>; user: { email: string } };

async function gatedClient(): Promise<GateResult> {
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
  // user.email is non-null here — narrow to the runtime guarantee.
  return { supabase, user: { email: user.email } };
}

export async function GET() {
  const gated = await gatedClient();
  if (gated.error) return gated.error;
  const { supabase } = gated;

  const { data, error } = await supabase
    .from("workflows")
    .select("id, quote_number, created_by_email, created_at, updated_at, state, status, sales_orders, monday_item_id, monday_item_url, monday_last_pushed_at")
    .order("updated_at", { ascending: false });

  if (error) {
    console.error("workflows list failed:", error.message);
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true, workflows: (data ?? []) as WorkflowRow[] });
}

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
  if (!body.state || typeof body.state !== "object") {
    return NextResponse.json({ ok: false, error: "missing_state" }, { status: 400 });
  }

  const { data, error } = await supabase
    .from("workflows")
    .insert({
      // RLS policy requires created_by_email = auth.jwt() email claim.
      created_by_email: user.email,
      state: body.state,
    })
    .select("id, quote_number, created_by_email, created_at, updated_at, state, status, sales_orders, monday_item_id, monday_item_url, monday_last_pushed_at")
    .single();

  if (error || !data) {
    console.error("workflow insert failed:", error?.message);
    return NextResponse.json({ ok: false, error: error?.message || "insert_failed" }, { status: 500 });
  }
  return NextResponse.json({ ok: true, workflow: data as WorkflowRow });
}
