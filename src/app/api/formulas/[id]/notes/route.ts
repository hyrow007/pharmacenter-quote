import { NextResponse } from "next/server";
import { createClient } from "@/lib/auth/server";
import type { GummyFormulaNote } from "@/lib/formulas";

// GET  /api/formulas/[id]/notes
//   → { ok: true, notes: GummyFormulaNote[] }  (newest first)
// POST /api/formulas/[id]/notes  { body: string }
//   → { ok: true, note: GummyFormulaNote }
//
// Notes are read + append only. author_email is derived from the session
// user (never accepted from the client) and display_name is resolved from
// user_directory so the timeline can render "Jairo Osorno" instead of the
// raw email. Auth follows the same pattern as the audit route.

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

// Batch-resolve emails → display names via user_directory. Same helper the
// audit route uses; kept local here to avoid touching audit code.
async function resolveDisplayNames(
  supabase: Awaited<ReturnType<typeof createClient>>,
  emails: string[],
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const unique = Array.from(new Set(emails.filter((e): e is string => !!e)));
  if (unique.length === 0) return map;
  const { data: dirRows } = await supabase
    .from("user_directory")
    .select("email, display_name")
    .in("email", unique);
  (dirRows ?? []).forEach((row) => {
    if (row.email && row.display_name) map.set(row.email, row.display_name);
  });
  return map;
}

function noteFromRow(
  row: {
    id: string;
    body: string;
    author_email: string;
    created_at: string;
  },
  authorDisplayName: string | null,
): GummyFormulaNote {
  return {
    id: row.id,
    body: row.body,
    authorEmail: row.author_email,
    authorDisplayName,
    createdAt: row.created_at,
  };
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const gated = await gatedClient();
  if (gated.error) return gated.error;
  const { supabase } = gated;
  const { id } = await params;

  const { data, error } = await supabase
    .from("gummy_formula_notes")
    .select("id, body, author_email, created_at")
    .eq("formula_id", id)
    .order("created_at", { ascending: false });

  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  const displayByEmail = await resolveDisplayNames(
    supabase,
    (data ?? []).map((r) => r.author_email),
  );
  const notes: GummyFormulaNote[] = (data ?? []).map((row) =>
    noteFromRow(row, displayByEmail.get(row.author_email) ?? null),
  );

  return NextResponse.json({ ok: true, notes });
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const gated = await gatedClient();
  if (gated.error) return gated.error;
  const { supabase, user } = gated;
  const { id } = await params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }

  const rawBody =
    body && typeof body === "object" && "body" in body
      ? (body as { body: unknown }).body
      : null;
  const noteBody = typeof rawBody === "string" ? rawBody.trim() : "";
  if (!noteBody) {
    return NextResponse.json({ ok: false, error: "empty_body" }, { status: 400 });
  }

  const { data, error } = await supabase
    .from("gummy_formula_notes")
    .insert({
      formula_id: id,
      body: noteBody,
      author_email: user.email,
    })
    .select("id, body, author_email, created_at")
    .single();

  if (error || !data) {
    return NextResponse.json(
      { ok: false, error: error?.message ?? "insert_failed" },
      { status: 500 },
    );
  }

  const displayByEmail = await resolveDisplayNames(supabase, [data.author_email]);
  const note = noteFromRow(data, displayByEmail.get(data.author_email) ?? null);

  return NextResponse.json({ ok: true, note });
}
