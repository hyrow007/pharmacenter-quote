import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

// POST /api/sync/product-costs
//
// Receiving side of the Fishbowl → Supabase sync for PRODUCT average
// costs (product.partId → latest partcost.avgCost). Bearer-auth with
// FISHBOWL_SYNC_SECRET, service-role client — same pattern as
// /api/sync/raw-materials.
//
// IMPORTANT: this endpoint UPDATES avg_cost on existing product rows
// only — it never inserts. Product identity (external_id / fp_code /
// name / active) is owned by the packing-list app's /api/sync/products;
// upserting here could race it or create half-formed rows.
//
// Consumed by the PricingCalculator: picking an "Existing stock"
// workflow product pre-fills Cost per unit with products.avg_cost.
//
// Expected body:
//   { product_costs: Array<{ fp_code: string, avg_cost: number }> }
//
// Response: { ok, received, updated }

export const runtime = "nodejs"; // service-role client needs Node runtime

type ProductCostPayload = {
  fp_code: string;
  avg_cost: number;
};

function isProductCost(v: unknown): v is ProductCostPayload {
  if (!v || typeof v !== "object") return false;
  const rec = v as Record<string, unknown>;
  if (typeof rec.fp_code !== "string" || rec.fp_code.trim().length === 0) {
    return false;
  }
  if (typeof rec.avg_cost !== "number" || !Number.isFinite(rec.avg_cost)) {
    return false;
  }
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
  let body: { product_costs?: unknown };
  try {
    body = (await request.json()) as { product_costs?: unknown };
  } catch {
    return NextResponse.json({ ok: false, error: "bad_json" }, { status: 400 });
  }
  if (!body || !Array.isArray(body.product_costs)) {
    return NextResponse.json(
      { ok: false, error: "missing_product_costs_array" },
      { status: 400 },
    );
  }
  const rows: ProductCostPayload[] = [];
  for (const v of body.product_costs) {
    if (!isProductCost(v)) continue; // ignore garbage silently
    rows.push({ fp_code: v.fp_code.trim(), avg_cost: v.avg_cost });
  }
  if (rows.length === 0) {
    return NextResponse.json({ ok: true, received: 0, updated: 0 });
  }

  // ----- update ---------------------------------------------------------
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

  // Per-row UPDATE by fp_code (no bulk-update-with-distinct-values in
  // PostgREST without an upsert, and upsert is off the table — see header
  // comment). Chunked Promise.all keeps a full catalog to a few seconds,
  // fine for a nightly job.
  const CHUNK = 50;
  let updated = 0;
  let firstError: string | null = null;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const results = await Promise.all(
      chunk.map((r) =>
        supabase
          .from("products")
          .update({ avg_cost: r.avg_cost })
          .eq("fp_code", r.fp_code)
          .select("id"),
      ),
    );
    for (const res of results) {
      if (res.error) {
        // Pre-migration window: avg_cost column doesn't exist yet. Bail
        // with a clear error so the sync log says exactly what to run.
        if (/avg_cost/.test(res.error.message)) {
          return NextResponse.json(
            {
              ok: false,
              error:
                "products.avg_cost column missing — run sql/products_avg_cost.sql in Supabase",
            },
            { status: 500 },
          );
        }
        if (!firstError) firstError = res.error.message;
      } else {
        updated += res.data?.length ?? 0;
      }
    }
  }

  if (firstError) {
    return NextResponse.json(
      { ok: false, error: firstError, received: rows.length, updated },
      { status: 500 },
    );
  }
  return NextResponse.json({ ok: true, received: rows.length, updated });
}
