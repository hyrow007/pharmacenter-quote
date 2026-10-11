import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

// POST /api/sync/fishbowl-work-orders
//
// Sibling of /api/sync/purchase-orders — receives Fishbowl work-order mirrors
// from the pharmacenter-sync agent and writes public.fishbowl_work_orders.
// Same contract: bearer FISHBOWL_SYNC_SECRET, service-role write, batches
// share a run_id, a finalize call closes whatever this run did not stamp.
//
//   1. Data batch:  { run_id, work_orders: [ {...}, ... ] }
//   2. Finalize:    { run_id, finalize: true }
//
// The sender posts open work orders (status 10 Entered, 30 Started) plus
// anything fulfilled in the last 120 days. A row missing from a run has left
// that window, so finalize marks it closed rather than deleting it.
//
// ---------------------------------------------------------------------------
// so_numbers is inferred, and so_link_method says how
// ---------------------------------------------------------------------------
// Fishbowl has two columns linking production to a sales order and
// PharmaCenter uses neither: mo.soId is set on 13 of 4,651 rows (all
// 2019-2020) and moitem.soItemId on none of the open work orders. The agent
// reconstructs the link by matching the MO's finished good against open
// sales-order lines — 39 of 41 open work orders resolved that way.
//
// So an empty so_numbers means UNKNOWN, not "nothing is scheduled". Rows with
// so_link_method 'none' are typically bulk sub-assemblies made to stock. The
// read side must keep those three states apart; collapsing 'none' into
// "nothing scheduled" would raise a false alarm on every sub-assembly.
// Full findings: claude/fishbowl-work-orders.md.
//
// Response: { ok, received, upserted } or { ok, finalized, closed }.

export const runtime = "nodejs";

const LINK_METHODS = new Set(["fishbowl", "product_match", "none"]);

type WoItemPayload = {
  sort_id?: number | null;
  type_id?: number | null;
  part_num?: string | null;
  description?: string | null;
  qty_target?: number | null;
  qty_used?: number | null;
  qty_scrapped?: number | null;
};

type WorkOrderPayload = {
  fb_wo_id: number;
  wo_number: string;
  fb_mo_id?: number | null;
  mo_number?: string | null;
  status_id?: number | null;
  status_name?: string | null;
  is_open?: boolean;
  mo_status_id?: number | null;
  mo_status_name?: string | null;
  product_num?: string | null;
  product_description?: string | null;
  so_numbers?: string[];
  so_link_method?: string | null;
  qty_ordered?: number | null;
  qty_target?: number | null;
  qty_scrapped?: number | null;
  date_created?: string | null;
  date_scheduled?: string | null;
  date_scheduled_to_start?: string | null;
  date_started?: string | null;
  date_finished?: string | null;
  date_last_modified?: string | null;
  note?: string | null;
  items?: WoItemPayload[];
};

type Body = {
  run_id?: string;
  work_orders?: unknown;
  finalize?: boolean;
};

function badRequest(msg: string): NextResponse {
  return NextResponse.json({ ok: false, error: msg }, { status: 400 });
}

function isWorkOrder(v: unknown): v is WorkOrderPayload {
  if (!v || typeof v !== "object") return false;
  const rec = v as Record<string, unknown>;
  if (typeof rec.fb_wo_id !== "number" || !Number.isFinite(rec.fb_wo_id))
    return false;
  if (typeof rec.wo_number !== "string" || rec.wo_number.trim().length === 0)
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
      .from("fishbowl_work_orders")
      .update({ is_open: false })
      .neq("sync_run_id", body.run_id)
      .eq("is_open", true)
      .select("fb_wo_id");
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
  if (!Array.isArray(body.work_orders))
    return badRequest("missing_work_orders_array");

  const rows: Array<Record<string, unknown>> = [];
  const now = new Date().toISOString();
  for (const raw of body.work_orders as unknown[]) {
    if (!isWorkOrder(raw)) continue;

    const soNumbers = new Set<string>();
    if (Array.isArray(raw.so_numbers)) {
      for (const s of raw.so_numbers)
        if (typeof s === "string" && s.trim()) soNumbers.add(s.trim());
    }

    // An unrecognised method is stored as null rather than rejected: the
    // column is a hint for rendering, and losing a whole work order over a
    // vocabulary the sender grew later would be the worse failure. The CHECK
    // constraint would reject the batch outright.
    const method =
      typeof raw.so_link_method === "string" &&
      LINK_METHODS.has(raw.so_link_method)
        ? raw.so_link_method
        : null;

    rows.push({
      fb_wo_id: raw.fb_wo_id,
      wo_number: raw.wo_number.trim(),
      fb_mo_id: raw.fb_mo_id ?? null,
      mo_number: raw.mo_number ?? null,
      status_id: raw.status_id ?? null,
      status_name: raw.status_name ?? null,
      is_open: raw.is_open ?? true,
      mo_status_id: raw.mo_status_id ?? null,
      mo_status_name: raw.mo_status_name ?? null,
      product_num: raw.product_num ?? null,
      product_description: raw.product_description ?? null,
      so_numbers: Array.from(soNumbers),
      so_link_method: method,
      qty_ordered: raw.qty_ordered ?? null,
      qty_target: raw.qty_target ?? null,
      qty_scrapped: raw.qty_scrapped ?? null,
      date_created: raw.date_created ?? null,
      date_scheduled: raw.date_scheduled ?? null,
      date_scheduled_to_start: raw.date_scheduled_to_start ?? null,
      date_started: raw.date_started ?? null,
      date_finished: raw.date_finished ?? null,
      date_last_modified: raw.date_last_modified ?? null,
      note: raw.note ?? null,
      items: Array.isArray(raw.items) ? raw.items : [],
      sync_run_id: body.run_id,
      synced_at: now,
    });
  }

  if (rows.length === 0) {
    return NextResponse.json({ ok: true, received: 0, upserted: 0 });
  }

  const { error } = await supabase
    .from("fishbowl_work_orders")
    .upsert(rows, { onConflict: "fb_wo_id" });
  if (error) {
    console.error("fishbowl_work_orders upsert failed:", error.message);
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
