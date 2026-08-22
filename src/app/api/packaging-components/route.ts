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
  "master_box",
  "other",
]);

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
    .select(
      "fp_code, name, category, owner, effective_cost_per_unit, cost_status",
    )
    .eq("active", true);

  // Slot is a filter, not a hard gate — a user may legitimately need a part
  // filed under a different category, so we only PREFER the matching slot when
  // there is also a search term to fall back on.
  if (SLOTS.has(slot) && !q) {
    query = query.eq("category", slot);
  }

  if (q) {
    // Split the suggested spec string into words and require each to appear
    // somewhere in code or name. "150 PET Amber" then narrows properly instead
    // of matching anything containing the whole phrase verbatim.
    const words = q.split(/\s+/).filter(Boolean).slice(0, 5);
    for (const w of words) {
      const esc = w.replace(/[%_,()]/g, " ").trim();
      if (!esc) continue;
      query = query.or(`fp_code.ilike.%${esc}%,name.ilike.%${esc}%`);
    }
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
  };

  const rank = (r: Row) => {
    let s = 0;
    if (slot && r.category === slot) s -= 100;
    if (r.cost_status === "ok" || r.cost_status === "customer_asset") s -= 10;
    return s;
  };

  const rows = ((data ?? []) as Row[])
    .sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name))
    .slice(0, 60);

  return NextResponse.json({ ok: true, rows });
}
