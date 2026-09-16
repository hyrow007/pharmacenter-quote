import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

// POST /api/sync/purchase-orders
//
// Sibling of /api/sync/sales-orders — receives Fishbowl purchase-order
// mirrors and writes to public.fishbowl_purchase_orders. Same shape:
// bearer-auth with FISHBOWL_SYNC_SECRET, service-role write, batches
// share a run_id, a finalize call flips is_open=false on rows whose
// sync_run_id is not the current one.
//
// Two request shapes:
//
//   1. Data batch:
//      { run_id: "...", purchase_orders: [ {...}, ... ] }
//
//   2. Finalize:
//      { run_id: "...", finalize: true }
//
// PO ↔ SO linkage: each poitem carries a soItemId; the sender resolves
// that to the SO number and stamps it on the item, then rolls the
// distinct SO numbers up into a top-level so_numbers[] so the read side
// can find POs for one SO with a single indexed query.
//
// Response: { ok, received, upserted } or { ok, finalized, closed }.

export const runtime = "nodejs";

type PoItemPayload = {
  line?: number | null;
  product_num?: string | null;
  description?: string | null;
  qty_ordered?: number | null;
  qty_fulfilled?: number | null;
  unit_cost?: number | null;
  total_cost?: number | null;
  date_scheduled?: string | null;
  so_number?: string | null;
  so_item_line?: number | null;
  so_item_product_num?: string | null;
};

type PurchaseOrderPayload = {
  fb_po_id: number;
  po_number: string;
  status_id?: number | null;
  status_name?: string | null;
  is_open?: boolean;
  vendor_id?: number | null;
  vendor_name?: string | null;
  buyer?: string | null;
  date_issued?: string | null;
  date_created?: string | null;
  date_completed?: string | null;
  date_last_modified?: string | null;
  subtotal?: number | null;
  total_price?: number | null;
  items?: PoItemPayload[];
  so_numbers?: string[];
};

type Body = {
  run_id?: string;
  purchase_orders?: unknown;
  finalize?: boolean;
};

function badRequest(msg: string): NextResponse {
  return NextResponse.json({ ok: false, error: msg }, { status: 400 });
}

function isPurchaseOrder(v: unknown): v is PurchaseOrderPayload {
  if (!v || typeof v !== "object") return false;
  const rec = v as Record<string, unknown>;
  if (typeof rec.fb_po_id !== "number" || !Number.isFinite(rec.fb_po_id))
    return false;
  if (typeof rec.po_number !== "string" || rec.po_number.trim().length === 0)
    return false;
  if (rec.items !== undefined && !Array.isArray(rec.items)) return false;
  return true;
}

export async function POST(request: Request) {
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

  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return badRequest("bad_json");
  }
  if (typeof body.run_id !== "string" || body.run_id.trim() === "")
    return badRequest("missing_run_id");

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

  // ----- finalize path ------------------------------------------------
  if (body.finalize) {
    const { data, error } = await supabase
      .from("fishbowl_purchase_orders")
      .update({ is_open: false })
      .neq("sync_run_id", body.run_id)
      .eq("is_open", true)
      .select("fb_po_id");
    if (error) {
      console.error("finalize failed:", error.message);
      return NextResponse.json(
        { ok: false, error: error.message },
        { status: 500 },
      );
    }
    return NextResponse.json({
      ok: true,
      finalized: true,
      closed: (data ?? []).length,
    });
  }

  // ----- data path ----------------------------------------------------
  if (!Array.isArray(body.purchase_orders))
    return badRequest("missing_purchase_orders_array");

  const rows: Array<Record<string, unknown>> = [];
  const now = new Date().toISOString();
  for (const raw of body.purchase_orders as unknown[]) {
    if (!isPurchaseOrder(raw)) continue;
    const items = Array.isArray(raw.items) ? raw.items : [];
    const soNumbers = new Set<string>();
    if (Array.isArray(raw.so_numbers)) {
      for (const s of raw.so_numbers)
        if (typeof s === "string" && s.trim()) soNumbers.add(s.trim());
    }
    for (const it of items) {
      if (typeof it?.so_number === "string" && it.so_number.trim())
        soNumbers.add(it.so_number.trim());
    }
    rows.push({
      fb_po_id: raw.fb_po_id,
      po_number: raw.po_number.trim(),
      status_id: raw.status_id ?? null,
      status_name: raw.status_name ?? null,
      is_open: raw.is_open ?? true,
      vendor_id: raw.vendor_id ?? null,
      vendor_name: raw.vendor_name ?? null,
      buyer: raw.buyer ?? null,
      date_issued: raw.date_issued ?? null,
      date_created: raw.date_created ?? null,
      date_completed: raw.date_completed ?? null,
      date_last_modified: raw.date_last_modified ?? null,
      subtotal: raw.subtotal ?? null,
      total_price: raw.total_price ?? null,
      items,
      so_numbers: Array.from(soNumbers),
      sync_run_id: body.run_id,
      synced_at: now,
    });
  }

  if (rows.length === 0) {
    return NextResponse.json({ ok: true, received: 0, upserted: 0 });
  }

  const { error } = await supabase
    .from("fishbowl_purchase_orders")
    .upsert(rows, { onConflict: "fb_po_id" });
  if (error) {
    console.error("fishbowl_purchase_orders upsert failed:", error.message);
    return NextResponse.json(
      { ok: false, error: error.message },
      { status: 500 },
    );
  }

  return NextResponse.json({
    ok: true,
    received: rows.length,
    upserted: rows.length,
  });
}
