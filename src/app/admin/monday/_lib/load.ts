import "server-only";
import type { BoardItem, BoardKey, MirrorRow } from "./reconcile";
import { ENTITIES, type EntityKey } from "./entity";
import { easternDate } from "./plan";

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

const SO_SELECT =
  "so_number, status_id, status_name, is_open, customer_name, customer_po, vendor_po, date_completed, salesman, items, sync_run_id, synced_at, date_last_modified";
const PO_SELECT =
  "po_number, status_id, status_name, is_open, vendor_name, buyer, so_numbers, items, date_issued, date_completed, sync_run_id, synced_at, date_last_modified";

type PoItem = {
  line?: number | null;
  product_num?: string | null;
  description?: string | null;
  qty_ordered?: number | null;
  qty_fulfilled?: number | null;
};

/** One line per PO item: "500 · PC-RM-0135 · Gelatin 200 Bloom (received 200)". */
export function poItemLines(items: unknown): string {
  if (!Array.isArray(items)) return "";
  return (items as PoItem[])
    .slice()
    .sort((a, b) => (a.line ?? 0) - (b.line ?? 0))
    .map((it) => {
      const qty = typeof it.qty_ordered === "number" ? it.qty_ordered.toLocaleString("en-US") : "";
      const got =
        typeof it.qty_fulfilled === "number" && it.qty_fulfilled > 0 && it.qty_fulfilled !== it.qty_ordered
          ? ` (received ${it.qty_fulfilled.toLocaleString("en-US")})`
          : "";
      return [qty, it.product_num ?? "", it.description ?? ""].filter(Boolean).join(" · ") + got;
    })
    .filter(Boolean)
    .join("\n");
}

type SoItem = PoItem & { type_id?: number | null; uom?: string | null; uom_name?: string | null };

// Fishbowl SO line types that are not products: discounts, subtotals,
// associated prices, shipping, tax, notes.
const SO_NON_PRODUCT_TYPES = new Set([30, 31, 40, 50, 60, 70, 90]);

