// Collect, judge and snapshot metrics. The KPI app owns this; it never computes
// a metric itself -- every value comes from an owning app's kpi.ts via SOURCES.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Metric } from "./contract";
import { SOURCES } from "./sections";

export const PLANT_TZ = "America/New_York";

export function plantToday(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: PLANT_TZ }).format(now);
}

export function addDays(iso: string, n: number): string {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Every metric from every source. A source that throws is skipped, not fatal. */
export async function collectMetrics(supabase: SupabaseClient): Promise<Map<string, Metric>> {
  const out = new Map<string, Metric>();
  const results = await Promise.allSettled(SOURCES.map((src) => src(supabase)));
  for (const r of results) {
    if (r.status === "fulfilled") for (const m of r.value) out.set(m.id, m);
    else console.error("kpi source failed:", r.reason);
  }
  return out;
}

/** One row per metric for the plant day. Re-running a day overwrites it. */
export async function writeSnapshots(
  db: SupabaseClient,
  metrics: Iterable<Metric>,
  period = plantToday(),
): Promise<{ ok: boolean; written: number; error?: string }> {
  const rows = [...metrics].map((m) => ({
    metric_id: m.id,
    period_date: period,
    value: m.value,
    unit: m.unit,
    target: m.target?.value ?? null,
    coverage_known: m.coverage?.known ?? null,
    coverage_total: m.coverage?.total ?? null,
    detail: m.detail ?? {},
    data_as_of: m.dataAsOf ?? null,
    computed_at: new Date().toISOString(),
  }));
  if (rows.length === 0) return { ok: true, written: 0 };
  const { error } = await db.from("kpi_snapshots").upsert(rows, { onConflict: "metric_id,period_date" });
  return error ? { ok: false, written: 0, error: error.message } : { ok: true, written: rows.length };
}

export type Comparison = {
  priorValue: number | null;
  priorDate: string | null;   // the snapshot compared against, if old enough
  firstDate: string | null;   // when this metric's history begins
  changePct: number | null;
};

/** For each metric, the latest snapshot at least `vsDays` old, and where history begins. */
export async function loadComparisons(
  supabase: SupabaseClient,
  metrics: Metric[],
  today = plantToday(),
): Promise<Map<string, Comparison>> {
  const out = new Map<string, Comparison>();
  await Promise.all(
    metrics.map(async (m) => {
      const vsDays = m.alarm?.vsDays ?? 30;
      const cutoff = addDays(today, -vsDays);
      const [prior, first] = await Promise.all([
        supabase
          .from("kpi_snapshots")
          .select("period_date, value")
          .eq("metric_id", m.id)
          .lte("period_date", cutoff)
          .order("period_date", { ascending: false })
          .limit(1)
          .maybeSingle(),
        supabase
          .from("kpi_snapshots")
          .select("period_date")
          .eq("metric_id", m.id)
          .order("period_date", { ascending: true })
          .limit(1)
          .maybeSingle(),
      ]);
      const pv = prior.data?.value === null || prior.data?.value === undefined ? null : Number(prior.data.value);
      const changePct =
        pv !== null && pv !== 0 && m.value !== null ? ((m.value - pv) / Math.abs(pv)) * 100 : null;
      out.set(m.id, {
        priorValue: pv,
        priorDate: (prior.data?.period_date as string | undefined) ?? null,
        firstDate: (first.data?.period_date as string | undefined) ?? null,
        changePct,
      });
    }),
  );
  return out;
}

export type Verdict =
  | { off: false }
  | { off: true; reason: "unknown" | "below" | "above" | "moved"; changePct?: number };

/** Is this metric "off"? Only metrics with a target or an alarm can be. */
export function judge(m: Metric, c: Comparison | undefined): Verdict {
  if (!m.target && !m.alarm) return { off: false };
  if (m.value === null) return { off: true, reason: "unknown" };
  if (m.target) {
    if (m.target.kind === "min" && m.value < m.target.value) return { off: true, reason: "below" };
    if (m.target.kind === "max" && m.value > m.target.value) return { off: true, reason: "above" };
  }
  if (m.alarm && c?.changePct !== null && c?.changePct !== undefined && Math.abs(c.changePct) > m.alarm.changePct) {
    return { off: true, reason: "moved", changePct: c.changePct };
  }
  return { off: false };
}
