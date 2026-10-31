// The Fishbowl → Monday reconciler. Pure functions only: no I/O, no clock, so
// the same inputs always give the same report and it can be tested offline.
//
// READ-ONLY BY DESIGN. This module decides what is wrong; it never decides
// what to do about it. The push (not built yet) will consume this report, and
// nothing writes to Monday until this report has been checked against reality.
// See claude/monday-integration.md, "Build the audit first".
//
// How the mirror is read, and why it can tell fulfilled from cancelled:
//   - pharmacenter-sync sends Estimate (10), Issued (20), In Progress (25),
//     and, since 5c192bf, Fulfilled (60) for 365 days after completion.
//   - Every row in one run carries that run's sync_run_id. Anything else
//     (Void, Cancelled, Closed Short, Expired) stops arriving, keeps the
//     status it had when last seen, and is flipped is_open=false.
//   So: in the latest run with status 60 = fulfilled; NOT in the latest run =
//   closed some other way (cancelled, void, closed short, expired, or
//   fulfilled more than a year ago).

export type MirrorRow = {
  so_number: string;
  status_id: number | null;
  status_name: string | null;
  is_open: boolean;
  customer_name: string | null;
  customer_po: string | null;
  vendor_po: string | null;
  date_completed: string | null;
  salesman: string | null;
  sync_run_id: string | null;
  synced_at: string | null;
  date_last_modified: string | null;
};

export type BoardKey = "open" | "fulfilled";

export type BoardItem = {
  id: string;
  name: string;
  board: BoardKey;
  url: string;
  // Column values keyed by lower-cased column TITLE. Monday column ids are
  // generated per board, so titles are the stable handle.
  cols: Record<string, string | null>;
};

// "link" = matched through monday_so_links, the push's own record.
export type MatchType = "link" | "exact" | "format" | "prefix";

export type Row = {
  so: string; // the Fishbowl SO number, or the board item name when unmatched
  mirror: MirrorRow | null;
  item: BoardItem | null;
  matchType: MatchType | null;
};

export type FieldDiff = {
  so: string;
  item: BoardItem;
  field: "customer" | "customer_po" | "vendor_po" | "owner";
  fishbowl: string;
  board: string;
};

export type Report = {
  latestRunId: string | null;
  latestRunAt: string | null;
  fulfilledInMirror: number;
  counts: { mirrorWanted: number; openItems: number; fulfilledItems: number };
  // The four categories from the spec, split where the data allows.
  missing: Row[]; //           should be on Open, is on neither board
  openOnFulfilled: Row[]; //   still open in Fishbowl, but on the Fulfilled board
  fulfilledOnOpen: Row[]; //   on Open, fulfilled in Fishbowl -> should move
  closedOnOpen: Row[]; //      on Open, closed in Fishbowl without being fulfilled
  unknownOnOpen: Row[]; //     on Open, not in the mirror at all
  fieldDiffs: FieldDiff[]; //  matched, but a column disagrees
  // Every order matched to exactly one item: what the push works from.
  pairs: Row[];
  // Supporting evidence.
  prefixMatches: Row[]; //     matched only by ignoring format or the M prefix
  duplicates: { so: string; items: BoardItem[] }[];
  fulfilledNeither: Row[]; //  fulfilled since go-live, on neither board
};

const WANTED_ON_OPEN = new Set([10, 20, 25]); // Estimate, Issued, In Progress
const FULFILLED = 60;
// LilyPad went live in late January 2026. Fulfilled orders older than that
// were never expected on either board.
export const GO_LIVE = "2026-01-27";

