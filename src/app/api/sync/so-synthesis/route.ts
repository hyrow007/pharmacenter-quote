import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { requireSyncAuth } from "@/lib/sync-auth";

// POST /api/sync/so-synthesis
//
// Receiver for AI-generated key-points bullets per SO. A Cowork
// scheduled task assembles the raw context (Fishbowl + Monday + Plaud
// meeting notes) via GET /api/sync/so-synthesis/inputs, calls Claude
// to summarize into 3-5 bullets per SO, and POSTs the result here.
// Read side of the meetings hub reads from public.so_synthesis to
// render a "Key points" block at the top of every SO card.
//
// Auth: requireSyncAuth(request, "so-synthesis") — see src/lib/sync-auth.ts.
// Accepts SO_SYNTHESIS_SECRET if set, else the shared PLAUD_SYNC_SECRET.
//
// Request body (batch):
//   {
//     "items": [
//       {
//         "so_number": "14328",
//         "headline": "Bulk arriving Sep 22; hold line time",
//         "points": [
//           { "text": "Fishbowl: In Progress, ship Feb 19 (original)" },
//           { "text": "Monday Aug 27: Load ETA at port 9/22", "source": "monday" },
//           { "text": "Meeting 9/8: Schedule Omega line tentative 27th", "source": "plaud" }
//         ],
//         "based_on": {
//           "fishbowl_synced_at": "…",
//           "monday_synced_at": "…",
//           "meeting_session_ids": ["…"]
//         }
//       }
//     ]
//   }
//
// Idempotent on so_number — repost overwrites with fresh bullets.
// Response: { ok, upserted }.

export const runtime = "nodejs";

type Point = { text: string; source?: string };
type SynthesisItem = {
  so_number: string;
  headline?: string | null;
  points: Point[];
  // Optional Spanish companions — the /orders page prefers these when
  // lang=es and falls back to the canonical English fields. Producers
  // (the scheduled synthesis task, the render-time backfill) should
  // send both when they can.
  headline_es?: string | null;
  points_es?: Point[] | null;
  based_on?: Record<string, unknown> | null;
};

function badRequest(msg: string): NextResponse {
  return NextResponse.json({ ok: false, error: msg }, { status: 400 });
}

export async function POST(request: Request) {
  const denied = requireSyncAuth(request, "so-synthesis");
  if (denied) return denied;

  let body: { items?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return badRequest("bad_json");
  }
  if (!Array.isArray(body.items)) return badRequest("missing_items_array");

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRoleKey) {
    console.error("Supabase env vars missing");
    return NextResponse.json(
      { ok: false, error: "server_misconfigured" },
      { status: 500 },
    );
  }
  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false },
  });

  const rows: Array<Record<string, unknown>> = [];
  const now = new Date().toISOString();
  const cleanPoints = (arr: unknown): Point[] =>
    Array.isArray(arr)
      ? arr
          .filter(
            (p): p is Point =>
              !!p &&
              typeof (p as Point).text === "string" &&
              (p as Point).text.trim().length > 0,
          )
          .map((p) => ({
            text: p.text.trim(),
            source: typeof p.source === "string" ? p.source : undefined,
          }))
      : [];
  for (const raw of body.items as unknown[]) {
    if (!raw || typeof raw !== "object") continue;
    const s = raw as SynthesisItem;
    if (typeof s.so_number !== "string" || s.so_number.trim() === "") continue;
    const points = cleanPoints(s.points);
    // Build the row conditionally — only include the *_es fields when
    // the payload actually supplied them, so a producer that doesn't
    // do Spanish (the render-time backfill) doesn't stomp on Spanish
    // that a different producer (the scheduled task) already wrote.
    const row: Record<string, unknown> = {
      so_number: s.so_number.trim(),
      headline:
        typeof s.headline === "string" && s.headline.trim()
          ? s.headline.trim()
          : null,
      points,
      based_on:
        s.based_on && typeof s.based_on === "object"
          ? (s.based_on as Record<string, unknown>)
          : null,
      generated_at: now,
    };
    if (typeof s.headline_es === "string") {
      row.headline_es = s.headline_es.trim() || null;
    }
    if (s.points_es !== undefined) {
      const cleaned = cleanPoints(s.points_es);
      row.points_es = cleaned.length > 0 ? cleaned : null;
    }
    rows.push(row);
  }

  if (rows.length === 0) {
    return NextResponse.json({ ok: true, upserted: 0 });
  }

  const { error } = await supabase
    .from("so_synthesis")
    .upsert(rows, { onConflict: "so_number" });
  if (error) {
    console.error("so_synthesis upsert failed:", error.message);
    return NextResponse.json(
      { ok: false, error: error.message },
      { status: 500 },
    );
  }

  return NextResponse.json({ ok: true, upserted: rows.length });
}
