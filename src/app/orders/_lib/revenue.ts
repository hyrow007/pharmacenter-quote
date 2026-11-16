// Fulfilled-order revenue from the Fishbowl SO mirror. Owned by Orders; the
// KPI app's Sales page and headline metrics read it from here and never
// recompute it.
//
// Decided with the user 2026-11-16:
//   - Revenue = FULFILLED Fishbowl orders (status 60), dated by date_completed
//     (plant day, America/New_York), valued at total_price -- the same field
//     as open order value.
//   - Gross = gross PROFIT: total_price minus Fishbowl's line cost
//     (items[].total_cost, recorded at fulfillment). A zero cost means
//     UNKNOWN, not free (the Yields rule) -- those orders count toward revenue
//     but are left out of gross, and the coverage says how many.
//   - FGBG: an SO whose customer is PharmaCenter itself is a stock build of
//     the house brand, not a sale. Excluded by default, can be included.
//
// Limits of the mirror: the sync sends fulfilled orders completed in roughly
// the last 365 days (first: 2025-10-31), and never sends cancelled ones.
// Customers are matched by name -- the mirror has no customer id.

import type { SupabaseClient } from "@supabase/supabase-js";

export const PLANT_TZ = "America/New_York";
const FULFILLED = 60;
const PAGE = 1000;

export type FulfilledOrder = {
  so: string;
  customer: string;     // display name, as first seen
  customerKey: string;  // matching key (trimmed, lowercased, spaces collapsed)
  day: string;          // plant date of completion, YYYY-MM-DD
  revenue: number;
  cost: number | null;  // null = unknown (Fishbowl cost 0 or missing)
  house: boolean;       // PharmaCenter's own stock build (FGBG)
};

export function plantDay(iso: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: PLANT_TZ }).format(new Date(iso));
}

export function customerKey(name: string | null): string {
  return (name ?? "—").trim().toLowerCase().replace(/\s+/g, " ").replace(/[.,]+$/g, "");
}

/** PharmaCenter as its own customer = house-brand (FGBG) stock build. */
export function isHouse(name: string | null): boolean {
  return /pharma\s*center/i.test(name ?? "");
}

type Row = {
  so_number: string;
  customer_name: string | null;
  date_completed: string | null;
  total_price: number | null;
  items: { total_cost?: number | null }[] | null;
};

/** Every fulfilled order with a completion date, oldest first. */
export async function loadFulfilled(supabase: SupabaseClient): Promise<FulfilledOrder[] | null> {
  const out: FulfilledOrder[] = [];
  const names = new Map<string, string>();
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from("fishbowl_sales_orders")
      .select("so_number, customer_name, date_completed, total_price, items")
      .eq("status_id", FULFILLED)
      .not("date_completed", "is", null)
      .order("date_completed")
      .range(from, from + PAGE - 1);
    if (error) return null;
    for (const r of (data ?? []) as Row[]) {
      if (!r.date_completed) continue;
      const key = customerKey(r.customer_name);
      if (!names.has(key)) names.set(key, (r.customer_name ?? "—").trim());
      const cost = (r.items ?? []).reduce((a, it) => a + (typeof it?.total_cost === "number" ? it.total_cost : 0), 0);
      out.push({
        so: r.so_number,
        customer: names.get(key)!,
        customerKey: key,
        day: plantDay(r.date_completed),
        revenue: r.total_price ?? 0,
        cost: cost > 0 ? cost : null,
        house: isHouse(r.customer_name),
      });
    }
    if (!data || data.length < PAGE) break;
  }
  return out;
}

export function firstDay(rows: FulfilledOrder[]): string | null {
  return rows.length ? rows[0].day : null;
}

// ---------- months ----------

export function monthOf(day: string): string {
  return day.slice(0, 7);
}

export function monthsBetween(fromMonth: string, toMonth: string): string[] {
  const out: string[] = [];
  let [y, m] = fromMonth.split("-").map(Number);
  const [ty, tm] = toMonth.split("-").map(Number);
  while (y < ty || (y === ty && m <= tm)) {
    out.push(`${y}-${String(m).padStart(2, "0")}`);
    m += 1;
    if (m > 12) { m = 1; y += 1; }
    if (out.length > 120) break;
  }
  return out;
}

export function addMonths(day: string, n: number): string {
  const d = new Date(`${day}T12:00:00Z`);
  const target = d.getUTCMonth() + n;
  d.setUTCDate(1);
  d.setUTCMonth(target);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(Number(day.slice(8, 10)), last));
  return d.toISOString().slice(0, 10);
}

/** Last day of a YYYY-MM month. */
export function monthEnd(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}

// ---------- sales by customer ----------

export type CustomerSales = {
  key: string;
  name: string;
  revenue: number;
  share: number;            // of total revenue in the range, 0..1
  orders: number;
  byMonth: Map<string, number>;
};