// "so 14653", "M-14653", "m14653" all mean M14653; "M-RD13790" means M-RD-13790.
export function formatKey(raw: string): string {
  return raw
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "")
    .replace(/^SO[#:-]?/, "")
    .replace(/^M-?RD-?/, "MRD-")
    .replace(/^M-(?=\d)/, "M");
}

// The number with any M / M-RD prefix removed: M14653 -> 14653. Used last,
// and only when unambiguous, because 14653 and M14653 COULD be different
// orders. Every such match is listed so a person can confirm it.
export function bareKey(raw: string): string {
  return formatKey(raw).replace(/^MRD-|^M/, "");
}

function norm(v: string | null | undefined): string {
  return (v ?? "").trim().replace(/\s+/g, " ").toLowerCase();
}

function index<T>(rows: T[], key: (r: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const r of rows) {
    const k = key(r);
    if (!k) continue;
    const list = m.get(k);
    if (list) list.push(r);
    else m.set(k, [r]);
  }
  return m;
}

export function latestRun(mirror: MirrorRow[]): { id: string | null; at: string | null } {
  let best: MirrorRow | null = null;
  for (const r of mirror) {
    if (!r.synced_at) continue;
    if (!best || r.synced_at > (best.synced_at ?? "")) best = r;
  }
  return { id: best?.sync_run_id ?? null, at: best?.synced_at ?? null };
}

/** Board-item -> mirror-row match, strongest rule first. */
function matchItem(
  item: BoardItem,
  links: Map<string, string>,
  exact: Map<string, MirrorRow[]>,
  byFormat: Map<string, MirrorRow[]>,
  byBare: Map<string, MirrorRow[]>,
): { row: MirrorRow; type: MatchType } | null {
  const linked = links.get(item.id);
  if (linked) {
    const l = exact.get(linked);
    if (l?.length === 1) return { row: l[0], type: "link" };
  }
  const name = item.name.trim();
  const e = exact.get(name);
  if (e?.length === 1) return { row: e[0], type: "exact" };
  const f = byFormat.get(formatKey(name));
  if (f?.length === 1) return { row: f[0], type: "format" };
  const b = byBare.get(bareKey(name));
  if (b?.length === 1) return { row: b[0], type: "prefix" };
  return null;
}

/** links: Monday item id -> SO number, from monday_so_links. Optional. */
export function reconcile(
  mirror: MirrorRow[],
  items: BoardItem[],
  links: Map<string, string> = new Map(),
): Report {
  const run = latestRun(mirror);
  const inLatest = (r: MirrorRow) => run.id !== null && r.sync_run_id === run.id;

  const exact = index(mirror, (r) => r.so_number.trim());
  const byFormat = index(mirror, (r) => formatKey(r.so_number));
  const byBare = index(mirror, (r) => bareKey(r.so_number));

  // Which board items landed on which mirror row.
  const itemsBySo = new Map<string, { item: BoardItem; type: MatchType }[]>();
  const unmatched: BoardItem[] = [];
  for (const item of items) {
    if (!item.name.trim()) continue;
    const m = matchItem(item, links, exact, byFormat, byBare);
    if (!m) {
      unmatched.push(item);
      continue;
    }
    const list = itemsBySo.get(m.row.so_number) ?? [];
    list.push({ item, type: m.type });
    itemsBySo.set(m.row.so_number, list);
  }

  const report: Report = {
    latestRunId: run.id,
    latestRunAt: run.at,
    fulfilledInMirror: 0,
    counts: {
      mirrorWanted: 0,
      openItems: items.filter((i) => i.board === "open").length,
      fulfilledItems: items.filter((i) => i.board === "fulfilled").length,
    },
    missing: [],
    openOnFulfilled: [],
    fulfilledOnOpen: [],
    closedOnOpen: [],
    unknownOnOpen: [],
    fieldDiffs: [],
    pairs: [],
    prefixMatches: [],
    duplicates: [],
    fulfilledNeither: [],
  };

  for (const r of mirror) {
    const latest = inLatest(r);
    const fulfilled = latest && r.status_id === FULFILLED;
    const wanted = latest && r.status_id !== null && WANTED_ON_OPEN.has(r.status_id);
    if (fulfilled) report.fulfilledInMirror++;
    if (wanted) report.counts.mirrorWanted++;

    const hits = itemsBySo.get(r.so_number) ?? [];
    for (const h of hits) {
      if (h.type === "format" || h.type === "prefix") {
        report.prefixMatches.push({ so: r.so_number, mirror: r, item: h.item, matchType: h.type });
      }
    }
    if (hits.length > 1) {
      report.duplicates.push({ so: r.so_number, items: hits.map((h) => h.item) });
    } else if (hits.length === 1) {
      report.pairs.push(row(r, hits[0]));
    }

    const onOpen = hits.filter((h) => h.item.board === "open");
    const onFulfilled = hits.filter((h) => h.item.board === "fulfilled");

    if (wanted) {
      if (onOpen.length > 0) {
        for (const h of onOpen) report.fieldDiffs.push(...diffFields(r, h.item));
      } else if (onFulfilled.length > 0) {
        report.openOnFulfilled.push(row(r, onFulfilled[0]));
      } else {
        report.missing.push({ so: r.so_number, mirror: r, item: null, matchType: null });
      }
      continue;
    }

    for (const h of onOpen) {
      if (fulfilled) report.fulfilledOnOpen.push(row(r, h));
      else if (!latest) report.closedOnOpen.push(row(r, h));
    }

    if (
      fulfilled &&
      hits.length === 0 &&
      (r.date_last_modified ?? "") >= GO_LIVE
    ) {
      report.fulfilledNeither.push({ so: r.so_number, mirror: r, item: null, matchType: null });
    }
  }

  for (const item of unmatched) {
    if (item.board === "open") {
      report.unknownOnOpen.push({ so: item.name.trim(), mirror: null, item, matchType: null });
    }
  }

  const bySo = (a: Row, b: Row) => a.so.localeCompare(b.so, "en", { numeric: true });
  for (const list of [
    report.missing,
    report.openOnFulfilled,
    report.fulfilledOnOpen,
    report.closedOnOpen,
    report.unknownOnOpen,
    report.prefixMatches,
    report.fulfilledNeither,
  ]) {
    list.sort(bySo);
  }
  report.fieldDiffs.sort((a, b) => a.so.localeCompare(b.so, "en", { numeric: true }));
  return report;
}

function row(r: MirrorRow, h: { item: BoardItem; type: MatchType }): Row {
  return { so: r.so_number, mirror: r, item: h.item, matchType: h.type };
}

// Board column titles -> mirror fields. Date is not compared: on the Open
// board it is empty by design (LilyPad filled it with DateCompleted on move).
const COMPARED: { field: FieldDiff["field"]; title: string; pick: (r: MirrorRow) => string | null }[] = [
  { field: "customer", title: "customer", pick: (r) => r.customer_name },
  { field: "customer_po", title: "customer po", pick: (r) => r.customer_po },
  { field: "vendor_po", title: "vendor po", pick: (r) => r.vendor_po },
  { field: "owner", title: "owner", pick: (r) => r.salesman },
];

export function diffFields(r: MirrorRow, item: BoardItem): FieldDiff[] {
  const out: FieldDiff[] = [];
  for (const c of COMPARED) {
    if (!(c.title in item.cols)) continue; // column not on this board
    const fb = c.pick(r) ?? "";
    const board = item.cols[c.title] ?? "";
    if (norm(fb) === norm(board)) continue;
    if (c.field === "owner" && sameOwner(fb, board)) continue;
    out.push({ so: r.so_number, item, field: c.field, fishbowl: fb, board });
  }
  return out;
}

// The mirror carries Fishbowl's salesman USERNAME ("Jairo", "admin"); LilyPad
// wrote SalesmanFullName ("Jairo Osorno", "Administrator Administrator"). The
// first live run flagged all 49 owners for that alone. Same person = the board
// name starts with the username, or both are the admin account.
export function sameOwner(fishbowl: string, board: string): boolean {
  const fb = norm(fishbowl);
  const b = norm(board);
  if (!fb) return false;
  const isAdmin = (v: string) => v === "admin" || v.startsWith("administrator");
  if (isAdmin(fb) && isAdmin(b)) return true;
  return b === fb || b.startsWith(fb + " ");
}
