import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { requireSyncAuth } from "@/lib/sync-auth";

// GET /api/sync/so-synthesis/inputs
//
// Read-side companion to /api/sync/so-synthesis. Returns the raw
// per-SO context blob the Cowork scheduled task needs to generate
// key-point bullets — a pre-joined view of Fishbowl, Monday, and
// Plaud meeting notes for every SO that has activity on any source.
//
// Auth: requireSyncAuth(request, "so-synthesis-inputs") — see
// src/lib/sync-auth.ts. Shares SO_SYNTHESIS_SECRET with the write side if
// set, else the shared PLAUD_SYNC_SECRET. Read-only: the generator step
// can only fetch what it needs to summarize, no wider access.
//
// Query params:
//   ?so=<n>       only this SO (useful for one-off regeneration)
//   ?limit=<n>    cap the batch size (default 200)
//
// Response:
//   {
//     ok: true,
//     count: N,
//     sos: [
//       {
//         so_number: "14328",
//         fishbowl: {  // null if not in the mirror
//           status_name, is_open, customer_name, customer_po, salesman,
//           note, date_first_ship, date_issued, subtotal, total_price,
//           sale_items: [{ product_num, description, qty_ordered,
//                          qty_picked, qty_fulfilled, unit_price,
//                          total_price, date_scheduled }],
//           synced_at
//         },
//         monday: {    // null if no Monday cache yet
//           status, monday_url, item_updated_at, last_synced_at,
//           updates: [{ text_body, created_at, creator_name }]
//         },
//         meetings: [  // meeting_so_notes across all sessions, newest first
//           { session_date, note_md, action_items, status_flag }
//         ],
//         existing_synthesis: {  // so the generator can skip if fresh
//           generated_at, based_on
//         } | null
//       }
//     ]
//   }
//
// Design note: only SOs with at least one meeting note OR Monday item
// are returned. Fresh Fishbowl-only rows without either signal aren't
// worth synthesizing — the SO card already shows Fishbowl inline.

export const runtime = "nodejs";

