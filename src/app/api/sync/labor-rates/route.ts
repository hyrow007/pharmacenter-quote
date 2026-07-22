import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

// POST /api/sync/labor-rates
//
// Receiving side of the ADP → Supabase labor-rate sync. Mirrors
// /api/sync/raw-materials: Bearer-auth with FISHBOWL_SYNC_SECRET (same
// server, same secret), upsert on `adp_id` using the service-role key.
//
// Expected body:
//   {
//     labor_rates: Array<{
//       adp_id: string,        // ADP associate/position ID
//       name: string,
//       department?: string | null,
//       hourly_rate?: number | null,  // base hourly $
//       active?: boolean              // defaults to true
//     }>
//   }
//
// Response: { ok, received, upserted }

export const runtime = "nodejs";

type LaborRatePayload = {
  adp_id: string;
  name: string;
  department?: string | null;
  hourly_rate?: number | null;
  active?: boolean;
};

function isLaborRate(v: unknown): v is LaborRatePayload {
  if (!v || typeof v !== "object") return false;
  const rec = v as Record<string, unknown>;
  if (typeof rec.adp_id !== "string" || rec.adp_id.trim().length === 0) return false;
  if (typeof rec.name !== "string" || rec.name.trim().length === 0) return false;
  if (
    rec.department !== undefined &&
    rec.department !== null &&
    typeof rec.department !== "string"
  ) {
    return false;
  }
  if (
    rec.hourly_rate !== undefined &&
    rec.hourly_rate !== null &&
    typeof rec.hourly_rate !== "number"
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
  let body: { labor_rates?: unknown };
  try {
    body = (await request.json()) as { labor_rates?: unknown };
  } catch {
    return NextResponse.json({ ok: false, error: "bad_json" }, { status: 400 });
  }
  if (!body || !Array.isArray(body.labor_rates)) {
    return NextResponse.json(
      { ok: false, error: "missing_labor_rates_array" },
      { status: 400 },
    );
  }
  const rows: Required<LaborRatePayload>[] = [];
  for (const v of body.labor_rates) {
    if (!isLaborRate(v)) continue; // ignore garbage silently
    rows.push({
      adp_id: v.adp_id.trim(),
      name: v.name.trim(),
      department:
        typeof v.department === "string" && v.department.trim()
          ? v.department.trim()
          : null,
      hourly_rate: typeof v.hourly_rate === "number" ? v.hourly_rate : null,
      active: v.active === undefined ? true : v.active,
    });
  }

  if (rows.length === 0) {
    return NextResponse.json({ ok: true, received: 0, upserted: 0 });
  }

  // ----- upsert -------------------------------------------------------
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
  const records = rows.map((r) => ({ ...r, source: "adp", synced_at: now }));

  const { error, count } = await supabase
    .from("labor_rates")
    .upsert(records, {
      onConflict: "adp_id",
      ignoreDuplicates: false,
      count: "exact",
    });

  if (error) {
    console.error("labor_rates upsert failed:", error.message);
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
