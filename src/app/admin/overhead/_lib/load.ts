// Everything /admin/overhead shows, read as the signed-in user (RLS applies).
//
// Band resolution is NOT redone here. The page asks overhead_for_line() twice —
// once with no date (the quote date: current_date + quote_lead_days) and once
// for today — so the SQL resolver stays the one place that decides which band
// is in force. The raw table is read only to list every band for history.

import type { createClient } from "@/lib/supabase/server";

type Supa = Awaited<ReturnType<typeof createClient>>;

export type Group = "rent" | "indirect" | "other";

export type Band = {
  itemKey: string;
  group: Group;
  label: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  monthly: number;
  cam: number | null;
  camEstimated: boolean;
  payType: "hourly" | "salary" | null;
  rate: number | null;
  qty: number | null;
  taxPct: number | null;
  wcPct: number | null;
  hours: number | null;
  qbAccount: string | null;
  sourceDoc: string | null;
  verifiedOn: string | null;
  active: boolean;
};

export type Resolved = Band & {
  status: "current" | "expired" | "not_yet";
  daysLeft: number | null;
  asofUsed: string;
};

export type Share = { lineKey: string; itemKey: string; sharePct: number };

export type OverheadData = {
  today: string;
  quoteDate: string;
  leadDays: number | null;
  quote: Resolved[];
  current: Map<string, Resolved>;
  bands: Map<string, Band[]>;
  shares: Share[];
  lines: string[];
};

/** Today's date in the plant's time zone, YYYY-MM-DD. */
export function plantToday(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date());
}

