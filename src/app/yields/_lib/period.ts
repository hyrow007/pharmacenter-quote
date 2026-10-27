import { addDays, isIsoDate } from "./model";

// The snapshot panel's time period. Everything is relative to the date picked
// at the top of the log page, so "this week" on an old date means that week.
export const SNAP_KINDS = ["day", "week", "7d", "month", "lastmonth", "custom"] as const;
export type SnapKind = (typeof SNAP_KINDS)[number];

export function isSnapKind(v: unknown): v is SnapKind {
  return typeof v === "string" && (SNAP_KINDS as readonly string[]).includes(v);
}

function monthStart(iso: string): string {
  return iso.slice(0, 8) + "01";
}
function monthEnd(iso: string): string {
  const d = new Date(iso.slice(0, 8) + "01T12:00:00Z");
  d.setUTCMonth(d.getUTCMonth() + 1);
  d.setUTCDate(0);
  return d.toISOString().slice(0, 10);
}

// "7d" is resolved by the caller (it needs the dates that have entries);
// here it falls back to the date itself.
export function snapRange(
  kind: SnapKind,
  date: string,
  from?: string | null,
  to?: string | null,
): { from: string; to: string } {
  switch (kind) {
    case "day":
    case "7d":
      return { from: date, to: date };
    case "week": {
      const wd = new Date(date + "T12:00:00Z").getUTCDay(); // 0 = Sunday
      const monday = addDays(date, wd === 0 ? -6 : 1 - wd);
      return { from: monday, to: addDays(monday, 6) };
    }
    case "month":
      return { from: monthStart(date), to: monthEnd(date) };
    case "lastmonth": {
      const prev = addDays(monthStart(date), -1);
      return { from: monthStart(prev), to: monthEnd(prev) };
    }
    case "custom": {
      const f = isIsoDate(from) ? from : date;
      const t = isIsoDate(to) ? to : date;
      return f <= t ? { from: f, to: t } : { from: t, to: f };
    }
  }
}
