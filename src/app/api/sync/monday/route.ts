import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

// POST /api/sync/monday
//
// Pulls every item on the Monday "Open Sales Orders" board (id
// 18389208010) plus its most recent Updates and upserts them into
// public.so_monday_activity. The meetings hub reads from that cache so
// page renders never hit Monday's API directly.
//
// Auth: same pattern as /api/sync/sales-orders — bearer token in the
// Authorization header. Set FISHBOWL_SYNC_SECRET-style
// SYNC_SHARED_SECRET or accept the Vercel-side PLAUD_SYNC_SECRET as a
// generic sync bearer. Using PLAUD_SYNC_SECRET here to avoid adding
// another env var for the same job.
//
// Data source: Monday GraphQL v2. Requires MONDAY_API_TOKEN in env.
//
// Response: { ok, items_synced, updates_synced, elapsed_ms }.

export const runtime = "nodejs"; // service-role + fetch to external API

const MONDAY_BOARD_ID = 18389208010;
const MONDAY_API_URL = "https://api.monday.com/v2";
const UPDATES_PER_ITEM = 5;
const ITEMS_PER_PAGE = 100;

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
  }>;
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

export async function POST(request: Request) {
  const started = Date.now();

  // ----- auth ---------------------------------------------------------
  const expected = process.env.PLAUD_SYNC_SECRET; // reusing the shared sync bearer
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
      const updates = (it.updates ?? []).map((u) => ({
        id: u.id,
        text_body: u.text_body ?? "",
        created_at: u.created_at,
        creator_name: u.creator?.name ?? null,
      }));
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
  return NextResponse.json({
    ok: true,
    items_synced: rows.length,
    updates_synced: updatesSynced,
    elapsed_ms: Date.now() - started,
  });
}