/** One line per product on an SO: "5,000 ea · 1928 · Omega 3 Softgels (shipped 2,000)". */
export function soItemLines(items: unknown): string {
  if (!Array.isArray(items)) return "";
  return (items as SoItem[])
    .filter((it) => !(typeof it.type_id === "number" && SO_NON_PRODUCT_TYPES.has(it.type_id)))
    .filter((it) => it.product_num || it.description)
    .slice()
    .sort((a, b) => (a.line ?? 0) - (b.line ?? 0))
    .map((it) => {
      // In PharmaCenter's Fishbowl a line in "Unit" (uom "un") counts
      // thousands of finished pieces: 0.024 un is 24 pieces. Show pieces.
      const perThousand = (it.uom ?? "").toLowerCase() === "un";
      const k = perThousand ? 1000 : 1;
      const fmt = (n: number) => Math.round(n * k * 1000) / 1000;
      const unit = perThousand ? "ea" : it.uom ?? "";
      const qty =
        typeof it.qty_ordered === "number"
          ? [fmt(it.qty_ordered).toLocaleString("en-US"), unit].filter(Boolean).join(" ")
          : "";
      const shipped =
        typeof it.qty_fulfilled === "number" && it.qty_fulfilled > 0 && it.qty_fulfilled !== it.qty_ordered
          ? ` (shipped ${fmt(it.qty_fulfilled).toLocaleString("en-US")})`
          : "";
      return [qty, it.product_num ?? "", it.description ?? ""].filter(Boolean).join(" · ") + shipped;
    })
    .join("\n");
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toRow(entity: EntityKey, r: any): MirrorRow {
  if (entity === "so") {
    return {
      ...r,
      fields: {
        customer: r.customer_name,
        "customer po": r.customer_po,
        "vendor po": r.vendor_po,
        owner: r.salesman,
        // Only written and compared once the board has an "Items" column
        // (added from /admin/monday, 2026-11-09).
        items: soItemLines(r.items) || null,
      },
    } as MirrorRow;
  }
  return {
    so_number: r.po_number,
    status_id: r.status_id,
    status_name: r.status_name,
    is_open: r.is_open,
    customer_name: r.vendor_name, // shown in the report's name column
    customer_po: null,
    vendor_po: null,
    date_completed: r.date_completed,
    salesman: r.buyer,
    sync_run_id: r.sync_run_id,
    synced_at: r.synced_at,
    date_last_modified: r.date_last_modified,
    fields: {
      vendor: r.vendor_name,
      "linked sos": Array.isArray(r.so_numbers) ? r.so_numbers.join(", ") : null,
      "issue date": easternDate(r.date_issued) || null,
      items: poItemLines(r.items) || null,
    },
  };
}

/** Every row in the mirror, paged: PostgREST stops at 1,000 rows per request. */
export async function loadMirror(supabase: AnySupabase, entity: EntityKey = "so"): Promise<MirrorRow[]> {
  const spec = ENTITIES[entity];
  const out: MirrorRow[] = [];
  const step = 1000;
  for (let from = 0; ; from += step) {
    const { data, error } = await supabase
      .from(spec.mirrorTable)
      .select(entity === "so" ? SO_SELECT : PO_SELECT)
      .order(spec.numberColumn)
      .range(from, from + step - 1);
    if (error) throw new Error(`mirror read failed: ${error.message}`);
    const rows = (data ?? []) as unknown[];
    out.push(...rows.map((r) => toRow(entity, r)));
    if (rows.length < step) break;
  }
  return out;
}

/**
 * Board ids per entity. Sales orders are fixed; the PO boards were created by
 * the "Create PO boards" button on /admin/monday and recorded in
 * monday_boards. Null until that has been done.
 */
export async function loadBoardIds(
  supabase: AnySupabase,
  entity: EntityKey,
): Promise<Record<BoardKey, string> | null> {
  if (entity === "so") return { open: String(BOARDS.open), fulfilled: String(BOARDS.fulfilled) };
  const { data, error } = await supabase.from("monday_boards").select("role, board_id").eq("entity", entity);
  if (error) throw new Error(`monday_boards read failed: ${error.message}`);
  const ids: Partial<Record<BoardKey, string>> = {};
  for (const r of (data ?? []) as { role: BoardKey; board_id: number }[]) ids[r.role] = String(r.board_id);
  return ids.open && ids.fulfilled ? (ids as Record<BoardKey, string>) : null;
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

async function loadBoard(token: string, key: BoardKey, boardId: string): Promise<{ items: BoardItem[]; meta: BoardMeta }> {
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

export async function loadBoards(
  ids: Record<BoardKey, string> = { open: String(BOARDS.open), fulfilled: String(BOARDS.fulfilled) },
): Promise<Boards> {
  const token = mondayToken();
  const [open, fulfilled] = await Promise.all([
    loadBoard(token, "open", ids.open),
    loadBoard(token, "fulfilled", ids.fulfilled),
  ]);
  return { items: [...open.items, ...fulfilled.items], meta: { open: open.meta, fulfilled: fulfilled.meta } };
}

/** The entity's link table, as Monday item id -> order number. */
export async function loadLinks(supabase: AnySupabase, entity: EntityKey = "so"): Promise<Map<string, string>> {
  const spec = ENTITIES[entity];
  const { data, error } = await supabase
    .from(spec.linkTable)
    .select(`${spec.numberColumn}, monday_item_id`)
    .is("archived_at", null);
  if (error) throw new Error(`link table read failed: ${error.message}`);
  const out = new Map<string, string>();
  for (const r of (data ?? []) as Record<string, string | number>[]) {
    out.set(String(r.monday_item_id), String(r[spec.numberColumn]));
  }
  return out;
}
