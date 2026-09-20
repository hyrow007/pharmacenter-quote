import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

// GET /api/sales-orders
//
// Read side of the Fishbowl sales-orders sync — the endpoint OTHER tools
// (Claude sessions updating SO documents, dashboards, etc.) are pointed at.
// Requires a signed-in @pharmacenterusa.com session, same as every page.
//
// Query params:
//   ?all=1          include closed orders too (default: open only)
//   ?q=<text>       case-insensitive match on so_number / customer / PO
//   ?so=<number>    exact so_number lookup (returns that order only)
//
// Response:
//   { ok: true, count, synced_at, sales_orders: [...] }
// where synced_at is the newest sync stamp in the result — data is only as
// fresh as the last nightly Fishbowl run (~04:00), and consumers should
// surface that timestamp rather than implying real-time.

const COLS =
  "fb_so_id, so_number, status_id, status_name, is_open, customer_name, " +
  "customer_po, salesman, note, date_issued, date_created, date_first_ship, " +
  "date_last_modified, subtotal, total_price, items, synced_at";

export async function GET(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user || !user.email?.endsWith("@pharmacenterusa.com")) {
    return NextResponse.json(
      { ok: false, error: "unauthorized" },
      { status: 401 },
    );
  }

  const url = new URL(request.url);
  const all = url.searchParams.get("all") === "1";
  const q = (url.searchParams.get("q") || "").trim();
  const so = (url.searchParams.get("so") || "").trim();

  let query = supabase
    .from("fishbowl_sales_orders")
    .select(COLS)
    .order("so_number", { ascending: false })
    .limit(500);

  if (so) {
    query = query.eq("so_number", so);
  } else {
    if (!all) query = query.eq("is_open", true);
    if (q) {
      const like = `%${q.replace(/[%_]/g, "")}%`;
      query = query.or(
        `so_number.ilike.${like},customer_name.ilike.${like},customer_po.ilike.${like}`,
      );
    }
  }

  const { data, error } = await query;
  if (error) {
    console.error("sales_orders read failed:", error.message);
    return NextResponse.json(
      { ok: false, error: error.message },
      { status: 500 },
    );
  }

  // supabase-js cannot statically parse a runtime-composed column string,
  // so it types the rows as GenericStringError. The shape is ours; cast.
  const rows = (data ?? []) as unknown as Array<
    Record<string, unknown> & { synced_at?: string | null }
  >;
  const syncedAt = rows.reduce<string | null>(
    (m, r) =>
      typeof r.synced_at === "string" && (!m || r.synced_at > m)
        ? r.synced_at
        : m,
    null,
  );
  return NextResponse.json({
    ok: true,
    count: rows.length,
    synced_at: syncedAt,
    sales_orders: rows,
  });
}
