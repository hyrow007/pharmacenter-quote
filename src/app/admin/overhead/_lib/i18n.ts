// Overhead's own strings, EN and ES. Same contract as the shared dictionary:
// `satisfies` on `es` makes a missing key a type error.

import type { Lang } from "@/lib/i18n/dict";

const en = {
  eyebrow: "PharmaCenter · Admin",
  title: "Overhead",
  lede: "The rent, indirect labor and other expenses behind every quote. Read-only for now: changes still go in by hand.",
  backToAdmin: "← Admin",
  loadFailed: "Could not load the overhead figures: {detail}",

  today: "Today",
  quotesAsOf: "New quotes cost as of",
  leadNote: "{days}-day lead time: a quote is costed at the rates in force when the job is expected to run, not on the day it is typed. Statuses and days left below are measured from that date.",
  leadMissing: "No lead time is set, so new quotes cost at today's rates.",

  attention: "Needs a look",
  attentionNone: "Nothing lapsing, nothing estimated.",
  aExpired: "{label}: no band covers {date}. Quotes are using the nearest one, which ended {to}.",
  aNotYet: "{label}: its first band starts {from}, after {date}. Quotes are using it anyway.",
  aEnding: "{label}: current band ends {to}, {days} days after the quote date.",
  aCam: "{label}: CAM is still an estimate.",
  aStepped: "{label}: quotes already use the band starting {from} ({quote}/mo). Today's rate is {today}/mo.",

  gRent: "Rent and CAM",
  gIndirect: "Indirect labor",
  gOther: "Other expenses",

  colItem: "Item",
  colMonthly: "Monthly in quotes",
  colDetail: "Detail",
  colBand: "Band",
  colSource: "Source",
  colVerified: "Verified",
  colStatus: "Status",

  base: "base {v}",
  cam: "CAM {v}",
  camEst: "CAM {v} (estimate)",
  hourly: "{qty} × {rate}/h × {hours} h",
  salary: "{qty} × {rate}/mo",
  burden: "+ {tax}% tax, {wc}% WC",
  qb: "QB {acct}",
  open: "open-ended",
  differsToday: "Today: {v}/mo",
  history: "All bands ({n})",

  sCurrent: "current",
  sExpired: "expired",
  sNotYet: "not yet",

  sharesTitle: "Share of each item charged to each line",
  sharesNote: "These are not dated. Changing one re-prices every new quote from that moment, and there is no record of the old figure. That is why they stay read-only until they have bands of their own.",
  colTotal: "Total",
  none: "—",
} as const;

type OKey = keyof typeof en;

const es = {
  eyebrow: "PharmaCenter · Admin",
  title: "Gastos generales",
  lede: "El alquiler, la mano de obra indirecta y los demás gastos detrás de cada cotización. Solo lectura por ahora: los cambios todavía se cargan a mano.",
  backToAdmin: "← Admin",
  loadFailed: "No se pudieron cargar los gastos generales: {detail}",

  today: "Hoy",
  quotesAsOf: "Las cotizaciones nuevas cuestan al",
  leadNote: "Plazo de {days} días: una cotización se calcula con las tarifas vigentes cuando se espera producir el trabajo, no el día en que se escribe. Los estados y días restantes se miden desde esa fecha.",
  leadMissing: "No hay plazo configurado, así que las cotizaciones nuevas usan las tarifas de hoy.",

  attention: "Para revisar",
  attentionNone: "Nada vencido, nada estimado.",
  aExpired: "{label}: ningún período cubre el {date}. Las cotizaciones usan el más cercano, que terminó el {to}.",
  aNotYet: "{label}: su primer período empieza el {from}, después del {date}. Las cotizaciones lo usan de todos modos.",
  aEnding: "{label}: el período vigente termina el {to}, {days} días después de la fecha de cotización.",
  aCam: "{label}: el CAM todavía es una estimación.",
  aStepped: "{label}: las cotizaciones ya usan el período que empieza el {from} ({quote}/mes). La tarifa de hoy es {today}/mes.",

  gRent: "Alquiler y CAM",
  gIndirect: "Mano de obra indirecta",
  gOther: "Otros gastos",

  colItem: "Concepto",
  colMonthly: "Mensual en cotizaciones",
  colDetail: "Detalle",
  colBand: "Período",
  colSource: "Fuente",
  colVerified: "Verificado",
  colStatus: "Estado",

  base: "base {v}",
  cam: "CAM {v}",
  camEst: "CAM {v} (estimado)",
  hourly: "{qty} × {rate}/h × {hours} h",
  salary: "{qty} × {rate}/mes",
  burden: "+ {tax}% impuestos, {wc}% WC",
  qb: "QB {acct}",
  open: "sin fin",
  differsToday: "Hoy: {v}/mes",
  history: "Todos los períodos ({n})",

  sCurrent: "vigente",
  sExpired: "vencido",
  sNotYet: "aún no",

  sharesTitle: "Parte de cada concepto cargada a cada línea",
  sharesNote: "Estos porcentajes no tienen fechas. Cambiar uno recalcula toda cotización nueva desde ese momento, sin registro del valor anterior. Por eso siguen en solo lectura hasta que tengan sus propios períodos.",
  colTotal: "Total",
  none: "—",
} satisfies Record<OKey, string>;

export type OT = (key: OKey, vars?: Record<string, string | number>) => string;

export function makeOT(lang: Lang): OT {
  const dict: Record<OKey, string> = lang === "es" ? es : en;
  return (key, vars) => {
    let out = dict[key] ?? en[key] ?? key;
    if (vars) for (const [k, v] of Object.entries(vars)) out = out.replace(`{${k}}`, String(v));
    return out;
  };
}
