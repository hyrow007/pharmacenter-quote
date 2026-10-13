import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { eachPrice, toNum } from "@/app/yields/_lib/model";

// GET /api/yields/lookup
//
// The two lookups behind the Yields entry form, both read as the signed-in user:
//
//   ?q=<text>         active Fishbowl products whose number or name matches
//                     -> { ok, products: [{ fp_code, name, avg_cost }] }
//   ?product=<num>    that product, plus every mirrored SO line selling it
//                     -> { ok, product, orders: [...] , synced_at }
//
// Products come from `products` (the nightly sync: fp_code = Fishbowl's
// product.num, avg_cost = its latest partcost). Orders come from the
// fishbowl_sales_orders mirror, open and closed -- a run often packs an order
// the sync has already marked closed.

type Item = {
  type_id?: number | null;
  product_num?: string | null;
  unit_price?: unknown;
  qty_ordered?: unknown;
  uom?: string | null;
  uom_name?: string | null;
};

export async function GET(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user || !user.email?.endsWith("@pharmacenterusa.com")) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const url = new URL(request.url);
  const q = (url.searchParams.get("q") || "").trim();
  const product = (url.searchParams.get("product") || "").trim();

  if (product) {
    const [pRes, soRes] = await Promise.all([
      supabase.from("products").select("fp_code, name, avg_cost").eq("fp_code", product).limit(1).maybeSingle(),
      supabase
        .from("fishbowl_sales_orders")
        .select("so_number, customer_name, is_open, status_name, date_issued, items, synced_at")
        .contains("items", [{ product_num: product }])
        .order("date_issued", { ascending: false })
        .limit(25),
    ]);
    if (soRes.error) return NextResponse.json({ ok: false, error: soRes.error.message }, { status: 500 });

    let syncedAt: string | null = null;
    const orders = (soRes.data ?? []).flatMap((so) => {
      if (typeof so.synced_at === "string" && (!syncedAt || so.synced_at > syncedAt)) syncedAt = so.synced_at;
      const items = (Array.isArray(so.items) ? so.items : []) as Item[];
      return items
        .filter((it) => it.product_num === product && (it.type_id === 10 || it.type_id === 30))
        .map((it) => {
          const unitPrice = toNum(it.unit_price);
          const { each, factor, unitLabel } = eachPrice(unitPrice, it.uom, it.uom_name);
          return {
            so_number: so.so_number as string,
            customer_name: (so.customer_name as string | null) ?? null,
            is_open: !!so.is_open,
            status_name: (so.status_name as string | null) ?? null,
            date_issued: (so.date_issued as string | null) ?? null,
            unit_price: unitPrice,
            qty_ordered: toNum(it.qty_ordered),
            each_price: each,
            unit_factor: factor,
            unit_label: unitLabel,
          };
        });
    });

    const p = pRes.data;
    return NextResponse.json({
      ok: true,
      product: p ? { fp_code: p.fp_code, name: p.name, avg_cost: toNum(p.avg_cost) } : null,
      orders,
      synced_at: syncedAt,
    });
  }

  if (q.length < 2) return NextResponse.json({ ok: true, products: [] });
  const term = q.replace(/[%_,()*]/g, " ").trim();
  const { data, error } = await supabase
    .from("products")
    .select("fp_code, name, avg_cost")
    .eq("active", true)
    .or(`fp_code.ilike.%${term}%,name.ilike.%${term}%`)
    .order("fp_code", { ascending: true })
    .limit(20);
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });

  // An exact number match first: the leader usually types the code.
  const rows = (data ?? []).map((p) => ({ fp_code: p.fp_code as string, name: p.name as string, avg_cost: toNum(p.avg_cost) }));
  rows.sort((a, b) => Number(b.fp_code === term) - Number(a.fp_code === term));
  return NextResponse.json({ ok: true, products: rows });
}
