// The registry: which metrics appear, in which section, in what order.
// Each owning module returns its metrics; a section names the ids it shows,
// so one module can feed several sections and the layout stays independent
// of who owns the code.
// Adding a section = the owning app writes its _lib/kpi.ts, plus an entry here.

import type { Bilingual, MetricSource } from "./contract";
import { ordersMetrics } from "@/app/orders/_lib/kpi";

export const SOURCES: MetricSource[] = [ordersMetrics];

export type Section = { id: string; title: Bilingual; metrics: string[] };

export const SECTIONS: Section[] = [
  {
    id: "sales-orders",
    title: { en: "Sales orders", es: "Órdenes de venta" },
    metrics: ["orders.open_value"],
  },
  {
    id: "estimates",
    title: { en: "Estimates", es: "Cotizaciones" },
    metrics: ["orders.estimate_value"],
  },
];
