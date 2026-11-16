// Open order value on a past day, REBUILT from the Fishbowl SO mirror. Owned by
// Orders, used by the KPI History page for days before saved snapshots began
// (2026-11-05). Same "open" rule and the same value (total_price) as
// orders.open_value, applied backwards:
//
//   an order was open at the end of day D when it was issued on or before D
//   and either it is still open (status Issued / In Progress, is_open) or it
//   was fulfilled after D (status 60, date_completed > D).
//
// It is an ESTIMATE and the page says so:
//   - cancelled / voided orders never reach the mirror, so orders that were
//     open on D and later cancelled are missing (undercounts);
//   - total_price is today's value -- a price changed since D is not undone;
//   - fulfilled orders are only kept ~365 days (first completion 2025-10-31),
//     so days before ESTIMATE_FROM would miss orders that closed before then.

import type { SupabaseClient } from "@supabase/supabase-js";
import { plantDay } from "./revenue";

export const ESTIMATE_FROM = "2025-11-01";
const PAGE = 1000;

export type HistoricOrder = {
  so: string;
  customer: string;
  value: number;
  issued: string;          // plant day
  completed: string | null; // plant day; null = still open
};

type Row = {
  so_number: string;
  status_id: number | null;
  is_open: boolean;
  customer_name: string | null;
  total_price: number | null;
  date_issued: string | null;
  date_completed: string | null;
};

export async function loadHistoricOrders(supabase: SupabaseClient): Promise<HistoricOrder[] | null> {
  const out: HistoricOrder[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from("fishbowl_sales_orders")
      .select("so_number, status_id, is_open, customer_name, total_price, date_issued, date_completed")
      .in("status_id", [20, 25, 60])
      .not("date_issued", "is", null)
      .order("so_number")
      .range(from, from + PAGE - 1);
    if (error) return null;
    for (const r of (data ?? []) as Row[]) {
      const stillOpen = (r.status_id === 20 || r.status_id === 25) && r.is_open;
      const fulfilled = r.status_id === 60 && !!r.date_completed;
      if (!stillOpen && !fulfilled) continue; // closed with no known close date
      out.push({
        so: r.so_number,
        customer: (r.customer_name ?? "—").trim(),
        value: r.total_price ?? 0,
        issued: plantDay(r.date_issued!),
        completed: fulfilled ? plantDay(r.date_completed!) : null,
      });
    }
    if (!data || data.length < PAGE) break;
  }
  return out;
}

export function openOn(orders: HistoricOrder[], day: string): HistoricOrder[] {
  return orders.filter((o) => o.issued <= day && (o.completed === null || o.completed > day));
}

/** Estimated value and count for every day in [from, to]. */
export function estimateSeries(orders: HistoricOrder[], from: string, to: string): Map<string, { value: number; orders: number }> {
  const out = new Map<string, { value: number; orders: number }>();
  const d = new Date(`${from}T12:00:00Z`);
  for (let i = 0; i < 1000; i++) {
    const day = d.toISOString().slice(0, 10);
    if (day > to) break;
    let value = 0, n = 0;
    for (const o of orders) if (o.issued <= day && (o.completed === null || o.completed > day)) { value += o.value; n += 1; }
    out.set(day, { value, orders: n });
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}
