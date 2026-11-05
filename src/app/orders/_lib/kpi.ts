// Orders' metrics for kpi.pharmacenter.app. Owned by Orders; the KPI app only
// renders and snapshots them. See src/app/kpi/_lib/contract.ts.
//
// Decided with the user 2026-11-05:
//   - Open value is the WHOLE order value of every open SO, as Fishbowl shows
//     it (total_price), not the unshipped remainder.
//   - Estimates are excluded from it and reported as their own metric.
// "Open" is Orders' own rule: status Issued/In Progress AND is_open -- status
// alone keeps closed orders (the sync flips is_open but never rewrites status).

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Metric, MetricSource } from "@/app/kpi/_lib/contract";

const ESTIMATE = 10;
const COMMITTED = [20, 25]; // Issued, In Progress
const PAGE = 1000;

type Row = { so_number: string; status_id: number | null; customer_name: string | null; total_price: number | null };

async function openRows(supabase: SupabaseClient): Promise<Row[] | null> {
  const out: Row[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from("fishbowl_sales_orders")
      .select("so_number, status_id, customer_name, total_price")
      .in("status_id", [ESTIMATE, ...COMMITTED])
      .eq("is_open", true)
      .order("so_number")
      .range(from, from + PAGE - 1);
    if (error) return null;
    out.push(...((data ?? []) as Row[]));
    if (!data || data.length < PAGE) return out;
  }
}

function summarize(rows: Row[]) {
  let value = 0;
  let unpriced = 0;
  const byCustomer = new Map<string, number>();
  for (const r of rows) {
    if (r.total_price === null) { unpriced += 1; continue; }
    value += r.total_price;
    const c = r.customer_name ?? "—";
    byCustomer.set(c, (byCustomer.get(c) ?? 0) + r.total_price);
  }
  const top = [...byCustomer.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([customer, v]) => ({ customer, value: Math.round(v * 100) / 100 }));
  return { value, unpriced, top, orders: rows.length };
}

async function dataAsOf(supabase: SupabaseClient): Promise<string | null> {
  const { data } = await supabase
    .from("sync_state")
    .select("source_as_of, synced_at")
    .eq("entity", "sales_orders")
    .maybeSingle();
  return (data?.source_as_of as string | null) ?? (data?.synced_at as string | null) ?? null;
}

export const ordersMetrics: MetricSource = async (supabase) => {
  const [rows, asOf] = await Promise.all([openRows(supabase), dataAsOf(supabase)]);
  const committed = rows ? summarize(rows.filter((r) => COMMITTED.includes(r.status_id ?? -1))) : null;
  const estimates = rows ? summarize(rows.filter((r) => r.status_id === ESTIMATE)) : null;

  const open: Metric = {
    id: "orders.open_value",
    owner: "orders",
    label: { en: "Open sales order value", es: "Valor de órdenes de venta abiertas" },
    value: committed ? committed.value : null,
    unit: "usd",
    direction: "up",
    alarm: { changePct: 20, vsDays: 30 },
    coverage: committed ? { known: committed.orders - committed.unpriced, total: committed.orders } : undefined,
    detail: committed ? { orders: committed.orders, unpriced: committed.unpriced, top_customers: committed.top } : {},
    href: "https://order.pharmacenter.app/",
    dataAsOf: asOf,
  };

  const est: Metric = {
    id: "orders.estimate_value",
    owner: "orders",
    label: { en: "Open estimates", es: "Cotizaciones abiertas" },
    value: estimates ? estimates.value : null,
    unit: "usd",
    direction: "up",
    coverage: estimates ? { known: estimates.orders - estimates.unpriced, total: estimates.orders } : undefined,
    detail: estimates ? { orders: estimates.orders, unpriced: estimates.unpriced, top_customers: estimates.top } : {},
    href: "https://order.pharmacenter.app/",
    dataAsOf: asOf,
  };

  return [open, est];
};
