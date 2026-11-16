// Capacity utilization for the KPI page.
//
//   used       = Overhead's run-days for last calendar month
//                (overhead_measured_run_days: distinct line x job x day from
//                Yields). Owned by Overhead; called here, never recounted.
//   available  = machines x working days, per line, from kpi_capacity_lines
//                (KPI-owned; edited on /capacity).
//
// Lines with no machines or no working days set are left out -- unknown, not
// zero -- and the coverage line says how many lines are counted.
// Note: a run-day is a job-day. Two jobs on one bottle line in one day count
// twice, and a sachet job split across machines may count once. Utilization
// is therefore approximate per line; the band is what matters.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Metric, MetricSource } from "./contract";

export const CAP_LINES = ["blister", "bottle", "pouch", "sachet", "other"] as const;
export type CapLine = (typeof CAP_LINES)[number];

export type CapacityRow = {
  line_key: CapLine | "ALL";
  machines: number | null;
  days_per_month: number | null;
  band_low: number | null;
  band_high: number | null;
  updated_by: string | null;
  updated_at: string | null;
};

export type LineUse = {
  line: CapLine;
  used: number;              // run-days last month
  available: number | null;  // machines x days; null = not set
  pct: number | null;
};

export type Capacity = {
  month: string;             // YYYY-MM measured
  windowFrom: string;
  windowTo: string;          // exclusive
  lines: LineUse[];
  used: number;              // over lines with capacity set
  available: number;
  pct: number | null;
  band: { low: number; high: number } | null;
  config: CapacityRow[];
};

function plantToday(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date());
}

export async function loadCapacity(supabase: SupabaseClient): Promise<Capacity | null> {
  const today = plantToday();
  const windowTo = `${today.slice(0, 7)}-01`; // first of this month, exclusive
  const d = new Date(`${windowTo}T12:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() - 1);
  const windowFrom = d.toISOString().slice(0, 10);

  const [cfg, runs] = await Promise.all([
    supabase.from("kpi_capacity_lines").select("line_key, machines, days_per_month, band_low, band_high, updated_by, updated_at"),
    supabase.rpc("overhead_measured_run_days", { p_months: 1, p_end: windowTo }),
  ]);
  if (cfg.error || runs.error) {
    console.error("capacity load failed:", cfg.error?.message ?? runs.error?.message);
    return null;
  }
  const config = (cfg.data ?? []) as CapacityRow[];
  const usedBy = new Map<string, number>();
  for (const r of (runs.data ?? []) as { line_key: string; run_days: number }[]) usedBy.set(r.line_key, Number(r.run_days));

  const lines: LineUse[] = CAP_LINES.map((line) => {
    const c = config.find((x) => x.line_key === line);
    const used = usedBy.get(line) ?? 0;
    const available = c?.machines && c?.days_per_month ? Number(c.machines) * Number(c.days_per_month) : null;
    return { line, used, available, pct: available ? (used / available) * 100 : null };
  });
  const counted = lines.filter((l) => l.available !== null);
  const used = counted.reduce((a, l) => a + l.used, 0);
  const available = counted.reduce((a, l) => a + (l.available ?? 0), 0);
  const all = config.find((x) => x.line_key === "ALL");
  const band = all && all.band_low !== null && all.band_high !== null ? { low: Number(all.band_low), high: Number(all.band_high) } : null;

  return {
    month: windowFrom.slice(0, 7),
    windowFrom,
    windowTo,
    lines,
    used,
    available,
    pct: available > 0 ? (used / available) * 100 : null,
    band,
    config,
  };
}

export const capacityMetrics: MetricSource = async (supabase) => {
  const cap = await loadCapacity(supabase);
  const counted = cap ? cap.lines.filter((l) => l.available !== null).length : 0;
  const m: Metric = {
    id: "capacity.utilization_last_month",
    owner: "kpi",
    label: { en: "Capacity used, last month", es: "Capacidad usada, mes pasado" },
    value: cap?.pct ?? null,
    unit: "pct",
    direction: "up",
    target: cap?.band ? { kind: "range", value: cap.band.low, high: cap.band.high } : undefined,
    coverage: cap ? { known: counted, total: cap.lines.filter((l) => l.used > 0 || l.available !== null).length } : undefined,
    note: cap && counted === 0
      ? { en: "Set line counts and working days on the Capacity page.", es: "Defina líneas y días hábiles en la página de Capacidad." }
      : undefined,
    detail: cap
      ? {
          month: cap.month,
          used: cap.used,
          available: cap.available,
          lines: cap.lines.map((l) => ({ line: l.line, used: l.used, available: l.available, pct: l.pct === null ? null : Math.round(l.pct * 10) / 10 })),
        }
      : {},
    href: "/capacity",
    hrefLabel: { en: "Capacity by line", es: "Capacidad por línea" },
  };
  return [m];
};
