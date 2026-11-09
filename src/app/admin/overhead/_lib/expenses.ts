import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { log, qboConfig, qboGet, serviceDb } from "./qbo";
import { plantToday } from "./load";

// Other expenses from QuickBooks → a proposal. Read-only against Intuit.
//
// Window: `months` calendar months ending at the last RECONCILED month
// (overhead_settings.qbo_reconciled_through, admin-set) — never past the last complete
// month. Unreconciled months still move, so they are left out (operator, 2026-11-08).
// Basis: Accrual (operator decision 2026-11-08).
// Each overhead_items row with a qb_account is matched to a QuickBooks account by its
// account number, and gets that account's amount PLUS all its sub-accounts' amounts —
// except sub-accounts that are overhead rows of their own. Every posting is attributed
// to its nearest mapped ancestor-or-self (via ParentRef), so nothing is counted twice:
// 5135 "Utilities & Services" gets its other children but not Cleaning (5135.05) or
// Electricity (5135.30), which are their own rows; 5130 "Insurances" gets all its
// sub-accounts. (First version took only the account's own postings and proposed $0
// for parents whose spending sits in sub-accounts — caught before approval, 2026-11-08.)

export const WINDOW_MONTHS = 6;
export const BASIS = "Accrual" as const;

type Col = { ColTitle?: string; ColType?: string; MetaData?: { Name: string; Value: string }[] };
type ColData = { value?: string; id?: string };
type Row = { type?: string; ColData?: ColData[]; Header?: { ColData?: ColData[] }; Rows?: { Row?: Row[] } };
type PnL = { Columns?: { Column?: Col[] }; Rows?: { Row?: Row[] } };
type Account = { Id: string; Name: string; AcctNum?: string; FullyQualifiedName?: string; ParentRef?: { value: string } };

export type ExpenseLine = {
  item_key: string;
  label: string;
  qb_account: string;
  qb_account_name: string | null;
  current_band_id: string;
  current_monthly: number;
  proposed_monthly: number;
  months: Record<string, number>;
  missing: boolean;
};

function ym(d: Date) {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** reconciledThrough: "YYYY-MM" or null. The window ends at the earlier of that and last month. */
export function windowFor(today: string, reconciledThrough: string | null, months = WINDOW_MONTHS) {
  const t = new Date(`${today}T12:00:00Z`);
  let endMonthFirst = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() - 1, 1)); // last complete month
  if (reconciledThrough && /^\d{4}-\d{2}$/.test(reconciledThrough)) {
    const [y, m] = reconciledThrough.split("-").map(Number);
    const rec = new Date(Date.UTC(y, m - 1, 1));
    if (rec < endMonthFirst) endMonthFirst = rec;
  }
  const firstAfter = new Date(Date.UTC(endMonthFirst.getUTCFullYear(), endMonthFirst.getUTCMonth() + 1, 1));
  const end = new Date(firstAfter.getTime() - 86400_000); // last day of the end month
  const start = new Date(Date.UTC(endMonthFirst.getUTCFullYear(), endMonthFirst.getUTCMonth() - months + 1, 1));
  const keys: string[] = [];
  for (let i = 0; i < months; i++) keys.push(ym(new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + i, 1))));
  return { from: start.toISOString().slice(0, 10), to: end.toISOString().slice(0, 10), keys };
}

function amounts(pnl: PnL): Map<string, Record<string, number>> {
  const cols = pnl.Columns?.Column ?? [];
  const monthAt: (string | null)[] = cols.map((c) => {
    const sd = c.MetaData?.find((m) => m.Name === "StartDate")?.Value;
    return c.ColType === "Money" && sd ? sd.slice(0, 7) : null; // "Total" has no StartDate month of its own
  });
  // The Total column also carries StartDate = window start; drop the last money column if it is titled Total.
  cols.forEach((c, i) => {
    if ((c.ColTitle ?? "").trim().toLowerCase() === "total") monthAt[i] = null;
  });
  const out = new Map<string, Record<string, number>>();
  const walk = (rows?: Row[]) => {
    for (const r of rows ?? []) {
      const cd = r.ColData;
      if (cd && cd[0]?.id) {
        const rec = out.get(cd[0].id) ?? {};
        cd.forEach((c, i) => {
          const m = monthAt[i];
          if (!m) return;
          const v = Number(c.value);
          if (Number.isFinite(v)) rec[m] = (rec[m] ?? 0) + v;
        });
        out.set(cd[0].id, rec);
      }
      walk(r.Rows?.Row);
    }
  };
  walk(pnl.Rows?.Row);
  return out;
}

/**
 * Pull and store a proposal. `user` is the admin's own client (RLS: proposals and bands);
 * tokens are read with the service role inside qboGet.
 */
