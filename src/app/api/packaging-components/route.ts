import { NextResponse } from "next/server";
import { createClient } from "@/lib/auth/server";

// GET /api/packaging-components?slot=bottle&q=150 PET amber
//
// Type-to-search behind the bottle-costing component picker. Reads the
// packaging_components_costed VIEW, not the base table, so callers get
// effective_cost_per_unit (admin override applied) and cost_status without
// having to reimplement that logic client-side.
//
// Ranking, in order:
//   1. rows whose category matches the slot being filled
//   2. rows we can actually cost (status 'ok' or 'customer_asset')
//   3. name
//
// It is a SUGGESTION engine, never an identification: a description match is a
// hint. The human picks. That is why nothing here auto-selects a single hit.

export const runtime = "nodejs";

const SLOTS = new Set([
  "bottle",
  "closure",
  "liner",
  "neckband",
  "sleeve",
  "label",
  "carton",
  "insert",
  "safety_seal",
  "inner_pack",
  "master_box",
  "other",
]);

// Fishbowl does not classify inner packs — the categoriser has no such arm and
// no row carries the category. Filtering on it would return an empty picker
// every time, so an inner pack borrows the master box's shelf: both are
// corrugated containers holding a number of bottles, and in practice the same
// parts get used for either. The seeded "inner" search term still floats a
// genuinely inner-pack-named part to the top when one exists.
const categoryForSlot = (slot: string) =>
  slot === "inner_pack" ? "master_box" : slot;

export async function GET(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user || !user.email?.endsWith("@pharmacenterusa.com")) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const url = new URL(request.url);
  const slot = (url.searchParams.get("slot") ?? "").trim();
  const q = (url.searchParams.get("q") ?? "").trim();

  let query = supabase
    .from("packaging_components_costed")
    // last_order_cost_per_purchase_unit + effective_units_per_purchase_unit
    // are carried so the cost-source picker has a second Fishbowl figure to
    // switch to. The view only derives the INVENTORY per-each cost; the
    // last-order one is divided down below rather than in SQL, which keeps
    // this a code change instead of a migration someone has to remember to run.
    .select(
      "fp_code, name, category, owner, effective_cost_per_unit, cost_status, last_order_cost_per_purchase_unit, effective_units_per_purchase_unit",
    )
    .eq("active", true);

  // Slot is a filter, not a hard gate — a user may legitimately need a part
  // filed under a different category, so we only PREFER the matching slot when
  // there is also a search term to fall back on.
  if (SLOTS.has(slot) && !q) {
    query = query.eq("category", categoryForSlot(slot));
  }

  // Words are OR-matched and then RANKED by how many hit — never AND-filtered.
  //
  // The spec speaks the app's vocabulary ("Flip-top", "Induction (heat seal)")
  // while Fishbowl speaks its own ("FLIP TOP", "IH"). Requiring every word to
  // match therefore returns NOTHING for a perfectly ordinary closure — which is
  // exactly what it did on the first live test. Matching any word and sorting
  // by how many matched degrades gracefully: the closest part floats up, and a
  // vocabulary mismatch costs relevance instead of the entire result set.
  const words = q
    ? q
        .split(/[\s/]+/)
        .map((w) => w.replace(/[%_,()-]/g, " ").trim())
        .filter((w) => w.length > 1)
        .slice(0, 6)
    : [];

  if (words.length) {
    query = query.or(
      words
        .flatMap((w) => [`fp_code.ilike.%${w}%`, `name.ilike.%${w}%`])
        .join(","),
    );
  }

  const { data, error } = await query.limit(200);
  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  type Row = {
    fp_code: string;
    name: string;
    category: string | null;
    owner: string;
    effective_cost_per_unit: number | null;
    cost_status: string;
    last_order_cost_per_purchase_unit: number | null;
    effective_units_per_purchase_unit: number | null;
  };

  // Lower is better. Word hits dominate, then the slot match, then whether we
  // can actually cost it. Scoring rather than filtering is what lets a partial
  // vocabulary match still surface the right part.
  const rank = (r: Row) => {
    const hay = `${r.fp_code} ${r.name}`.toLowerCase();
    const hits = words.filter((w) => hay.includes(w.toLowerCase())).length;
    let s = -hits * 50;
    if (slot && r.category === categoryForSlot(slot)) s -= 100;
    if (r.cost_status === "ok" || r.cost_status === "customer_asset") s -= 10;
    // A part whose name STARTS with the slot word is almost always the real
    // thing, rather than something that merely mentions it in passing — this
    // is what separates "BOX (18 X 14 X 14)" from "GLUE STICKS (90 PER BOX)".
    if (slot && hay.startsWith(slot.replace("_", " "))) s -= 40;
    return s;
  };

  // Divide the last-order purchase-unit cost down to per-each using the SAME
  // factor the view used for the inventory cost, so the two figures are
  // directly comparable. Null in, null out — an unconvertible UOM must leave
  // this blank rather than quietly reporting a per-1,000 price as per-each,
  // which is exactly the bug that made boxes look like $7,461 (#357).
  const perEach = (r: Row): number | null => {
    const c = r.last_order_cost_per_purchase_unit;
    const f = r.effective_units_per_purchase_unit;
    if (c === null || f === null || f === 0) return null;
    if (r.owner === "customer") return 0;
    return c / f;
  };

  const rows = ((data ?? []) as Row[])
    .sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name))
    .slice(0, 60)
    .map((r) => ({
      fp_code: r.fp_code,
      name: r.name,
      category: r.category,
      owner: r.owner,
      effective_cost_per_unit: r.effective_cost_per_unit,
      cost_status: r.cost_status,
      last_order_cost_per_unit: perEach(r),
    }));

  return NextResponse.json({ ok: true, rows });
}
