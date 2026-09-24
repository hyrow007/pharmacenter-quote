import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import type { SavedSolution, SolutionComponent } from "@/lib/formulas";
import { isAdmin as checkIsAdmin } from "@/lib/workflows";

// GET    /api/solutions              — list active saved solutions
// POST   /api/solutions              — save (upsert by name) a solution to the library
// DELETE /api/solutions?id=<uuid>    — ADMIN ONLY: retire a library entry
//
// A "solution" is a reusable pre-mixed compound (name + component
// percentages). Solutions live in public.gummy_solutions and can be
// picked into any formula's blend section. Name is treated as unique
// (case-insensitive); POSTing an existing name overwrites the components
// so the library entry always reflects the latest authored version.

type GateResult =
  | { error: NextResponse; supabase?: undefined; user?: undefined }
  | {
      error?: undefined;
      supabase: Awaited<ReturnType<typeof createClient>>;
      user: { email: string };
    };

async function gatedClient(): Promise<GateResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return {
      error: NextResponse.json({ ok: false, error: "not_signed_in" }, { status: 401 }),
    };
  }
  if (!user.email?.endsWith("@pharmacenterusa.com")) {
    return {
      error: NextResponse.json({ ok: false, error: "wrong_domain" }, { status: 403 }),
    };
  }
  return { supabase, user: { email: user.email } };
}

// v85.1: DELETE is admin-only, unlike GET/POST which any @pharmacenterusa.com
// signer can call. Saving a solution is everyday formulation work; removing
// one changes what every other formulator sees in the picker.
async function gatedAdmin(): Promise<GateResult> {
  const gated = await gatedClient();
  if (gated.error) return gated;
  if (!(await checkIsAdmin(gated.supabase, gated.user.email))) {
    return {
      error: NextResponse.json({ ok: false, error: "not_admin" }, { status: 403 }),
    };
  }
  return gated;
}

function rowToSavedSolution(row: Record<string, unknown>): SavedSolution {
  return {
    id: String(row.id),
    name: String(row.name),
    components: Array.isArray(row.components)
      ? (row.components as SolutionComponent[])
      : [],
    active: row.active === true,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    createdByEmail: (row.created_by_email as string | null) ?? null,
    updatedByEmail: (row.updated_by_email as string | null) ?? null,
  };
}

// --- GET ---------------------------------------------------------------------

export async function GET() {
  const gated = await gatedClient();
  if (gated.error) return gated.error;
  const { supabase } = gated;

  const { data, error } = await supabase
    .from("gummy_solutions")
    .select(
      "id, name, components, active, created_at, updated_at, created_by_email, updated_by_email",
    )
    .eq("active", true)
    .order("name", { ascending: true });

  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }
  const solutions: SavedSolution[] = (data ?? []).map(rowToSavedSolution);
  return NextResponse.json({ ok: true, solutions });
}

// --- POST --------------------------------------------------------------------
//
// Body: { name: string, components: SolutionComponent[] }
// Upserts by lowercase(name). Returns the freshly-saved row.

type PostBody = {
  name?: string;
  components?: SolutionComponent[];
};

export async function POST(request: Request) {
  const gated = await gatedClient();
  if (gated.error) return gated.error;
  const { supabase, user } = gated;

  let body: PostBody;
  try {
    body = (await request.json()) as PostBody;
  } catch {
    return NextResponse.json({ ok: false, error: "bad_json" }, { status: 400 });
  }
  const name = body.name?.trim();
  if (!name) {
    return NextResponse.json({ ok: false, error: "missing_name" }, { status: 400 });
  }
  const components: SolutionComponent[] = Array.isArray(body.components)
    ? body.components
    : [];
  if (components.length === 0) {
    return NextResponse.json(
      { ok: false, error: "empty_components" },
      { status: 400 },
    );
  }

  // Upsert by name so re-saving under the same name refreshes the
  // components rather than erroring on the unique constraint.
  const { data: existing } = await supabase
    .from("gummy_solutions")
    .select("id")
    .ilike("name", name)
    .maybeSingle();

  let data: Record<string, unknown> | null = null;
  let error: { message: string } | null = null;

  if (existing?.id) {
    const res = await supabase
      .from("gummy_solutions")
      .update({
        name,
        components,
        active: true,
        updated_by_email: user.email,
        updated_at: new Date().toISOString(),
      })
      .eq("id", existing.id)
      .select(
        "id, name, components, active, created_at, updated_at, created_by_email, updated_by_email",
      )
      .maybeSingle();
    data = res.data;
    error = res.error;
  } else {
    const res = await supabase
      .from("gummy_solutions")
      .insert({
        name,
        components,
        created_by_email: user.email,
        updated_by_email: user.email,
      })
      .select(
        "id, name, components, active, created_at, updated_at, created_by_email, updated_by_email",
      )
      .single();
    data = res.data;
    error = res.error;
  }

  if (error || !data) {
    return NextResponse.json(
      { ok: false, error: error?.message ?? "save_failed" },
      { status: 500 },
    );
  }
  return NextResponse.json(
    { ok: true, solution: rowToSavedSolution(data) },
    { status: 201 },
  );
}

// --- DELETE ------------------------------------------------------------------
//
// /api/solutions?id=<uuid> — retire a library entry. Admin only.
//
// This DEACTIVATES (active = false) rather than destroying the row. Two
// reasons: the list is a picker, not a record — GET already filters on
// active, so a retired entry vanishes from every "+ Add solution" menu the
// moment this returns; and the audit trail (who authored it, when) is worth
// more than the row is worth deleting. Formulas that already used the
// solution are untouched either way: ingredientFromSavedSolution COPIES the
// components into the formula row, so nothing downstream depends on this row
// still existing.
//
// Re-saving a solution with the same name revives it — the POST upsert above
// sets active: true. That is the intended "undelete", and it is why the name
// lookup there does NOT filter on active.

export async function DELETE(request: Request) {
  const gated = await gatedAdmin();
  if (gated.error) return gated.error;
  const { supabase, user } = gated;

  const id = new URL(request.url).searchParams.get("id")?.trim();
  if (!id) {
    return NextResponse.json({ ok: false, error: "missing_id" }, { status: 400 });
  }

  const { data, error } = await supabase
    .from("gummy_solutions")
    .update({
      active: false,
      updated_by_email: user.email,
      updated_at: new Date().toISOString(),
    })
    .eq("id", id)
    .select("id, name")
    .maybeSingle();

  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }
  if (!data) {
    return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  }
  return NextResponse.json({ ok: true, id: String(data.id), name: String(data.name) });
}
