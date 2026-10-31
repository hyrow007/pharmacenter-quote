import "server-only";
import { gql, loadBoards, loadLinks, loadMirror, mondayToken, type BoardMeta, type Column } from "./load";
import { reconcile, type BoardItem, type BoardKey, type Report } from "./reconcile";
import { mondayWrites, plan, type Action, type Values } from "./plan";

// Carries out the push plan. One function, used by the cron-style route
// (/api/monday/push, called by the office server after each Fishbowl sync) and
// by the "Push now" button on /admin/monday.
//
// LIVE WRITES NEED TWO THINGS: the caller asking for live, AND the Vercel env
// var MONDAY_PUSH_LIVE=1. Until that var is set, every run is a dry run: it
// plans, records the plan in monday_push_runs, and writes nothing to Monday.
//
// A run REFUSES to write (and says why) when the inputs look wrong, because the
// cost of a bad push is archiving or moving real items:
//   - the mirror is empty, or its last sync is over 26 hours old
//   - the mirror holds no fulfilled orders (office sync older than 5c192bf, so
//     fulfilled and cancelled cannot be told apart)
//   - the link table cannot be read
//   - the plan has more than MAX_WRITES Monday writes

export const MAX_WRITES = 60;
const STALE_HOURS = 26;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnySupabase = any;

export type Trigger = "schedule" | "button" | "manual";

export type PushResult = {
  runId: string | null;
  live: boolean;
  refused: string | null;
  report: Report;
  actions: Action[];
  applied: Action[];
  errors: { action: Action; error: string }[];
  movesDrop: string[]; // moves blocked: "SO: column" pairs that would lose a value
};

/**
 * A move maps each Open-board column to the same-titled Fulfilled column.
 * Columns with no counterpart are dropped by Monday. That only matters when
 * the item actually holds something there, so check per item: an empty
 * "Subelementos" on an item with no subitems loses nothing.
 */
export function moveLosses(
  actions: Action[],
  items: BoardItem[],
  dropTitles: string[],
): string[] {
  const byId = new Map(items.map((i) => [i.id, i]));
  const out: string[] = [];
  for (const a of actions) {
    if (a.kind !== "move") continue;
    const item = byId.get(a.itemId);
    for (const title of dropTitles) {
      const v = item?.cols[title.trim().toLowerCase()];
      if (v && v.trim()) out.push(`${a.so}: ${title}`);
    }
  }
  return out;
}

export function liveEnabled(): boolean {
  return process.env.MONDAY_PUSH_LIVE === "1";
}

function colByTitle(meta: BoardMeta): Map<string, Column> {
  return new Map(meta.columns.map((c) => [c.title.trim().toLowerCase(), c]));
}

/** Monday's column_values JSON for our three text-like columns. */
export function encode(values: Values, meta: BoardMeta): Record<string, unknown> {
  const cols = colByTitle(meta);
  const out: Record<string, unknown> = {};
  for (const [title, value] of Object.entries(values)) {
    if (value === undefined || value === "") continue;
    const c = cols.get(title);
    if (!c) continue; // that board has no such column
    switch (c.type) {
      case "text":
        out[c.id] = value;
        break;
      case "long_text":
        out[c.id] = { text: value };
        break;
      case "status":
        out[c.id] = { label: value };
        break;
      case "dropdown":
        out[c.id] = { labels: [value] };
        break;
      default:
        throw new Error(`column "${c.title}" is a ${c.type} column; the push only writes text, status and dropdown`);
    }
  }
  return out;
}

/**
 * Column mapping for moving an item from Open to Fulfilled: same title, same
 * type. Monday drops whatever is mapped to null, so `drops` is reported in the
 * dry run before any move is allowed to happen.
 */
export function moveMapping(open: BoardMeta, fulfilled: BoardMeta) {
  const target = colByTitle(fulfilled);
  const mapping: { source: string; target: string | null }[] = [];
  const drops: string[] = [];
  for (const c of open.columns) {
    if (c.id === "name") continue;
    const t = target.get(c.title.trim().toLowerCase());
    if (t && t.type === c.type) mapping.push({ source: c.id, target: t.id });
    else {
      mapping.push({ source: c.id, target: null });
      if (c.type !== "formula") drops.push(c.title);
    }
  }
  return { mapping, drops };
}

