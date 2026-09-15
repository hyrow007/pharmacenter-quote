import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

// POST /api/sync/sales-orders
//
// Receiving side of the Fishbowl → Supabase sync for OPEN sales orders.
// Mirrors /api/sync/raw-materials: bearer-auth with FISHBOWL_SYNC_SECRET,
// upsert on fb_so_id using the service-role key (bypasses RLS).
//
// Table is fishbowl_sales_orders — NOT sales_orders, which already exists
// and belongs to the Packing List app's packing-list ↔ SO linkage.
//
// Two request shapes, both authenticated the same way:
//
//   1. Data batch (repeated):
//      { run_id: "2026-09-14T04:12:00.000Z", sales_orders: [ {...}, ... ] }
//
//   2. Finalize (once, after every batch landed):
//      { run_id: "...", finalize: true }
//      → flips is_open=false on every row whose sync_run_id is NOT this
//        run's. An SO that closed in Fishbowl simply stops arriving, and
//        this is the step that notices. Rows are kept, never deleted, so
//        "what closed since yesterday" stays answerable.
//
// Response: { ok, received, upserted } or { ok, finalized, closed }.

export const runtime = "nodejs"; // service-role client needs Node runtime

type SoItemPayload = {
  line?: number | null;
  type_id?: number | null;
  status_id?: number | null;
  product_num?: string | null;
  description?: string | null;
  qty_ordered?: number | null;
  qty_fulfilled?: number | null;
  qty_picked?: number | null;
  unit_price?: number | null;
  total_price?: number | null;
  date_scheduled?: string | null;
};

type SalesOrderPayload = {
  fb_so_id: number;
  so_number: string;
  status_id?: number | null;
  status_name?: string | null;
  is_open?: boolean;
  customer_name?: string | null;
  customer_po?: string | null;
  salesman?: string | null;
  note?: string | null;
  date_issued?: string | null;
  date_created?: string | null;
  date_first_ship?: string | null;
  date_last_modified?: string | null;
  subtotal?: number | null;
  total_price?: number | null;
  items?: SoItemPayload[];
};

const str = (v: unknown): string | null =>
  typeof v === "string" && v.trim() ? v.trim() : null;
const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

function isSalesOrder(v: unknown): v is SalesOrderPayload {
  if (!v || typeof v !== "object") return false;
  const rec = v as Record<string, unknown>;
  if (typeof rec.fb_so_id !== "number" || !Number.isFinite(rec.fb_so_id))
    return false;
  if (typeof rec.so_number !== "string" || rec.so_number.trim().length === 0)
    return false;
  if (rec.items !== undefined && !Array.isArray(rec.items)) return false;
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
  let body: { sales_orders?: unknown; run_id?: unknown; finalize?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ ok: false, error: "bad_json" }, { status: 400 });
  }
  const runId = typeof body.run_id === "string" ? body.run_id : null;
  if (!runId) {
    return NextResponse.json(
      { ok: false, error: "missing_run_id" },
      { status: 400 },
    );
  }

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

  // ----- finalize -----------------------------------------------------
  if (body.finalize === true) {
    const { error, count } = await supabase
      .from("fishbowl_sales_orders")
      .update({ is_open: false }, { count: "exact" })
      .neq("sync_run_id", runId)
      .eq("is_open", true);
    if (error) {
      console.error("sales_orders finalize failed:", error.message);
      return NextResponse.json(
        { ok: false, error: error.message },
        { status: 500 },
      );
    }
    return NextResponse.json({ ok: true, finalized: true, closed: count ?? 0 });
  }

  // ----- data batch ---------------------------------------------------
  if (!Array.isArray(body.sales_orders)) {
    return NextResponse.json(
      { ok: false, error: "missing_sales_orders_array" },
      { status: 400 },
    );
  }

  const now = new Date().toISOString();
  const records = [];
  for (const v of body.sales_orders) {
    if (!isSalesOrder(v)) continue; // ignore garbage silently
    records.push({
      fb_so_id: v.fb_so_id,
      so_number: v.so_number.trim(),
      status_id: num(v.status_id),
      status_name: str(v.status_name),
      is_open: v.is_open === undefined ? true : Boolean(v.is_open),
      customer_name: str(v.customer_name),
      customer_po: str(v.customer_po),
      salesman: str(v.salesman),
      note: str(v.note),
      date_issued: str(v.date_issued),
      date_created: str(v.date_created),
      date_first_ship: str(v.date_first_ship),
      date_last_modified: str(v.date_last_modified),
      subtotal: num(v.subtotal),
      total_price: num(v.total_price),
      items: Array.isArray(v.items)
        ? v.items.map((it) => ({
            line: num(it?.line),
            type_id: num(it?.type_id),
            status_id: num(it?.status_id),
            product_num: str(it?.product_num),
            description: str(it?.description),
            qty_ordered: num(it?.qty_ordered),
            qty_fulfilled: num(it?.qty_fulfilled),
            qty_picked: num(it?.qty_picked),
            unit_price: num(it?.unit_price),
            total_price: num(it?.total_price),
            date_scheduled: str(it?.date_scheduled),
          }))
        : [],
      sync_run_id: runId,
      synced_at: now,
    });
  }

  if (records.length === 0) {
    return NextResponse.json({ ok: true, received: 0, upserted: 0 });
  }

  const { error, count } = await supabase.from("fishbowl_sales_orders").upsert(records, {
    onConflict: "fb_so_id",
    ignoreDuplicates: false,
    count: "exact",
  });
  if (error) {
    console.error("sales_orders upsert failed:", error.message);
    return NextResponse.json(
      { ok: false, error: error.message },
      { status: 500 },
    );
  }

  return NextResponse.json({
    ok: true,
    received: records.length,
    upserted: count ?? records.length,
  });
}
