import { NextResponse } from "next/server";
import { createClient } from "@/lib/auth/server";

// GET /api/overhead?line=bottle[&asof=YYYY-MM-DD]
//
// The plant's overhead defaults, resolved to a date. Backs the Overhead card on
// every costing calculator, so there is one set of rent and payroll figures
// rather than a copy per tool.
//
// Reads the overhead_for_line() function rather than the tables directly: the
// date-band resolution and the per-line share join belong in one place, and SQL
// is that place. See sql/overhead_reference.sql.
//
// WHAT THIS ROUTE DOES NOT DO
//
//   - No arithmetic. Rows come back as they are; overheadRowMonthly and friends
//     in lib/bottleCosting.ts turn them into money. One tested money model.
//   - No snapshotting. A job that has saved its own overhead rows keeps them.
//     These are DEFAULTS for new work, not a record of what anything cost.
//
// IF THE MIGRATION HAS NOT BEEN RUN the function will not exist. That is not an
// error worth shouting about — the route says so plainly and the caller falls
// back to the constants in lib/overheadCosting.ts. This is what lets the code
// ship before the SQL is applied.

export const runtime = "nodejs";

// Deliberately open-ended: standing up a blister or sachet calculator should be
// a row in overhead_line_shares, not an edit here.
const LINE_PATTERN = /^[a-z][a-z0-9_]{1,31}$/;

