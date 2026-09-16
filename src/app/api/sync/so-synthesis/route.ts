import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

// POST /api/sync/so-synthesis
//
// Receiver for AI-generated key-points bullets per SO. A Cowork
// scheduled task assembles the raw context (Fishbowl + Monday + Plaud
// meeting notes) via GET /api/sync/so-synthesis/inputs, calls Claude
// to summarize into 3-5 bullets per SO, and POSTs the result here.
// Read side of the meetings hub reads from public.so_synthesis to
// render a "Key points" block at the top of every SO card.
//
// Auth: shared bearer PLAUD_SYNC_SECRET (same secret the other sync
// routes use).
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
  based_on?: Record<string, unknown> | null;
};

function badRequest(msg: string): NextResponse {
  return NextResponse.json({ ok: false, error: msg }, { status: 400 });
}

export async function POST(request: Request) {
  const expected = process.env.PLAUD_SYNC_SECRET;
  if (!expected) {
    console.error("PLAUD_SYNC_SECRET not configured");
    return NextResponse.json(
      { ok: false, error: "server_misconfigured" },
      { status: 500 },
    );
  }
  const authz = request.headers.get("authorization") || "";
  const provided = authz.startsWith("Bearer ")
    ? authz.slice("Bearer ".length).trim()
    : "";
  if (provided !== expected) {
    return NextResponse.json(
      { ok: false, error: "unauthorized" },
      { status: 401 },
    );
  }

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

  const rows: Array<{
    so_number: string;
    headline: string | null;
    points: Point[];
    based_on: Record<string, unknown> | null;
    generated_at: string;
  }> = [];
  const now = new Date().toISOString();
  for (const raw of body.items as unknown[]) {
    if (!raw || typeof raw !== "object") continue;
    const s = raw as SynthesisItem;
    if (typeof s.so_number !== "string" || s.so_number.trim() === "") continue;
    const points = Array.isArray(s.points)
      ? s.points
          .filter(
            (p): p is Point =>
              !!p && typeof (p as Point).text === "string" &&
              (p as Point).text.trim().length > 0,
          )
          .map((p) => ({
            text: p.text.trim(),
            source: typeof p.source === "string" ? p.source : undefined,
          }))
      : [];
    rows.push({
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
    });
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
