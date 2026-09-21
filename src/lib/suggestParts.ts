/**
 * Default the Fishbowl part on a costing board's empty rows.
 *
 * The picker is a suggestion engine and the human still confirms — but a
 * rep should not have to hunt for a part the product's own name identifies.
 * PharmaCenter names customer-specific packaging after the product
 * ("Restorz Restful Sleep Gummies Preformed Bag", "HealthRight Products LLC
 * / Restorz Shipper Box (6 x 5 x 4)"), so the product name, the row's slot
 * and the packaging spec (master-box size, bulk code) pick the part with
 * high confidence when exactly one part stands out.
 *
 * Only EMPTY rows are touched (no part, not typed in), a row is filled only
 * when one candidate clearly wins, and the board marks every default
 * "auto-matched — confirm" until a human picks. A wrong confident answer is
 * worse than a blank, so ambiguity leaves the row blank.
 */
import type { PackagingSlot } from "./bottleCosting";

export type SuggestLine = {
  id: string;
  slot: PackagingSlot;
  /** Row label, e.g. "Preformed bags" — narrows an "other"-slot row. */
  label: string;
  isBulk: boolean;
  suppliedBy: "pharmacenter" | "customer";
};

type Row = {
  fp_code: string;
  name: string;
  category: string | null;
  owner: string;
};

// Words that describe a FORMAT, not the product — they match hundreds of
// parts and would drown out the words that actually identify this one.
const GENERIC = new Set([
  "gummy", "gummies", "softgel", "softgels", "capsule", "capsules", "caps",
  "tablet", "tablets", "tabs", "bag", "bags", "pouch", "pouches", "bottle",
  "bottles", "blister", "blisters", "jar", "ct", "count", "pack", "packs",
  "of", "and", "the", "with", "for", "mg", "mcg", "g", "iu", "plus", "llc",
  "inc", "new", "product",
]);

/** The words in a product name that identify it (brand, line, variant). */
export function distinctiveWords(productName: string | null): string[] {
  if (!productName) return [];
  return productName
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !/\d/.test(w) && !GENERIC.has(w))
    .slice(0, 5);
}

/** Words a part's name must carry to fit a slot at all. */
function slotPattern(line: SuggestLine): RegExp | null {
  switch (line.slot) {
    case "bottle": return /bottle|btl/;
    case "closure": return /cap|closure|lid/;
    case "liner": return /liner/;
    case "neckband": return /neck/;
    case "sleeve": return /sleeve/;
    case "label": return /label/;
    case "carton": return /carton|u\/c|\buc\b/;
    case "insert": return /insert|leaflet/;
    case "safety_seal": return /seal/;
    case "master_box":
    case "inner_pack": return /box|shipper|case|carton/;
    default: {
      const l = line.label.toLowerCase();
      if (/bag|pouch/.test(l)) return /bag|pouch/;
      if (/film|web/.test(l)) return /film|web|foil/;
      if (/lidding|foil/.test(l)) return /foil|lidding/;
      return null;
    }
  }
}

const categoryFor = (slot: PackagingSlot) =>
  slot === "inner_pack" ? "master_box" : slot;

/** "6 X 5 X 4" / "6x5x4" / "(6 x 5 x 4)" → "6x5x4"; null when no size. */
function sizeKey(s: string | null | undefined): string | null {
  const nums = String(s ?? "").match(/\d+(?:\.\d+)?/g);
  return nums && nums.length >= 2 ? nums.join("x") : null;
}

/**
 * Returns { lineId → fp_code } for the rows it is confident about.
 * Network failures return {} — a missing default is the safe outcome.
 */
export async function suggestParts(args: {
  lines: SuggestLine[];
  productName: string | null;
  spec: Record<string, string> | null;
}): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const words = distinctiveWords(args.productName);
  const brand = words[0];

  for (const line of args.lines) {
    // Bulk: the packaging form names the exact code — no guessing needed.
    if (line.isBulk) {
      const code = String(args.spec?.bulkProductCode ?? "").trim().toUpperCase();
      if (/^(PC|CA)-BK-\d+/.test(code)) out[line.id] = code;
      continue;
    }
    if (!brand) continue;
    const pattern = slotPattern(line);
    if (!pattern) continue;

    let rows: Row[] = [];
    try {
      const r = await fetch(
        `/api/packaging-components?slot=${encodeURIComponent(line.slot)}&q=${encodeURIComponent(words.join(" "))}`,
      );
      if (!r.ok) continue;
      const j = (await r.json()) as { rows?: Row[] };
      rows = j.rows ?? [];
    } catch {
      continue;
    }

    const wantSize =
      line.slot === "master_box" ? sizeKey(args.spec?.masterBoxSize) : null;
    const wantOwner = line.suppliedBy === "customer" ? "customer" : "pharmacenter";

    const scored = rows
      .map((row) => {
        const hay = row.name.toLowerCase();
        if (!hay.includes(brand)) return null;
        if (!pattern.test(hay)) return null;
        // "other" rows (bags, film) carry the category "other"; typed
        // slots must match their own shelf.
        if (line.slot !== "other" && row.category !== categoryFor(line.slot))
          return null;
        let score = words.filter((w) => hay.includes(w)).length * 10;
        if (wantSize) {
          const got = sizeKey(row.name);
          if (got === wantSize) score += 15;
          else if (got) return null; // a different box size is a different box
        }
        if (row.owner === wantOwner) score += 2;
        return { code: row.fp_code, score };
      })
      .filter((x): x is { code: string; score: number } => x !== null)
      .sort((a, b) => b.score - a.score);

    const [top, second] = scored;
    if (top && (!second || top.score > second.score)) out[line.id] = top.code;
  }
  return out;
}
