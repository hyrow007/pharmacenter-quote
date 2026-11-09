import "server-only";
import type { createClient } from "@/lib/supabase/server";
import { qboConfig, type QboEnv } from "./qbo";
import { pullExpenses, windowFor, type ExpenseLine } from "./expenses";
import { plantToday } from "./load";

type Supa = Awaited<ReturnType<typeof createClient>>;

export type QboStatus = {
  environment: QboEnv;
  realm_id: string;
  company_name: string | null;
  status: "connected" | "needs_reconnect";
  connected_by: string;
  connected_at: string;
  last_refreshed_at: string | null;
  refresh_expires_at: string | null;
};

export type ExpenseProposal = {
  id: string;
  trigger: "schedule" | "button";
  environment: QboEnv;
  company_name: string | null;
  basis: string;
  window_months: number;
  window_from: string;
  window_to: string;
  lines: ExpenseLine[];
  status: "pending" | "approved" | "rejected" | "superseded";
  created_at: string;
  created_by: string;
  decided_at: string | null;
  decided_by: string | null;
  decision_note: string | null;
};

export type LogRow = { at: string; level: string; action: string; http_status: number | null; intuit_tid: string | null; message: string | null };

export type QboData = {
  migrated: boolean;
  missingConfig: string[];
  env: QboEnv | "";
  status: QboStatus | null;
  reconciledThrough: string | null;
  annualAccounts: string | null;
  autoPct: number | null;
  nextWindow: { from: string; to: string; keys: string[] };
  proposals: ExpenseProposal[];
  log: LogRow[];
  scheduleError: string | null;
};

/**
 * Reads the QuickBooks section. Like the run-days, "once a month" hangs on opening the page:
 * if connected (production or sandbox) and the reconciled window has moved past the last
 * pull, this makes the month's proposal first. A failure there never breaks the page.
 */
export async function loadQbo(supabase: Supa, email: string): Promise<QboData> {
  const cfg = qboConfig();
  const st = await supabase.rpc("overhead_qbo_status");
  const migrated = !(st.error && /does not exist|schema cache/i.test(st.error.message));
  const status = migrated ? (((st.data ?? []) as QboStatus[])[0] ?? null) : null;

  const { data: settings } = await supabase
    .from("overhead_settings")
    .select("key, value_text, value_num")
    .in("key", ["qbo_reconciled_through", "qbo_annual_accounts", "auto_apply_pct"]);
  const setting = (k: string) => ((settings ?? []).find((r) => r.key === k)?.value_text as string | null | undefined) ?? null;
  const autoPctRow = (settings ?? []).find((r) => r.key === "auto_apply_pct");
  const autoPct = autoPctRow?.value_num != null ? Number(autoPctRow.value_num) : null;
  const reconciledThrough = setting("qbo_reconciled_through");
  const annualAccounts = setting("qbo_annual_accounts");

  let scheduleError: string | null = null;
  if (migrated && !cfg.missing.length && status?.status === "connected") {
    try {
      await pullExpenses(supabase, "schedule", email);
    } catch (e) {
      scheduleError = (e as Error).message;
    }
  }

  const [props, log] = migrated
    ? await Promise.all([
        supabase.from("overhead_expense_proposals").select("*").order("created_at", { ascending: false }).limit(8),
        supabase.from("overhead_qbo_log").select("at, level, action, http_status, intuit_tid, message").order("at", { ascending: false }).limit(8),
      ])
    : [{ data: [] }, { data: [] }];

  return {
    migrated,
    missingConfig: cfg.missing,
    env: cfg.env,
    status,
    reconciledThrough,
    annualAccounts,
    autoPct,
    nextWindow: windowFor(plantToday(), reconciledThrough),
    proposals: (props.data ?? []) as ExpenseProposal[],
    log: (log.data ?? []) as LogRow[],
    scheduleError,
  };
}
