import "server-only";
import { gql, mondayToken } from "./load";
import { MONDAY_WORKSPACE_ID, PO_BOARD_NAMES, PO_COLUMNS } from "./entity";
import type { BoardKey } from "./reconcile";

// One-time: create the two PO boards in the SO boards' workspace, give both
// the same columns (a move maps by title and type, so they must match), and
// record their ids in monday_boards. Re-running is safe: a recorded board is
// reused, and a column that already exists with the right type is not added
// twice. Nothing here touches items.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnySupabase = any;

type Col = { id: string; title: string; type: string };

async function createBoard(token: string, name: string): Promise<string> {
  const q = (empty: boolean) =>
    `mutation ($n: String!, $w: ID) { create_board(board_name: $n, board_kind: public, workspace_id: $w${
      empty ? ", empty: true" : ""
    }) { id } }`;
  const vars = { n: name, w: String(MONDAY_WORKSPACE_ID) };
  try {
    // empty: no sample items. Older API versions reject the argument.
    return (await gql<{ create_board: { id: string } }>(token, q(true), vars)).create_board.id;
  } catch {
    return (await gql<{ create_board: { id: string } }>(token, q(false), vars)).create_board.id;
  }
}

async function ensureColumns(token: string, boardId: string): Promise<void> {
  const res = await gql<{ boards: { columns: Col[] }[] }>(
    token,
    `query ($b: [ID!]) { boards(ids: $b) { columns { id title type } } }`,
    { b: [boardId] },
  );
  const have = res.boards[0]?.columns ?? [];
  for (const want of PO_COLUMNS) {
    const exists = have.some(
      (c) => c.title.trim().toLowerCase() === want.title.toLowerCase() && c.type === want.type,
    );
    if (exists) continue;
    await gql(
      token,
      `mutation ($b: ID!, $t: String!) { create_column(board_id: $b, title: $t, column_type: ${want.type}) { id } }`,
      { b: boardId, t: want.title },
    );
  }
}

export async function setupPoBoards(db: AnySupabase): Promise<Record<BoardKey, string>> {
  const token = mondayToken();
  const { data } = await db.from("monday_boards").select("role, board_id").eq("entity", "po");
  const ids: Partial<Record<BoardKey, string>> = {};
  for (const r of (data ?? []) as { role: BoardKey; board_id: number }[]) ids[r.role] = String(r.board_id);

  for (const role of ["open", "fulfilled"] as BoardKey[]) {
    if (!ids[role]) {
      const id = await createBoard(token, PO_BOARD_NAMES[role]);
      const { error } = await db
        .from("monday_boards")
        .upsert({ entity: "po", role, board_id: Number(id) }, { onConflict: "entity,role" });
      if (error) throw new Error(`created board ${id} but could not record it: ${error.message}`);
      ids[role] = id;
    }
    await ensureColumns(token, ids[role] as string);
  }
  return ids as Record<BoardKey, string>;
}
