// KPI's own strings, EN and ES. Metric labels live with each metric (the
// owning app's kpi.ts); these are the page's own words. `satisfies` on `es`
// makes a missing key a type error -- the parity check.

import type { Lang } from "@/lib/i18n/dict";

const en = {
  eyebrow: "PharmaCenter · KPIs",
  title: "How the business is doing",
  lede: "Anything that needs attention is at the top. Each section holds the detail underneath.",
  attention: "Needs attention",
  allClear: "Nothing needs attention right now.",
  changeVs: "{pct} since {date}",
  noChange: "No change since {date}",
  trendStarts: "History started {date} — the {n}-day comparison begins {from}.",
  noHistory: "History starts with today's snapshot.",
  alarmRule: "Flags when it moves more than {pct}% in {n} days.",
  movedUp: "Up {pct} in {n} days.",
  movedDown: "Down {pct} in {n} days.",
  belowTarget: "Below target of {target}.",
  aboveTarget: "Above target of {target}.",
  unknown: "Unknown",
  unknownNote: "Could not be computed from the current data.",
  orders: "{n} orders",
  unpriced: "{n} without a price — not counted",
  topCustomers: "Largest customers",
  openIn: "Open in {app} →",
  dataAsOf: "Fishbowl data as of {when}",
  stale: "Last night's Fishbowl sync did not run — these numbers may be out of date.",
};

export type KKey = keyof typeof en;

const es = {
  eyebrow: "PharmaCenter · Indicadores",
  title: "Cómo va el negocio",
  lede: "Lo que requiere atención aparece arriba. Cada sección tiene el detalle debajo.",
  attention: "Requiere atención",
  allClear: "Nada requiere atención en este momento.",
  changeVs: "{pct} desde el {date}",
  noChange: "Sin cambio desde el {date}",
  trendStarts: "El historial empezó el {date} — la comparación de {n} días empieza el {from}.",
  noHistory: "El historial empieza con la foto de hoy.",
  alarmRule: "Se marca si cambia más de {pct}% en {n} días.",
  movedUp: "Subió {pct} en {n} días.",
  movedDown: "Bajó {pct} en {n} días.",
  belowTarget: "Por debajo de la meta de {target}.",
  aboveTarget: "Por encima de la meta de {target}.",
  unknown: "Desconocido",
  unknownNote: "No se pudo calcular con los datos actuales.",
  orders: "{n} órdenes",
  unpriced: "{n} sin precio — no se cuentan",
  topCustomers: "Clientes principales",
  openIn: "Abrir en {app} →",
  dataAsOf: "Datos de Fishbowl al {when}",
  stale: "La sincronización de Fishbowl de anoche no corrió — estos números pueden estar desactualizados.",
} satisfies Record<KKey, string>;

export type KT = (key: KKey, vars?: Record<string, string | number>) => string;

export function makeKT(lang: Lang): KT {
  const dict: Record<KKey, string> = lang === "es" ? es : en;
  return (key, vars) => {
    let out = dict[key] ?? en[key] ?? key;
    if (vars) for (const [k, v] of Object.entries(vars)) out = out.replaceAll(`{${k}}`, String(v));
    return out;
  };
}
