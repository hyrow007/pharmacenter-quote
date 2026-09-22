import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { requireSyncAuth } from "@/lib/sync-auth";

// POST /api/sync/monday
//
// Pulls every item on the Monday "Open Sales Orders" board (id
// 18389208010) plus its most recent Updates and upserts them into
// public.so_monday_activity. The meetings hub reads from that cache so
// page renders never hit Monday's API directly.
//
// Auth: same pattern as /api/sync/sales-orders — bearer token in the
// Authorization header. Set FISHBOWL_SYNC_SECRET-style
// SYNC_SHARED_SECRET or accept the Vercel-side MONDAY_SYNC_SECRET as a
// generic sync bearer. Now handled by requireSyncAuth(request, "monday"),
// which takes MONDAY_SYNC_SECRET, or Vercel's CRON_SECRET, or
// another env var for the same job.
//
// Data source: Monday GraphQL v2. Requires MONDAY_API_TOKEN in env.
//
// Response: { ok, items_synced, updates_synced, replies_synced, elapsed_ms }.

export const runtime = "nodejs"; // service-role + fetch to external API

const MONDAY_BOARD_ID = 18389208010;
const MONDAY_API_URL = "https://api.monday.com/v2";
// Fetch a generous window of updates per SO so the synthesis task can
// spot older-but-still-operational context (a "caps ETA 9/15 confirmed"
// from three weeks ago is often more useful than today's "moved to In
// Progress" chatter). 30 covers ~2-3 months of typical activity on the
// busiest SOs while staying well inside Monday's per-query cost budget.
const UPDATES_PER_ITEM = 30;
// Cap on what we STORE per SO once replies are flattened in (see below).
// A thread of 30 updates can carry many replies; this keeps the jsonb row
// bounded while still holding far more than any card or prompt reads.
const MAX_ENTRIES_PER_ITEM = 60;
// 50, not 100: nesting replies under every update multiplies Monday's
// query-complexity cost per page. Smaller pages stay well inside the
// budget at the price of one extra round trip on a ~64-item board.
const ITEMS_PER_PAGE = 50;

// Shape of what Monday returns per items_page. Only the fields we care
// about; other fields are ignored.
type MondayItem = {
  id: string;
  name: string;
  updated_at: string | null;
  state: string | null;
  column_values?: Array<{
    id: string;
    text: string | null;
    value?: string | null;
  }>;
  updates?: Array<{
    id: string;
    text_body: string | null;
    created_at: string;
    creator?: { name?: string | null } | null;
    replies?: Array<{
      id: string;
      text_body: string | null;
      created_at: string;
      creator?: { name?: string | null } | null;
    }> | null;
  }>;
};

// One entry in so_monday_activity.updates. Replies are stored as their own
// entries (kind "reply", parent_id = the update they answer) rather than
// nested, so every consumer that sorts by created_at -- the Orders card
// preview, the SO detail feed, the Spanish translation pass (keyed by id),
// and the synthesis inputs + freshness check -- sees the newest dialogue
// without needing to know threads exist.
type StoredEntry = {
  id: string;
  text_body: string;
  created_at: string;
  creator_name: string | null;
  kind: "update" | "reply";
  parent_id: string | null;
};

async function mondayGraphql<T>(token: string, query: string): Promise<T> {
  const res = await fetch(MONDAY_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: token,
      "API-Version": "2024-10",
    },
    body: JSON.stringify({ query }),
  });
  if (!res.ok) {
    throw new Error(`Monday HTTP ${res.status}: ${await res.text()}`);
  }
  const body = (await res.json()) as { data?: T; errors?: unknown };
  if (body.errors) {
    throw new Error(`Monday GraphQL: ${JSON.stringify(body.errors)}`);
  }
  if (!body.data) throw new Error("Monday returned no data");
  return body.data;
}

// Paging a whole board with 30 updates per item takes well over the 10s
// default. 60s is the ceiling on Hobby and comfortably inside Pro's, so
// it is safe on either plan. Without this the cron fails silently on a
// busy board.
export const maxDuration = 60;


// Vercel Cron only ever issues GET. Same work, same auth.
export async function GET(request: Request) {
  return POST(request);
}