const n = (v: unknown): number | null => (v === null || v === undefined || v === "" ? null : Number(v));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toBand(r: any): Band {
  return {
    itemKey: r.item_key,
    group: r.group_key,
    label: r.label,
    effectiveFrom: r.effective_from,
    effectiveTo: r.effective_to ?? null,
    monthly: n(r.monthly) ?? 0,
    cam: n(r.cam),
    camEstimated: !!r.cam_estimated,
    payType: r.pay_type ?? null,
    rate: n(r.rate),
    qty: n(r.qty),
    taxPct: n(r.tax_pct),
    wcPct: n(r.wc_pct),
    hours: n(r.hours),
    qbAccount: r.qb_account ?? null,
    sourceDoc: r.source_doc ?? null,
    verifiedOn: r.verified_on ?? null,
    active: r.active ?? true,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toResolved(r: any): Resolved {
  return { ...toBand(r), status: r.status, daysLeft: n(r.days_left), asofUsed: r.asof_used };
}

export async function loadOverhead(supabase: Supa): Promise<OverheadData> {
  const today = plantToday();

  const [settings, items, shares] = await Promise.all([
    supabase.from("overhead_settings").select("key, value_num").eq("key", "quote_lead_days").maybeSingle(),
    supabase.from("overhead_items").select("*").order("item_key").order("effective_from"),
    supabase.from("overhead_line_shares").select("line_key, item_key, share_pct"),
  ]);
  if (items.error) throw new Error(items.error.message);
  if (shares.error) throw new Error(shares.error.message);

  const shareRows: Share[] = (shares.data ?? []).map((s) => ({
    lineKey: s.line_key,
    itemKey: s.item_key,
    sharePct: Number(s.share_pct) || 0,
  }));
  const lines = [...new Set(shareRows.map((s) => s.lineKey))].sort();

  // Any line key will do: every active item comes back whatever its share.
  const line = lines[0] ?? "bottle";
  const [q, c] = await Promise.all([
    supabase.rpc("overhead_for_line", { p_line_key: line }),
    supabase.rpc("overhead_for_line", { p_line_key: line, p_asof: today }),
  ]);
  if (q.error) throw new Error(q.error.message);
  if (c.error) throw new Error(c.error.message);

  const quote = ((q.data ?? []) as unknown[]).map(toResolved);
  const current = new Map(((c.data ?? []) as unknown[]).map(toResolved).map((r) => [r.itemKey, r]));

  const bands = new Map<string, Band[]>();
  for (const r of items.data ?? []) {
    const b = toBand(r);
    bands.set(b.itemKey, [...(bands.get(b.itemKey) ?? []), b]);
  }

  return {
    today,
    // The resolver's own answer, so the page can never disagree with the boards.
    quoteDate: quote[0]?.asofUsed ?? today,
    leadDays: settings.data ? n(settings.data.value_num) : null,
    quote,
    current,
    bands,
    shares: shareRows,
    lines,
  };
}

// ------------------------------------------------------------------
// Capacity from Yields: the Contract Packaging divisor, measured vs in use.
// ------------------------------------------------------------------

export type Measured = {
  line_key: string;
  run_days: number;
  per_month: number;
  distinct_days: number;
  window_from: string;
  window_to: string;
  first_entry: string | null;
  last_entry: string | null;
};

export type Proposal = {
  id: string;
  trigger: "schedule" | "button";
  period: string | null;
  windowMonths: number;
  windowFrom: string;
  windowTo: string;
  currentValue: number | null;
  proposedValue: number;
  measured: Measured[];
  status: "pending" | "approved" | "rejected" | "superseded";
  createdAt: string;
  createdBy: string;
  decidedAt: string | null;
  decidedBy: string | null;
  decisionNote: string | null;
};

export type CapacityData = {
  cpCapacity: number | null;
  gummyCapacity: number | null;
  /** Rent apportioned to the Contract Packaging floor, on the quote date. */
  cpMonthly: number | null;
  /** Item keys charged through the production-support pool. */
  supportItems: Set<string>;
  proposals: Proposal[];
  /** Set when the monthly proposal could not be made (e.g. migration not applied). */
  scheduleError: string | null;
  migrated: boolean;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toProposal(r: any): Proposal {
  return {
    id: r.id,
    trigger: r.trigger,
    period: r.period,
    windowMonths: r.window_months,
    windowFrom: r.window_from,
    windowTo: r.window_to,
    currentValue: n(r.current_value),
    proposedValue: Number(r.proposed_value),
    measured: (r.measured ?? []) as Measured[],
    status: r.status,
    createdAt: r.created_at,
    createdBy: r.created_by,
    decidedAt: r.decided_at,
    decidedBy: r.decided_by,
    decisionNote: r.decision_note,
  };
}

/**
 * Makes this month's scheduled proposal if there is none yet (the SQL is
 * idempotent per month), then reads everything the capacity section shows.
 * Opening the page is what "once a month" hangs on: nobody can approve without
 * opening it, so a proposal made on first open is waiting exactly when needed.
 */
export async function loadCapacity(supabase: Supa): Promise<CapacityData> {
  let scheduleError: string | null = null;
  let migrated = true;
  const sched = await supabase.rpc("overhead_capacity_propose", { p_trigger: "schedule", p_months: 6 });
  if (sched.error) {
    scheduleError = sched.error.message;
    if (/does not exist|schema cache/i.test(sched.error.message)) migrated = false;
  }

  const [pools, rates, itemPools, props] = await Promise.all([
    supabase.from("overhead_pools").select("pool_key, capacity_per_month"),
    supabase.rpc("overhead_pool_rates"),
    supabase.from("overhead_item_pools").select("item_key, pool_key"),
    migrated
      ? supabase.from("overhead_capacity_proposals").select("*").order("created_at", { ascending: false }).limit(8)
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (pools.error) throw new Error(pools.error.message);

  const cap = new Map((pools.data ?? []).map((p) => [p.pool_key as string, n(p.capacity_per_month)]));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cpRate = ((rates.data ?? []) as any[]).find((r) => r.pool_key === "cp_packaging");

  return {
    cpCapacity: cap.get("cp_packaging") ?? null,
    gummyCapacity: cap.get("gummy_manufacturing") ?? null,
    cpMonthly: cpRate ? n(cpRate.monthly) : null,
    supportItems: new Set(
      (itemPools.data ?? []).filter((r) => r.pool_key === "production_support").map((r) => r.item_key as string),
    ),
    proposals: ((props.data ?? []) as unknown[]).map(toProposal),
    scheduleError,
    migrated,
  };
}
