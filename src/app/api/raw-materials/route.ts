import { NextResponse } from "next/server";
import { createClient } from "@/lib/auth/server";
import { isAdmin as checkIsAdmin } from "@/lib/workflows";

// GET    /api/raw-materials                   list active materials (with includeInactive=1 to show all)
// POST   /api/raw-materials                   create a manual material (admin only)
//   body: { name, fp_code?, default_unit?, default_cost_per_kg?, default_solids?, category?, notes? }
// PATCH  /api/raw-materials?id=<uuid>         edit a row (admin only)
//   body: any subset of editable fields
// DELETE /api/raw-materials?id=<uuid>         soft-deactivate (admin only)
//
// All routes require an authenticated @pharmacenterusa.com user. Mutations
// require admin (which is also enforced by the RLS policies on the table —
// the gates here just give the UI a clean error.

type EditablePatch = {
  name?: string | null;
  fp_code?: string | null;
  default_unit?: string | null;
  default_cost_per_kg?: number | null;
  default_solids?: number | null;
  category?: string | null;
  notes?: string | null;
  active?: boolean | null;
};

async function gatedSignedIn() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user || !user.email?.endsWith("@pharmacenterusa.com")) {
    return {
      error: NextResponse.json(
        { ok: false, error: "unauthorized" },
        { status: 401 },
      ),
    } as const;
  }
  return { supabase, user: { email: user.email } } as const;
}

async function gatedAdmin() {
  const g = await gatedSignedIn();
  if ("error" in g) return g;
  const admin = await checkIsAdmin(g.supabase, g.user.email);
  if (!admin) {
    return {
      error: NextResponse.json({ ok: false, error: "not_admin" }, { status: 403 }),
    } as const;
  }
  return g;
}

// Allow only these fields through patch payloads. Quote-app overlays
// (default_solids, category, notes) are always editable. Fishbowl-owned
// fields (name, default_unit, default_cost_per_kg) are also editable here
// — the Fishbowl sync will overwrite them on the next run by design.
function sanitisePatch(raw: unknown): EditablePatch | null {
  if (!raw || typeof raw !== "object") return null;
  const rec = raw as Record<string, unknown>;
  const out: EditablePatch = {};
  if ("name" in rec) {
    if (rec.name === null) out.name = null;
    else if (typeof rec.name === "string") out.name = rec.name.trim();
  }
  if ("fp_code" in rec) {
    if (rec.fp_code === null) out.fp_code = null;
    else if (typeof rec.fp_code === "string") {
      const t = rec.fp_code.trim();
      out.fp_code = t.length === 0 ? null : t;
    }
  }
  if ("default_unit" in rec) {
    if (rec.default_unit === null) out.default_unit = null;
    else if (typeof rec.default_unit === "string") out.default_unit = rec.default_unit.trim();
  }
  if ("default_cost_per_kg" in rec) {
    if (rec.default_cost_per_kg === null) out.default_cost_per_kg = null;
    else if (typeof rec.default_cost_per_kg === "number" && isFinite(rec.default_cost_per_kg)) {
      out.default_cost_per_kg = rec.default_cost_per_kg;
    }
  }
  if ("default_solids" in rec) {
    if (typeof rec.default_solids === "number" && rec.default_solids > 0 && rec.default_solids <= 1) {
      out.default_solids = rec.default_solids;
    }
  }
  if ("category" in rec) {
    if (rec.category === null) out.category = null;
    else if (typeof rec.category === "string") {
      const c = rec.category.trim().toLowerCase();
      if (c === "" ) out.category = null;
      else if (["primary", "secondary", "final", "other"].includes(c)) out.category = c;
    }
  }
  if ("notes" in rec) {
    if (rec.notes === null) out.notes = null;
    else if (typeof rec.notes === "string") out.notes = rec.notes;
  }
  if ("active" in rec) {
    if (typeof rec.active === "boolean") out.active = rec.active;
  }
  return out;
}

// ----- GET ---------------------------------------------------------------

export async function GET(request: Request) {
  const g = await gatedSignedIn();
  if ("error" in g) return g.error;
  const { supabase } = g;

  const url = new URL(request.url);
  const includeInactive = url.searchParams.get("includeInactive") === "1";

  let q = supabase
    .from("raw_materials")
    .select(
      "id, fp_code, name, default_unit, default_cost_per_kg, default_solids, category, notes, active, source, synced_at, updated_at",
    )
    .order("category", { ascending: true, nullsFirst: false })
    .order("name", { ascending: true });
  if (!includeInactive) q = q.eq("active", true);

  const { data, error } = await q;
  if (error) {
    return NextResponse.json(
      { ok: false, error: error.message },
      { status: 500 },
    );
  }
  return NextResponse.json({ ok: true, raw_materials: data ?? [] });
}

// ----- POST (create manual) ---------------------------------------------

export async function POST(request: Request) {
  const g = await gatedAdmin();
  if ("error" in g) return g.error;
  const { supabase, user } = g;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "bad_json" }, { status: 400 });
  }
  const patch = sanitisePatch(body);
  if (!patch || !patch.name) {
    return NextResponse.json({ ok: false, error: "missing_name" }, { status: 400 });
  }

  const insertRow = {
    name: patch.name,
    fp_code: patch.fp_code ?? null,
    default_unit: patch.default_unit ?? "kg",
    default_cost_per_kg: patch.default_cost_per_kg ?? null,
    default_solids: patch.default_solids ?? 1.0,
    category: patch.category ?? null,
    notes: patch.notes ?? null,
    active: patch.active ?? true,
    source: "manual" as const,
    updated_by_email: user.email,
  };

  const { data, error } = await supabase
    .from("raw_materials")
    .insert(insertRow)
    .select()
    .single();
  if (error) {
    // 23505 = unique violation (fp_code collision).
    const conflict = (error as { code?: string }).code === "23505";
    return NextResponse.json(
      { ok: false, error: conflict ? "fp_code_taken" : error.message },
      { status: conflict ? 409 : 500 },
    );
  }
  return NextResponse.json({ ok: true, raw_material: data });
}

// ----- PATCH (edit) ------------------------------------------------------

export async function PATCH(request: Request) {
  const g = await gatedAdmin();
  if ("error" in g) return g.error;
  const { supabase, user } = g;

  const url = new URL(request.url);
  const id = url.searchParams.get("id");
  if (!id) {
    return NextResponse.json({ ok: false, error: "missing_id" }, { status: 400 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "bad_json" }, { status: 400 });
  }
  const patch = sanitisePatch(body);
  if (!patch || Object.keys(patch).length === 0) {
    return NextResponse.json({ ok: false, error: "empty_patch" }, { status: 400 });
  }
  // Don't let callers blank out the name on a PATCH.
  if (patch.name !== undefined && (patch.name === null || patch.name.trim().length === 0)) {
    delete patch.name;
  }

  const { data, error } = await supabase
    .from("raw_materials")
    .update({ ...patch, updated_by_email: user.email })
    .eq("id", id)
    .select()
    .single();
  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true, raw_material: data });
}

// ----- DELETE (soft) -----------------------------------------------------

export async function DELETE(request: Request) {
  const g = await gatedAdmin();
  if ("error" in g) return g.error;
  const { supabase, user } = g;

  const url = new URL(request.url);
  const id = url.searchParams.get("id");
  if (!id) {
    return NextResponse.json({ ok: false, error: "missing_id" }, { status: 400 });
  }
  const { error } = await supabase
    .from("raw_materials")
    .update({ active: false, updated_by_email: user.email })
    .eq("id", id);
  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
