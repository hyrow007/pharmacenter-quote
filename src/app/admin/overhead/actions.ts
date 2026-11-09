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

// ------------------------------------------------------------------
// QuickBooks: disconnect, pull now, approve/reject an expense proposal.
// Outcomes come back as ?qbo=… so the page can say what happened.
// ------------------------------------------------------------------

function qboDone(outcome: string, detail?: string): never {
  revalidatePath("/admin/overhead");
  const q = new URLSearchParams({ qbo: outcome });
  if (detail) q.set("d", detail.slice(0, 300));
  redirect(`/admin/overhead?${q}#quickbooks`);
}

async function adminWithEmail() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user?.email || !(await isAdmin(supabase, user.email))) throw new Error("admins only");
  return { supabase, email: user.email };
}

export async function qboDisconnect(): Promise<void> {
  const { email } = await adminWithEmail();
  const { disconnect, serviceDb } = await import("./_lib/qbo");
  try {
    await disconnect(serviceDb(), email);
  } catch (e) {
    qboDone("error", (e as Error).message);
  }
  qboDone("disconnected_here");
}

export async function qboPullNow(): Promise<void> {
  const { supabase, email } = await adminWithEmail();
  const { pullExpenses } = await import("./_lib/expenses");
  try {
    await pullExpenses(supabase, "button", email);
  } catch (e) {
    qboDone("error", (e as Error).message);
  }
  qboDone("pulled");
}

export async function qboDecide(form: FormData): Promise<void> {
  const { supabase } = await adminWithEmail();
  const id = String(form.get("id") ?? "");
  const approve = form.get("verdict") === "approve";
  const note = String(form.get("note") ?? "");
  if (!id) qboDone("error", "missing proposal");
  const { data, error } = await supabase.rpc("overhead_expense_decide", { p_id: id, p_approve: approve, p_note: note });
  if (error) qboDone("error", error.message);
  const r = String(data ?? "");
  if (r === "stale") qboDone("stale");
  if (r.startsWith("approved")) qboDone("approved", r.split(":")[1] ?? "0");
  qboDone("rejected");
}

/** "Books reconciled through" (YYYY-MM). The QuickBooks average ends at this month. */
export async function qboSetReconciled(form: FormData): Promise<void> {
  const { supabase, email } = await adminWithEmail();
  const v = String(form.get("month") ?? "").trim();
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(v)) qboDone("error", "pick a month");
  const { error } = await supabase.from("overhead_settings").upsert({
    key: "qbo_reconciled_through",
    value_text: v,
    notes: "Last month (YYYY-MM) whose books are reconciled. QuickBooks expense averages end here.",
    updated_at: new Date().toISOString(),
    updated_by_email: email,
  });
  if (error) qboDone("error", error.message);
  qboDone("reconciled", v);
}
