import type { SupabaseClient } from "@supabase/supabase-js";

// The order the Orders board puts sales orders in: grouped by customer name,
// then by SO number within the customer. The SO detail page's Previous /
// Next buttons walk this same sequence, which is the order the weekly
// meeting works through -- so the two must not drift. One definition, used
// by both.

/** Statuses the board treats as in flight (10 Estimate / 20 Issued / 25 In Progress). */
export const OPEN_STATUS_IDS = [10, 20, 25];

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
    // Fishbowl decides what is still open; a closed SO keeps its last-known
    // status label, so status alone would keep it in the sequence.
    .eq("is_open", true)
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
