import "server-only";
import { pullExpenses } from "./expenses";
import { checkFeed } from "./feedHealth";
import { log, qboConfig, serviceDb } from "./qbo";

// The Overhead step of /api/cron/daily (operator decision 2026-11-08, "option 2").
//
// Runs every day but only does real work when something is due:
//   1. run-days: overhead_capacity_propose('schedule') makes at most one proposal a month;
//   2. QuickBooks: a scheduled pull happens only when "books reconciled through" has
//      moved past the last pull (and only if the link is connected);
//   3. overhead_auto_apply() then applies every change under auto_apply_pct (10%) and
//      leaves bigger ones, $0s and unknown accounts waiting on /admin/overhead.
//   4. feed health: overhead_for_line() must give real rent/indirect/other rows for the
//      two keys the quoting screens read; if not, this step goes red and it is logged.
// Each part fails on its own; one failing never stops the others or the rest of the cron.

export async function overheadDaily(): Promise<Record<string, unknown>> {
  const db = serviceDb();
  const out: Record<string, unknown> = { ok: true };

  const cap = await db.rpc("overhead_capacity_propose", { p_trigger: "schedule", p_months: 6 });
  out.run_days_measure = cap.error ? `error: ${cap.error.message}` : "ok";

  const cfg = qboConfig();
  if (cfg.missing.length) {
    out.quickbooks = "not configured";
  } else {
    const st = await db.from("overhead_qbo_connection").select("status").eq("id", 1).maybeSingle();
    if (st.data?.status !== "connected") {
      out.quickbooks = st.data ? "needs reconnect" : "not connected";
    } else {
      try {
        const id = await pullExpenses(db, "schedule", "auto");
        out.quickbooks = id ? "pulled" : "nothing due";
      } catch (e) {
        out.quickbooks = `error: ${(e as Error).message}`;
      }
    }
  }

  const auto = await db.rpc("overhead_auto_apply");
  out.auto_apply = auto.error ? `error: ${auto.error.message}` : auto.data;

  const feed = await checkFeed(db).catch((e: unknown) => ({ ok: false, lines: [{ line: "all", ok: false, problem: (e as Error).message }] }));
  out.quote_feed = feed.ok ? "ok" : feed.lines.filter((l) => !l.ok).map((l) => `${l.line}: ${l.problem}`).join("; ");
  if (!feed.ok) {
    out.ok = false;
    await log(db, { level: "error", action: "quote_feed_check", message: String(out.quote_feed), actor: "auto" });
  }

  if (String(out.run_days_measure).startsWith("error") || String(out.auto_apply).startsWith("error")) out.ok = false;
  return out;
}
