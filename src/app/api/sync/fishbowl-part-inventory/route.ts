import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

// POST /api/sync/fishbowl-part-inventory
//
// Receives Fishbowl's own qtyinventorytotals figures from the
// pharmacenter-sync agent and writes public.fishbowl_part_inventory. Same
// contract as work orders and purchase orders: bearer FISHBOWL_SYNC_SECRET,
// service-role write, run_id batches, then a finalize call.
//
//   1. Data batch:  { run_id, parts: [ {...}, ... ] }
//   2. Finalize:    { run_id, finalize: true }
//
// Unlike the order mirrors, finalize DELETES rows this run did not stamp.
// A part with no inventory row in Fishbowl has no quantities at all, and a
// leftover row would keep reporting stock that is no longer there -- the one
// direction of error this feature must not make. The guard below refuses to
// delete when the run wrote nothing, so a stray finalize cannot empty the
// table.
//
// ---------------------------------------------------------------------------
// qty_available is signed, deliberately
// ---------------------------------------------------------------------------
// qty_available = qty_on_hand - qty_allocated - qty_not_available, computed in
// the agent so no two consumers compute it differently. 127 of 728 parts are
// NEGATIVE today: Fishbowl has promised more than it holds. Nothing here or
// downstream may clamp it at zero -- that erases the condition the board
// exists to surface. qty_on_order carries the rest of the sentence: 80 parts
// are short with stock inbound, which is a different conversation.
//
// Full findings: claude/fishbowl-part-inventory.md.
//
// Response: { ok, received, upserted } or { ok, finalized, deleted }.

export const runtime = "nodejs";

type LocationGroupPayload = {
  location_group?: string | null;
  qty_on_hand?: number | null;
  qty_allocated?: number | null;
};

type PartInventoryPayload = {
  fb_part_id: number;
  part_num: string;
  description?: string | null;
  uom?: string | null;
  qty_on_hand?: number | null;
  qty_allocated?: number | null;
  qty_not_available?: number | null;
  qty_not_available_to_pick?: number | null;
  qty_drop_ship?: number | null;
  qty_on_order?: number | null;
  qty_available?: number | null;
  by_location_group?: LocationGroupPayload[];
};

type Body = {
  run_id?: string;
  parts?: unknown;
  finalize?: boolean;
};

function badRequest(msg: string): NextResponse {
  return NextResponse.json({ ok: false, error: msg }, { status: 400 });
}

function isPart(v: unknown): v is PartInventoryPayload {
  if (!v || typeof v !== "object") return false;
  const rec = v as Record<string, unknown>;
  if (typeof rec.fb_part_id !== "number" || !Number.isFinite(rec.fb_part_id))
    return false;
  if (typeof rec.part_num !== "string" || rec.part_num.trim().length === 0)
    return false;
  if (
    rec.by_location_group !== undefined &&
    !Array.isArray(rec.by_location_group)
  )
    return false;
  return true;
}

// Quantities pass through as sent, including negatives and zero. Only a
// non-finite value becomes null -- "unknown" and "none" are different answers
// and the board renders them differently.
function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
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
    // Refuse to delete on behalf of a run that wrote nothing. Without this,
    // one finalize arriving alone -- a retry, a half-failed run, a stray
    // call -- would empty the table and every part would read as unknown.
    const { count, error: countErr } = await supabase
      .from("fishbowl_part_inventory")
      .select("fb_part_id", { count: "exact", head: true })
      .eq("sync_run_id", body.run_id);
    if (countErr) {
      console.error("finalize count failed:", countErr.message);
      return NextResponse.json(
        { ok: false, error: countErr.message },
        { status: 500 },
      );
    }
    if (!count) {
      return NextResponse.json({
        ok: true,
        finalized: false,
        deleted: 0,
        note: "run wrote no rows; nothing deleted",
      });
    }

    const { data, error } = await supabase
      .from("fishbowl_part_inventory")
      .delete()
      .neq("sync_run_id", body.run_id)
      .select("fb_part_id");
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
      kept: count,
      deleted: (data ?? []).length,
    });
  }

  // ----- data path ----------------------------------------------------
  if (!Array.isArray(body.parts)) return badRequest("missing_parts_array");

  const rows: Array<Record<string, unknown>> = [];
  const now = new Date().toISOString();
  for (const raw of body.parts as unknown[]) {
    if (!isPart(raw)) continue;
    rows.push({
      fb_part_id: raw.fb_part_id,
      part_num: raw.part_num.trim(),
      description: raw.description ?? null,
      uom: raw.uom ?? null,
      qty_on_hand: num(raw.qty_on_hand),
      qty_allocated: num(raw.qty_allocated),
      qty_not_available: num(raw.qty_not_available),
      qty_not_available_to_pick: num(raw.qty_not_available_to_pick),
      qty_drop_ship: num(raw.qty_drop_ship),
      qty_on_order: num(raw.qty_on_order),
      qty_available: num(raw.qty_available),
      by_location_group: Array.isArray(raw.by_location_group)
        ? raw.by_location_group
        : [],
      sync_run_id: body.run_id,
      synced_at: now,
    });
  }

  if (rows.length === 0) {
    return NextResponse.json({ ok: true, received: 0, upserted: 0 });
  }

  const { error } = await supabase
    .from("fishbowl_part_inventory")
    .upsert(rows, { onConflict: "fb_part_id" });
  if (error) {
    console.error("fishbowl_part_inventory upsert failed:", error.message);
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
