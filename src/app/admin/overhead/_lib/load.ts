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
