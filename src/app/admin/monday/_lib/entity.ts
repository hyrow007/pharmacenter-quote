// What differs between pushing sales orders and purchase orders to Monday.
// Everything else (reconcile, plan, push, the safety checks, the run log) is
// shared, so a rule fixed for one is fixed for both.
//
// Fishbowl uses the same status numbers for both: 10 Estimate, 20 Issued,
// 25 In Progress (SO) / Partial (PO), 60 Fulfilled. Purchase orders added
// 2026-11-09 at the user's request; decisions in claude/monday-reconciler.md.

export type EntityKey = "so" | "po";

export type EntitySpec = {
  key: EntityKey;
  /** Mirror table and the column that holds the order number. */
  mirrorTable: "fishbowl_sales_orders" | "fishbowl_purchase_orders";
  numberColumn: "so_number" | "po_number";
  /** Our own "already sent" record (never Fishbowl). */
  linkTable: "monday_so_links" | "monday_po_links";
  /** Vercel env var that switches this entity's writes on. Unset = dry run. */
  liveEnv: "MONDAY_PUSH_LIVE" | "MONDAY_PO_PUSH_LIVE";
  /** Status label set on the item when it moves to the second board. */
  movedStatus: string;
  /** Most Monday writes one run may make before it refuses (creates excluded). */
  maxWrites: number;
};

export const ENTITIES: Record<EntityKey, EntitySpec> = {
  so: {
    key: "so",
    mirrorTable: "fishbowl_sales_orders",
    numberColumn: "so_number",
    linkTable: "monday_so_links",
    liveEnv: "MONDAY_PUSH_LIVE",
    movedStatus: "Fulfilled",
    maxWrites: 60,
  },
  po: {
    key: "po",
    mirrorTable: "fishbowl_purchase_orders",
    numberColumn: "po_number",
    linkTable: "monday_po_links",
    liveEnv: "MONDAY_PO_PUSH_LIVE",
    movedStatus: "Received",
    maxWrites: 60,
  },
};

/**
 * Creates per run. Creating is never destructive, so it does not count toward
 * maxWrites; instead it is spread out, so a new board fills over a few runs
 * rather than one run running past Vercel's 60-second limit.
 */
export const MAX_CREATES_PER_RUN = 25;

/**
 * The PO boards' columns. Created on both boards with identical titles and
 * types, because a move maps columns by title AND type.
 */
export const PO_COLUMNS: { title: string; type: "text" | "long_text" | "date" | "status" }[] = [
  { title: "Vendor", type: "text" },
  { title: "Linked SOs", type: "text" },
  { title: "Issue date", type: "date" },
  { title: "Items", type: "long_text" },
  { title: "Status", type: "status" },
  { title: "Date", type: "date" },
];

export const PO_BOARD_NAMES = {
  open: "Open Purchase Orders",
  fulfilled: "Received Purchase Orders",
} as const;

/** The workspace the SO boards live in; the PO boards go beside them. */
export const MONDAY_WORKSPACE_ID = 13384272;
