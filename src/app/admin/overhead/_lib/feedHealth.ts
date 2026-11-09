import type { SupabaseClient } from "@supabase/supabase-js";

// Is the overhead feed the quoting screens read actually giving real numbers?
//
// The boards ask /api/overhead for these two line keys and, when the answer is
// not ok, quietly keep the built-in constants in lib/overheadCosting.ts. The
// warning banner (components/OverheadFeedWarning) covers the person at the
// board; this covers everyone else — the daily cron step goes red, and
// /admin/overhead shows it. Same RPC the route calls, no arithmetic here.
// A 200 is not enough: we assert rows exist for rent, indirect and other, each
// with a share above zero and a band in force.

export const FEED_LINES = ["contract_packaging", "gummy_manufacturing"] as const;

type Row = { group_key: string; share_pct: number | null; status: string };

export type FeedCheck = { line: string; ok: boolean; problem?: string };

export async function checkFeed(db: SupabaseClient): Promise<{ ok: boolean; lines: FeedCheck[] }> {
  const lines: FeedCheck[] = [];
  for (const line of FEED_LINES) {
    const { data, error } = await db.rpc("overhead_for_line", { p_line_key: line });
    if (error) {
      lines.push({ line, ok: false, problem: `query failed: ${error.message}` });
      continue;
    }
    const rows = (data ?? []) as Row[];
    const missing = (["rent", "indirect", "other"] as const).filter(
      (g) => !rows.some((r) => r.group_key === g && r.status === "current" && Number(r.share_pct ?? 0) > 0),
    );
    lines.push(
      missing.length
        ? { line, ok: false, problem: rows.length ? `no current ${missing.join(", ")} rows` : "no rows" }
        : { line, ok: true },
    );
  }
  return { ok: lines.every((l) => l.ok), lines };
}
