import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createClient as createServiceClient } from "@supabase/supabase-js";

// "Sync now" — the app half.
//
//   POST /api/sync/request   an admin asks the office server to sync
//   GET  /api/sync/request   the button polls for what happened
//
// Vercel cannot reach the office LAN, so this does not start anything. It
// writes a row the server picks up within ~2 minutes (see /api/sync/queue).
// The honest latency is minutes, not instant, and the UI says so.
//
// Open to any signed-in @pharmacenterusa.com account, not only admins: the
// people who notice stale data are the ones using it. Two guards keep that
// from turning the office server into a toy -- one run at a time, and a
// cooldown after a completed one.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// A request older than this with no runner is stale: the server was asleep,
// the task was disabled, the machine was off. Reporting it as "still
// running" forever is the silence this whole ecosystem keeps getting caught
// by, so the UI is told to call it abandoned instead.
const STALE_AFTER_MIN = 15;

function serviceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createServiceClient(url, key, { auth: { persistSession: false } });
}

// A completed run this recent makes another one pointless: the data is
// already from the last couple of minutes. Short enough that someone who just
// typed a part into Fishbowl is not locked out for long.
const COOLDOWN_MIN = 3;

async function staffEmail(): Promise<string | null> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user?.email || !user.email.endsWith("@pharmacenterusa.com")) return null;
  return user.email;
}

export async function POST() {
  const email = await staffEmail();
  if (!email) {
    return NextResponse.json({ ok: false, error: "not_signed_in" }, { status: 403 });
  }
  const svc = serviceClient();
  if (!svc) {
    return NextResponse.json({ ok: false, error: "server_misconfigured" }, { status: 500 });
  }

  // Single-flight. Two people clicking within a minute should queue ONE run,
  // not two full dumps of the database back to back.
  const { data: open } = await svc
    .from("sync_requests")
    .select("id, requested_by, requested_at, status")
    .in("status", ["pending", "running"])
    .order("requested_at", { ascending: true })
    .limit(1);
  if (open && open.length > 0) {
    return NextResponse.json({ ok: true, deduped: true, request: open[0] });
  }

  // Cooldown: a run that finished moments ago already carries today's data.
  const { data: recent } = await svc
    .from("sync_requests")
    .select("id, requested_by, requested_at, status, finished_at")
    .eq("status", "done")
    .order("finished_at", { ascending: false })
    .limit(1);
  const lastFinished = recent?.[0]?.finished_at;
  if (lastFinished && Date.now() - Date.parse(lastFinished) < COOLDOWN_MIN * 60_000) {
    return NextResponse.json({ ok: true, deduped: true, cooldown: true, request: recent[0] });
  }

  const { data, error } = await svc
    .from("sync_requests")
    // requested_by cannot come from the column default here: the service role
    // has no JWT email. It is the verified session email, not anything the
    // client sent.
    .insert({ requested_by: email, status: "pending" })
    .select("id, requested_by, requested_at, status")
    .single();
  if (error || !data) {
    console.error("sync_requests insert failed:", error?.message);
    return NextResponse.json({ ok: false, error: error?.message || "insert_failed" }, { status: 500 });
  }
  console.log(`sync-request: queued by ${email} (${data.id})`);
  return NextResponse.json({ ok: true, deduped: false, request: data });
}

export async function GET() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user?.email) {
    return NextResponse.json({ ok: false, error: "not_signed_in" }, { status: 401 });
  }

  // RLS allows any signed-in user to read these, so this uses the session
  // client rather than the service role: the status is not a secret, and the
  // button shows "Jairo started a sync" to whoever is looking.
  const { data, error } = await supabase
    .from("sync_requests")
    .select("id, requested_by, requested_at, status, started_at, finished_at, detail")
    .order("requested_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  const { data: state } = await supabase
    .from("sync_state")
    .select("entity, source_as_of, synced_at, row_count, dump_source")
    .order("entity");

  let request = data ?? null;
  if (
    request &&
    (request.status === "pending" || request.status === "running") &&
    Date.now() - Date.parse(request.requested_at) > STALE_AFTER_MIN * 60_000
  ) {
    request = { ...request, status: "abandoned" };
  }

  return NextResponse.json({ ok: true, request, state: state ?? [] });
}
