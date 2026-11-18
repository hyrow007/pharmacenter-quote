import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import type { WorkflowRow, WorkflowState } from "@/lib/workflows";

// POST /api/workflows/[id]/duplicate
//   → { ok: true, workflow: WorkflowRow }
//
// Copies a workflow's state into a NEW row: same customer, products,
// pricing tabs and costing build-ups, a fresh quote number from the
// database, and the caller as its author.
//
// The copy happens here rather than in the browser so the whole state
// never round-trips through the client — a workflow with four costing
// boards and a dozen pricing tabs is large, and a client that can rewrite
// it on the way past is a client that can rewrite someone else's quote.
// RLS still decides what the caller may read and insert.

const COLS =
  "id, quote_number, created_by_email, created_at, updated_at, state, status, sales_orders, description_override, monday_item_id, monday_item_url, monday_last_pushed_at";

function uid(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto)
    return crypto.randomUUID();
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

export async function POST(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ ok: false, error: "not_signed_in" }, { status: 401 });
  }
  if (!user.email?.endsWith("@pharmacenterusa.com")) {
    return NextResponse.json({ ok: false, error: "wrong_domain" }, { status: 403 });
  }

  const { data: source, error: readError } = await supabase
    .from("workflows")
    .select("state")
    .eq("id", id)
    .maybeSingle();

  if (readError) {
    console.error("workflow duplicate read failed:", readError.message);
    return NextResponse.json({ ok: false, error: readError.message }, { status: 500 });
  }
  if (!source?.state) {
    return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  }

  const state = source.state as WorkflowState;

  // What a copy must NOT inherit.
  //
  // issuedQuotes are the documents that went to a customer, and each one
  // stores the sheet HTML with the ORIGINAL's quote number printed on it.
  // Carrying them would put Q0080 inside a quote numbered Q0081 and date
  // the new workflow's history to work it never did.
  //
  // workflowUid is the storage prefix its attachments live under. Sharing
  // one would leave two workflows writing to the same folder, where
  // removing a file from either takes it from both.
  const {
    issuedQuotes: _droppedQuotes,
    workflowUid: _droppedUid,
    ...carried
  } = state;

  const nextState: WorkflowState = { ...carried, workflowUid: uid() };

  // status, sales_orders and the monday_* columns are left off the insert
  // entirely: a copy has not been won, has no sales orders against it and
  // has never been pushed. They take their column defaults.
  const { data, error } = await supabase
    .from("workflows")
    .insert({ created_by_email: user.email, state: nextState })
    .select(COLS)
    .single();

  if (error || !data) {
    console.error("workflow duplicate insert failed:", error?.message);
    return NextResponse.json(
      { ok: false, error: error?.message || "insert_failed" },
      { status: 500 },
    );
  }
  return NextResponse.json({ ok: true, workflow: data as WorkflowRow });
}
