import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { isAdmin } from "@/lib/workflows";
import { ENTRY_COLS, normalizeEntry, toNum, type YieldEntry } from "@/app/yields/_lib/model";
import { fillMissingGross } from "@/app/yields/_lib/backfill";

// GET /api/yields/sheet-gross?from_row=3412 -- admins only.
//
// For the daily Google Sheet sync. Runs the Fishbowl gross fill over every
// sheet-imported entry from that sheet row on (so provisional figures become
// real ones without anyone opening a page), then returns, by sheet row, the
// gross per finished unit to paste into the sheet's column J.
//
//   -> { ok, rows: [{ source_row, gross_per_unit, gross_source }], filled }
export async function GET(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user?.email || !(await isAdmin(supabase, user.email))) {
    return NextResponse.json({ ok: false, error: "not_admin" }, { status: 403 });
  }
  const fromRow = Math.max(2, Math.floor(toNum(new URL(request.url).searchParams.get("from_row")) ?? 3412));

  const rows: (YieldEntry & { source_row: number })[] = [];
  for (let offset = 0; offset < 20_000; offset += 1000) {
    const { data, error } = await supabase
      .from("yield_entries")
      .select(`${ENTRY_COLS}, source_row`)
      .gte("source_row", fromRow)
      .order("source_row", { ascending: true })
      .range(offset, offset + 999);
    if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    const page = (data ?? []) as unknown as Record<string, unknown>[];
    rows.push(...page.map((r) => ({ ...normalizeEntry(r), source_row: Number(r.source_row) })));
    if (page.length < 1000) break;
  }

  const filled = await fillMissingGross(supabase, rows);
  return NextResponse.json({
    ok: true,
    filled,
    rows: rows.map((r) => ({ source_row: r.source_row, gross_per_unit: r.gross_per_unit, gross_source: r.gross_source })),
  });
}
