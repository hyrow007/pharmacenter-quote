import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { requireSyncAuth } from "@/lib/sync-auth";

// POST /api/sync/heartbeat
//
// A scheduled job says "I ran, here is how it went" -- every run, success or
// failure. The Orders header renders it, so a job that runs and fails is
// visible the same day instead of hiding behind the age of the data it last
// managed to fetch.
//
// Body: { source, ran_at, status, detail?, exit? }
//   source  plaud | fishbowl | monday | daily-cron
//   status  the job's own word: INGESTED, NOTHING, UNREACHABLE, ...
//
// Auth: the bearer the caller already holds for its own scope. Today the only
// caller is the Plaud ingest on the laptop (PLAUD_WEBHOOK_SECRET).

export const runtime = "nodejs";

const SOURCES = ["plaud", "fishbowl", "monday", "daily-cron"];

export async function POST(request: Request) {
  const denied = requireSyncAuth(request, "plaud-webhook");
  if (denied) return denied;

  let body: {
    source?: unknown;
    ran_at?: unknown;
    status?: unknown;
    detail?: unknown;
    exit?: unknown;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }

  const source = typeof body.source === "string" ? body.source.trim() : "";
  const status = typeof body.status === "string" ? body.status.trim().slice(0, 40) : "";
  if (!SOURCES.includes(source) || !status) {
    return NextResponse.json({ ok: false, error: "source and status are required" }, { status: 400 });
  }
  // A job reporting a time we cannot parse is still a job that ran; fall back
  // to now rather than rejecting the only signal it sends.
  const ranAt =
    typeof body.ran_at === "string" && Number.isFinite(Date.parse(body.ran_at))
      ? new Date(body.ran_at).toISOString()
      : new Date().toISOString();

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    return NextResponse.json({ ok: false, error: "server_misconfigured" }, { status: 500 });
  }
  const supabase = createClient(url, key, { auth: { persistSession: false } });

  const { error } = await supabase.from("sync_heartbeats").upsert(
    {
      source,
      ran_at: ranAt,
      status,
      detail:
        typeof body.detail === "string" ? body.detail.slice(0, 2000) : null,
      exit_code: typeof body.exit === "number" ? body.exit : null,
      received_at: new Date().toISOString(),
    },
    { onConflict: "source" },
  );
  if (error) {
    console.error("sync_heartbeats upsert failed:", error.message);
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true, source, status, ran_at: ranAt });
}
