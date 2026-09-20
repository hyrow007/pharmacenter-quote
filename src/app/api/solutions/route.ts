import { NextResponse } from "next/server";
import { createClient } from "@/lib/auth/server";
import type { SavedSolution, SolutionComponent } from "@/lib/formulas";

// GET  /api/solutions          — list active saved solutions
// POST /api/solutions          — save (upsert by name) a solution to the library
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
