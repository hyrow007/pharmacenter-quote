import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

// POST /api/sync/raw-materials
//
// Receiving side of the Fishbowl → Supabase sync for raw materials.
// Mirrors /api/sync/vendors. Bearer-auth with FISHBOWL_SYNC_SECRET, upsert
// on `fp_code` using the service-role key (bypasses RLS).
//
// Fishbowl owns: name, default_unit, default_cost_per_kg, active.
// Quote-app owns (never touched by sync): default_solids, category, notes.
//
// Expected body:
//   {
//     raw_materials: Array<{
//       fp_code: string,             // e.g. "PC-RW-0010"
//       name: string,
//       default_unit?: string,        // defaults to "kg" if absent
//       default_cost_per_kg?: number, // average cost from Fishbowl
//       active?: boolean              // defaults to true
//     }>
//   }
//
// Response: { ok, received, upserted }

export const runtime = "nodejs"; // service-role client needs Node runtime

type RawMaterialPayload = {
  fp_code: string;
  name: string;
  default_unit?: string;
  default_cost_per_kg?: number | null;
  // v57: Fishbowl cost sources for the Costing tab —
  //   inventory_cost_per_kg  = latest partcost.avgCost (inventory average)
  //   last_order_cost_per_kg = newest poitem.unitCost (last price paid)
  inventory_cost_per_kg?: number | null;
  last_order_cost_per_kg?: number | null;
  // v57.1: source UOM each cost was converted from ("lb", "gal", …).
  // "kg"/null = no conversion; the Costing tab shows a "lb → kg"
  // indicator for anything else.
  inventory_cost_uom?: string | null;
  last_order_cost_uom?: string | null;
  active?: boolean;
};

function isRawMaterial(v: unknown): v is RawMaterialPayload {
  if (!v || typeof v !== "object") return false;
  const rec = v as Record<string, unknown>;
  if (typeof rec.fp_code !== "string" || rec.fp_code.length === 0) return false;
  if (typeof rec.name !== "string" || rec.name.trim().length === 0) return false;
  if (
    rec.default_unit !== undefined &&
    (typeof rec.default_unit !== "string" || rec.default_unit.length === 0)
  ) {
    return false;
  }
  if (
    rec.default_cost_per_kg !== undefined &&
    rec.default_cost_per_kg !== null &&
    typeof rec.default_cost_per_kg !== "number"
  ) {
    return false;
  }
  if (
    rec.inventory_cost_per_kg !== undefined &&
    rec.inventory_cost_per_kg !== null &&
    typeof rec.inventory_cost_per_kg !== "number"
  ) {
    return false;
  }
  if (
    rec.last_order_cost_per_kg !== undefined &&
    rec.last_order_cost_per_kg !== null &&
    typeof rec.last_order_cost_per_kg !== "number"
  ) {
    return false;
  }
  if (
    rec.inventory_cost_uom !== undefined &&
    rec.inventory_cost_uom !== null &&
    typeof rec.inventory_cost_uom !== "string"
  ) {
    return false;
  }
  if (
    rec.last_order_cost_uom !== undefined &&
    rec.last_order_cost_uom !== null &&
    typeof rec.last_order_cost_uom !== "string"
  ) {
    return false;
  }
  if (rec.active !== undefined && typeof rec.active !== "boolean") return false;
  return true;
}