export async function GET(request: Request) {
  const denied = requireSyncAuth(request, "so-synthesis-inputs");
  if (denied) return denied;

  const url = new URL(request.url);
  const singleSo = url.searchParams.get("so")?.trim() || null;
  const limit = Math.min(
    Number(url.searchParams.get("limit")) || 200,
    500,
  );

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRoleKey) {
    return NextResponse.json(
      { ok: false, error: "server_misconfigured" },
      { status: 500 },
    );
  }
  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false },
  });

  // Union of SO numbers with any signal we can synthesize on.
  const soSet = new Set<string>();
  if (singleSo) {
    soSet.add(singleSo);
  } else {
    const [mondaySos, meetingSos] = await Promise.all([
      supabase.from("so_monday_activity").select("so_number").limit(limit),
      supabase
        .from("meeting_so_notes")
        .select("so_number")
        .limit(limit * 3),
    ]);
    (mondaySos.data ?? []).forEach((r) =>
      soSet.add((r as { so_number: string }).so_number),
    );
    (meetingSos.data ?? []).forEach((r) =>
      soSet.add((r as { so_number: string }).so_number),
    );
  }
  const soList = Array.from(soSet).slice(0, limit);
  if (soList.length === 0) {
    return NextResponse.json({ ok: true, count: 0, sos: [] });
  }

  // Fan out three reads in parallel.
  const [fbRes, mondayRes, notesRes, synthesisRes] = await Promise.all([
    supabase
      .from("fishbowl_sales_orders")
      .select(
        "so_number, status_name, is_open, customer_name, customer_po, salesman, note, date_first_ship, date_issued, subtotal, total_price, items, synced_at",
      )
      .in("so_number", soList),
    supabase
      .from("so_monday_activity")
      .select(
        "so_number, status, monday_url, item_updated_at, last_synced_at, updates",
      )
      .in("so_number", soList),
    supabase
      .from("meeting_so_notes")
      .select(
        "so_number, note_md, action_items, status_flag, created_at, meeting_sessions(session_date)",
      )
      .in("so_number", soList)
      .order("created_at", { ascending: false }),
    supabase
      .from("so_synthesis")
      .select("so_number, generated_at, based_on")
      .in("so_number", soList),
  ]);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fbBy = new Map<string, any>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mondayBy = new Map<string, any>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const notesBy = new Map<string, any[]>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const synthBy = new Map<string, any>();

  const SALE_TYPE_IDS = new Set([10, 30]);
  (fbRes.data ?? []).forEach((raw) => {
    const r = raw as Record<string, unknown> & {
      so_number: string;
      items?: Array<Record<string, unknown>>;
    };
    const items = Array.isArray(r.items) ? r.items : [];
    const saleItems = items
      .filter((it) => {
        const t = (it as { type_id?: number }).type_id;
        return typeof t === "number" && SALE_TYPE_IDS.has(t);
      })
      .map((it) => ({
        product_num: (it as { product_num?: string | null }).product_num ?? null,
        description:
          (it as { description?: string | null }).description ?? null,
        qty_ordered:
          (it as { qty_ordered?: number | null }).qty_ordered ?? null,
        qty_picked: (it as { qty_picked?: number | null }).qty_picked ?? null,
        qty_fulfilled:
          (it as { qty_fulfilled?: number | null }).qty_fulfilled ?? null,
        unit_price: (it as { unit_price?: number | null }).unit_price ?? null,
        total_price:
          (it as { total_price?: number | null }).total_price ?? null,
        date_scheduled:
          (it as { date_scheduled?: string | null }).date_scheduled ?? null,
      }));
    fbBy.set(r.so_number, {
      status_name: r.status_name ?? null,
      is_open: r.is_open ?? null,
      customer_name: r.customer_name ?? null,
      customer_po: r.customer_po ?? null,
      salesman: r.salesman ?? null,
      note: r.note ?? null,
      date_first_ship: r.date_first_ship ?? null,
      date_issued: r.date_issued ?? null,
      subtotal: r.subtotal ?? null,
      total_price: r.total_price ?? null,
      sale_items: saleItems,
      synced_at: r.synced_at ?? null,
    });
  });
  (mondayRes.data ?? []).forEach((raw) => {
    const r = raw as Record<string, unknown> & { so_number: string };
    mondayBy.set(r.so_number, {
      status: r.status ?? null,
      monday_url: r.monday_url ?? null,
      item_updated_at: r.item_updated_at ?? null,
      last_synced_at: r.last_synced_at ?? null,
      updates: Array.isArray(r.updates) ? r.updates : [],
    });
  });
  (notesRes.data ?? []).forEach((raw) => {
    const r = raw as Record<string, unknown> & { so_number: string };
    const arr = notesBy.get(r.so_number) ?? [];
    arr.push({
      session_date:
        ((r.meeting_sessions ?? null) as { session_date?: string } | null)
          ?.session_date ?? null,
      note_md: r.note_md ?? null,
      action_items: Array.isArray(r.action_items) ? r.action_items : [],
      status_flag: r.status_flag ?? null,
    });
    notesBy.set(r.so_number, arr);
  });
  (synthesisRes.data ?? []).forEach((raw) => {
    const r = raw as Record<string, unknown> & { so_number: string };
    synthBy.set(r.so_number, {
      generated_at: r.generated_at ?? null,
      based_on: r.based_on ?? null,
    });
  });

  const sos = soList.map((so) => ({
    so_number: so,
    fishbowl: fbBy.get(so) ?? null,
    monday: mondayBy.get(so) ?? null,
    meetings: notesBy.get(so) ?? [],
    existing_synthesis: synthBy.get(so) ?? null,
  }));

  return NextResponse.json({ ok: true, count: sos.length, sos });
}