export async function runPush(opts: {
  db: AnySupabase; // service-role client: it writes links and the run log
  trigger: Trigger;
  startedBy: string | null;
  wantLive: boolean;
}): Promise<PushResult> {
  const { db } = opts;
  const live = opts.wantLive && liveEnabled();

  const [mirror, boards] = await Promise.all([loadMirror(db), loadBoards()]);
  let links = new Map<string, string>();
  let refused: string | null = null;
  try {
    links = await loadLinks(db);
  } catch (e) {
    refused = `link table unavailable (${e instanceof Error ? e.message : e})`;
  }

  const report = reconcile(mirror, boards.items, links);
  const actions = plan(report, new Set(links.keys()));
  const { mapping, drops } = moveMapping(boards.meta.open, boards.meta.fulfilled);
  const losses = moveLosses(actions, boards.items, drops);

  const ageH = report.latestRunAt ? (Date.now() - Date.parse(report.latestRunAt)) / 3.6e6 : Infinity;
  if (!refused && mirror.length === 0) refused = "the Fishbowl mirror is empty";
  if (!refused && ageH > STALE_HOURS) refused = `the Fishbowl data is ${Math.round(ageH)} hours old`;
  if (!refused && report.fulfilledInMirror === 0)
    refused = "the mirror holds no fulfilled orders, so fulfilled and cancelled cannot be told apart";
  if (!refused && mondayWrites(actions) > MAX_WRITES)
    refused = `${mondayWrites(actions)} Monday writes planned; the limit is ${MAX_WRITES}`;

  const { data: runRow } = await db
    .from("monday_push_runs")
    .insert({
      trigger: opts.trigger,
      dry_run: !live,
      mirror_as_of: report.latestRunAt,
      planned: actions,
      refused,
      started_by: opts.startedBy,
    })
    .select("id")
    .single();
  const runId: string | null = runRow?.id ?? null;

  const applied: Action[] = [];
  const errors: { action: Action; error: string }[] = [];

  if (live && !refused) {
    const token = mondayToken();
    const meta = boards.meta;
    const link = async (row: Record<string, unknown>) => {
      const { error } = await db.from("monday_so_links").upsert(row, { onConflict: "so_number" });
      if (error) throw new Error(`link write failed: ${error.message}`);
    };

    for (const a of actions) {
      try {
        switch (a.kind) {
          case "link":
            await link({ so_number: a.so, monday_item_id: Number(a.itemId), board: a.board, linked_by: "adopted", archived_at: null });
            break;
          case "create": {
            const res = await gql<{ create_item: { id: string } }>(
              token,
              `mutation ($b: ID!, $g: String, $n: String!, $v: JSON) { create_item(board_id: $b, group_id: $g, item_name: $n, column_values: $v) { id } }`,
              { b: meta.open.boardId, g: meta.open.groupId, n: a.so, v: JSON.stringify(encode(a.values, meta.open)) },
            );
            await link({ so_number: a.so, monday_item_id: Number(res.create_item.id), board: "open", linked_by: "created", archived_at: null });
            break;
          }
          case "move": {
            const lost = losses.filter((l) => l.startsWith(`${a.so}: `));
            if (lost.length > 0) throw new Error(`move would lose: ${lost.join(", ")}`);
            if (!meta.fulfilled.groupId) throw new Error("Fulfilled board has no group");
            await gql(
              token,
              `mutation ($b: ID!, $g: ID!, $i: ID!, $m: [ColumnMappingInput!]) { move_item_to_board(board_id: $b, group_id: $g, item_id: $i, columns_mapping: $m) { id } }`,
              { b: meta.fulfilled.boardId, g: meta.fulfilled.groupId, i: a.itemId, m: mapping },
            );
            await link({ so_number: a.so, monday_item_id: Number(a.itemId), board: "fulfilled", linked_by: "adopted", archived_at: null });
            break;
          }
          case "archive":
            await gql(token, `mutation ($i: ID!) { archive_item(item_id: $i) { id } }`, { i: a.itemId });
            await link({ so_number: a.so, monday_item_id: Number(a.itemId), board: "open", linked_by: "adopted", archived_at: new Date().toISOString() });
            break;
          case "rename":
          case "update": {
            const m = meta[a.board as BoardKey];
            const values = a.kind === "rename" ? { name: a.so } : encode(a.values, m);
            if (Object.keys(values).length === 0) break;
            await gql(
              token,
              `mutation ($b: ID!, $i: ID!, $v: JSON!) { change_multiple_column_values(board_id: $b, item_id: $i, column_values: $v) { id } }`,
              { b: m.boardId, i: a.itemId, v: JSON.stringify(values) },
            );
            break;
          }
        }
        applied.push(a);
      } catch (e) {
        errors.push({ action: a, error: e instanceof Error ? e.message : String(e) });
      }
    }
  }

  if (runId) {
    await db
      .from("monday_push_runs")
      .update({ finished_at: new Date().toISOString(), applied, errors })
      .eq("id", runId);
  }

  return { runId, live, refused, report, actions, applied, errors, movesDrop: losses };
}
