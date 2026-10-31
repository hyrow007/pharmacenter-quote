import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { isAdmin } from "@/lib/workflows";
import { ENTRY_COLS, normalizeEntry, parseSoNumbers, toNum, type YieldEntry } from "@/app/yields/_lib/model";
import { fillMissingGross } from "@/app/yields/_lib/backfill";

// POST /api/yields/sheet-sync
//
// Called once a day by the Google Apps Script attached to the "Packaging
// Yields v2.1" sheet (see docs: claude/yields.md, "Sheet sync"). It runs on
// Google's servers, so the sync no longer depends on anyone's laptop.
//
// Auth: no shared secret. The script sends the Google OAuth access token of
// the account that installed it (ScriptApp.getOAuthToken(), with the
// userinfo.email scope); we ask Google who it belongs to and accept it only
// for a verified PharmaCenter admin. A leaked token expires within the hour.
//
// Body: { from_row: 3412, rows: [[A..O display values], ...] } -- the sheet's
// rows from from_row on, exactly as shown. Parsing lives here, in one place.
//   1. inserts sheet rows not imported yet (existing rows are never touched:
//      SOs and grosses corrected in the app survive);
//   2. fills real Fishbowl grosses over every sheet row from from_row on;
//   3. returns { ok, imported, filled, gross: { [source_row]: number|null } }.

export const runtime = "nodejs";

const LINE: Record<string, string> = {
  Blisters: "blister",
  Bottles: "bottle",
  Pouches: "pouch",
  Sachets: "sachet",
  Other: "other",
};

function num(v: unknown): number | null {
  const s = String(v ?? "").trim().replace(/[$,]/g, "");
  if (["", "-", "N/A", "NA"].includes(s.toUpperCase())) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

async function verifyGoogleAdmin(authorization: string | null): Promise<string | null> {
  const token = (authorization ?? "").startsWith("Bearer ") ? authorization!.slice(7).trim() : "";
  if (!token) return null;
  const r = await fetch(`https://oauth2.googleapis.com/tokeninfo?access_token=${encodeURIComponent(token)}`, {
    cache: "no-store",
  });
  if (!r.ok) return null;
  const info = (await r.json()) as { email?: string; email_verified?: string | boolean; expires_in?: string };
  const verified = info.email_verified === true || info.email_verified === "true";
  if (!info.email || !verified || !info.email.endsWith("@pharmacenterusa.com")) return null;
  return info.email.toLowerCase();
}

export async function POST(request: Request) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return NextResponse.json({ ok: false, error: "server_misconfigured" }, { status: 500 });
  const supabase = createClient(url, key, { auth: { persistSession: false } });

  const email = await verifyGoogleAdmin(request.headers.get("authorization"));
  if (!email || !(await isAdmin(supabase, email))) {
    console.warn(`yields sheet-sync: refused (${email ?? "no valid Google token"})`);
    return NextResponse.json({ ok: false, error: "not_admin" }, { status: 403 });
  }

  let body: { from_row?: unknown; rows?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "bad_json" }, { status: 400 });
  }
  const fromRow = Math.max(2, Math.floor(toNum(body.from_row) ?? 3412));
  const cells = Array.isArray(body.rows) ? (body.rows as unknown[][]) : [];
  if (cells.length > 5000) return NextResponse.json({ ok: false, error: "too_many_rows" }, { status: 400 });

  // 1. Parse and insert new rows only.
  const rows = [];
  const skipped: number[] = [];
  for (let i = 0; i < cells.length; i++) {
    const c = (cells[i] ?? []).map((v) => String(v ?? "").trim());
    const sourceRow = fromRow + i;
    if (!c[0] && !c[2]) continue; // blank line
    const m = c[0].match(/(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    const line = LINE[c[1]];
    if (!m || !line || !c[2]) {
      skipped.push(sourceRow);
      continue;
    }
    const finished = num(c[7]) ?? 0;
    rows.push({
      source: "sheet_import" as const,
      source_row: sourceRow,
      area: "packaging",
      run_date: `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`,
      line_key: line,
      product_num: c[2],
      product_name: c[3] || null,
      so_numbers: parseSoNumbers(c[4]),
      is_multipack: c[5].toLowerCase() === "yes",
      units_per_pack: num(c[6]),
      finished_units: finished,
      single_units: num(c[8]),
      people: num(c[11]),
      hours: num(c[12]),
      gross_per_unit: null,
      gross_source: null,
      created_by: email,
    });
  }
  let imported = 0;
  if (rows.length) {
    const { error, count } = await supabase
      .from("yield_entries")
      .upsert(rows, { onConflict: "source_row", ignoreDuplicates: true, count: "exact" });
    if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    imported = count ?? 0;
  }

  // 2. Fill real grosses over the sheet rows from from_row on.
  const entries: (YieldEntry & { source_row: number })[] = [];
  for (let offset = 0; offset < 20_000; offset += 1000) {
    const { data, error } = await supabase
      .from("yield_entries")
      .select(`${ENTRY_COLS}, source_row`)
      .gte("source_row", fromRow)
      .order("source_row", { ascending: true })
      .range(offset, offset + 999);
    if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    const page = (data ?? []) as unknown as Record<string, unknown>[];
    entries.push(...page.map((r) => ({ ...normalizeEntry(r), source_row: Number(r.source_row) })));
    if (page.length < 1000) break;
  }
  const filled = await fillMissingGross(supabase, entries);

  // 3. Gross per finished unit by sheet row.
  const gross: Record<number, number | null> = {};
  for (const e of entries) gross[e.source_row] = e.gross_per_unit;
  console.log(`yields sheet-sync: ${email} imported=${imported} filled=${filled} rows=${entries.length} skipped=${skipped.join(",")}`);
  return NextResponse.json({ ok: true, imported, filled, skipped, gross });
}
