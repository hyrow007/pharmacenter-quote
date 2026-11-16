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
import { addMonths, loadFulfilled, newCustomers, plantDay, salesByCustomer } from "./revenue";

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
  // The full list, saved with each day's snapshot so a past day can show which
  // orders were open -- history that is not written cannot be rebuilt later.
  const list = rows
    .map((r) => ({ so: r.so_number, customer: r.customer_name ?? "—", value: r.total_price }))
    .sort((a, b) => (b.value ?? 0) - (a.value ?? 0));
  return { value, unpriced, top, orders: rows.length, list };
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
    detail: committed ? { orders: committed.orders, unpriced: committed.unpriced, top_customers: committed.top, order_list: committed.list } : {},
    href: "/history",
    hrefLabel: { en: "History by day", es: "Historial por día" },
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
    detail: estimates ? { orders: estimates.orders, unpriced: estimates.unpriced, top_customers: estimates.top, order_list: estimates.list } : {},
    href: "https://order.pharmacenter.app/",
    hrefLabel: { en: "Open in Sales Orders", es: "Abrir en Órdenes" },
    dataAsOf: asOf,
  };

  // Fulfilled revenue and new customers -- same rules as the KPI Sales page
  // (./revenue.ts). FGBG stock builds excluded.
  const fulfilled = await loadFulfilled(supabase);
  const today = plantDay(new Date().toISOString());
  const from30 = addDays(today, -29);
  const sales = fulfilled ? salesByCustomer(fulfilled, from30, today, { includeHouse: false }) : null;
  const from90 = addMonths(today, -3);
  const nc = fulfilled ? newCustomers(fulfilled, from90, today, 6, { includeHouse: false }) : null;

  const revenue: Metric = {
    id: "orders.revenue_30d",
    owner: "orders",
    label: { en: "Fulfilled revenue, last 30 days", es: "Ingresos despachados, últimos 30 días" },
    value: sales ? sales.total : null,
    unit: "usd",
    direction: "up",
    alarm: { changePct: 25, vsDays: 30 },
    detail: sales
      ? {
          orders: sales.customers.reduce((a, c) => a + c.orders, 0),
          top_customers: sales.customers.slice(0, 5).map((c) => ({ customer: c.name, value: Math.round(c.revenue * 100) / 100 })),
        }
      : {},
    href: "/sales",
    hrefLabel: { en: "Sales by customer", es: "Ventas por cliente" },
    dataAsOf: asOf,
  };

  const newCust: Metric = {
    id: "orders.new_customers_3m",
    owner: "orders",
    label: { en: "New customers billed, last 3 months", es: "Clientes nuevos facturados, últimos 3 meses" },
    value: nc ? nc.count : null,
    unit: "count",
    direction: "up",
    alarm: { changePct: 50, vsDays: 30 },
    coverage: nc ? { known: nc.ordersKnown, total: nc.ordersTotal } : undefined,
    note: { en: "New = no fulfilled order in the 6 months before.", es: "Nuevo = sin órdenes despachadas en los 6 meses anteriores." },
    detail: nc
      ? {
          revenue: Math.round(nc.revenue * 100) / 100,
          gross: Math.round(nc.gross * 100) / 100,
          lookback_months: nc.lookbackMonths,
          top_customers: nc.customers.slice(0, 5).map((c) => ({ customer: c.name, value: Math.round(c.revenue * 100) / 100 })),
        }
      : {},
    href: "/sales#new",
    hrefLabel: { en: "New customers", es: "Clientes nuevos" },
    dataAsOf: asOf,
  };

  return [open, est, revenue, newCust];
};

function addDays(iso: string, n: number): string {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
