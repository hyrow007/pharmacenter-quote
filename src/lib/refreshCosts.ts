/**
 * Refresh a costing board's Fishbowl costs on demand.
 *
 * WHY THIS EXISTS. The component picker copies a part's Fishbowl costs ONTO
 * the saved line at pick time; nothing re-reads them afterwards. That is
 * deliberate — a quote you sent last month should still show the numbers you
 * sent it with, not silently re-price when someone reopens it. The cost of
 * that choice is a line that keeps a figure Fishbowl has since corrected: on
 * 2026-09-20 every packaging part had a null last-order cost, so every line
 * picked before the sync fix carries that null and reads "—" forever on the
 * Fish Bowl (Last Order) source.
 *
 * So the refresh is a BUTTON, never an effect: the board pulls current costs
 * only when a human asks, reports what moved, and leaves it unsaved until
 * they save. Freshness becomes a decision with a diff attached instead of
 * something that happens behind the quote's back.
 */
import type { BomLine } from "./bottleCosting";

/** One row of /api/packaging-components — the same shape the picker reads. */
export type FishbowlCostRow = {
  fp_code: string;
  name: string;
  owner: string;
  effective_cost_per_unit: number | null;
  cost_status: string;
  last_order_cost_per_unit: number | null;
  inventory_cost_per_purchase_unit: number | null;
  last_order_cost_per_purchase_unit: number | null;
  inventory_cost_uom: string | null;
  active?: boolean | null;
};

export type CostRefreshChange = {
  fpCode: string;
  name: string;
  /** Which of the two Fishbowl figures moved. */
  field: "inventory" | "last order";
  before: number | null;
  after: number | null;
};

export type CostRefreshResult = {
  bom: BomLine[];
  changes: CostRefreshChange[];
  /** Lines that carried an fp_code and were therefore checked. */
  checked: number;
  /** Codes the API returned nothing for — deactivated or renumbered parts. */
  missing: string[];
};

/**
 * Look up exact parts by code. Custom (typed-in) parts have no Fishbowl
 * record and are never sent.
 */
export async function fetchFishbowlCosts(
  codes: string[],
): Promise<Map<string, FishbowlCostRow>> {
  const wanted = [...new Set(codes.map((c) => c.trim()).filter(Boolean))];
  const out = new Map<string, FishbowlCostRow>();
  if (!wanted.length) return out;

  // Chunked so a board with a long BOM cannot build a URL the server refuses.
  const CHUNK = 40;
  for (let i = 0; i < wanted.length; i += CHUNK) {
    const slice = wanted.slice(i, i + CHUNK);
    const r = await fetch(
      `/api/packaging-components?codes=${encodeURIComponent(slice.join(","))}`,
    );
    if (!r.ok) throw new Error(`Fishbowl lookup failed (${r.status})`);
    const j = (await r.json()) as { ok?: boolean; rows?: FishbowlCostRow[] };
    if (!j.ok) throw new Error("Fishbowl lookup failed");
    for (const row of j.rows ?? []) out.set(row.fp_code.toUpperCase(), row);
  }
  return out;
}

const near = (a: number | null, b: number | null) => {
  if (a === null || b === null) return a === b;
  return Math.abs(a - b) < 1e-9;
};

/**
 * Apply fetched rows to a BOM, mirroring the picker's onPick exactly — the
 * same web-priced branch, the same customer-asset zeroing — so a refreshed
 * line is indistinguishable from a freshly picked one.
 *
 * `isWeb` marks rows whose per-each conversion is a job-level yield (pouch
 * film, blister film/foil) rather than a part property. On those the RAW
 * per-purchase-unit figures are the row's costs.
 */
export function refreshBomCosts(
  bom: BomLine[],
  rows: Map<string, FishbowlCostRow>,
  isWeb: (line: BomLine) => boolean,
): CostRefreshResult {
  const changes: CostRefreshChange[] = [];
  const missing: string[] = [];
  let checked = 0;

  const next = bom.map((line) => {
    // A typed-in part is priced by hand and has nothing to refresh against.
    if (!line.fpCode || line.customPart) return line;
    checked += 1;

    const row = rows.get(line.fpCode.toUpperCase());
    if (!row) {
      missing.push(line.fpCode);
      return line;
    }

    const rawInv = row.inventory_cost_per_purchase_unit ?? null;
    const webPriced =
      isWeb(line) && row.cost_status === "uom_unresolved" && rawInv !== null;

    const inventory = webPriced ? rawInv : (row.effective_cost_per_unit ?? null);
    const lastOrder = webPriced
      ? (row.last_order_cost_per_purchase_unit ?? null)
      : (row.last_order_cost_per_unit ?? null);

    if (!near(line.inventoryCostPerUnit ?? line.costPerUnit ?? null, inventory))
      changes.push({
        fpCode: row.fp_code,
        name: row.name,
        field: "inventory",
        before: line.inventoryCostPerUnit ?? line.costPerUnit ?? null,
        after: inventory,
      });
    if (!near(line.lastOrderCostPerUnit ?? null, lastOrder))
      changes.push({
        fpCode: row.fp_code,
        name: row.name,
        field: "last order",
        before: line.lastOrderCostPerUnit ?? null,
        after: lastOrder,
      });

    return {
      ...line,
      // Fishbowl owns the name (baseline #7): a part renamed there should not
      // keep reading under its old description on a quote.
      name: row.name,
      costPerUnit: inventory,
      inventoryCostPerUnit: inventory,
      lastOrderCostPerUnit: lastOrder,
      costStatus: webPriced ? "ok" : (row.cost_status ?? "no_cost"),
      // A confirmation only ever applied to the $0 it was given. If the cost
      // is no longer 0, the tick is stale and must not carry forward.
      zeroCostConfirmed:
        inventory === 0 || lastOrder === 0 ? line.zeroCostConfirmed : false,
    } as BomLine;
  });

  return { bom: next, changes, checked, missing };
}
