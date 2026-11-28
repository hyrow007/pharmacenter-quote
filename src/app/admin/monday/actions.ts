"use server";

import { revalidatePath } from "next/cache";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { isAdmin } from "@/lib/workflows";
import { liveEnabled, runPush } from "./_lib/push";
import { gql, loadBoardIds, loadBoards, loadLinks, loadMirror, loadRunLog, mondayToken } from "./_lib/load";
import { reconcile } from "./_lib/reconcile";
import { addSoItemsColumn, setupPoBoards } from "./_lib/setup";
import type { EntityKey } from "./_lib/entity";

async function adminDb(): Promise<{ db: ReturnType<typeof createServiceClient>; email: string }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user?.email || !(await isAdmin(supabase, user.email))) throw new Error("admins only");
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("server misconfigured");
  return { db: createServiceClient(url, key, { auth: { persistSession: false } }), email: user.email };
}

/**
 * "Push now" on /admin/monday. Admins only. Live only if MONDAY_PUSH_LIVE=1.
 *
 * The push can only send what is already in the mirror, and the mirror is as
 * old as the last Fishbowl sync. On 2026-11-09 an order issued at 11:40 was
 * pushed twice with nothing to show, because the last sync was 10:00. So a
 * live push now ALSO queues a Fishbowl sync, the same request the header's
 * Sync button makes. The office server picks it up within ~2 minutes, and
 * every successful sync ends with a push, so the new order lands on the board
 * a few minutes later without anyone needing to know the plumbing.
 */
export async function pushNow(formData: FormData): Promise<void> {
  const { db, email } = await adminDb();
  const entity: EntityKey = formData.get("entity") === "po" ? "po" : "so";
  const result = await runPush({ db, trigger: "button", startedBy: email, wantLive: true, entity });
  if (result?.live) await queueSync(db, email);
  revalidatePath("/admin/monday");
}

/** "Add Items column" on the sales-order tab: one-time, admins only. */
export async function addItemsColumn(): Promise<void> {
  await adminDb();
  await addSoItemsColumn();
  revalidatePath("/admin/monday");
}

/** "Create PO boards": one-time, admins only. Safe to press twice. */
export async function createPoBoards(): Promise<void> {
  const { db } = await adminDb();
  await setupPoBoards(db);
  revalidatePath("/admin/monday");
}

// Same guards as POST /api/sync/request: one run at a time, and no new run
// within 3 minutes of a finished one (that data is already fresh).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function queueSync(db: any, email: string): Promise<void> {
  const { data: open } = await db
    .from("sync_requests")
    .select("id")
    .in("status", ["pending", "running"])
    .limit(1);
  if (open && open.length > 0) return;
  const { data: recent } = await db
    .from("sync_requests")
    .select("finished_at")
    .eq("status", "done")
    .order("finished_at", { ascending: false })
    .limit(1);
  const last = recent?.[0]?.finished_at;
  if (last && Date.now() - Date.parse(last) < 3 * 60_000) return;
  const { error } = await db.from("sync_requests").insert({ requested_by: email, status: "pending" });
  if (error) console.error("monday push: sync request failed:", error.message);
}

/**
 * "Archive" beside an item in "On the Open board, not in Fishbowl at all".
 * The push never touches those on its own -- it cannot tell a dead order
 * (e.g. 14790, cancelled before the sync started keeping history) from
 * something a person added by hand. This is the person deciding.
 *
 * Re-checks before writing: the item must still be on this entity's Open
 * board and still match no order in the mirror. Archived, never deleted
 * (restorable in Monday for 30 days), and logged in monday_push_runs.
 */
export async function archiveUnmatched(formData: FormData): Promise<void> {
  const { db, email } = await adminDb();
  const entity: EntityKey = formData.get("entity") === "po" ? "po" : "so";
  const itemId = String(formData.get("itemId") ?? "");
  if (!/^\d+$/.test(itemId)) throw new Error("bad item id");
  if (!liveEnabled(entity)) throw new Error("this board's push is not live");

  const ids = await loadBoardIds(db, entity);
  if (!ids) throw new Error("boards not set up");
  const [mirror, boards, links, runLog] = await Promise.all([
    loadMirror(db, entity),
    loadBoards(ids),
    loadLinks(db, entity),
    loadRunLog(db, entity),
  ]);
  const report = reconcile(mirror, boards.items, links, runLog);
  const target = report.unknownOnOpen.find((r) => r.item?.id === itemId);
  if (!target) throw new Error("that item is no longer unmatched on the Open board");

  const action = { kind: "archive", so: target.so, itemId, lastStatus: "not in Fishbowl" };
  let error: string | null = null;
  try {
    await gql(mondayToken(), `mutation ($i: ID!) { archive_item(item_id: $i) { id } }`, { i: itemId });
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (db as any).from("monday_push_runs").insert({
    entity,
    trigger: "manual",
    dry_run: false,
    mirror_as_of: report.latestRunAt,
    planned: [action],
    applied: error ? [] : [action],
    errors: error ? [{ action, error }] : [],
    started_by: email,
    finished_at: new Date().toISOString(),
  });
  if (error) throw new Error(error);
  revalidatePath("/admin/monday");
}
