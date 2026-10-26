import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { toNum, unitFactor, type SoItemLike, type YieldEntry } from "./model";

// SO balance: how many finished units are still to produce on the sales
// order(s) an entry names.
//
//   ordered  = the SO line quantity for this product, in finished units
//              ("Each" x1, "Unit" x1,000 -- see unitFactor). A base number
//              ("M14381") with no order of its own counts its "-N" splits.
//   produced = every finished unit logged against the SAME product and the
//              SAME set of SO numbers, up to and including this entry, in run
//              order (date, then time entered) -- across all history, not
//              just the rows on screen.
//   balance  = ordered - produced. Negative means more was made than ordered.
//
// No SO, an SO not in the mirror, or a line whose unit is unknown -> no
// balance (shown as "—"), never a guess.

//
// ECD (estimated completion date), as of each run: the balance divided by the
// average of the last two run rates -- finished units per working day on this
// product + SO set, the two most recent days with runs up to and including this
// one (one day if that is all there is) -- counted forward in working days
// (Mon-Fri; holidays are not known) from the run date.
export type SoBalance = {
  ordered: number;
  produced: number;
  balance: number;
  rate: number | null; // avg finished units per working day, last two run days
  daysLeft: number | null; // working days still needed at that rate
  ecd: string | null; // YYYY-MM-DD
};

function addWorkingDays(iso: string, n: number): string {
  const d = new Date(iso + "T12:00:00Z");
  let left = n;
  while (left > 0) {
    d.setUTCDate(d.getUTCDate() + 1);
    const wd = d.getUTCDay();
    if (wd !== 0 && wd !== 6) left -= 1;
  }
  return d.toISOString().slice(0, 10);
}

const keyOf = (product: string, sos: string[]) => `${product}|${[...sos].sort().join(",")}`;

export async function soBalances(
  supabase: SupabaseClient,
  rows: YieldEntry[],
): Promise<Map<string, SoBalance>> {
  const out = new Map<string, SoBalance>();
  const withSo = rows.filter((r) => r.so_numbers.length > 0);
  if (withSo.length === 0) return out;

  // 1. Ordered quantity per (product, SO set).
  const wanted = Array.from(new Set(withSo.flatMap((r) => r.so_numbers))).slice(0, 200);
  const ors = wanted.map((so) => `so_number.eq.${so},so_number.like.${so}-*`).join(",");
  const { data: sos } = await supabase.from("fishbowl_sales_orders").select("so_number, items").or(ors).limit(1000);
  const itemsBySo = new Map<string, SoItemLike[]>();
  for (const so of sos ?? []) {
    itemsBySo.set(so.so_number as string, (Array.isArray(so.items) ? so.items : []) as SoItemLike[]);
  }
  const orderedFor = (product: string, soNumbers: string[]): number | null => {
    let total = 0;
    let found = false;
    for (const so of soNumbers) {
      // The exact order if it sells this product; otherwise its "-N" splits
      // (the sheet writes "13915" where Fishbowl's line is on "13915-2").
      const sells = (k: string) =>
        (itemsBySo.get(k) ?? []).some((it) => it.product_num === product && (it.type_id === 10 || it.type_id === 30));
      const targets = sells(so) ? [so] : [...itemsBySo.keys()].filter((k) => k.startsWith(`${so}-`));
      for (const t of targets) {
        for (const it of itemsBySo.get(t) ?? []) {
          if (it.product_num !== product || !(it.type_id === 10 || it.type_id === 30)) continue;
          const qty = toNum((it as Record<string, unknown>).qty_ordered);
          const { factor } = unitFactor(it.uom, it.uom_name);
          if (qty === null || factor === null) return null; // unknown unit -> no balance at all
          total += qty * factor;
          found = true;
        }
      }
    }
    return found ? Math.round(total) : null;
  };

  // 2. Everything ever logged for these products, to accumulate in order.
  const products = Array.from(new Set(withSo.map((r) => r.product_num))).slice(0, 200);
  const logged: { id: string; product_num: string; so_numbers: string[]; finished_units: number; run_date: string; created_at: string }[] = [];
  for (let offset = 0; offset < 20_000; offset += 1000) {
    const { data, error } = await supabase
      .from("yield_entries")
      .select("id, product_num, so_numbers, finished_units, run_date, created_at")
      .in("product_num", products)
      .order("run_date", { ascending: true })
      .order("created_at", { ascending: true })
      .range(offset, offset + 999);
    if (error || !data) break;
    for (const d of data) {
      logged.push({
        id: d.id as string,
        product_num: d.product_num as string,
        so_numbers: Array.isArray(d.so_numbers) ? (d.so_numbers as string[]) : [],
        finished_units: toNum(d.finished_units) ?? 0,
        run_date: d.run_date as string,
        created_at: d.created_at as string,
      });
    }
    if (data.length < 1000) break;
  }

  const wantedKeys = new Set(withSo.map((r) => keyOf(r.product_num, r.so_numbers)));
  const orderedByKey = new Map<string, number | null>();
  const running = new Map<string, number>();
  const daily = new Map<string, Map<string, number>>(); // key -> run_date -> units
  for (const e of logged) {
    if (e.so_numbers.length === 0) continue;
    const k = keyOf(e.product_num, e.so_numbers);
    if (!wantedKeys.has(k)) continue;
    if (!orderedByKey.has(k)) orderedByKey.set(k, orderedFor(e.product_num, e.so_numbers));
    const ordered = orderedByKey.get(k);
    const produced = (running.get(k) ?? 0) + e.finished_units;
    running.set(k, produced);
    const days = daily.get(k) ?? new Map<string, number>();
    days.set(e.run_date, (days.get(e.run_date) ?? 0) + e.finished_units);
    daily.set(k, days);
    if (ordered == null) continue;
    const balance = ordered - produced;
    // Last two run days up to this one (entries arrive in run order).
    const recent = [...days.entries()].filter(([d]) => d <= e.run_date).slice(-2).map(([, u]) => u);
    const rate = recent.length ? recent.reduce((a, b) => a + b, 0) / recent.length : null;
    let daysLeft: number | null = null;
    let ecd: string | null = null;
    if (balance <= 0) {
      daysLeft = 0;
    } else if (rate && rate > 0) {
      daysLeft = Math.ceil(balance / rate);
      ecd = addWorkingDays(e.run_date, daysLeft);
    }
    out.set(e.id, { ordered, produced, balance, rate: rate === null ? null : Math.round(rate), daysLeft, ecd });
  }
  return out;
}
