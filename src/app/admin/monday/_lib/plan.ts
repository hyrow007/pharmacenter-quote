// The push planner: turns a reconciler report into the list of things to do.
// Pure, like reconcile.ts. The executor (push.ts) carries the list out.
//
// Rules, as decided with the user on 2026-10-26 (claude/monday-reconciler.md):
//   - Missing orders, estimates included, are CREATED on the Open board.
//   - Fulfilled orders on the Open board are MOVED to the Fulfilled board.
//   - Cancelled / voided orders on the Open board are ARCHIVED (Monday keeps an
//     archived item, files included, restorable for 30 days). Never deleted.
//   - Matched items are RENAMED to the exact Fishbowl number.
//   - Customer, Customer PO and Owner are UPDATED when they disagree. No other
//     column is ever written: people type into some of them (Files at least).
//   - Every matched item is LINKED in monday_so_links (our database, never
//     Fishbowl), so a duplicated Fishbowl order cannot inherit an "already sent"
//     marker the way it did with LilyPad.
// Deliberately left for a person, and only reported:
//   orders on more than one item, items matching no order, open orders sitting
//   on the Fulfilled board, and anything on the Fulfilled board that disagrees.

import { sameOwner, type BoardItem, type BoardKey, type MirrorRow, type Report } from "./reconcile";

export type Values = Partial<Record<"customer" | "customer po" | "owner", string>>;

export type Action =
  | { kind: "create"; so: string; values: Values }
  | { kind: "move"; so: string; itemId: string }
  | { kind: "archive"; so: string; itemId: string; lastStatus: string | null }
  | { kind: "rename"; so: string; itemId: string; board: BoardKey; from: string }
  | { kind: "update"; so: string; itemId: string; board: BoardKey; values: Values; before: Values }
  | { kind: "link"; so: string; itemId: string; board: BoardKey };

/** Monday writes, i.e. everything except recording a link in our own table. */
export function mondayWrites(actions: Action[]): number {
  return actions.filter((a) => a.kind !== "link").length;
}

/**
 * Fishbowl stores the salesman's username ("Jairo"); LilyPad wrote the full
 * name ("Jairo Osorno"). Learn the full name from items that already agree,
 * so new items get the same form as the old ones.
 */
export function ownerNames(report: Report): Map<string, string> {
  const names = new Map<string, string>();
  for (const p of report.pairs) {
    const user = (p.mirror?.salesman ?? "").trim();
    const board = (p.item?.cols["owner"] ?? "").trim();
    if (!user || !board || !sameOwner(user, board)) continue;
    // Keep the longest form seen: "Jairo Osorno" over a stray "Jairo".
    const seen = names.get(user.toLowerCase());
    if (!seen || board.length > seen.length) names.set(user.toLowerCase(), board);
  }
  return names;
}

function wantedValues(r: MirrorRow, owners: Map<string, string>): Values {
  const user = (r.salesman ?? "").trim();
  return {
    customer: (r.customer_name ?? "").trim(),
    "customer po": (r.customer_po ?? "").trim(),
    owner: owners.get(user.toLowerCase()) ?? user,
  };
}

export function plan(report: Report, linkedItemIds: Set<string>): Action[] {
  const out: Action[] = [];
  const owners = ownerNames(report);
  const doubled = new Set(report.duplicates.map((d) => d.so));

  for (const r of report.missing) {
    if (!r.mirror || doubled.has(r.so)) continue;
    out.push({ kind: "create", so: r.so, values: wantedValues(r.mirror, owners) });
  }

  // Moves and archives first, so later renames and updates are not wasted on
  // items that are about to leave the Open board.
  const leaving = new Set<string>();
  for (const r of report.fulfilledOnOpen) {
    if (!r.item || doubled.has(r.so)) continue;
    out.push({ kind: "move", so: r.so, itemId: r.item.id });
    leaving.add(r.item.id);
  }
  for (const r of report.closedOnOpen) {
    if (!r.item || doubled.has(r.so)) continue;
    out.push({ kind: "archive", so: r.so, itemId: r.item.id, lastStatus: r.mirror?.status_name ?? null });
    leaving.add(r.item.id);
  }

  for (const p of report.pairs) {
    const item = p.item as BoardItem;
    if (!p.mirror || doubled.has(p.so)) continue;
    // A move or archive records its own link; linking it here as well would
    // run after it and undo the board change or the archive stamp.
    if (leaving.has(item.id)) continue;
    if (!linkedItemIds.has(item.id)) {
      out.push({ kind: "link", so: p.so, itemId: item.id, board: item.board });
    }
    if (item.name.trim() !== p.so) {
      out.push({ kind: "rename", so: p.so, itemId: item.id, board: item.board, from: item.name });
    }
  }

  // Column fixes: Open board only. The Fulfilled board is history.
  const byItem = new Map<string, { so: string; item: BoardItem; values: Values; before: Values }>();
  for (const d of report.fieldDiffs) {
    if (d.item.board !== "open" || doubled.has(d.so) || leaving.has(d.item.id)) continue;
    // Never blank a board value: an empty Fishbowl field may simply never have
    // been filled in, while someone typed it on the board.
    if (!d.fishbowl.trim()) continue;
    const key = d.field === "customer_po" ? "customer po" : d.field;
    const entry = byItem.get(d.item.id) ?? { so: d.so, item: d.item, values: {}, before: {} };
    entry.values[key] = d.field === "owner" ? owners.get(d.fishbowl.trim().toLowerCase()) ?? d.fishbowl : d.fishbowl;
    entry.before[key] = d.board;
    byItem.set(d.item.id, entry);
  }
  for (const e of byItem.values()) {
    out.push({ kind: "update", so: e.so, itemId: e.item.id, board: e.item.board, values: e.values, before: e.before });
  }
  return out;
}