export type SalesByCustomer = {
  months: string[];
  total: number;
  totalByMonth: Map<string, number>;
  customers: CustomerSales[]; // sorted by revenue, descending
};

export function salesByCustomer(
  rows: FulfilledOrder[],
  from: string, // YYYY-MM-DD inclusive
  to: string,   // YYYY-MM-DD inclusive
  opts: { includeHouse: boolean },
): SalesByCustomer {
  const months = monthsBetween(monthOf(from), monthOf(to));
  const byKey = new Map<string, CustomerSales>();
  const totalByMonth = new Map<string, number>(months.map((m) => [m, 0]));
  let total = 0;
  for (const r of rows) {
    if (r.day < from || r.day > to) continue;
    if (r.house && !opts.includeHouse) continue;
    const c = byKey.get(r.customerKey) ?? { key: r.customerKey, name: r.customer, revenue: 0, share: 0, orders: 0, byMonth: new Map() };
    c.revenue += r.revenue;
    c.orders += 1;
    const m = monthOf(r.day);
    c.byMonth.set(m, (c.byMonth.get(m) ?? 0) + r.revenue);
    totalByMonth.set(m, (totalByMonth.get(m) ?? 0) + r.revenue);
    total += r.revenue;
    byKey.set(r.customerKey, c);
  }
  const customers = [...byKey.values()].sort((a, b) => b.revenue - a.revenue);
  for (const c of customers) c.share = total > 0 ? c.revenue / total : 0;
  return { months, total, totalByMonth, customers };
}

// ---------- new customers ----------

export type NewCustomer = {
  key: string;
  name: string;
  firstDay: string;        // first fulfilled order in the period
  orders: number;
  revenue: number;
  gross: number;           // over orders with a known cost
  costKnownRevenue: number; // revenue of the orders the gross rests on
  costKnown: number;
};

export type NewCustomers = {
  lookbackMonths: number;
  customers: NewCustomer[];  // by revenue, descending
  count: number;
  revenue: number;
  gross: number;
  costKnownRevenue: number;
  ordersKnown: number;
  ordersTotal: number;
  periodRevenue: number;     // all customers in the period (same filter), for share
  /** Earliest first-order day for which the full lookback is inside the data. */
  fullHistoryFrom: string | null;
};

/**
 * A customer is NEW in [from, to] when it has a fulfilled order in the period
 * and NO fulfilled order in the `lookbackMonths` before its first order in the
 * period. Revenue and gross are everything it was billed in the period.
 */
export function newCustomers(
  rows: FulfilledOrder[],
  from: string,
  to: string,
  lookbackMonths: number,
  opts: { includeHouse: boolean },
): NewCustomers {
  const days = new Map<string, string[]>(); // customer -> sorted fulfilled days
  for (const r of rows) {
    if (r.house && !opts.includeHouse) continue;
    const list = days.get(r.customerKey) ?? [];
    list.push(r.day);
    days.set(r.customerKey, list);
  }
  for (const l of days.values()) l.sort();

  const inPeriod = new Map<string, FulfilledOrder[]>();
  let periodRevenue = 0;
  for (const r of rows) {
    if (r.day < from || r.day > to) continue;
    if (r.house && !opts.includeHouse) continue;
    periodRevenue += r.revenue;
    const l = inPeriod.get(r.customerKey) ?? [];
    l.push(r);
    inPeriod.set(r.customerKey, l);
  }

  const out: NewCustomer[] = [];
  for (const [key, orders] of inPeriod) {
    const first = orders.reduce((a, o) => (o.day < a ? o.day : a), orders[0].day);
    const windowStart = addMonths(first, -lookbackMonths);
    const before = (days.get(key) ?? []).some((d) => d >= windowStart && d < first);
    if (before) continue;
    let revenue = 0, gross = 0, costKnownRevenue = 0, costKnown = 0;
    for (const o of orders) {
      revenue += o.revenue;
      if (o.cost !== null) { gross += o.revenue - o.cost; costKnownRevenue += o.revenue; costKnown += 1; }
    }
    out.push({ key, name: orders[0].customer, firstDay: first, orders: orders.length, revenue, gross, costKnownRevenue, costKnown });
  }
  out.sort((a, b) => b.revenue - a.revenue);

  const earliest = firstDay(rows);
  return {
    lookbackMonths,
    customers: out,
    count: out.length,
    revenue: out.reduce((a, c) => a + c.revenue, 0),
    gross: out.reduce((a, c) => a + c.gross, 0),
    costKnownRevenue: out.reduce((a, c) => a + c.costKnownRevenue, 0),
    ordersKnown: out.reduce((a, c) => a + c.costKnown, 0),
    ordersTotal: out.reduce((a, c) => a + c.orders, 0),
    periodRevenue,
    fullHistoryFrom: earliest ? addMonths(earliest, lookbackMonths) : null,
  };
}
