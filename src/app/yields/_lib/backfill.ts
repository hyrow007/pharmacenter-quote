import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { grossForEntry, type SoItemLike, type YieldEntry } from "./model";

// Production happens before shipping, and Fishbowl only records a line's cost
// when it ships. So most entries are saved with no gross, and the gross that
// belongs to them appears in the mirror days later. This fills it in.
//
// Runs on page load over the rows being shown, and only touches entries that
// (a) were made in the app, (b) have no gross yet, (c) name a sales order.
// Hand-entered and sheet grosses are never overwritten. Rows are updated in
// place in the array as well, so the page shows the new figure on this load.
const MAX_SOS = 200;

export async function fillMissingGross(supabase: SupabaseClient, rows: YieldEntry[]): Promise<number> {
  const pending = rows.filter(
    (r) => r.source === "app" && r.gross_per_unit === null && r.finished_units > 0 && r.so_numbers.length > 0,
  );
  if (pending.length === 0) return 0;

  const sos = Array.from(new Set(pending.flatMap((r) => r.so_numbers))).slice(0, MAX_SOS);
  const { data, error } = await supabase.from("fishbowl_sales_orders").select("so_number, items").in("so_number", sos);
  if (error || !data) return 0;
  const itemsBySo = new Map<string, SoItemLike[]>();
  for (const so of data) itemsBySo.set(so.so_number as string, (Array.isArray(so.items) ? so.items : []) as SoItemLike[]);

  let filled = 0;
  for (const r of pending) {
    const g = grossForEntry(r.product_num, r.so_numbers, itemsBySo);
    if (!g) continue;
    const { error: upErr } = await supabase
      .from("yield_entries")
      .update({ gross_per_unit: g.each_gross, gross_source: "fishbowl", unit_price: g.each_price, unit_cost: g.each_cost })
      .eq("id", r.id)
      .is("gross_per_unit", null);
    if (upErr) continue;
    r.gross_per_unit = g.each_gross;
    r.gross_source = "fishbowl";
    r.unit_price = g.each_price;
    r.unit_cost = g.each_cost;
    r.gross_total = r.finished_units * g.each_gross;
    filled += 1;
  }
  return filled;
}
