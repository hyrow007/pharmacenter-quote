"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { isAdmin } from "@/lib/workflows";

// /admin/overhead's two writes. Both go through SQL functions that check admin
// themselves and run in one transaction; this file only gates and redirects.
// Outcomes come back as ?cap=… so the page can say what happened.

async function gate() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user?.email || !(await isAdmin(supabase, user.email))) throw new Error("admins only");
  return supabase;
}

function done(outcome: string, detail?: string): never {
  revalidatePath("/admin/overhead");
  const q = new URLSearchParams({ cap: outcome });
  if (detail) q.set("d", detail.slice(0, 300));
  redirect(`/admin/overhead?${q}#capacity`);
}

/** "Measure now": a fresh 6-month measurement from Yields, as a proposal. */
export async function measureNow(): Promise<void> {
  const supabase = await gate();
  const { error } = await supabase.rpc("overhead_capacity_propose", { p_trigger: "button", p_months: 6 });
  if (error) done("error", error.message);
  done("measured");
}

/** Approve or reject the pending proposal. */
export async function decide(form: FormData): Promise<void> {
  const supabase = await gate();
  const id = String(form.get("id") ?? "");
  const approve = form.get("verdict") === "approve";
  const note = String(form.get("note") ?? "");
  if (!id) done("error", "missing proposal");
  const { data, error } = await supabase.rpc("overhead_capacity_decide", {
    p_id: id,
    p_approve: approve,
    p_note: note,
  });
  if (error) done("error", error.message);
  done(String(data ?? (approve ? "approved" : "rejected")));
}
