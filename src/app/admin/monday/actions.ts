"use server";

import { revalidatePath } from "next/cache";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { isAdmin } from "@/lib/workflows";
import { runPush } from "./_lib/push";

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
export async function pushNow(): Promise<void> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user?.email || !(await isAdmin(supabase, user.email))) throw new Error("admins only");

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("server misconfigured");
  const db = createServiceClient(url, key, { auth: { persistSession: false } });

  const result = await runPush({ db, trigger: "button", startedBy: user.email, wantLive: true });
  if (result.live) await queueSync(db, user.email);
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
