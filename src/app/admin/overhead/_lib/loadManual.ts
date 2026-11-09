// Hand-made changes waiting on /admin/overhead, and the last few decided.
// Read as the signed-in admin (RLS). Money comes from overheadRowMonthly(), the
// same function the boards use.

import type { createClient } from "@/lib/supabase/server";
import { overheadRowMonthly } from "@/lib/bottleCosting";

type Supa = Awaited<ReturnType<typeof createClient>>;

export type ManualKind = "band" | "lead_days" | "share";

export type ManualProposal = {
  id: string;
  kind: ManualKind;
  itemKey: string | null;
  lineKey: string | null;
  label: string;
  effectiveFrom: string | null;
  bandFrom: string | null;
  bandTo: string | null;
  current: Record<string, unknown>;
  proposed: Record<string, unknown>;
  monthlyBefore: number | null;
  monthlyAfter: number | null;
  sourceDoc: string | null;
  reason: string | null;
  status: "pending" | "approved" | "rejected" | "superseded";
  createdAt: string;
  createdBy: string;
  decidedAt: string | null;
  decidedBy: string | null;
  decisionNote: string | null;
};

export type ManualData = { migrated: boolean; error: string | null; pending: ManualProposal[]; recent: ManualProposal[] };

type Row = {
  id: string;
  kind: ManualKind;
  item_key: string | null;
  line_key: string | null;
  effective_from: string | null;
  band_id: string | null;
  current_values: Record<string, unknown>;
  proposed_values: Record<string, unknown>;
  source_doc: string | null;
  reason: string | null;
  status: ManualProposal["status"];
  created_at: string;
  created_by: string;
  decided_at: string | null;
  decided_by: string | null;
  decision_note: string | null;
};

type ItemRow = Record<string, unknown> & { id: string; item_key: string; group_key: string; label: string };

const num = (v: unknown): number | null => (v === null || v === undefined || v === "" ? null : Number(v));

function monthly(b: Record<string, unknown>): number {
  return overheadRowMonthly(
    {
      label: String(b.label ?? ""),
      monthly: num(b.monthly) ?? 0,
      cam: num(b.cam),
      rate: num(b.rate),
      taxPct: num(b.tax_pct),
      wcPct: num(b.wc_pct),
      hours: num(b.hours),
      qty: num(b.qty),
      payType: (b.pay_type as "hourly" | "salary" | null) ?? null,
      qbAccount: null,
      sharePct: 0,
    },
    b.group_key === "indirect" ? "labor" : b.group_key === "rent" ? "lease" : undefined,
  );
}

export async function loadManual(supabase: Supa): Promise<ManualData> {
  const { data, error } = await supabase
    .from("overhead_manual_proposals")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(40);
  if (error) {
    const missing = error.code === "42P01" || /overhead_manual_proposals/.test(error.message ?? "");
    return { migrated: !missing, error: error.message, pending: [], recent: [] };
  }
  const rows = (data ?? []) as Row[];

  const bandIds = rows.map((r) => r.band_id).filter((x): x is string => !!x);
  const itemKeys = [...new Set(rows.map((r) => r.item_key).filter((x): x is string => !!x))];
  const [bandsRes, labelsRes] = await Promise.all([
    bandIds.length ? supabase.from("overhead_items").select("*").in("id", bandIds) : Promise.resolve({ data: [] as ItemRow[] }),
    itemKeys.length ? supabase.from("overhead_items").select("item_key, label").in("item_key", itemKeys) : Promise.resolve({ data: [] }),
  ]);
  const bands = new Map(((bandsRes.data ?? []) as ItemRow[]).map((b) => [b.id, b]));
  const labels = new Map(((labelsRes.data ?? []) as { item_key: string; label: string }[]).map((l) => [l.item_key, l.label]));

  const out = rows.map((r): ManualProposal => {
    const cur = r.current_values ?? {};
    let before: number | null = null;
    let after: number | null = null;
    if (r.kind === "band") {
      // The band as it stood when proposed: today's row with the proposal's
      // before-values laid over it (only changed fields are stored).
      const base = { ...(r.band_id ? bands.get(r.band_id) ?? {} : {}), group_key: cur.group_key, label: cur.label };
      const was = { ...base, ...cur };
      before = monthly(was);
      after = monthly({ ...was, ...r.proposed_values });
    }
    return {
      id: r.id,
      kind: r.kind,
      itemKey: r.item_key,
      lineKey: r.line_key,
      label: String(cur.label ?? (r.item_key ? labels.get(r.item_key) ?? r.item_key : "")),
      effectiveFrom: r.effective_from,
      bandFrom: (cur.band_from as string) ?? null,
      bandTo: (cur.band_to as string) ?? null,
      current: cur,
      proposed: r.proposed_values ?? {},
      monthlyBefore: before,
      monthlyAfter: after,
      sourceDoc: r.source_doc,
      reason: r.reason,
      status: r.status,
      createdAt: r.created_at,
      createdBy: r.created_by,
      decidedAt: r.decided_at,
      decidedBy: r.decided_by,
      decisionNote: r.decision_note,
    };
  });
  return {
    migrated: true,
    error: null,
    pending: out.filter((p) => p.status === "pending").reverse(),
    recent: out.filter((p) => p.status !== "pending").slice(0, 10),
  };
}
