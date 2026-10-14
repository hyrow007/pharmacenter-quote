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

export type GrossSource = "sheet" | "fishbowl" | "manual";

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
const EACH_UNITS = new Set(["ea", "each"]);
const THOUSAND_RE = /^(thousand|per thousand|1000|1,000|m units?|millar|mil)$/i;

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
};

export function emptyRollup(): Rollup {
  return { entries: 0, finished: 0, gross: 0, manHours: 0, grossMissing: 0, grossManHours: 0 };
}

export function addToRollup(r: Rollup, e: YieldEntry): Rollup {
  r.entries += 1;
  r.finished += e.finished_units;
  const mh = e.man_hours ?? (e.people !== null && e.hours !== null ? e.people * e.hours : null);
  if (mh !== null) r.manHours += mh;
  if (e.gross_total !== null) {
    r.gross += e.gross_total;
    if (mh !== null) r.grossManHours += mh;
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
// Margin report shows for the sales-order line -- line price minus line cost
// (soitem.totalPrice - soitem.totalCost) -- divided down to one finished unit.
// That report is where the packaging sheet's "Projected Gross" was read from.
//
// Dividing down needs the line's unit, because qty_ordered is counted in it
// ("Each" is 1; anything else is unknown -- see unitFactor). An unknown unit,
// a line synced before total_cost was carried, or a zero quantity makes the
// gross unknown. It never falls back to the bare price.
export function lineMarginEach(line: {
  total_price: number | null;
  total_cost: number | null;
  qty_ordered: number | null;
  unit_factor: number | null;
}): { cost: number | null; gross: number | null } {
  const { total_price, total_cost, qty_ordered, unit_factor } = line;
  if (total_cost === null || total_price === null || !qty_ordered || !unit_factor) return { cost: null, gross: null };
  const units = qty_ordered * unit_factor;
  const cost = total_cost / units;
  const gross = (total_price - total_cost) / units;
  return { cost: Math.round(cost * 1e6) / 1e6, gross: Math.round(gross * 1e6) / 1e6 };
}