export async function POST(request: Request) {
  const started = Date.now();

  // ----- auth ---------------------------------------------------------
  const denied = requireSyncAuth(request, "monday");
  if (denied) return denied;

  // ----- env ----------------------------------------------------------
  const mondayToken = process.env.MONDAY_API_TOKEN;
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!mondayToken || !supabaseUrl || !serviceRoleKey) {
    console.error("Monday sync env vars missing");
    return NextResponse.json(
      { ok: false, error: "server_misconfigured" },
      { status: 500 },
    );
  }
  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false },
  });

  // ----- page through the board --------------------------------------
  const all: MondayItem[] = [];
  let cursor: string | null = null;
  do {
    const cursorArg: string = cursor ? `, cursor: "${cursor}"` : "";
    const query = `query {
      boards(ids: [${MONDAY_BOARD_ID}]) {
        items_page(limit: ${ITEMS_PER_PAGE}${cursorArg}) {
          cursor
          items {
            id
            name
            updated_at
            state
            column_values {
              id
              text
              value
            }
            updates(limit: ${UPDATES_PER_ITEM}) {
              id
              text_body
              created_at
              creator { name }
              replies {
                id
                text_body
                created_at
                creator { name }
              }
            }
          }
        }
      }
    }`;
    let data: {
      boards: Array<{
        items_page: { cursor: string | null; items: MondayItem[] };
      }>;
    };
    try {
      data = await mondayGraphql(mondayToken, query);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("Monday sync failed:", msg);
      return NextResponse.json({ ok: false, error: msg }, { status: 502 });
    }
    const page = data.boards[0]?.items_page;
    if (!page) break;
    all.push(...page.items);
    cursor = page.cursor;
  } while (cursor);

  // ----- shape rows for upsert ---------------------------------------
  const now = new Date().toISOString();
  const rows = all
    .filter((it) => it.name && it.name.trim().length > 0)
    .map((it) => {
      // Find the status column by looking for one whose text is the
      // human-readable status label. Monday's column id for a status
      // column is variable, so we pattern-match rather than hardcode.
      const statusCol = (it.column_values ?? []).find(
        (c) =>
          c.id.startsWith("status") ||
          c.id === "status" ||
          c.id.startsWith("color") ||
          c.id.startsWith("estado"),
      );
      const status = statusCol?.text ?? null;
      let statusColor: string | null = null;
      if (statusCol?.value) {
        try {
          const parsed = JSON.parse(statusCol.value) as {
            color?: string;
            style?: { color?: string };
          };
          statusColor = parsed?.style?.color ?? parsed?.color ?? null;
        } catch {
          // ignore malformed value
        }
      }
      // Monday's conversation lives mostly in REPLIES: a thread started
      // in June can carry this week's answer, and `updates` alone only
      // reports the thread's own created_at. Before 2026-09-21 replies
      // were not fetched at all, so a card could read "25d ago" while the
      // item had a reply from 4 days ago. Flatten, newest first.
      const entries: StoredEntry[] = [];
      for (const u of it.updates ?? []) {
        entries.push({
          id: u.id,
          text_body: u.text_body ?? "",
          created_at: u.created_at,
          creator_name: u.creator?.name ?? null,
          kind: "update",
          parent_id: null,
        });
        for (const r of u.replies ?? []) {
          entries.push({
            id: r.id,
            text_body: r.text_body ?? "",
            created_at: r.created_at,
            creator_name: r.creator?.name ?? null,
            kind: "reply",
            parent_id: u.id,
          });
        }
      }
      const updates = entries
        .sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? ""))
        .slice(0, MAX_ENTRIES_PER_ITEM);
      return {
        so_number: it.name.trim(),
        monday_item_id: Number(it.id),
        monday_url: `https://pharmacenterusa-squad.monday.com/boards/${MONDAY_BOARD_ID}/pulses/${it.id}`,
        status,
        status_color: statusColor,
        item_updated_at: it.updated_at,
        updates,
        last_synced_at: now,
      };
    });

  if (rows.length === 0) {
    return NextResponse.json({
      ok: true,
      items_synced: 0,
      updates_synced: 0,
      elapsed_ms: Date.now() - started,
    });
  }

  const { error: upErr } = await supabase
    .from("so_monday_activity")
    .upsert(rows, { onConflict: "so_number" });
  if (upErr) {
    console.error("so_monday_activity upsert failed:", upErr.message);
    return NextResponse.json(
      { ok: false, error: upErr.message },
      { status: 500 },
    );
  }

  const updatesSynced = rows.reduce((n, r) => n + r.updates.length, 0);
  const repliesSynced = rows.reduce(
    (n, r) => n + r.updates.filter((u) => u.kind === "reply").length,
    0,
  );
  return NextResponse.json({
    ok: true,
    items_synced: rows.length,
    // Total stored entries (updates + replies). replies_synced is the
    // evidence the reply fetch is working -- 0 after a sync means it isn't.
    updates_synced: updatesSynced,
    replies_synced: repliesSynced,
    elapsed_ms: Date.now() - started,
  });
}
