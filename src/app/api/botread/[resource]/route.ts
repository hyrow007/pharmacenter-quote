import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { timingSafeEqual } from "node:crypto";

// GET /api/botread/<resource>
//
// The read-only window for the outside agent (see claude/ecosystem-registry.md,
// the botread section). The agent cannot reach Postgres from its sandbox --
// 5432 and 6543 both time out there -- so it asks over HTTPS and the SERVER
// reads on its behalf.
//
// What this deliberately is NOT:
//   * it does not accept SQL. The resource name picks one of three fixed
//     functions; nothing the caller sends becomes SQL.
//   * it hands out no Supabase credential of any kind.
//   * it cannot see anything outside the three botread views, because those
//     functions are the only thing it calls and the row caps live in SQL.
//
// Auth: Authorization: Bearer <BOTREAD_TOKEN>. Revoke by rotating that one
// Vercel variable; there is nothing else to clean up.
//
// Every answered request writes a public.botread_requests row. That log is the
// point: a direct Postgres connection would have told us nothing about what
// was asked for.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Spec = {
  fn: string;
  build: (sp: URLSearchParams) => Record<string, unknown>;
};

function limitOf(sp: URLSearchParams): number {
  const raw = Number.parseInt(sp.get("limit") ?? "", 10);
  if (!Number.isFinite(raw)) return 200;
  // SQL caps this again at 1000. Both on purpose.
  return Math.min(Math.max(raw, 1), 1000);
}

function openOf(sp: URLSearchParams): boolean | null {
  const v = (sp.get("open") ?? "").toLowerCase();
  if (v === "true" || v === "1") return true;
  if (v === "false" || v === "0") return false;
  return null;
}

function sinceOf(sp: URLSearchParams): string | null {
  const v = sp.get("since");
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

const RESOURCES: Record<string, Spec> = {
  "sales-orders": {
    fn: "botread_sales_orders",
    build: (sp) => ({
      p_open: openOf(sp),
      p_since: sinceOf(sp),
      p_limit: limitOf(sp),
    }),
  },
  "work-orders": {
    fn: "botread_work_orders",
    build: (sp) => ({
      p_open: openOf(sp),
      p_since: sinceOf(sp),
      p_limit: limitOf(sp),
    }),
  },
  "part-inventory": {
    fn: "botread_part_inventory",
    build: (sp) => ({
      p_part: sp.get("part"),
      p_limit: limitOf(sp),
    }),
  },
};

// Constant-time compare so the token cannot be guessed a character at a time.
function tokenMatches(presented: string, expected: string): boolean {
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ resource: string }> },
) {
  const startedAt = Date.now();
  const { resource } = await params;
  const url = new URL(request.url);
  const sp = url.searchParams;

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const expected = process.env.BOTREAD_TOKEN;

  // Fail closed. No token configured means the door is shut, not open.
  if (!expected) {
    console.error("botread: BOTREAD_TOKEN is not set");
    return NextResponse.json({ ok: false, error: "not_configured" }, { status: 503 });
  }
  if (!supabaseUrl || !serviceRoleKey) {
    console.error("botread: Supabase env vars missing");
    return NextResponse.json({ ok: false, error: "server_misconfigured" }, { status: 500 });
  }

  const header = request.headers.get("authorization") ?? "";
  const presented = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!presented || !tokenMatches(presented, expected)) {
    console.warn(`botread: rejected resource=${resource}`);
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const spec = RESOURCES[resource];
  if (!spec) {
    return NextResponse.json(
      { ok: false, error: "unknown_resource", available: Object.keys(RESOURCES) },
      { status: 404 },
    );
  }

  const args = spec.build(sp);
  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false },
  });

  const { data, error } = await supabase.rpc(spec.fn, args);

  const duration = Date.now() - startedAt;
  const rows = Array.isArray(data) ? data.length : 0;
  const status = error ? 502 : 200;

  // Log every answered request, including failures. Never block the response
  // on the log: a logging problem must not look like a data problem.
  try {
    await supabase.from("botread_requests").insert({
      endpoint: resource,
      params: args,
      row_count: error ? null : rows,
      status,
      duration_ms: duration,
      caller_ip:
        request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
      user_agent: request.headers.get("user-agent"),
    });
  } catch (logError) {
    console.error("botread: failed to write request log", logError);
  }

  if (error) {
    // The caller gets a flat failure; the detail stays in our logs.
    console.error(`botread: rpc ${spec.fn} failed`, error.message);
    return NextResponse.json({ ok: false, error: "query_failed" }, { status: 502 });
  }

  console.log(`botread: ${resource} rows=${rows} ${duration}ms`);
  return NextResponse.json(
    { ok: true, resource, count: rows, rows: data ?? [] },
    { status: 200, headers: { "cache-control": "no-store" } },
  );
}
