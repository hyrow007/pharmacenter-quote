import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { requireSyncAuth } from "@/lib/sync-auth";
import { runPush } from "@/app/admin/monday/_lib/push";

// POST /api/monday/push — Fishbowl mirror -> Monday boards.
//
// Called by the office server right after each scheduled Fishbowl sync
// (5am, and every 2 hours 8am-6pm ET), so the push always works from data that
// was just mirrored. Same bearer as /api/sync/monday (scope "monday").
//
//   ?live=1   ask for a live run. Still a dry run unless MONDAY_PUSH_LIVE=1.
//
// The logic lives in src/app/admin/monday/_lib/push.ts, shared with the
// "Push now" button. Reads the mirror, never Fishbowl; never writes Fishbowl.

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request: Request) {
  return POST(request);
}

export async function POST(request: Request) {
  const denied = requireSyncAuth(request, "monday");
  if (denied) return denied;

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return NextResponse.json({ ok: false, error: "server_misconfigured" }, { status: 500 });
  const db = createClient(url, key, { auth: { persistSession: false } });

  const wantLive = new URL(request.url).searchParams.get("live") === "1";
  try {
    const r = await runPush({ db, trigger: "schedule", startedBy: null, wantLive });
    const count = (k: string) => r.actions.filter((a) => a.kind === k).length;
    return NextResponse.json({
      ok: r.errors.length === 0 && !r.refused,
      run_id: r.runId,
      live: r.live,
      refused: r.refused,
      planned: {
        create: count("create"),
        move: count("move"),
        archive: count("archive"),
        rename: count("rename"),
        update: count("update"),
        link: count("link"),
      },
      applied: r.applied.length,
      errors: r.errors.map((e) => `${e.action.kind} ${e.action.so}: ${e.error}`),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("monday push failed:", msg);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