export async function pullExpenses(user: SupabaseClient, trigger: "schedule" | "button", actor: string): Promise<string | null> {
  const db = serviceDb();
  const { env } = qboConfig();
  const today = plantToday();
  const { data: rs } = await user.from("overhead_settings").select("value_text").eq("key", "qbo_reconciled_through").maybeSingle();
  const reconciled = (rs?.value_text as string | null) ?? null;
  const win = windowFor(today, reconciled);
  const period = trigger === "schedule" ? today.slice(0, 7) : null;

  if (trigger === "schedule") {
    // Once a month at most, and only when the reconciled window has moved past the last pull.
    const { data: last } = await user
      .from("overhead_expense_proposals")
      .select("window_to, period, trigger")
      .eq("environment", env)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (last && last.window_to >= win.to) return null;
    const { data: thisMonth } = await user
      .from("overhead_expense_proposals")
      .select("id")
      .eq("trigger", "schedule")
      .eq("environment", env)
      .eq("period", period!)
      .maybeSingle();
    if (thisMonth) return null;
  }

  // Bands in force today for every item that names a QuickBooks account.
  const { data: bands, error: bErr } = await user
    .from("overhead_items")
    .select("id, item_key, label, monthly, qb_account, effective_from, effective_to, active")
    .not("qb_account", "is", null)
    .lte("effective_from", today)
    .or(`effective_to.is.null,effective_to.gte.${today}`);
  if (bErr) throw new Error(bErr.message);
  const current = (bands ?? []).filter((b) => b.active !== false);
  if (!current.length) throw new Error("no overhead items carry a QuickBooks account number");

  const conn = await db.from("overhead_qbo_connection").select("realm_id, company_name, environment").eq("id", 1).maybeSingle();
  if (!conn.data) throw new Error("QuickBooks is not connected");

  const accts = await qboGet<{ QueryResponse?: { Account?: Account[] } }>(db, "query", {
    // Inactive accounts too: one closed mid-window still has postings in it.
    query: "select Id, Name, AcctNum, FullyQualifiedName, ParentRef from Account where Active in (true, false) MAXRESULTS 1000",
  });
  const all = accts.QueryResponse?.Account ?? [];
  const byNum = new Map(all.filter((a) => a.AcctNum).map((a) => [a.AcctNum!.trim(), a]));
  const parentOf = new Map(all.map((a) => [a.Id, a.ParentRef?.value ?? null]));

  const pnl = await qboGet<PnL>(db, "reports/ProfitAndLoss", {
    start_date: win.from,
    end_date: win.to,
    summarize_column_by: "Month",
    accounting_method: BASIS,
  });
  const own = amounts(pnl);

  // Attribute every account's own postings to its nearest mapped ancestor-or-self.
  const mappedIds = new Set(
    current.map((b) => byNum.get(String(b.qb_account).trim())?.Id).filter((x): x is string => !!x),
  );
  const rolled = new Map<string, Record<string, number>>();
  for (const [id, rec] of own) {
    let cur: string | null = id;
    let guard = 0;
    while (cur && !mappedIds.has(cur) && guard++ < 20) cur = parentOf.get(cur) ?? null;
    if (!cur || !mappedIds.has(cur)) continue;
    const into = rolled.get(cur) ?? {};
    for (const [m, v] of Object.entries(rec)) into[m] = (into[m] ?? 0) + v;
    rolled.set(cur, into);
  }

  const lines: ExpenseLine[] = current
    .sort((a, b) => String(a.qb_account).localeCompare(String(b.qb_account)))
    .map((b) => {
      const acct = byNum.get(String(b.qb_account).trim()) ?? null;
      const rec = acct ? rolled.get(acct.Id) ?? {} : {};
      const months: Record<string, number> = {};
      for (const k of win.keys) months[k] = Math.round((rec[k] ?? 0) * 100) / 100;
      const total = win.keys.reduce((s, k) => s + months[k], 0);
      return {
        item_key: b.item_key,
        label: b.label,
        qb_account: String(b.qb_account),
        qb_account_name: acct?.FullyQualifiedName ?? acct?.Name ?? null,
        current_band_id: b.id,
        current_monthly: Number(b.monthly),
        proposed_monthly: Math.round((total / WINDOW_MONTHS) * 100) / 100,
        months,
        missing: !acct,
      };
    });

  await user
    .from("overhead_expense_proposals")
    .update({ status: "superseded", decided_at: new Date().toISOString(), decided_by: actor, decision_note: "Replaced by a newer pull." })
    .eq("status", "pending");

  const { data, error } = await user
    .from("overhead_expense_proposals")
    .insert({
      trigger,
      period,
      environment: conn.data.environment,
      realm_id: conn.data.realm_id,
      company_name: conn.data.company_name,
      basis: BASIS,
      window_months: WINDOW_MONTHS,
      window_from: win.from,
      window_to: win.to,
      lines,
    })
    .select("id")
    .single();
  if (error) {
    if (error.code === "23505") return null; // this month's scheduled pull already exists
    throw new Error(error.message);
  }
  await log(db, { level: "info", action: "pull", message: `${trigger}: ${win.from}..${win.to}, ${lines.length} accounts, ${lines.filter((l) => l.missing).length} not found`, actor });
  return data.id as string;
}