export async function POST(request: Request) {
  // ----- auth ---------------------------------------------------------
  const expected = process.env.FISHBOWL_SYNC_SECRET;
  if (!expected) {
    console.error("FISHBOWL_SYNC_SECRET not configured");
    return NextResponse.json(
      { ok: false, error: "server_misconfigured" },
      { status: 500 },
    );
  }
  const authz = request.headers.get("authorization") || "";
  const provided = authz.startsWith("Bearer ")
    ? authz.slice("Bearer ".length).trim()
    : "";
  if (provided !== expected) {
    return NextResponse.json(
      { ok: false, error: "unauthorized" },
      { status: 401 },
    );
  }

  // ----- parse body ---------------------------------------------------
  let body: { raw_materials?: unknown };
  try {
    body = (await request.json()) as { raw_materials?: unknown };
  } catch {
    return NextResponse.json({ ok: false, error: "bad_json" }, { status: 400 });
  }
  if (!body || !Array.isArray(body.raw_materials)) {
    return NextResponse.json(
      { ok: false, error: "missing_raw_materials_array" },
      { status: 400 },
    );
  }
  const raw = body.raw_materials;
  const rows: Required<RawMaterialPayload>[] = [];
  for (const v of raw) {
    if (!isRawMaterial(v)) continue; // ignore garbage silently
    rows.push({
      fp_code: v.fp_code.trim(),
      name: v.name.trim(),
      default_unit: (v.default_unit || "kg").trim(),
      default_cost_per_kg:
        typeof v.default_cost_per_kg === "number" ? v.default_cost_per_kg : null,
      inventory_cost_per_kg:
        typeof v.inventory_cost_per_kg === "number"
          ? v.inventory_cost_per_kg
          : null,
      last_order_cost_per_kg:
        typeof v.last_order_cost_per_kg === "number"
          ? v.last_order_cost_per_kg
          : null,
      inventory_cost_uom:
        typeof v.inventory_cost_uom === "string" && v.inventory_cost_uom.trim()
          ? v.inventory_cost_uom.trim()
          : null,
      last_order_cost_uom:
        typeof v.last_order_cost_uom === "string" && v.last_order_cost_uom.trim()
          ? v.last_order_cost_uom.trim()
          : null,
      active: v.active === undefined ? true : v.active,
    });
  }

  if (rows.length === 0) {
    return NextResponse.json({ ok: true, received: 0, upserted: 0 });
  }

  // ----- upsert -------------------------------------------------------
  // We deliberately do NOT touch default_solids, category, or notes here.
  // Those are admin-set overlays and Fishbowl has no concept of them.
  // The upsert payload omits those columns entirely; existing rows keep
  // whatever the admin set, new rows get the table defaults.
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRoleKey) {
    console.error("Supabase env vars missing");
    return NextResponse.json(
      { ok: false, error: "server_misconfigured" },
      { status: 500 },
    );
  }
  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false },
  });

  const now = new Date().toISOString();
  const records = rows.map((r) => ({
    fp_code: r.fp_code,
    name: r.name,
    default_unit: r.default_unit,
    default_cost_per_kg: r.default_cost_per_kg,
    inventory_cost_per_kg: r.inventory_cost_per_kg,
    last_order_cost_per_kg: r.last_order_cost_per_kg,
    inventory_cost_uom: r.inventory_cost_uom,
    last_order_cost_uom: r.last_order_cost_uom,
    active: r.active,
    source: "fishbowl",
    synced_at: now,
  }));

  let { error, count } = await supabase
    .from("raw_materials")
    .upsert(records, {
      onConflict: "fp_code",
      ignoreDuplicates: false,
      count: "exact",
    });
  // Pre-migration fallback: if the cost columns don't exist yet, retry
  // without them so the nightly sync never breaks during the window.
  if (
    error &&
    /inventory_cost_per_kg|last_order_cost_per_kg|inventory_cost_uom|last_order_cost_uom/.test(
      error.message,
    )
  ) {
    const legacy = records.map(
      ({
        inventory_cost_per_kg: _i,
        last_order_cost_per_kg: _l,
        inventory_cost_uom: _iu,
        last_order_cost_uom: _lu,
        ...rest
      }) => rest,
    );
    ({ error, count } = await supabase
      .from("raw_materials")
      .upsert(legacy, {
        onConflict: "fp_code",
        ignoreDuplicates: false,
        count: "exact",
      }));
  }

  if (error) {
    console.error("raw_materials upsert failed:", error.message);
    return NextResponse.json(
      { ok: false, error: error.message },
      { status: 500 },
    );
  }

  return NextResponse.json({
    ok: true,
    received: rows.length,
    upserted: count ?? rows.length,
  });
}
