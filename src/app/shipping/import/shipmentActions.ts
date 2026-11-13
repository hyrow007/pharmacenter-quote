"use server";

// fedex.com shipment report import. Admins only. The browser reads the .xlsx
// into a table of strings (no spreadsheet code runs on the server); this
// re-validates every cell, groups boxes into shipments, and upserts on the
// master tracking number, so the same report can be uploaded any number of
// times. Writes with the service role -- RLS lets signed-in people only read.

import { revalidatePath } from "next/cache";
import { shipGate } from "../_lib/gate";
import { shipmentsFromReport } from "../_lib/fedexShipments";

export type ShipmentImportResult =
  | { ok: true; total: number; added: number; updated: number }
  | { ok: false; error: string };

export async function importFedexShipments(table: unknown): Promise<ShipmentImportResult> {
  const g = await shipGate();
  if (!g.ok) return { ok: false, error: g.error };
  if (!g.admin) return { ok: false, error: "not_admin" };
  const parsed = shipmentsFromReport(table);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  if (!parsed.shipments.length) return { ok: true, total: 0, added: 0, updated: 0 };

  const masters = parsed.shipments.map((s) => s.master_tracking_number);
  const existing = new Set<string>();
  for (let i = 0; i < masters.length; i += 500) {
    const { data, error } = await g.service
      .from("shipping_external_shipments")
      .select("master_tracking_number")
      .eq("source", "fedex_com")
      .in("master_tracking_number", masters.slice(i, i + 500));
    if (error) return { ok: false, error: error.message };
    for (const r of data ?? []) existing.add(r.master_tracking_number as string);
  }

  const now = new Date().toISOString();
  const rows = parsed.shipments.map((s) => ({ ...s, source: "fedex_com", imported_by: g.email, imported_at: now }));
  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await g.service
      .from("shipping_external_shipments")
      .upsert(rows.slice(i, i + 500), { onConflict: "source,master_tracking_number" });
    if (error) return { ok: false, error: error.message };
  }
  revalidatePath("/shipping");
  revalidatePath("/shipping/import");
  const added = masters.filter((m) => !existing.has(m)).length;
  return { ok: true, total: masters.length, added, updated: masters.length - added };
}
