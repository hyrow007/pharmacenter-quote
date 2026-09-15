import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import {
  extractMentionsFromSummary,
  resolveSoAgainstFishbowl,
  detectCustomerMismatch,
  type SoMention,
} from "@/lib/plaud/extract";

// POST /api/plaud/webhook
//
// Receiver for Plaud recording notifications. Ingests one meeting per
// call, upserts meeting_sessions + meeting_so_notes, and cross-references
// every extracted SO against fishbowl_sales_orders (see lib/plaud/extract).
//
// Two request shapes, both bearer-authenticated:
//
//   1. Auto-extract from Plaud summary:
//      {
//        "meeting_type_slug": "sales-orders",   // which hub tile owns this
//        "recording": {
//          "id": "917f87516507d8bc3b7562e2a44014f4",
//          "name": "09-08 Sales Order Updates …",
//          "session_date": "2026-09-08",         // YYYY-MM-DD
//          "attendees": ["Jairo Osorno", "Jessica Medri", …],
//          "summary_md": "## Meeting Notes\n- Sales Order 14693 (…)\n  - …",
//          "transcript_url": "https://…"          // optional
//        }
//      }
//      → the extractor walks summary_md, pulls every SO reference,
//        resolves each against Fishbowl, snapshots the current row, flags
//        customer-name mismatches (Peter Chu vs Purechews, etc.), and
//        upserts on (session_id, so_number).
//
//   2. Pre-extracted mentions (used when the caller already ran the
//      extractor themselves — Zapier with a Code step, a Cowork agent):
//      {
//        "meeting_type_slug": "sales-orders",
//        "recording": { id, name, session_date, attendees, transcript_url },
//        "so_mentions": [
//          { "so_number": "14693",
//            "note_md": "…",
//            "action_items": [{ "text": "…", "owner": "Lindsey" }],
//            "status_flag": "blocked" }
//        ]
//      }
//      → the receiver still cross-references each SO against Fishbowl,
//        stamps the snapshot, and flags mismatches — Fishbowl remains the
//        source of truth even when the caller supplied its own notes.
//
// Response: { ok, session_id, inserted_notes, mismatched, snapshotted }
//
// Auth: bearer PLAUD_SYNC_SECRET header; mirrors /api/sync/sales-orders.

export const runtime = "nodejs"; // service-role client needs Node

// ---- payload types ------------------------------------------------------

type Recording = {
  id: string;
  name?: string;
  session_date: string; // YYYY-MM-DD
  attendees?: string[];
  summary_md?: string;
  transcript_url?: string;
};

type Body = {
  meeting_type_slug?: string;
  recording?: Recording;
  so_mentions?: Array<{
    so_number: string;
    note_md?: string;
    action_items?: Array<{
      text: string;
      owner?: string;
      due_date?: string;
      done?: boolean;
    }>;
    status_flag?: "on_track" | "at_risk" | "blocked" | null;
  }>;
};

function badRequest(msg: string): NextResponse {
  return NextResponse.json({ ok: false, error: msg }, { status: 400 });
}

// ---- handler ------------------------------------------------------------

