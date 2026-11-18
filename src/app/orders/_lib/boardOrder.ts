import type { SupabaseClient } from "@supabase/supabase-js";

// The order the Orders board puts sales orders in: grouped by customer name,
// then by SO number within the customer. The SO detail page's Previous /
// Next buttons walk this same sequence, which is the order the weekly
// meeting works through -- so the two must not drift. One definition, used
// by both.

/** Statuses the board treats as in flight (10 Estimate / 20 Issued / 25 In Progress). */
export const OPEN_STATUS_IDS = [10, 20, 25];

/** Fishbowl's Estimate status. Quoted work, not committed work. */
export const ESTIMATE_STATUS_ID = 10;

/**
 * How the board decides an SO is still live, in one place because the landing
 * page and the Prev/Next sequence must agree.
 *
 * Committed orders (20 Issued / 25 In Progress) go by `is_open`: Fishbowl
 * stops sending an order once it is Fulfilled / Closed Short / Void, and the
 * sync's finalize step flips the flag. It never rewrites `status_id`, so
 * status alone would keep closed orders on the board forever -- 17 of them as
 * of 2026-09-23, and 9 again when this was written.
 *
 * Estimates cannot use that flag at all. The agent sets
 * `is_open = statusId in (20, 25)`, so an estimate's flag is false by design
 * while it is perfectly current, and false again once it is abandoned. The
 * signal that does separate them is freshness: live estimates are re-sent on
 * every run, so one seen in the last day is current, and a quote that dies in
 * Fishbowl simply stops arriving and ages off the board on its own. No expiry
 * rule to invent, and nothing to flip when someone finally closes it.
 *
 * 26 hours rather than 24: the nightly run is the floor, and a late or
 * skipped run should not blank the estimates.
 */
export const ESTIMATE_FRESH_HOURS = 26;

export function estimateFreshCutoff(now: number = Date.now()): string {
  return new Date(now - ESTIMATE_FRESH_HOURS * 60 * 60 * 1000).toISOString();
}

/** PostgREST `or` predicate pairing the two rules above. */
export function liveSoFilter(cutoffIso: string = estimateFreshCutoff()): string {
  return `is_open.eq.true,and(status_id.eq.${ESTIMATE_STATUS_ID},synced_at.gte.${cutoffIso})`;
}

/**
 * SO numbers sort by their leading digit run, not as plain strings: 14746-1
 * must stay next to 14746 rather than sorting as 147461 (after 14870).
 * Purely-numeric SOs come before alpha-prefixed ones ("M-14221"), and the
 * raw string breaks ties so 14746, 14746-1, 14746-2 land in order.
 */
export function compareSoNumbers(a: string, b: string): number {
  const aStr = String(a);
  const bStr = String(b);
  const aLead = aStr.match(/^\d+/);
  const bLead = bStr.match(/^\d+/);
  const aNum = aLead ? parseInt(aLead[0], 10) : NaN;
  const bNum = bLead ? parseInt(bLead[0], 10) : NaN;
  if (Number.isFinite(aNum) && !Number.isFinite(bNum)) return -1;
  if (!Number.isFinite(aNum) && Number.isFinite(bNum)) return 1;
  if (Number.isFinite(aNum) && Number.isFinite(bNum) && aNum !== bNum) {
    return aNum - bNum;
  }
  return aStr.localeCompare(bStr);
}

export type BoardEntry = { so_number: string; customer_name: string | null };

/** Every open SO in board order: customer A-Z, then SO number. */
export async function loadBoardOrder(
  supabase: SupabaseClient,
): Promise<BoardEntry[]> {
  const { data } = await supabase
    .from("fishbowl_sales_orders")
    .select("so_number, customer_name")
    .in("status_id", OPEN_STATUS_IDS)
    // Committed orders by is_open, estimates by freshness -- see liveSoFilter.
    .or(liveSoFilter())
    .limit(500);

  return ((data ?? []) as unknown as BoardEntry[]).slice().sort((x, y) => {
    const cx = (x.customer_name ?? "").trim();
    const cy = (y.customer_name ?? "").trim();
    if (cx !== cy) return cx.localeCompare(cy);
    return compareSoNumbers(x.so_number, y.so_number);
  });
}

/** Where this SO sits in the sequence, and what is either side of it. */
export function neighbours(
  entries: BoardEntry[],
  soNumber: string,
): {
  index: number;
  total: number;
  prev: BoardEntry | null;
  next: BoardEntry | null;
} {
  const i = entries.findIndex((e) => e.so_number === soNumber);
  return {
    index: i,
    total: entries.length,
    prev: i > 0 ? entries[i - 1] : null,
    next: i >= 0 && i < entries.length - 1 ? entries[i + 1] : null,
  };
}
