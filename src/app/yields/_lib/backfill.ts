import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { grossForEntry, isHouseCustomer, type SoItemLike, type YieldEntry } from "./model";

// Production happens before shipping, and Fishbowl only records a line's cost
// when it ships. So most entries are saved with no gross, and the gross that
// belongs to them appears in the mirror days later. This fills it in.
//
// Runs on page load over the rows being shown, and only touches entries that
// (a) have no gross yet and (b) name a sales order. That includes rows
// imported from the sheet after 2026-09-01, when the sheet stopped computing
// gross -- filling a blank is not overwriting anything. A gross that exists,
// typed or imported, is never replaced. (RLS lets only admins write sheet
// rows; for anyone else those updates are refused and the rows stay blank
// until an admin opens the page.) Rows are updated in place in the array too,
// so the page shows the new figure on this load.
//
// The sheet often names the base order ("M14381") while Fishbowl splits it
// into shipments ("M14381-1" ... "-6"), each with its own cost. A base number
// therefore matches its -N shipments, and the one used is the first that
// shipped on or after the run date -- the shipment those units most likely
// went out on -- or the latest one if none did.
const MAX_SOS = 200;

export async function fillMissingGross(supabase: SupabaseClient, rows: YieldEntry[]): Promise<number> {
  const pending = rows.filter(
    (r) => r.gross_per_unit === null && r.gross_source !== "house" && r.finished_units > 0 && r.so_numbers.length > 0,
  );
  if (pending.length === 0) return 0;

  const wanted = Array.from(new Set(pending.flatMap((r) => r.so_numbers))).slice(0, MAX_SOS);
  // Exact numbers, plus every "-N" shipment of a base number.
  const ors = wanted.map((so) => `so_number.eq.${so},so_number.like.${so}-*`).join(",");
  const { data, error } = await supabase
    .from("fishbowl_sales_orders")
    .select("so_number, customer_name, items, date_last_modified")
    .or(ors)
    .limit(1000);
  if (error || !data) return 0;
  const itemsBySo = new Map<string, SoItemLike[]>();
  const shippedAt = new Map<string, string>();
  const house = new Set<string>();
  for (const so of data) {
    if (isHouseCustomer(so.customer_name as string | null)) house.add(so.so_number as string);
    itemsBySo.set(so.so_number as string, (Array.isArray(so.items) ? so.items : []) as SoItemLike[]);
    shippedAt.set(so.so_number as string, ((so.date_last_modified as string | null) ?? "").slice(0, 10));
  }
  const candidatesFor = (r: YieldEntry): string[] => {
    const out: string[] = [];
    for (const so of r.so_numbers) {
      if (itemsBySo.has(so)) out.push(so);
      const parts = [...itemsBySo.keys()]
        .filter((k) => k.startsWith(`${so}-`))
        .sort((a, b) => (shippedAt.get(a) ?? "").localeCompare(shippedAt.get(b) ?? ""));
      const after = parts.filter((k) => (shippedAt.get(k) ?? "") >= r.run_date);
      out.push(...after, ...parts.filter((k) => !after.includes(k)).reverse());
    }
    return out;
  };

  let filled = 0;
  for (const r of pending) {
    const cands = candidatesFor(r);
    const g = grossForEntry(r.product_num, cands, itemsBySo);
    if (!g) {
      // Every order it names is one of ours -> house stock, not a missing gross.
      if (cands.length > 0 && cands.every((so) => house.has(so))) {
        const { error: hErr } = await supabase
          .from("yield_entries")
          .update({ gross_source: "house" })
          .eq("id", r.id)
          .is("gross_per_unit", null);
        if (!hErr) r.gross_source = "house";
      }
      continue;
    }
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
