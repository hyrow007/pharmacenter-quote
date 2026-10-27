"use server";

import { revalidatePath } from "next/cache";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { isAdmin } from "@/lib/workflows";
import { runPush } from "./_lib/push";

/** "Push now" on /admin/monday. Admins only. Live only if MONDAY_PUSH_LIVE=1. */
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

  await runPush({ db, trigger: "button", startedBy: user.email, wantLive: true });
  revalidatePath("/admin/monday");
}
