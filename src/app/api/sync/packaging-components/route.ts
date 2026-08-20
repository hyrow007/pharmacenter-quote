import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

// POST /api/sync/packaging-components
//
// Receiving side of the Fishbowl → Supabase sync for packaging components.
// Mirrors /api/sync/raw-materials. Bearer-auth with FISHBOWL_SYNC_SECRET,
// upsert on `fp_code` using the service-role key (bypasses RLS).
//
// Fishbowl owns: name, default_unit, the two cost columns, active.
// Quote-app owns (never touched by sync): category, notes.
//
// Part-number grammar — the sync sends anything matching BOTH halves:
//
//   owner prefix   PC-…  PharmaCenter buys it   → real cost
//                  CA-…  customer asset         → ALWAYS $0 (free issue)
//
//   kind infix     -PK-  bottles, caps, liners, master boxes
//                  -LL-  labels
//                  -UC-  unit cartons / IFCs
//
// `owner` and `kind` are derived HERE from fp_code rather than trusted from
// the payload, so a malformed sender can't mislabel a customer asset as a
// PharmaCenter-purchased one and quietly inflate a quote.
//
// UOM CONVERSION: Fishbowl reports avgCost in the part's own purchase UOM,
// and PharmaCenter buys most packaging in "un" — a THOUSAND-count unit. The
// incoming number is therefore a per-thousand price, not a per-each price.
// We store both: the raw purchase cost (auditable) and the derived per-each
// cost (usable). Getting this wrong is worse than a missing cost, because a
// 1000x-too-high number is still a NUMBER — it slips past null-propagation
// and quotes confidently. See EACHES_PER_PURCHASE_UOM below.
//
// CUSTOMER-ASSET ZEROING: for owner = "customer" both cost columns are
// forced to 0 regardless of what Fishbowl reports. That zero is a KNOWN
// value, not a missing one — the costing model must treat it as resolved
// (contributing $0) and NOT blank the material line the way a genuinely
// absent PharmaCenter cost does.
//
// Expected body:
//   {
//     packaging_components: Array<{
//       fp_code: string,                     // e.g. "PC-PK-0031"
//       name: string,
//       default_unit?: string,               // defaults to "ea"
//       inventory_cost_per_unit?: number,    // latest partcost.avgCost
//       last_order_cost_per_unit?: number,   // newest poitem.unitCost
//       inventory_cost_uom?: string,
//       last_order_cost_uom?: string,
//       active?: boolean                     // defaults to true
//     }>
//   }
//
// Response: { ok, received, upserted, skipped }

export const runtime = "nodejs"; // service-role client needs Node runtime

type PackagingComponentPayload = {
  fp_code: string;
  name: string;
  default_unit?: string;
  inventory_cost_per_unit?: number | null;
  last_order_cost_per_unit?: number | null;
  inventory_cost_uom?: string | null;
  last_order_cost_uom?: string | null;
  active?: boolean;
};

type Owner = "pharmacenter" | "customer";
type Kind = "pk" | "ll" | "uc";

/** Exactly the column set we upsert. Deliberately omits `category` and
 *  `notes` — those are admin overlays Fishbowl knows nothing about, and
 *  leaving them out of the payload is what preserves them on re-sync. */
type PackagingComponentRecord = {
  fp_code: string;
  name: string;
  default_unit: string;
  owner: Owner;
  kind: Kind;
  inventory_cost_per_purchase_unit: number | null;
  last_order_cost_per_purchase_unit: number | null;
  units_per_purchase_unit: number | null;
  inventory_cost_per_unit: number | null;
  last_order_cost_per_unit: number | null;
  inventory_cost_uom: string | null;
  last_order_cost_uom: string | null;
  active: boolean;
  source: "fishbowl";
  synced_at: string;
};

/** How many eaches sit inside one Fishbowl purchase UOM.
 *
 *  PharmaCenter buys most packaging in "un", which is a THOUSAND-count unit.
 *  Fishbowl's avgCost is denominated in that UOM, so a $292.10 "un" cost is
 *  $0.2921 per bottle — not $292.10 per bottle. Getting this wrong does not
 *  produce a visibly empty quote, it produces a confidently wrong one that
 *  is 1000x too high, because a bad-but-present number sails straight past
 *  the costing model's null-propagation guard.
 *
 *  Anything absent from this map has no defensible each-count: you cannot
 *  derive "how many bottles" from a kilogram or a millimetre. Those rows get
 *  a NULL factor, which yields a NULL per-each cost, which correctly blanks
 *  the costing line instead of inventing a number. An admin resolves them
 *  via units_per_purchase_unit_override. */
const EACHES_PER_PURCHASE_UOM: Record<string, number> = {
  un: 1000,
  ea: 1,
  each: 1,
  ct: 1,
};

function eachesPerPurchaseUom(uom: string | null | undefined): number | null {
  if (!uom) return null;
  return EACHES_PER_PURCHASE_UOM[uom.trim().toLowerCase()] ?? null;
}

/** Owner from the leading two letters. Anything that isn't an explicit
 *  CA- prefix is treated as PharmaCenter-purchased. */
function ownerOf(fpCode: string): Owner {
  return /^CA[-_]/i.test(fpCode.trim()) ? "customer" : "pharmacenter";
}

