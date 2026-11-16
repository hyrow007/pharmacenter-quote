"use server";

// Save available capacity (kpi_capacity_lines). Writes through the signed-in
// user's own session: RLS allows @pharmacenterusa.com staff to update, and
// updated_by records who changed it.

import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { CAP_LINES } from "../_lib/capacity";

function num(v: FormDataEntryValue | null, max: number): number | null | "bad" {
  const s = typeof v === "string" ? v.trim() : "";
  if (s === "") return null;
  const n = Number(s);
  if (!Number.isFinite(n) || n < 0 || n > max) return "bad";
  return n;
}

export async function saveCapacity(form: FormData): Promise<void> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  const host = (await headers()).get("host") ?? "";
  const base = host.startsWith("kpi.") || host.startsWith("kpis.") ? "/capacity" : "/kpi/capacity";
  if (!user?.email?.endsWith("@pharmacenterusa.com")) redirect(base);

  const now = new Date().toISOString();
  const rows: Record<string, unknown>[] = [];
  for (const line of CAP_LINES) {
    const machines = num(form.get(`machines_${line}`), 100);
    const days = num(form.get(`days_${line}`), 31);
    if (machines === "bad" || days === "bad") redirect(`${base}?err=${encodeURIComponent(line)}`);
    rows.push({ line_key: line, machines: machines === null ? null : Math.round(machines as number), days_per_month: days, updated_by: user!.email, updated_at: now });
  }
  const low = num(form.get("band_low"), 100);
  const high = num(form.get("band_high"), 100);
  if (low === "bad" || high === "bad" || (low !== null && high !== null && (low as number) >= (high as number))) {
    redirect(`${base}?err=band`);
  }
  rows.push({ line_key: "ALL", band_low: low, band_high: high, updated_by: user!.email, updated_at: now });

  for (const r of rows) {
    const { line_key, ...rest } = r;
    const { error } = await supabase.from("kpi_capacity_lines").update(rest).eq("line_key", line_key as string);
    if (error) redirect(`${base}?err=${encodeURIComponent(error.message)}`);
  }
  redirect(`${base}?saved=1`);
}