type Row = {
  item_key: string;
  group_key: "rent" | "indirect" | "other";
  label: string;
  monthly: number | null;
  cam: number | null;
  cam_estimated: boolean;
  pay_type: "hourly" | "salary" | null;
  rate: number | null;
  qty: number | null;
  tax_pct: number | null;
  wc_pct: number | null;
  hours: number | null;
  qb_account: string | null;
  share_pct: number | null;
  source_doc: string | null;
  verified_on: string | null;
  effective_from: string;
  effective_to: string | null;
  status: "current" | "expired" | "not_yet";
  days_left: number | null;
  asof_used: string;
  sort_order: number;
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
  const line = (url.searchParams.get("line") ?? "").trim().toLowerCase();
  const asof = (url.searchParams.get("asof") ?? "").trim();

  if (!LINE_PATTERN.test(line)) {
    return NextResponse.json({ ok: false, error: "bad line key" }, { status: 400 });
  }
  // Passing a date is optional. Omitting it lets SQL work out the as-of from
  // current_date + quote_lead_days, which is the point of the whole design:
  // the rates step over on their own.
  if (asof && !/^\d{4}-\d{2}-\d{2}$/.test(asof)) {
    return NextResponse.json({ ok: false, error: "bad asof date" }, { status: 400 });
  }

  const { data, error } = await supabase.rpc("overhead_for_line", {
    p_line_key: line,
    ...(asof ? { p_asof: asof } : {}),
  });

  if (error) {
    // 42883 undefined_function / 42P01 undefined_table — the migration has not
    // been run on this project yet. Report it as a state, not a failure, so the
    // caller can fall back to the built-in constants without a scary console.
    const notMigrated =
      error.code === "42883" ||
      error.code === "42P01" ||
      /overhead_for_line|overhead_items/i.test(error.message ?? "");
    return NextResponse.json(
      {
        ok: false,
        error: error.message,
        reason: notMigrated ? "not_migrated" : "query_failed",
      },
      { status: notMigrated ? 200 : 500 },
    );
  }

  const rows = (data ?? []) as Row[];

  // snake_case out of Postgres, camelCase into the OverheadItem shape the
  // calculators and lib/bottleCosting.ts already speak. The extra provenance
  // fields ride along so the UI can flag a lapsed lease or an estimated CAM.
  const toItem = (r: Row) => ({
    itemKey: r.item_key,
    label: r.label,
    monthly: r.monthly ?? 0,
    cam: r.cam,
    camEstimated: r.cam_estimated,
    payType: r.pay_type,
    rate: r.rate,
    qty: r.qty,
    taxPct: r.tax_pct,
    wcPct: r.wc_pct,
    hours: r.hours,
    qbAccount: r.qb_account,
    // sharePct is NOT nullable downstream (lib/formulas.ts declares it number),
    // and a blank share means zero rather than unknown.
    sharePct: r.share_pct ?? 0,
    sourceDoc: r.source_doc,
    verifiedOn: r.verified_on,
    effectiveFrom: r.effective_from,
    effectiveTo: r.effective_to,
    status: r.status,
    daysLeft: r.days_left,
  });

  const pick = (g: Row["group_key"]) =>
    rows.filter((r) => r.group_key === g).map(toItem);

  // Rows a human should look at: a lapsed lease band, one ending within 90
  // days, or a CAM that is still an estimate. Surfaced here rather than left
  // for someone to notice, which is the entire reason these rows are dated.
  const attention = rows
    .filter(
      (r) =>
        r.status !== "current" ||
        (r.days_left !== null && r.days_left <= 90) ||
        r.cam_estimated,
    )
    .map((r) => ({
      itemKey: r.item_key,
      label: r.label,
      status: r.status,
      daysLeft: r.days_left,
      camEstimated: r.cam_estimated,
    }));

  // v74: rent per run-day. Best-effort — if overhead_lease_rate() is missing
  // (pools migration not run) the caller gets lease: null and the model falls
  // back to the old row-and-share arithmetic. A missing rate must never be a
  // hard failure: a board that cannot price is worse than one pricing the old
  // way.
  let lease: {
    perRunDay: number | null;
    floorRate: number | null;
    facilityRate: number | null;
    runDaysPerMonth: number | null;
    facilitySharePct: number | null;
    /**
     * v75: the rate exploded per suite x pool, so the board can show the
     * gummy-style logic chain (Base + CAM -> Charged -> ÷ days -> $/run-day)
     * instead of one untraceable number. Rows that charge this line nothing
     * are included with charged 0 — a visible zero answers "why isn't this
     * suite in my price?". Best-effort like the rate itself: null means the
     * breakdown function isn't migrated, and the board falls back to the
     * plain rate display.
     */
    breakdown:
      | Array<{
          suiteKey: string;
          suiteLabel: string;
          poolKey: string;
          poolLabel: string;
          sqFt: number | null;
          pctOfSuite: number | null;
          baseMonthly: number | null;
          camMonthly: number | null;
          chargedMonthly: number | null;
          divisorDays: number | null;
          ratePerDay: number | null;
          sharePctApplied: number | null;
        }>
      | null;
  } | null = null;
  try {
    const { data: lr, error: lrErr } = await supabase.rpc("overhead_lease_rate", {
      p_line_key: line,
      ...(asof ? { p_asof: asof } : {}),
    });
    const row = Array.isArray(lr) ? lr[0] : null;
    if (!lrErr && row) {
      lease = {
        perRunDay: row.per_run_day ?? null,
        floorRate: row.floor_rate ?? null,
        facilityRate: row.facility_rate ?? null,
        runDaysPerMonth: row.run_days_per_month ?? null,
        facilitySharePct: row.facility_share_pct ?? null,
        breakdown: null,
      };
      // Separate try: an unmigrated breakdown function must not cost the
      // board its rate. The rate prices; the breakdown only explains.
      try {
        const { data: bd, error: bdErr } = await supabase.rpc(
          "overhead_lease_breakdown",
          { p_line_key: line, ...(asof ? { p_asof: asof } : {}) },
        );
        if (!bdErr && Array.isArray(bd) && bd.length > 0) {
          lease.breakdown = bd.map((b: Record<string, unknown>) => ({
            suiteKey: String(b.item_key ?? ""),
            suiteLabel: String(b.suite_label ?? ""),
            poolKey: String(b.pool_key ?? ""),
            poolLabel: String(b.pool_label ?? ""),
            sqFt: (b.sq_ft as number) ?? null,
            pctOfSuite: (b.pct_of_suite as number) ?? null,
            baseMonthly: (b.base_monthly as number) ?? null,
            camMonthly: (b.cam_monthly as number) ?? null,
            chargedMonthly: (b.charged_monthly as number) ?? null,
            divisorDays: (b.divisor_days as number) ?? null,
            ratePerDay: (b.rate_per_day as number) ?? null,
            sharePctApplied: (b.share_pct_applied as number) ?? null,
          }));
        }
      } catch {
        // leave breakdown null
      }
    }
  } catch {
    // leave lease null
  }

  return NextResponse.json({
    ok: true,
    line,
    asOf: rows[0]?.asof_used ?? asof ?? null,
    lease,
    rent: pick("rent"),
    indirect: pick("indirect"),
    other: pick("other"),
    attention,
  });
}
