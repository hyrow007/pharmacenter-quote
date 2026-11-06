"use server";

// Address-book import: preview, then commit. Admins only. The preview is
// re-derived from the same CSV text on commit -- the browser sends back only
// which rows to include and the kind chosen for each, never the row data.

import { revalidatePath } from "next/cache";
import { shipGate } from "../_lib/gate";
import { rowsFromFedexExport, type ImportRow, type MatchLists } from "../_lib/fedexCsv";
import { RECIPIENT_KINDS, type RecipientKind } from "../_lib/draft";

const MAX_BYTES = 2_000_000;

async function lists(sb: Awaited<ReturnType<typeof shipGate>> & { ok: true }): Promise<MatchLists | string> {
  const [c, v, e] = await Promise.all([
    sb.supabase.from("customers").select("id, name").eq("active", true).limit(5000),
    sb.supabase.from("vendors").select("id, name").eq("active", true).limit(5000),
    sb.supabase.from("shipping_recipients").select("id, company, contact_name, street_lines, postal_code").is("archived_at", null).limit(10000),
  ]);
  const err = c.error ?? v.error ?? e.error;
  if (err) return err.message;
  return {
    customers: (c.data ?? []) as MatchLists["customers"],
    vendors: (v.data ?? []) as MatchLists["vendors"],
    existing: (e.data ?? []) as MatchLists["existing"],
  };
}

export type PreviewResult = { ok: true; rows: ImportRow[] } | { ok: false; error: string };

export async function previewImport(csv: string): Promise<PreviewResult> {
  const g = await shipGate();
  if (!g.ok) return { ok: false, error: g.error };
  if (!g.admin) return { ok: false, error: "not_admin" };
  if (typeof csv !== "string" || csv.length > MAX_BYTES) return { ok: false, error: "too_large" };
  const l = await lists(g);
  if (typeof l === "string") return { ok: false, error: l };
  const { rows, error } = rowsFromFedexExport(csv, l);
  if (error) return { ok: false, error };
  return { ok: true, rows };
}

export type CommitResult = { ok: true; inserted: number; skipped: number } | { ok: false; error: string };

export async function commitImport(
  csv: string,
  choices: Array<{ key: string; include: boolean; kind: RecipientKind }>,
): Promise<CommitResult> {
  const g = await shipGate();
  if (!g.ok) return { ok: false, error: g.error };
  if (!g.admin) return { ok: false, error: "not_admin" };
  if (typeof csv !== "string" || csv.length > MAX_BYTES) return { ok: false, error: "too_large" };
  const l = await lists(g);
  if (typeof l === "string") return { ok: false, error: l };
  const { rows, error } = rowsFromFedexExport(csv, l);
  if (error) return { ok: false, error };

  const byKey = new Map(choices.map((c) => [c.key, c]));
  const now = new Date().toISOString();
  const insert = rows
    .filter((r) => {
      const c = byKey.get(r.key);
      // Re-checked here: a duplicate or a row with problems never goes in.
      return c?.include && !r.duplicateOf && r.problems.length === 0;
    })
    .map((r) => {
      const chosen = byKey.get(r.key)!.kind;
      return {
        kind: RECIPIENT_KINDS.includes(chosen) ? chosen : r.kind,
        company: r.company,
        contact_name: r.contactName,
        phone: r.phone,
        email: r.email,
        street_lines: r.streetLines,
        city: r.city,
        state_province: r.stateProvince,
        postal_code: r.postalCode,
        country_code: r.countryCode,
        residential: r.residential,
        validated_at: null,
        customer_id: r.customerId,
        vendor_id: r.vendorId,
        bill_to_account: r.billToAccount,
        notes: [r.notes, `Imported from fedex.com ${now.slice(0, 10)}`].filter(Boolean).join(" · "),
        created_by: g.email,
      };
    });
  if (!insert.length) return { ok: true, inserted: 0, skipped: rows.length };
  const { error: insErr } = await g.service.from("shipping_recipients").insert(insert);
  if (insErr) return { ok: false, error: insErr.message };
  revalidatePath("/shipping");
  return { ok: true, inserted: insert.length, skipped: rows.length - insert.length };
}
