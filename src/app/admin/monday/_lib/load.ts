import "server-only";
import type { BoardItem, BoardKey, MirrorRow } from "./reconcile";

// Reads for the reconciler. Both are reads: the mirror through the signed-in
// user's client (RLS applies), the boards through Monday's GraphQL API.
// Nothing here writes anywhere.

export const BOARDS: Record<BoardKey, number> = {
  open: 18389208010, //       "Open Sales Orders" — also read by /api/sync/monday
  fulfilled: 18397259891, //  "Fulfilled Sales Orders"
};

const MONDAY_API_URL = "https://api.monday.com/v2";
const ACCOUNT = "https://pharmacenterusa-squad.monday.com";
const PAGE = 500;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnySupabase = any;

/** Every row in the mirror, paged: PostgREST stops at 1,000 rows per request. */
export async function loadMirror(supabase: AnySupabase): Promise<MirrorRow[]> {
  const out: MirrorRow[] = [];
  const step = 1000;
  for (let from = 0; ; from += step) {
    const { data, error } = await supabase
      .from("fishbowl_sales_orders")
      .select(
        "so_number, status_id, status_name, is_open, customer_name, customer_po, salesman, sync_run_id, synced_at, date_last_modified",
      )
      .order("so_number")
      .range(from, from + step - 1);
    if (error) throw new Error(`mirror read failed: ${error.message}`);
    const rows = (data ?? []) as MirrorRow[];
    out.push(...rows);
    if (rows.length < step) break;
  }
  return out;
}

type RawItem = { id: string; name: string; column_values: { id: string; text: string | null }[] };
type RawPage = { cursor: string | null; items: RawItem[] };

export type Column = { id: string; title: string; type: string };
export type BoardMeta = { boardId: string; groupId: string | null; columns: Column[] };
export type Boards = { items: BoardItem[]; meta: Record<BoardKey, BoardMeta> };

export async function gql<T>(token: string, query: string, variables: Record<string, unknown>): Promise<T> {
  const res = await fetch(MONDAY_API_URL, {
    method: "POST",
    headers: { Authorization: token, "Content-Type": "application/json", "API-Version": "2024-10" },
    body: JSON.stringify({ query, variables }),
    cache: "no-store",
  });
  const raw = await res.text();
  let body: { data?: T; errors?: unknown; error_message?: string };
  try {
    body = JSON.parse(raw);
  } catch {
    throw new Error(`Monday HTTP ${res.status}, not JSON: ${raw.slice(0, 160)}`);
  }
  if (body.errors || !body.data) {
    throw new Error(`Monday: ${JSON.stringify(body.errors ?? body.error_message ?? "no data").slice(0, 300)}`);
  }
  return body.data;
}

const ITEM_FIELDS = `cursor items { id name column_values { id text } }`;

async function loadBoard(token: string, key: BoardKey): Promise<{ items: BoardItem[]; meta: BoardMeta }> {
  const boardId = String(BOARDS[key]);
  const first = await gql<{
    boards: { columns: Column[]; top_group: { id: string } | null; items_page: RawPage }[];
  }>(
    token,
    `query ($b: [ID!]) { boards(ids: $b) { columns { id title type } top_group { id } items_page(limit: ${PAGE}) { ${ITEM_FIELDS} } } }`,
    { b: [boardId] },
  );
  const board = first.boards[0];
  if (!board) throw new Error(`Monday board ${boardId} not found, or the token cannot see it`);

  const titleById = new Map(board.columns.map((c) => [c.id, c.title.trim().toLowerCase()]));
  const raw: RawItem[] = [...board.items_page.items];
  let cursor = board.items_page.cursor;
  while (cursor) {
    const next = await gql<{ next_items_page: RawPage }>(
      token,
      `query ($c: String!) { next_items_page(cursor: $c, limit: ${PAGE}) { ${ITEM_FIELDS} } }`,
      { c: cursor },
    );
    raw.push(...next.next_items_page.items);
    cursor = next.next_items_page.cursor;
  }

  const items = raw.map((it) => {
    const cols: Record<string, string | null> = {};
    for (const cv of it.column_values) {
      const title = titleById.get(cv.id);
      if (title) cols[title] = cv.text;
    }
    return {
      id: it.id,
      name: it.name,
      board: key,
      url: `${ACCOUNT}/boards/${boardId}/pulses/${it.id}`,
      cols,
    };
  });
  return { items, meta: { boardId, groupId: board.top_group?.id ?? null, columns: board.columns } };
}

export function mondayToken(): string {
  const token = process.env.MONDAY_API_TOKEN;
  if (!token) throw new Error("MONDAY_API_TOKEN is not set");
  return token;
}

export async function loadBoards(): Promise<Boards> {
  const token = mondayToken();
  const [open, fulfilled] = await Promise.all([loadBoard(token, "open"), loadBoard(token, "fulfilled")]);
  return { items: [...open.items, ...fulfilled.items], meta: { open: open.meta, fulfilled: fulfilled.meta } };
}

/** monday_so_links, as item id -> SO number, plus the set of linked item ids. */
export async function loadLinks(supabase: AnySupabase): Promise<Map<string, string>> {
  const { data, error } = await supabase
    .from("monday_so_links")
    .select("so_number, monday_item_id")
    .is("archived_at", null);
  if (error) throw new Error(`link table read failed: ${error.message}`);
  const out = new Map<string, string>();
  for (const r of (data ?? []) as { so_number: string; monday_item_id: number }[]) {
    out.set(String(r.monday_item_id), r.so_number);
  }
  return out;
}
