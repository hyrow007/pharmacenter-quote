"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import {
  eachPrice,
  grossFrom,
  isIsoDate,
  isLine,
  parseSoNumbers,
  singlesFor,
  toNum,
} from "./_lib/model";

// Writes for Yields. Results are returned, not thrown -- Next redacts thrown
// errors in production, and the form needs something it can show.
//
// The money is decided HERE, not trusted from the browser. The form previews
// the same arithmetic (model.ts) so the leader sees the number before saving,
// but a 'fishbowl' gross is re-read from the mirror on save.

export type SaveInput = {
  id?: string | null;
  run_date: string;
  line_key: string;
  product_num: string;
  product_name?: string | null;
  so_numbers: string;
  is_multipack: boolean;
  units_per_pack?: number | string | null;
  finished_units: number | string;
  people?: number | string | null;
  hours?: number | string | null;
  note?: string | null;
  gross_mode: "fishbowl" | "manual" | "none";
  price_so?: string | null; // which SO's line the Fishbowl price is read from
  manual_gross?: number | string | null;
};

export type ActionResult = { ok: true; id: string } | { ok: false, error: string; detail?: string };

function nonNeg(v: unknown): number | null | "bad" {
  const n = toNum(v);
  if (n === null) return null;
  return n < 0 ? "bad" : n;
}

export async function saveYieldEntry(input: SaveInput): Promise<ActionResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user?.email?.endsWith("@pharmacenterusa.com")) return { ok: false, error: "err_not_signed_in" };

  const product = (input.product_num ?? "").trim();
  if (!product) return { ok: false, error: "err_no_product" };
  if (!isIsoDate(input.run_date) || !isLine(input.line_key)) return { ok: false, error: "err_bad_input" };

  const finished = nonNeg(input.finished_units);
  const perPack = nonNeg(input.units_per_pack);
  const people = nonNeg(input.people);
  const hours = nonNeg(input.hours);
  if (finished === "bad" || finished === null || perPack === "bad" || people === "bad" || hours === "bad") {
    return { ok: false, error: "err_bad_input" };
  }
  const multipack = !!input.is_multipack;
  const units_per_pack = multipack && perPack && perPack > 0 ? perPack : null;

  let unit_price: number | null = null;
  let unit_cost: number | null = null;
  let gross_per_unit: number | null = null;
  let gross_source: "fishbowl" | "manual" | null = null;

  if (input.gross_mode === "manual") {
    const g = toNum(input.manual_gross);
    if (g === null) return { ok: false, error: "err_bad_input" };
    gross_per_unit = g;
    gross_source = "manual";
  } else if (input.gross_mode === "fishbowl" && input.price_so) {
    const [soRes, pRes] = await Promise.all([
      supabase.from("fishbowl_sales_orders").select("items").eq("so_number", input.price_so).limit(1).maybeSingle(),
      supabase.from("products").select("avg_cost").eq("fp_code", product).limit(1).maybeSingle(),
    ]);
    const items = (Array.isArray(soRes.data?.items) ? soRes.data.items : []) as Array<Record<string, unknown>>;
    const line = items.find((it) => it.product_num === product && (it.type_id === 10 || it.type_id === 30));
    unit_price = eachPrice(
      toNum(line?.unit_price),
      line?.uom as string | null | undefined,
      line?.uom_name as string | null | undefined,
    ).each;
    unit_cost = toNum(pRes.data?.avg_cost);
    gross_per_unit = grossFrom(unit_price, unit_cost);
    gross_source = gross_per_unit === null ? null : "fishbowl";
  }

  const row = {
    area: "packaging",
    run_date: input.run_date,
    line_key: input.line_key,
    product_num: product,
    product_name: (input.product_name ?? "").trim() || null,
    so_numbers: parseSoNumbers(input.so_numbers ?? ""),
    is_multipack: multipack,
    units_per_pack,
    finished_units: finished,
    single_units: singlesFor(finished, multipack, units_per_pack),
    people,
    hours,
    unit_price,
    unit_cost,
    gross_per_unit,
    gross_source,
    note: (input.note ?? "").trim().slice(0, 2000) || null,
  };

  const res = input.id
    ? await supabase.from("yield_entries").update(row).eq("id", input.id).select("id").maybeSingle()
    : await supabase.from("yield_entries").insert({ ...row, source: "app" }).select("id").single();
  if (res.error) return { ok: false, error: "err_save_failed", detail: res.error.message };
  if (!res.data) return { ok: false, error: "err_not_allowed" };

  revalidatePath("/yields");
  return { ok: true, id: res.data.id as string };
}

export async function deleteYieldEntry(id: string): Promise<ActionResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user?.email?.endsWith("@pharmacenterusa.com")) return { ok: false, error: "err_not_signed_in" };
  const { data, error } = await supabase.from("yield_entries").delete().eq("id", id).select("id");
  if (error) return { ok: false, error: "err_save_failed", detail: error.message };
  if (!data || data.length === 0) return { ok: false, error: "err_not_allowed" };
  revalidatePath("/yields");
  return { ok: true, id };
}
