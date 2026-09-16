import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

// /api/sync/meeting-translations
//
// GET  — returns meeting content that still needs Spanish translations.
//        Shape:
//          {
//            ok: true,
//            sessions: [{
//              id, session_date, summary_md,
//              other_business,           // canonical (English) JSON blob
//              needs: { summary: bool, other_business: bool }
//            }],
//            notes: [{
//              id, session_id, so_number, note_md, action_items,
//              needs: { note: bool, action_items: bool }
//            }]
//          }
//        Callers should focus only on `needs` flags — those pinpoint
//        which fields to translate. Rows without missing translations
//        are not returned.
//
// POST — accepts translated content and writes _es columns.
//        Shape:
//          {
//            sessions: [{ id, summary_md_es?, other_business_es? }],
//            notes:    [{ id, note_md_es?,    action_items_es? }]
//          }
//        Idempotent — retranslating just overwrites.
//
// Auth: shared bearer PLAUD_SYNC_SECRET (same secret the other sync
// routes use). Used by a scheduled Cowork task that fetches GET,
// asks Claude to translate, and POSTs back.

export const runtime = "nodejs";

function badRequest(msg: string): NextResponse {
  return NextResponse.json({ ok: false, error: msg }, { status: 400 });
}

function auth(request: Request): NextResponse | null {
  const expected = process.env.PLAUD_SYNC_SECRET;
  if (!expected) {
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
  return null;
}

function client() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRoleKey) return null;
  return createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false },
  });
}

// ---- GET ----------------------------------------------------------------

export async function GET(request: Request) {
  const denied = auth(request);
  if (denied) return denied;
  const supabase = client();
  if (!supabase)
    return NextResponse.json(
      { ok: false, error: "server_misconfigured" },
      { status: 500 },
    );

  const url = new URL(request.url);
  const limit = Math.min(Number(url.searchParams.get("limit")) || 100, 500);

  const [sessRes, noteRes] = await Promise.all([
    supabase
      .from("meeting_sessions")
      .select(
        "id, session_date, summary_md, summary_md_es, other_business, other_business_es",
      )
      .order("session_date", { ascending: false })
      .limit(limit),
    supabase
      .from("meeting_so_notes")
      .select(
        "id, session_id, so_number, note_md, note_md_es, action_items, action_items_es",
      )
      .limit(limit * 3),
  ]);

  const sessions = (sessRes.data ?? [])
    .map((raw) => {
      const r = raw as {
        id: string;
        session_date: string;
        summary_md: string | null;
        summary_md_es: string | null;
        other_business: unknown;
        other_business_es: unknown;
      };
      const ob = Array.isArray(r.other_business)
        ? (r.other_business as unknown[])
        : [];
      const obEs = Array.isArray(r.other_business_es)
        ? (r.other_business_es as unknown[])
        : null;
      const needsSummary = !!r.summary_md && !r.summary_md_es;
      const needsOther = ob.length > 0 && (!obEs || obEs.length !== ob.length);
      if (!needsSummary && !needsOther) return null;
      return {
        id: r.id,
        session_date: r.session_date,
        summary_md: r.summary_md,
        other_business: ob,
        needs: { summary: needsSummary, other_business: needsOther },
      };
    })
    .filter(Boolean);

  const notes = (noteRes.data ?? [])
    .map((raw) => {
      const r = raw as {
        id: string;
        session_id: string;
        so_number: string;
        note_md: string | null;
        note_md_es: string | null;
        action_items: unknown;
        action_items_es: unknown;
      };
      const ai = Array.isArray(r.action_items)
        ? (r.action_items as unknown[])
        : [];
      const aiEs = Array.isArray(r.action_items_es)
        ? (r.action_items_es as unknown[])
        : null;
      const needsNote = !!r.note_md && !r.note_md_es;
      const needsAi = ai.length > 0 && (!aiEs || aiEs.length !== ai.length);
      if (!needsNote && !needsAi) return null;
      return {
        id: r.id,
        session_id: r.session_id,
        so_number: r.so_number,
        note_md: r.note_md,
        action_items: ai,
        needs: { note: needsNote, action_items: needsAi },
      };
    })
    .filter(Boolean);

  return NextResponse.json({
    ok: true,
    sessions,
    notes,
    counts: { sessions: sessions.length, notes: notes.length },
  });
}

// ---- POST ---------------------------------------------------------------

type SessionUpdate = {
  id: string;
  summary_md_es?: string | null;
  other_business_es?: unknown;
};
type NoteUpdate = {
  id: string;
  note_md_es?: string | null;
  action_items_es?: unknown;
};

export async function POST(request: Request) {
  const denied = auth(request);
  if (denied) return denied;
  const supabase = client();
  if (!supabase)
    return NextResponse.json(
      { ok: false, error: "server_misconfigured" },
      { status: 500 },
    );

  let body: { sessions?: unknown; notes?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return badRequest("bad_json");
  }

  const sessions = Array.isArray(body.sessions)
    ? (body.sessions as SessionUpdate[])
    : [];
  const notes = Array.isArray(body.notes) ? (body.notes as NoteUpdate[]) : [];

  let sessionWrites = 0;
  let noteWrites = 0;
  const errors: string[] = [];

  for (const s of sessions) {
    if (!s || typeof s.id !== "string") continue;
    const patch: Record<string, unknown> = {
      updated_at: new Date().toISOString(),
    };
    if (typeof s.summary_md_es === "string") patch.summary_md_es = s.summary_md_es;
    if (Array.isArray(s.other_business_es))
      patch.other_business_es = s.other_business_es;
    if (Object.keys(patch).length === 1) continue;
    const { error } = await supabase
      .from("meeting_sessions")
      .update(patch)
      .eq("id", s.id);
    if (error) errors.push(`session ${s.id}: ${error.message}`);
    else sessionWrites += 1;
  }

  for (const n of notes) {
    if (!n || typeof n.id !== "string") continue;
    const patch: Record<string, unknown> = {
      updated_at: new Date().toISOString(),
    };
    if (typeof n.note_md_es === "string") patch.note_md_es = n.note_md_es;
    if (Array.isArray(n.action_items_es))
      patch.action_items_es = n.action_items_es;
    if (Object.keys(patch).length === 1) continue;
    const { error } = await supabase
      .from("meeting_so_notes")
      .update(patch)
      .eq("id", n.id);
    if (error) errors.push(`note ${n.id}: ${error.message}`);
    else noteWrites += 1;
  }

  return NextResponse.json({
    ok: errors.length === 0,
    session_writes: sessionWrites,
    note_writes: noteWrites,
    errors,
  });
}