export async function POST(request: Request) {
  // Bearer auth --------------------------------------------------------
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

  // Body ---------------------------------------------------------------
  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return badRequest("bad_json");
  }
  const slug = body.meeting_type_slug ?? "sales-orders";
  const rec = body.recording;
  if (!rec || typeof rec.id !== "string" || rec.id.trim() === "")
    return badRequest("missing_recording_id");
  if (typeof rec.session_date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(rec.session_date))
    return badRequest("missing_or_bad_session_date");

  // Service-role Supabase client — writes bypass RLS by design.
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

  // Resolve meeting_type -----------------------------------------------
  const { data: typeRow, error: typeErr } = await supabase
    .from("meeting_types")
    .select("id")
    .eq("slug", slug)
    .maybeSingle();
  if (typeErr || !typeRow) {
    return NextResponse.json(
      { ok: false, error: `meeting_type_not_found: ${slug}` },
      { status: 404 },
    );
  }
  const meetingTypeId = (typeRow as { id: string }).id;

  // Upsert meeting_sessions --------------------------------------------
  // Idempotent on (meeting_type_id, plaud_recording_id): if a session for
  // this recording already exists we reuse its id so re-runs refresh notes
  // instead of duplicating.
  const { data: existing } = await supabase
    .from("meeting_sessions")
    .select("id")
    .eq("meeting_type_id", meetingTypeId)
    .eq("plaud_recording_id", rec.id)
    .maybeSingle();

  let sessionId: string;
  if (existing) {
    sessionId = (existing as { id: string }).id;
    const { error: updErr } = await supabase
      .from("meeting_sessions")
      .update({
        session_date: rec.session_date,
        source: "plaud",
        transcript_url: rec.transcript_url ?? null,
        summary_md: rec.summary_md ?? null,
        attendees: rec.attendees ?? [],
        updated_at: new Date().toISOString(),
      })
      .eq("id", sessionId);
    if (updErr) {
      console.error("meeting_sessions update failed:", updErr.message);
      return NextResponse.json(
        { ok: false, error: updErr.message },
        { status: 500 },
      );
    }
  } else {
    const { data: created, error: insErr } = await supabase
      .from("meeting_sessions")
      .insert({
        meeting_type_id: meetingTypeId,
        session_date: rec.session_date,
        source: "plaud",
        plaud_recording_id: rec.id,
        transcript_url: rec.transcript_url ?? null,
        summary_md: rec.summary_md ?? null,
        attendees: rec.attendees ?? [],
      })
      .select("id")
      .single();
    if (insErr || !created) {
      console.error(
        "meeting_sessions insert failed:",
        insErr?.message ?? "no row",
      );
      return NextResponse.json(
        { ok: false, error: insErr?.message ?? "insert_failed" },
        { status: 500 },
      );
    }
    sessionId = (created as { id: string }).id;
  }

  // Build the mentions list --------------------------------------------
  // Two paths: caller supplied so_mentions verbatim, or the extractor
  // walks the summary_md. Either way we always cross-reference against
  // Fishbowl before writing.
  let mentions: SoMention[];
  if (Array.isArray(body.so_mentions) && body.so_mentions.length > 0) {
    mentions = await hydrateSuppliedMentions(supabase, body.so_mentions);
  } else if (typeof rec.summary_md === "string" && rec.summary_md.length > 0) {
    mentions = await extractMentionsFromSummary(supabase, rec.summary_md);
  } else {
    return badRequest("no_summary_md_and_no_so_mentions");
  }

  // Upsert meeting_so_notes --------------------------------------------
  let inserted = 0;
  let mismatched = 0;
  let snapshotted = 0;
  for (const m of mentions) {
    if (m.customer_mismatch) mismatched += 1;
    if (m.fishbowl_snapshot) snapshotted += 1;
    const { error: upErr } = await supabase
      .from("meeting_so_notes")
      .upsert(
        {
          session_id: sessionId,
          so_number: m.so_number,
          note_md: m.note_md,
          action_items: m.action_items,
          status_flag: m.status_flag,
          fishbowl_snapshot: m.fishbowl_snapshot,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "session_id,so_number" },
      );
    if (upErr) {
      console.error(
        `meeting_so_notes upsert failed for SO ${m.so_number}:`,
        upErr.message,
      );
      continue;
    }
    inserted += 1;
  }

  return NextResponse.json({
    ok: true,
    session_id: sessionId,
    inserted_notes: inserted,
    total_mentions: mentions.length,
    mismatched,
    snapshotted,
  });
}

// ---- helpers ------------------------------------------------------------

/**
 * When the caller supplied so_mentions verbatim, we still run every one
 * through the Fishbowl resolver + customer-mismatch check. This is what
 * enforces the "Fishbowl is truth" rule regardless of who authored the
 * notes.
 */
async function hydrateSuppliedMentions(
  supabase: ReturnType<typeof createClient>,
  supplied: NonNullable<Body["so_mentions"]>,
): Promise<SoMention[]> {
  const out: SoMention[] = [];
  for (const s of supplied) {
    if (!s.so_number) continue;
    const fishbowl = await resolveSoAgainstFishbowl(supabase, s.so_number);
    const noteText = s.note_md ?? "";
    const { mismatch, hint } = detectCustomerMismatch(
      noteText,
      fishbowl?.customer_name ?? null,
    );
    let note_md = noteText;
    let status_flag = s.status_flag ?? null;
    if (mismatch) {
      const line = hint
        ? `\n\n⚠ Note mentions a customer that doesn't match Fishbowl — likely "${hint}" per Fishbowl. Verify before acting.`
        : `\n\n⚠ Note mentions a customer that doesn't match Fishbowl (${fishbowl?.customer_name ?? "no Fishbowl row"}). Verify.`;
      note_md += line;
      if (!status_flag) status_flag = "at_risk";
    }
    out.push({
      so_number: fishbowl?.so_number ?? s.so_number,
      note_md,
      action_items: Array.isArray(s.action_items) ? s.action_items : [],
      status_flag,
      fishbowl_snapshot: fishbowl
        ? (fishbowl as unknown as Record<string, unknown>)
        : null,
      customer_mismatch: mismatch,
    });
  }
  return out;
}
