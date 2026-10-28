// Shared, client-safe definitions for Yields: the line vocabulary, the row
// shape, and the arithmetic. No Supabase, no server imports -- the entry form
// runs this same code in the browser so what it previews is what gets saved.

import type { YKey } from "./i18n";

// line_key matches the overhead_* vocabulary (singular), so a yield row joins
// to its line's overhead without a mapping table. 'other' is the sheet's
// fifth value. Gummy manufacturing will add its own keys under area
// 'manufacturing' when it arrives.
export const LINES = ["blister", "bottle", "pouch", "sachet", "other"] as const;
export type LineKey = (typeof LINES)[number];
export const isLine = (v: unknown): v is LineKey =>
  typeof v === "string" && (LINES as readonly string[]).includes(v);
export const lineLabelKey = (l: string): YKey =>
  (isLine(l) ? `line_${l}` : "line_other") as YKey;

export type GrossSource = "sheet" | "fishbowl" | "manual" | "house" | "last";

// A run on a sales order whose customer is PharmaCenter itself is house-brand
// stock (FGBG and the like): production for our own shelf, sold later outside
// anything Yields sees. There is no sale, so there is no gross -- and that is
// not a gap to chase. Such entries are marked gross_source = 'house': they
// count toward units and man-hours, never toward gross or "missing".
export function isHouseCustomer(name: string | null | undefined): boolean {
  return /^\s*pharma\s*center\b/i.test(name ?? "");
}

export type YieldEntry = {
  id: string;
  area: string;
  run_date: string; // YYYY-MM-DD
  line_key: string;
  product_num: string;
  product_name: string | null;
  so_numbers: string[];
  is_multipack: boolean;
  units_per_pack: number | null;
  finished_units: number;
  single_units: number | null;
  people: number | null;
  hours: number | null;
  man_hours: number | null;
  unit_price: number | null;
  unit_cost: number | null;
  gross_per_unit: number | null;
  gross_source: GrossSource | null;
  gross_total: number | null;
  note: string | null;
  source: "app" | "sheet_import";
  created_by: string;
};

export const ENTRY_COLS =
  "id, area, run_date, line_key, product_num, product_name, so_numbers, is_multipack, " +
  "units_per_pack, finished_units, single_units, people, hours, man_hours, unit_price, " +
  "unit_cost, gross_per_unit, gross_source, gross_total, note, source, created_by";

