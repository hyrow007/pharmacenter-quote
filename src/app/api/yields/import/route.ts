import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { isAdmin } from "@/lib/workflows";
import { isIsoDate, isLine, toNum } from "@/app/yields/_lib/model";

// POST /api/yields/import -- admins only.
//
// Loads history from the "Packaging Yields v2.1" Google Sheet into
// yield_entries. The rows arrive already cleaned (one per sheet row, with
// source_row = the sheet's row number) and are upserted on source_row, so
// re-sending a batch updates it rather than duplicating it.
//
// Runs as the signed-in admin, not the service role: the RLS policy that
// lets an admin write sheet_import rows is the same one that stops anyone
// else from editing them later.

const MAX_ROWS = 1000;

export async function POST(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user?.email || !(await isAdmin(supabase, user.email))) {
    return NextResponse.json({ ok: false, error: "not_admin" }, { status: 403 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "bad_json" }, { status: 400 });
  }
  const input = (body as { rows?: unknown })?.rows;
  if (!Array.isArray(input) || input.length === 0 || input.length > MAX_ROWS) {
    return NextResponse.json({ ok: false, error: `rows must be 1-${MAX_ROWS}` }, { status: 400 });
  }

  const rows = [];
  for (const raw of input as Record<string, unknown>[]) {
    const sourceRow = toNum(raw.source_row);
    const gross = toNum(raw.gross_per_unit);
    if (
      sourceRow === null ||
      !Number.isInteger(sourceRow) ||
      !isIsoDate(raw.run_date) ||
      !isLine(raw.line_key) ||
      typeof raw.product_num !== "string" ||
      !raw.product_num.trim()
    ) {
      return NextResponse.json({ ok: false, error: "bad_row", row: raw }, { status: 400 });
    }
    rows.push({
      source: "sheet_import" as const,
      source_row: sourceRow,
      area: "packaging",
      run_date: raw.run_date,
      line_key: raw.line_key,
      product_num: raw.product_num.trim(),
      product_name: typeof raw.product_name === "string" ? raw.product_name : null,
      so_numbers: Array.isArray(raw.so_numbers) ? raw.so_numbers.map(String) : [],
      is_multipack: raw.is_multipack === true,
      units_per_pack: toNum(raw.units_per_pack),
      finished_units: toNum(raw.finished_units) ?? 0,
      single_units: toNum(raw.single_units),
      people: toNum(raw.people),
      hours: toNum(raw.hours),
      gross_per_unit: gross,
      gross_source: gross === null ? null : "sheet",
      created_by: user.email,
    });
  }

  const { error, count } = await supabase
    .from("yield_entries")
    .upsert(rows, { onConflict: "source_row", count: "exact" });
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, upserted: count ?? rows.length });
}
