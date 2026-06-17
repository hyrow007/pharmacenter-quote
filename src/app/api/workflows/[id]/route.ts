import { NextResponse } from "next/server";
import { createClient } from "@/lib/auth/server";
import {
  isAdmin,
  type SalesOrder,
  type WorkflowRow,
  type WorkflowState,
  type WorkflowStatus,
} from "@/lib/workflows";

// GET /api/workflows/[id]
//   → { ok: true, workflow, isAdmin, isOwner }
//
// PUT /api/workflows/[id]
// Body: { state?: WorkflowState, status?: WorkflowStatus, sales_orders?: SalesOrder[] }
//   → { ok: true, workflow }
// Any subset of fields may be present. Sending none is a 400.
// Server rules:
//   - status === "won" REQUIRES a non-empty, well-formed sales_orders array.
//   - status set to anything else clears sales_orders to [] automatically.
//   - status unchanged but sales_orders sent → store as-is (edit while Won).
//
// DELETE /api/workflows/[id]
//   → { ok: true } or 403 if RLS rejects.

const COLS =
  "id, quote_number, created_by_email, created_at, updated_at, state, status, sales_orders, description_override, monday_item_id, monday_item_url, monday_last_pushed_at";

const VALID_STATUSES: WorkflowStatus[] = ["in_progress", "won", "lost"];

// Hard cap on the override so a stray paste can't blow up the listing.
// Matches an arbitrary "two-line max-ish" UX limit; the actual DB column is
// TEXT (no limit), this is purely an input-validation guard.
const DESCRIPTION_OVERRIDE_MAX = 200;

type PutBody = {
  state?: WorkflowState;
  status?: WorkflowStatus;
  sales_orders?: SalesOrder[];
  // null / "" / whitespace-only → clear the override and fall back to the
  // server-computed label. Otherwise persist the trimmed string.
  description_override?: string | null;
};

// Narrow + sanitise an unknown payload into a SalesOrder[]. Returns null when
// the array contains anything invalid (empty so_number, non-finite value, etc.)
// so the caller can 400 out.
function parseSalesOrders(raw: unknown): SalesOrder[] | null {
  if (!Array.isArray(raw)) return null;
  const out: SalesOrder[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") return null;
    const rec = item as Record<string, unknown>;
    const so = typeof rec.so_number === "string" ? rec.so_number.trim() : "";
    const val = typeof rec.value === "number" ? rec.value : Number(rec.value);
    if (!so) return null;
    if (!Number.isFinite(val) || val <= 0) return null;
    out.push({ so_number: so, value: val });
  }
  return out;
}

type Ctx = { params: Promise<{ id: string }> };

type GateResult =
  | { error: NextResponse; supabase?: undefined; user?: undefined }
  | { error?: undefined; supabase: Awaited<ReturnType<typeof createClient>>; user: { email: string } };

async function gated(): Promise<GateResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return { error: NextResponse.json({ ok: false, error: "not_signed_in" }, { status: 401 }) };
  }
  if (!user.email?.endsWith("@pharmacenterusa.com")) {
    return { error: NextResponse.json({ ok: false, error: "wrong_domain" }, { status: 403 }) };
  }
  return { supabase, user: { email: user.email } };
}

export async function GET(_req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const g = await gated();
  if (g.error) return g.error;
  const { supabase, user } = g;

  const { data, error } = await supabase.from("workflows").select(COLS).eq("id", id).maybeSingle();
  if (error) {
    console.error("workflow fetch failed:", error.message);
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }
  if (!data) {
    return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  }
  const row = data as WorkflowRow;
  const admin = await isAdmin(supabase, user.email);
  return NextResponse.json({
    ok: true,
    workflow: row,
    isAdmin: admin,
    isOwner: row.created_by_email === user.email,
  });
}

export async function PUT(request: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const g = await gated();
  if (g.error) return g.error;
  const { supabase } = g;

  let body: PutBody;
  try {
    body = (await request.json()) as PutBody;
  } catch {
    return NextResponse.json({ ok: false, error: "bad_json" }, { status: 400 });
  }

  const patch: {
    state?: WorkflowState;
    status?: WorkflowStatus;
    sales_orders?: SalesOrder[];
    description_override?: string | null;
  } = {};
  if (body.state && typeof body.state === "object") {
    patch.state = body.state;
  }
  if (body.status !== undefined) {
    if (!VALID_STATUSES.includes(body.status)) {
      return NextResponse.json({ ok: false, error: "invalid_status" }, { status: 400 });
    }
    patch.status = body.status;
  }
  // description_override: null / empty / whitespace clears the override.
  // Otherwise we trim + length-cap before storing. We deliberately allow this
  // field even when nothing else changes — it's the most common "small edit".
  if (body.description_override !== undefined) {
    if (body.description_override === null) {
      patch.description_override = null;
    } else if (typeof body.description_override === "string") {
      const trimmed = body.description_override.trim();
      if (trimmed.length === 0) {
        patch.description_override = null;
      } else if (trimmed.length > DESCRIPTION_OVERRIDE_MAX) {
        return NextResponse.json(
          { ok: false, error: "description_too_long" },
          { status: 400 },
        );
      } else {
        patch.description_override = trimmed;
      }
    } else {
      return NextResponse.json(
        { ok: false, error: "invalid_description_override" },
        { status: 400 },
      );
    }
  }

  // Sales-order handling. Three cases:
  //   1. Caller is setting status=won → sales_orders are mandatory + valid.
  //   2. Caller is setting status to anything else → wipe sales_orders to [].
  //   3. status unchanged but sales_orders sent → store sanitised array
  //      (used by the "Edit sales orders" affordance while already Won).
  if (patch.status === "won") {
    const parsed = parseSalesOrders(body.sales_orders);
    if (!parsed || parsed.length === 0) {
      return NextResponse.json(
        { ok: false, error: "sales_orders_required" },
        { status: 400 },
      );
    }
    patch.sales_orders = parsed;
  } else if (patch.status === "in_progress" || patch.status === "lost") {
    // Leaving Won — discard any recorded SOs.
    patch.sales_orders = [];
  } else if (body.sales_orders !== undefined) {
    const parsed = parseSalesOrders(body.sales_orders);
    if (!parsed) {
      return NextResponse.json(
        { ok: false, error: "invalid_sales_orders" },
        { status: 400 },
      );
    }
    patch.sales_orders = parsed;
  }

  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ ok: false, error: "nothing_to_update" }, { status: 400 });
  }

  const { data, error } = await supabase
    .from("workflows")
    // updated_at has a DB trigger to bump itself; we only send the diff.
    .update(patch)
    .eq("id", id)
    .select(COLS)
    .single();

  if (error || !data) {
    console.error("workflow update failed:", error?.message);
    return NextResponse.json(
      { ok: false, error: error?.message || "update_failed" },
      { status: 500 },
    );
  }
  return NextResponse.json({ ok: true, workflow: data as WorkflowRow });
}

export async function DELETE(_req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const g = await gated();
  if (g.error) return g.error;
  const { supabase } = g;

  // RLS enforces owner-or-admin. If it rejects we get an empty count back —
  // surface that as a 403 rather than a silent 200.
  const { error, count } = await supabase
    .from("workflows")
    .delete({ count: "exact" })
    .eq("id", id);

  if (error) {
    console.error("workflow delete failed:", error.message);
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }
  if (!count || count === 0) {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }
  return NextResponse.json({ ok: true });
}