// PostgREST returns numeric as number or string depending on size; normalise.
export function toNum(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

export function normalizeEntry(r: Record<string, unknown>): YieldEntry {
  return {
    ...(r as unknown as YieldEntry),
    so_numbers: Array.isArray(r.so_numbers) ? (r.so_numbers as string[]) : [],
    units_per_pack: toNum(r.units_per_pack),
    finished_units: toNum(r.finished_units) ?? 0,
    single_units: toNum(r.single_units),
    people: toNum(r.people),
    hours: toNum(r.hours),
    man_hours: toNum(r.man_hours),
    unit_price: toNum(r.unit_price),
    unit_cost: toNum(r.unit_cost),
    gross_per_unit: toNum(r.gross_per_unit),
    gross_total: toNum(r.gross_total),
  };
}

// "14866, 14867" / "9802/9951" / "10630-10631-10768" -> separate SOs, but
// "11766-3" stays whole: Fishbowl has SO numbers with a -N suffix ("14866-1"
// is a real, separate order). A hyphen splits only when every piece is itself
// a full order number.
export function parseSoNumbers(raw: string): string[] {
  const out: string[] = [];
  for (const piece of raw.split(/[\/,;&\s]+/)) {
    const p = piece.trim();
    if (!p) continue;
    const parts = p.split("-");
    if (parts.length > 1 && parts.every((x) => /^M?\d{4,}$/i.test(x))) out.push(...parts);
    else out.push(p);
  }
  return Array.from(new Set(out));
}

// Fishbowl SO lines for finished goods are priced per each (0.38) or per
// thousand (3,820 for something that sells at $3.82). The unit is READ from the
// line (soitem.uomId, carried by the sync since 2026-10-13), never guessed from
// the size of the number: an earlier version did, and would have reported
// PC-PK-0264 -- genuinely $951.96 each -- as $0.95.
//
// Only units known to be "one finished unit" or "a thousand of them" convert.
// Anything else -- an unrecognised unit, or a line synced before the unit was
// carried -- yields NO per-unit price, and the form says so and asks for one.
//
// Measured on the first sync that carried units (2026-10-13 21:43): of 142
// finished-good lines, 62 are "ea / Each", 43 are "un / Unit" and 37 have no
// unit. "Unit" is NOT one finished unit -- 1075 sells at 3,820 per "Unit" with
// 52 ordered, i.e. 52 thousand bottles at $3.82. So only "Each" counts as each;
// "Unit" and a missing unit are both unknown, and the form asks for the gross.
//
// UPDATE 2026-10-20: the user confirmed "Unit" ALWAYS means 1,000 in
// PharmaCenter's Fishbowl. Checked on 14866 / 0430: $2,680 per Unit, 2.124
// Units shipped against ~2,124 bottles logged -> $2.68 a bottle. So "un /
// Unit" now converts at 1,000. A line with NO unit is still unknown.
const EACH_UNITS = new Set(["ea", "each"]);
const THOUSAND_RE = /^(un|unit|units|thousand|per thousand|1000|1,000|m units?|millar|mil)$/i;

export type PriceUnit = { factor: number | null; label: string | null };
export function unitFactor(uom: string | null | undefined, uomName: string | null | undefined): PriceUnit {
  const code = (uom ?? "").trim().toLowerCase();
  const name = (uomName ?? "").trim();
  const label = name || code || null;
  if (!code && !name) return { factor: null, label: null };
  if (EACH_UNITS.has(code) || EACH_UNITS.has(name.toLowerCase())) return { factor: 1, label };
  if (THOUSAND_RE.test(name) || THOUSAND_RE.test(code)) return { factor: 1000, label };
  return { factor: null, label };
}

export function eachPrice(
  unitPrice: number | null,
  uom: string | null | undefined,
  uomName: string | null | undefined,
): { each: number | null; factor: number | null; unitLabel: string | null } {
  const { factor, label } = unitFactor(uom, uomName);
  if (unitPrice === null || !Number.isFinite(unitPrice) || factor === null) {
    return { each: null, factor, unitLabel: label };
  }
  return { each: unitPrice / factor, factor, unitLabel: label };
}

export function singlesFor(finished: number, multipack: boolean, perPack: number | null): number {
  return multipack && perPack && perPack > 0 ? finished * perPack : finished;
}

// ---- rollups --------------------------------------------------------------

export type Rollup = {
  entries: number;
  finished: number;
  gross: number; // known gross only
  manHours: number; // entries with both people and hours
  grossMissing: number; // entries with finished > 0 and no gross
  grossManHours: number; // man-hours on entries that HAVE gross -- the honest denominator
  house: number; // house-brand stock runs: no sale, so no gross, and not missing
  provisional: number; // entries carrying the last run's gross until their order ships
  singles: number; // single units packed (finished x units per pack for multipacks)
  revenue: number; // known revenue only: finished units x the SO price per finished unit
  revenueManHours: number; // man-hours on entries whose revenue is known
  revenueMissing: number; // entries with finished > 0 and no SO price
  revenueWithGross: number; // revenue on entries that also have a gross -- the margin % denominator
};

export function emptyRollup(): Rollup {
  return {
    entries: 0,
    finished: 0,
    gross: 0,
    manHours: 0,
    grossMissing: 0,
    grossManHours: 0,
    house: 0,
    provisional: 0,
    singles: 0,
    revenue: 0,
    revenueManHours: 0,
    revenueMissing: 0,
    revenueWithGross: 0,
  };
}

export function addToRollup(r: Rollup, e: YieldEntry): Rollup {
  r.entries += 1;
  r.finished += e.finished_units;
  const mh = e.man_hours ?? (e.people !== null && e.hours !== null ? e.people * e.hours : null);
  if (mh !== null) r.manHours += mh;
  r.singles += e.single_units ?? e.finished_units;
  // Revenue = finished units x the SO price per finished unit (known before the
  // order ships). House-brand stock is no sale: known, and $0.
  if (e.gross_source === "house") {
    if (mh !== null) r.revenueManHours += mh;
  } else if (e.unit_price !== null) {
    r.revenue += e.unit_price * e.finished_units;
    if (mh !== null) r.revenueManHours += mh;
  } else if (e.finished_units > 0) {
    r.revenueMissing += 1;
  }
  if (e.gross_total !== null) {
    r.gross += e.gross_total;
    if (e.unit_price !== null) r.revenueWithGross += e.unit_price * e.finished_units;
    if (e.gross_source === "last") r.provisional += 1;
    if (mh !== null) r.grossManHours += mh;
  } else if (e.gross_source === "house") {
    r.house += 1;
  } else if (e.finished_units > 0) {
    r.grossMissing += 1;
  }
  return r;
}

// Gross per man-hour over the entries that have BOTH. Dividing all known gross
// by all man-hours would understate it whenever some rows lack a price -- the
// exact state of every day since 2026-09-01.
export function grossPerManHour(r: Rollup): number | null {
  return r.grossManHours > 0 ? r.gross / r.grossManHours : null;
}

export function revenuePerManHour(r: Rollup): number | null {
  return r.revenueManHours > 0 ? r.revenue / r.revenueManHours : null;
}

export function grossPerManHourOf(e: YieldEntry): number | null {
  const mh = e.man_hours;
  return e.gross_total !== null && mh !== null && mh > 0 ? e.gross_total / mh : null;
}

// ---- formatting -----------------------------------------------------------

export function fmtInt(n: number | null, lang: string): string {
  return n === null ? "—" : Math.round(n).toLocaleString(lang === "es" ? "es-US" : "en-US");
}
export function fmtNum(n: number | null, lang: string, digits = 2): string {
  return n === null
    ? "—"
    : n.toLocaleString(lang === "es" ? "es-US" : "en-US", { maximumFractionDigits: digits });
}
export function fmtMoney(n: number | null, lang: string, digits = 0): string {
  return n === null
    ? "—"
    : n.toLocaleString(lang === "es" ? "es-US" : "en-US", {
        style: "currency",
        currency: "USD",
        minimumFractionDigits: digits,
        maximumFractionDigits: digits,
      });
}
export function fmtUnitMoney(n: number | null, lang: string): string {
  if (n === null) return "—";
  const digits = Math.abs(n) < 1 ? 3 : 2;
  return fmtMoney(n, lang, digits);
}

// ---- dates ----------------------------------------------------------------

export const TZ = "America/New_York";
export function todayInPlant(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date());
}
export function isIsoDate(s: unknown): s is string {
  return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s + "T12:00:00Z"));
}
export function addDays(iso: string, n: number): string {
  const d = new Date(iso + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
export function fmtDate(iso: string, lang: string, withWeekday = true): string {
  const d = new Date(iso + "T12:00:00Z");
  return d.toLocaleDateString(lang === "es" ? "es-US" : "en-US", {
    timeZone: "UTC",
    weekday: withWeekday ? "short" : undefined,
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

// ---- gross ---------------------------------------------------------------

// THE definition of gross per finished unit, in one place: what Fishbowl's own
// Margin report shows for the sales-order line -- its price minus the cost
// Fishbowl recorded when the line SHIPPED (soitem.totalCost, written from the
// shipment's cost layers at fulfillment; 0 before that). Verified 2026-10-13
// against the packaging sheet: M14381-1 / 1928 gives 6.48 - 3,432.52/2,048 =
// 4.80 per bag, 14610-2 / 1075 gives 1.11 per bottle -- the sheet's figures.
//
// Per finished unit needs the line's unit ("Each" only -- see unitFactor) and
// the shipped quantity. An unshipped line (cost 0), an unknown unit, or
// nothing shipped makes the gross unknown. Never the bare price.
export type SoItemLike = {
  product_num?: string | null;
  type_id?: number | null;
  unit_price?: unknown;
  total_cost?: unknown;
  qty_fulfilled?: unknown;
  uom?: string | null;
  uom_name?: string | null;
};
export function marginFromLine(it: SoItemLike): {
  each_price: number | null;
  each_cost: number | null;
  each_gross: number | null;
  unit_factor: number | null;
  unit_label: string | null;
} {
  const price = eachPrice(toNum(it.unit_price), it.uom, it.uom_name);
  const cost = toNum(it.total_cost);
  const shipped = toNum(it.qty_fulfilled);
  let each_cost: number | null = null;
  let each_gross: number | null = null;
  // A $0 line is an internal / no-charge order (e.g. our own FGBG brand on a
  // PharmaCenter SO): there is no sale, so price minus cost is not a margin.
  if (price.each !== null && price.each > 0 && price.factor && cost && cost > 0 && shipped && shipped > 0) {
    each_cost = Math.round((cost / (shipped * price.factor)) * 1e6) / 1e6;
    each_gross = Math.round((price.each - each_cost) * 1e6) / 1e6;
  }
  return { each_price: price.each, each_cost, each_gross, unit_factor: price.factor, unit_label: price.unitLabel };
}

// Of several SOs on one entry, the first that can price the product.
export function grossForEntry(
  productNum: string,
  soNumbers: string[],
  itemsBySo: Map<string, SoItemLike[]>,
): { so: string; each_price: number | null; each_cost: number | null; each_gross: number } | null {
  for (const so of soNumbers) {
    for (const it of itemsBySo.get(so) ?? []) {
      if (it.product_num !== productNum || !(it.type_id === 10 || it.type_id === 30)) continue;
      const m = marginFromLine(it);
      if (m.each_gross !== null) return { so, each_price: m.each_price, each_cost: m.each_cost, each_gross: m.each_gross };
    }
  }
  return null;
}

// ---- the log page's entry list --------------------------------------------

// How many working days (days with entries) the "Every entry" list shows.
export const DAY_OPTIONS = ["5", "10", "20", "30", "60", "90", "all"] as const;
export const DEFAULT_DAYS = "10";
