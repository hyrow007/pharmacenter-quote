import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

// POST /api/sync/vendors
//
// Receiving side of the Fishbowl → Supabase sync for vendors. Mirrors the
// /api/sync/customers + /api/sync/products endpoints that already live on
// packing.pharmacenter.app: bearer-auth with FISHBOWL_SYNC_SECRET, upsert
// on `external_id` using the service role key.
//
// Expected body:
//   { vendors: Array<{ external_id: string; name: string; active: boolean }> }
//
// Response: { ok: true, received: N, upserted: N }

export const runtime = "nodejs"; // service-role client needs Node runtime

type VendorRow = {
  external_id: string;
  name: string;
  active: boolean;
};

function isVendor(v: unknown): v is VendorRow {
  if (!v || typeof v !== "object") return false;
  const rec = v as Record<string, unknown>;
  if (typeof rec.external_id !== "string" || rec.external_id.length === 0) return false;
  if (typeof rec.name !== "string" || rec.name.trim().length === 0) return false;
  // `active` defaults to true on the DB side if absent, so accept missing.
  if (rec.active !== undefined && typeof rec.active !== "boolean") return false;
  return true;
}

export async function POST(request: Request) {
  // ----- auth ---------------------------------------------------------
  // Bearer token must match the FISHBOWL_SYNC_SECRET env var on Vercel.
  // The sync script on the office Fishbowl server signs each request with
  // the same value. Anyone else hitting this endpoint gets a 401.
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
  let body: { vendors?: unknown };
  try {
    body = (await request.json()) as { vendors?: unknown };
  } catch {
    return NextResponse.json({ ok: false, error: "bad_json" }, { status: 400 });
  }
  if (!body || !Array.isArray(body.vendors)) {
    return NextResponse.json(
      { ok: false, error: "missing_vendors_array" },
      { status: 400 },
    );
  }
  const raw = body.vendors;
  const rows: VendorRow[] = [];
  for (const v of raw) {
    if (!isVendor(v)) continue; // skip silently — sender is allowed to ship junk
    rows.push({
      external_id: v.external_id,
      name: v.name.trim(),
      active: v.active === undefined ? true : v.active,
    });
  }

  if (rows.length === 0) {
    return NextResponse.json({ ok: true, received: 0, upserted: 0 });
  }

  // ----- upsert -------------------------------------------------------
  // We use the service role client (bypasses RLS) because the public anon
  // role only has SELECT on `vendors`. Source is hard-set to 'fishbowl' so
  // queries can distinguish synced rows from manually-entered ones if we
  // ever need to.
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

  const records = rows.map((r) => ({
    external_id: r.external_id,
    name: r.name,
    active: r.active,
    source: "fishbowl",
  }));

  const { error, count } = await supabase
    .from("vendors")
    .upsert(records, {
      onConflict: "external_id",
      ignoreDuplicates: false,
      count: "exact",
    });

  if (error) {
    console.error("vendors upsert failed:", error.message);
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
