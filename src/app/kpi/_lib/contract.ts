// The KPI contract. Every section of kpi.pharmacenter.app is a list of these,
// produced by the app that owns the numbers (src/app/<app>/_lib/kpi.ts).
// The KPI app never computes another app's metric itself: one number, one
// owner, so the KPI page and the owning app cannot disagree.

import type { SupabaseClient } from "@supabase/supabase-js";

export type Bilingual = { en: string; es: string };

export type MetricUnit = "usd" | "usd_per_hour" | "count" | "pct" | "units";

export type Metric = {
  id: string;                      // "<owner>.<name>" -- stable; keys kpi_snapshots.metric_id
  owner: string;                   // the app that computes it
  label: Bilingual;
  value: number | null;            // null = unknown, never 0
  unit: MetricUnit;
  direction: "up" | "down";        // which way is good
  target?: { value: number; kind: "min" | "max" };
  alarm?: { changePct: number; vsDays: number }; // "off" if it moved more than this
  coverage?: { known: number; total: number };   // how much of the data the value rests on
  note?: Bilingual;                // the "why this is off" line
  detail?: Record<string, unknown>; // stored with the snapshot (counts, top customers…)
  href?: string;                   // drill-down into the owning app
  dataAsOf?: string | null;        // ISO time of the data the value was computed from
};

// What each owning module exports.
export type MetricSource = (supabase: SupabaseClient) => Promise<Metric[]>;
