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

  // Two additional Spanish backfills for the /orders card:
  //   • Monday update bodies    (so_monday_activity.updates -> updates_es)
  //   • Fishbowl SO memo field  (fishbowl_sales_orders.note -> note_es)
  // Both are read-only translations of already-English content — same
  // pattern as meeting_sessions.summary_md_es. Only OPEN SOs are
  // considered so the translation task doesn't chew tokens on closed
  // rows that never render on the landing page.
  const OPEN_STATUS_IDS = [10, 20, 25];
  const MONDAY_TX_MAX_AGE_DAYS = 180;

  const [sessRes, noteRes, mondayRes, memoRes] = await Promise.all([
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
    supabase
      .from("so_monday_activity")
      .select("so_number, updates, updates_es")
      .limit(500),
    supabase
      .from("fishbowl_sales_orders")
      .select("so_number, note, note_es")
      .in("status_id", OPEN_STATUS_IDS)
      .not("note", "is", null)
      .limit(500),
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

  // ---- Monday updates that still need Spanish ---------------------------
  // Each row is one SO's full updates[] array. We only surface the
  // updates whose id (or created_at fallback key) has no matching
  // entry in updates_es AND is within the age window. The translation
  // task echoes the row back with updates_es filled per key.
  const mondayCutoffMs =
    Date.now() - MONDAY_TX_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
  const monday = (mondayRes.data ?? [])
    .map((raw) => {
      const r = raw as {
        so_number: string;
        updates: Array<{
          id?: string;
          text_body?: string;
          created_at?: string;
          creator_name?: string | null;
        }> | null;
        updates_es: Array<{
          id?: string;
          text_body?: string;
          created_at?: string;
        }> | null;
      };
      const updates = Array.isArray(r.updates) ? r.updates : [];
      const have = new Set<string>();
      if (Array.isArray(r.updates_es)) {
        for (const u of r.updates_es) {
          const k = (u.id ?? u.created_at ?? "").trim();
          if (k && (u.text_body ?? "").trim()) have.add(k);
        }
      }
      const needing = updates.filter((u) => {
        const k = (u.id ?? u.created_at ?? "").trim();
        if (!k || have.has(k)) return false;
        const ts = new Date(u.created_at ?? "").getTime();
        if (!Number.isFinite(ts) || ts < mondayCutoffMs) return false;
        return (u.text_body ?? "").trim().length > 0;
      });
      if (needing.length === 0) return null;
      return {
        so_number: r.so_number,
        updates: needing.map((u) => ({
          id: u.id ?? "",
          created_at: u.created_at ?? "",
          text_body: u.text_body ?? "",
          creator_name: u.creator_name ?? null,
        })),
      };
    })
    .filter(Boolean);

  // ---- Fishbowl SO memos that still need Spanish ------------------------
  const memos = (memoRes.data ?? [])
    .map((raw) => {
      const r = raw as {
        so_number: string;
        note: string | null;
        note_es: string | null;
      };
      const needs = !!r.note && !r.note_es;
      if (!needs) return null;
      return { so_number: r.so_number, note: r.note };
    })
    .filter(Boolean);

  return NextResponse.json({
    ok: true,
    sessions,
    notes,
    monday,
    memos,
    counts: {
      sessions: sessions.length,
      notes: notes.length,
      monday: monday.length,
      memos: memos.length,
    },
    debug: {
      mondayRawRows: (mondayRes.data ?? []).length,
      mondayError: mondayRes.error?.message ?? null,
      memoRawRows: (memoRes.data ?? []).length,
      memoError: memoRes.error?.message ?? null,
      mondayFirstRow: (mondayRes.data ?? [])[0]
        ? {
            so_number: (mondayRes.data as unknown as Array<{ so_number: string }>)[0]
              .so_number,
            updates_type: typeof (
              mondayRes.data as unknown as Array<{ updates: unknown }>
            )[0].updates,
            updates_len: Array.isArray(
              (mondayRes.data as unknown as Array<{ updates: unknown }>)[0]
                .updates,
            )
              ? (
                  mondayRes.data as unknown as Array<{ updates: unknown[] }>
                )[0].updates.length
              : null,
            updates_es_type: typeof (
              mondayRes.data as unknown as Array<{ updates_es: unknown }>
            )[0].updates_es,
          }
        : null,
    },
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
type MondayUpdatesTx = {
  // One row per SO. `updates_es` is a partial array — the endpoint
  // merges it into the existing updates_es on the row, keyed by id
  // (or created_at fallback), so the translation task only ever has
  // to send bodies it just translated.
  so_number: string;
  updates_es: Array<{
    id?: string;
    created_at?: string;
    text_body: string;
  }>;
};
type FishbowlMemoTx = {
  so_number: string;
  note_es: string | null;
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

  let body: {
    sessions?: unknown;
    notes?: unknown;
    monday?: unknown;
    memos?: unknown;
  };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return badRequest("bad_json");
  }

  const sessions = Array.isArray(body.sessions)
    ? (body.sessions as SessionUpdate[])
    : [];
  const notes = Array.isArray(body.notes) ? (body.notes as NoteUpdate[]) : [];
  const monday = Array.isArray(body.monday)
    ? (body.monday as MondayUpdatesTx[])
    : [];
  const memos = Array.isArray(body.memos)
    ? (body.memos as FishbowlMemoTx[])
    : [];

  let sessionWrites = 0;
  let noteWrites = 0;
  let mondayWrites = 0;
  let memoWrites = 0;
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

  // ---- Monday: merge translated bodies into so_monday_activity.updates_es
  for (const m of monday) {
    if (!m || typeof m.so_number !== "string") continue;
    if (!Array.isArray(m.updates_es) || m.updates_es.length === 0) continue;
    // Read the existing updates_es so we merge instead of replace —
    // otherwise a partial POST would wipe out earlier translations.
    const { data: existing, error: readErr } = await supabase
      .from("so_monday_activity")
      .select("updates_es")
      .eq("so_number", m.so_number)
      .maybeSingle();
    if (readErr) {
      errors.push(`monday ${m.so_number} read: ${readErr.message}`);
      continue;
    }
    const merged = new Map<
      string,
      { id?: string; created_at?: string; text_body: string }
    >();
    const prior = Array.isArray(existing?.updates_es)
      ? (existing!.updates_es as Array<{
          id?: string;
          created_at?: string;
          text_body?: string;
        }>)
      : [];
    for (const u of prior) {
      const k = (u.id ?? u.created_at ?? "").trim();
      if (k && (u.text_body ?? "").trim())
        merged.set(k, {
          id: u.id,
          created_at: u.created_at,
          text_body: u.text_body ?? "",
        });
    }
    for (const u of m.updates_es) {
      const k = (u.id ?? u.created_at ?? "").trim();
      if (!k) continue;
      const body = (u.text_body ?? "").trim();
      if (!body) continue;
      merged.set(k, {
        id: u.id,
        created_at: u.created_at,
        text_body: body,
      });
    }
    const nextArr = Array.from(merged.values());
    const { error } = await supabase
      .from("so_monday_activity")
      .update({ updates_es: nextArr })
      .eq("so_number", m.so_number);
    if (error) errors.push(`monday ${m.so_number}: ${error.message}`);
    else mondayWrites += 1;
  }

  // ---- Fishbowl memo: single-column write per SO
  for (const memo of memos) {
    if (!memo || typeof memo.so_number !== "string") continue;
    if (typeof memo.note_es !== "string") continue;
    const { error } = await supabase
      .from("fishbowl_sales_orders")
      .update({ note_es: memo.note_es })
      .eq("so_number", memo.so_number);
    if (error) errors.push(`memo ${memo.so_number}: ${error.message}`);
    else memoWrites += 1;
  }

  return NextResponse.json({
    ok: errors.length === 0,
    session_writes: sessionWrites,
    note_writes: noteWrites,
    monday_writes: mondayWrites,
    memo_writes: memoWrites,
    errors,
  });
}
