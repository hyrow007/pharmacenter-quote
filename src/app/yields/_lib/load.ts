import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { ENTRY_COLS, normalizeEntry, type YieldEntry } from "./model";

// PostgREST caps a response at 1,000 rows. History spans 3,500 and counting,
// so long ranges are read in pages rather than silently truncated.
const PAGE = 1000;

export async function loadEntries(
  supabase: SupabaseClient,
  opts: { from: string; to: string; line?: string | null; product?: string | null },
): Promise<{ rows: YieldEntry[]; error: string | null }> {
  const out: YieldEntry[] = [];
  for (let offset = 0; offset < 50_000; offset += PAGE) {
    let q = supabase
      .from("yield_entries")
      .select(ENTRY_COLS)
      .gte("run_date", opts.from)
      .lte("run_date", opts.to)
      .order("run_date", { ascending: false })
      .order("line_key", { ascending: true })
      .order("created_at", { ascending: true })
      .range(offset, offset + PAGE - 1);
    if (opts.line) q = q.eq("line_key", opts.line);
    if (opts.product) q = q.eq("product_num", opts.product);
    const { data, error } = await q;
    if (error) return { rows: out, error: error.message };
    const rows = (data ?? []) as unknown as Record<string, unknown>[];
    out.push(...rows.map(normalizeEntry));
    if (rows.length < PAGE) break;
  }
  return { rows: out, error: null };
}
