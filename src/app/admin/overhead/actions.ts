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
  const verdict = form.get("verdict");
  if (verdict !== "approve" && verdict !== "reject") done("error", "no decision received, nothing changed; try again");
  const approve = verdict === "approve";
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
  const verdict = form.get("verdict");
  if (verdict !== "approve" && verdict !== "reject") qboDone("error", "no decision received, nothing changed; try again");
  const approve = verdict === "approve";
  const note = String(form.get("note") ?? "");
  if (!id) qboDone("error", "missing proposal");
  const items = form.getAll("item").map(String).filter(Boolean);
  if (approve && !items.length) qboDone("error", "tick at least one line to approve");
  const { data, error } = await supabase.rpc("overhead_expense_decide", {
    p_id: id,
    p_approve: approve,
    p_note: note,
    p_items: approve ? items : null,
  });
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

/** Which QuickBooks accounts are billed yearly and get a 12-month average. */
export async function qboSetAnnual(form: FormData): Promise<void> {
  const { supabase, email } = await adminWithEmail();
  const list = String(form.get("accounts") ?? "")
    .split(/[\s,;]+/)
    .map((x) => x.trim())
    .filter(Boolean);
  if (list.some((x) => !/^[0-9][0-9.]*$/.test(x))) qboDone("error", "account numbers only, separated by commas");
  const { error } = await supabase.from("overhead_settings").upsert({
    key: "qbo_annual_accounts",
    value_text: list.join(","),
    notes: "QuickBooks account numbers billed yearly (or in a few large installments): averaged over 12 reconciled months instead of 6. Comma-separated.",
    updated_at: new Date().toISOString(),
    updated_by_email: email,
  });
  if (error) qboDone("error", error.message);
  qboDone("annual", list.join(", ") || "—");
}

// ------------------------------------------------------------------
// Hand-made changes: propose, then approve or reject (the proposer may
// approve their own — operator decision 2026-11-08). Outcomes: ?man=…
// ------------------------------------------------------------------

function manDone(outcome: string, detail?: string): never {
  revalidatePath("/admin/overhead");
  const q = new URLSearchParams({ man: outcome });
  if (detail) q.set("d", detail.slice(0, 300));
  redirect(`/admin/overhead?${q}#changes`);
}

const BAND_FIELDS = ["monthly", "cam", "cam_estimated", "pay_type", "rate", "qty", "hours", "tax_pct", "wc_pct"] as const;

/** Propose new figures for one rent / labour / expense item, from a date. */
export async function manualProposeBand(form: FormData): Promise<void> {
  const supabase = await gate();
  const values: Record<string, string> = {};
  for (const k of BAND_FIELDS) {
    const v = String(form.get(k) ?? "").replace(/[$,\s%]/g, "");
    if (v) values[k] = v;
  }
  if (form.get("cam_estimated_set") === "1") values.cam_estimated = form.get("cam_estimated") === "on" ? "true" : "false";
  const { error } = await supabase.rpc("overhead_manual_propose", {
    p_kind: "band",
    p_item_key: String(form.get("item") ?? ""),
    p_from: String(form.get("from") ?? "") || null,
    p_values: values,
    p_source: String(form.get("source") ?? ""),
    p_reason: String(form.get("reason") ?? ""),
  });
  if (error) manDone("error", error.message.replace(/^overhead: /, ""));
  manDone("proposed");
}

export async function manualProposeLead(form: FormData): Promise<void> {
  const supabase = await gate();
  const { error } = await supabase.rpc("overhead_manual_propose", {
    p_kind: "lead_days",
    p_values: { days: String(form.get("days") ?? "").trim() },
    p_reason: String(form.get("reason") ?? ""),
  });
  if (error) manDone("error", error.message.replace(/^overhead: /, ""));
  manDone("proposed");
}

export async function manualProposeShare(form: FormData): Promise<void> {
  const supabase = await gate();
  const { error } = await supabase.rpc("overhead_manual_propose", {
    p_kind: "share",
    p_item_key: String(form.get("item") ?? ""),
    p_line_key: String(form.get("line") ?? ""),
    p_values: { share_pct: String(form.get("share") ?? "").replace(/[%\s]/g, "") },
    p_reason: String(form.get("reason") ?? ""),
  });
  if (error) manDone("error", error.message.replace(/^overhead: /, ""));
  manDone("proposed");
}

export async function manualDecide(form: FormData): Promise<void> {
  const supabase = await gate();
  const id = String(form.get("id") ?? "");
  const verdict = form.get("verdict");
  if (verdict !== "approve" && verdict !== "reject") manDone("error", "no decision received, nothing changed; try again");
  if (!id) manDone("error", "missing proposal");
  const { data, error } = await supabase.rpc("overhead_manual_decide", {
    p_id: id,
    p_approve: verdict === "approve",
    p_note: String(form.get("note") ?? ""),
  });
  if (error) manDone("error", error.message.replace(/^overhead: /, ""));
  manDone(String(data ?? verdict));
}
