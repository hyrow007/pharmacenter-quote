import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

// "Sync now" — the office-server half.
//
//   GET  /api/sync/queue   claim the oldest pending request (or get nothing)
//   POST /api/sync/queue   report how the claimed run went
//
// Called every two minutes by Run-FishbowlSync.ps1 -Poll on the office server.
// The overwhelmingly common answer is "nothing pending", which must be cheap:
// no dump, no parse, one row read, exit.
//
// Bearer-auth with FISHBOWL_SYNC_SECRET, like its sibling Fishbowl routes.
// Writes with the service role; public.sync_requests grants SELECT to
// authenticated and nothing else, so this and /api/sync/request are the only
// writers.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function authorized(request: Request): boolean | null {
  const expected = process.env.FISHBOWL_SYNC_SECRET;
  if (!expected) return null; // misconfigured, not unauthorized
  const authz = request.headers.get("authorization") || "";
  const provided = authz.startsWith("Bearer ") ? authz.slice(7).trim() : "";
  return provided === expected;
}

function serviceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false } });
}

export async function GET(request: Request) {
  const ok = authorized(request);
  if (ok === null) {
    return NextResponse.json({ ok: false, error: "server_misconfigured" }, { status: 500 });
  }
  if (!ok) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });

  const svc = serviceClient();
  if (!svc) {
    return NextResponse.json({ ok: false, error: "server_misconfigured" }, { status: 500 });
  }

  const { data: pending, error } = await svc
    .from("sync_requests")
    .select("id, requested_by, requested_at")
    .eq("status", "pending")
    .order("requested_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error) {
    console.error("sync_requests read failed:", error.message);
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }
  if (!pending) return NextResponse.json({ ok: true, request: null });

  // Claim it. The .eq("status","pending") in the update is the lock: if two
  // pollers ever race -- a second server, a hand-run alongside the task --
  // the loser updates zero rows and is told there is nothing to do, rather
  // than both dumping the database at once.
  const { data: claimed, error: claimError } = await svc
    .from("sync_requests")
    .update({ status: "running", started_at: new Date().toISOString() })
    .eq("id", pending.id)
    .eq("status", "pending")
    .select("id, requested_by, requested_at")
    .maybeSingle();
  if (claimError) {
    console.error("sync_requests claim failed:", claimError.message);
    return NextResponse.json({ ok: false, error: claimError.message }, { status: 500 });
  }
  if (!claimed) return NextResponse.json({ ok: true, request: null });

  console.log(`sync-queue: claimed ${claimed.id} (requested by ${claimed.requested_by})`);
  return NextResponse.json({ ok: true, request: claimed });
}

export async function POST(request: Request) {
  const ok = authorized(request);
  if (ok === null) {
    return NextResponse.json({ ok: false, error: "server_misconfigured" }, { status: 500 });
  }
  if (!ok) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });

  let body: { id?: unknown; status?: unknown; detail?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ ok: false, error: "bad_json" }, { status: 400 });
  }

  const id = typeof body.id === "string" ? body.id : "";
  const status = body.status === "done" || body.status === "failed" ? body.status : null;
  if (!id || !status) {
    return NextResponse.json({ ok: false, error: "id_and_status_required" }, { status: 400 });
  }
  const detail =
    typeof body.detail === "string" ? body.detail.slice(0, 4000) : null;

  const svc = serviceClient();
  if (!svc) {
    return NextResponse.json({ ok: false, error: "server_misconfigured" }, { status: 500 });
  }

  const { error } = await svc
    .from("sync_requests")
    .update({ status, detail, finished_at: new Date().toISOString() })
    .eq("id", id);
  if (error) {
    console.error("sync_requests complete failed:", error.message);
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }
  console.log(`sync-queue: ${id} -> ${status}`);
  return NextResponse.json({ ok: true });
}