/** Kind from the middle slot. Null when the code carries none of the three
 *  packaging infixes — such rows are skipped entirely. */
function kindOf(fpCode: string): Kind | null {
  const s = fpCode.toUpperCase();
  if (s.includes("-PK-")) return "pk";
  if (s.includes("-LL-")) return "ll";
  if (s.includes("-UC-")) return "uc";
  return null;
}

function isNumberOrAbsent(v: unknown): boolean {
  return v === undefined || v === null || typeof v === "number";
}

function isStringOrAbsent(v: unknown): boolean {
  return v === undefined || v === null || typeof v === "string";
}

function isPackagingComponent(v: unknown): v is PackagingComponentPayload {
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
  if (!isNumberOrAbsent(rec.inventory_cost_per_unit)) return false;
  if (!isNumberOrAbsent(rec.last_order_cost_per_unit)) return false;
  if (!isStringOrAbsent(rec.inventory_cost_uom)) return false;
  if (!isStringOrAbsent(rec.last_order_cost_uom)) return false;
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
  let body: { packaging_components?: unknown };
  try {
    body = (await request.json()) as { packaging_components?: unknown };
  } catch {
    return NextResponse.json({ ok: false, error: "bad_json" }, { status: 400 });
  }
  if (!body || !Array.isArray(body.packaging_components)) {
    return NextResponse.json(
      { ok: false, error: "missing_packaging_components_array" },
      { status: 400 },
    );
  }

  const raw = body.packaging_components;
  let skipped = 0;
  const records: PackagingComponentRecord[] = [];
  const now = new Date().toISOString();

  for (const v of raw) {
    if (!isPackagingComponent(v)) {
      skipped += 1;
      continue; // ignore garbage silently
    }
    const fpCode = v.fp_code.trim();
    const kind = kindOf(fpCode);
    if (!kind) {
      // Not a packaging part (no -PK-/-LL-/-UC-). The sender shouldn't be
      // shipping these, but don't let one stray row poison the batch.
      skipped += 1;
      continue;
    }
    const owner = ownerOf(fpCode);
    const isCustomerAsset = owner === "customer";

    const inventory =
      typeof v.inventory_cost_per_unit === "number"
        ? v.inventory_cost_per_unit
        : null;
    const lastOrder =
      typeof v.last_order_cost_per_unit === "number"
        ? v.last_order_cost_per_unit
        : null;

    // The UOM the cost is denominated in. Fishbowl sends it alongside the
    // cost; fall back to the part's own unit when it doesn't.
    const purchaseUom =
      (typeof v.inventory_cost_uom === "string" && v.inventory_cost_uom.trim()
        ? v.inventory_cost_uom
        : v.default_unit) || null;
    const factor = eachesPerPurchaseUom(purchaseUom);

    /** Purchase-unit cost -> per-each cost. Null in, null out; and an
     *  unconvertible UOM also yields null, which is the point: a missing
     *  per-each cost blanks the costing line, an invented one poisons it. */
    const perEach = (cost: number | null): number | null =>
      cost === null || factor === null ? null : cost / factor;

    records.push({
      fp_code: fpCode,
      name: v.name.trim(),
      default_unit: (v.default_unit || "ea").trim(),
      owner,
      kind,
      // Customer assets are free issue — a hard 0, never Fishbowl's number.
      // Note the 0 applies at BOTH denominations: 0 per case is 0 per each.
      inventory_cost_per_purchase_unit: isCustomerAsset ? 0 : inventory,
      last_order_cost_per_purchase_unit: isCustomerAsset ? 0 : lastOrder,
      units_per_purchase_unit: factor,
      inventory_cost_per_unit: isCustomerAsset ? 0 : perEach(inventory),
      last_order_cost_per_unit: isCustomerAsset ? 0 : perEach(lastOrder),
      inventory_cost_uom: isCustomerAsset
        ? null
        : typeof v.inventory_cost_uom === "string" && v.inventory_cost_uom.trim()
          ? v.inventory_cost_uom.trim()
          : null,
      last_order_cost_uom: isCustomerAsset
        ? null
        : typeof v.last_order_cost_uom === "string" &&
            v.last_order_cost_uom.trim()
          ? v.last_order_cost_uom.trim()
          : null,
      active: v.active === undefined ? true : v.active,
      source: "fishbowl",
      synced_at: now,
    });
  }

  if (records.length === 0) {
    return NextResponse.json({
      ok: true,
      received: raw.length,
      upserted: 0,
      skipped,
    });
  }

  // ----- upsert -------------------------------------------------------
  // We deliberately do NOT touch category or notes here. Those are
  // admin-set overlays and Fishbowl has no concept of them. The upsert
  // payload omits those columns entirely; existing rows keep whatever the
  // admin set, new rows get the table defaults.
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

  const { error, count } = await supabase
    .from("packaging_components")
    .upsert(records, {
      onConflict: "fp_code",
      ignoreDuplicates: false,
      count: "exact",
    });

  if (error) {
    console.error("packaging_components upsert failed", error);
    return NextResponse.json(
      { ok: false, error: error.message },
      { status: 500 },
    );
  }

  return NextResponse.json({
    ok: true,
    received: raw.length,
    upserted: count ?? records.length,
    skipped,
  });
}
