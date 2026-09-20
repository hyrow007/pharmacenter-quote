import { NextResponse } from "next/server";
import { createClient } from "@/lib/auth/server";
import type { GummyFormulaNote } from "@/lib/formulas";

// PATCH  /api/formulas/[id]/notes/[noteId]  { body: string }
// DELETE /api/formulas/[id]/notes/[noteId]
//
// Both operations require the requesting user to be the note's author.
// Domain gate mirrors the parent notes route.

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

async function resolveDisplayName(
  supabase: Awaited<ReturnType<typeof createClient>>,
  email: string,
): Promise<string | null> {
  const { data } = await supabase
    .from("user_directory")
    .select("display_name")
    .eq("email", email)
    .maybeSingle();
  return data?.display_name ?? null;
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string; noteId: string }> },
) {
  const gated = await gatedClient();
  if (gated.error) return gated.error;
  const { supabase, user } = gated;
  const { id, noteId } = await params;

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }

  const rawBody =
    payload && typeof payload === "object" && "body" in payload
      ? (payload as { body: unknown }).body
      : null;
  const noteBody = typeof rawBody === "string" ? rawBody.trim() : "";
  if (!noteBody) {
    return NextResponse.json({ ok: false, error: "empty_body" }, { status: 400 });
  }

  // Ownership check — only the author can edit their own note.
  const { data: existing, error: readError } = await supabase
    .from("gummy_formula_notes")
    .select("id, author_email")
    .eq("id", noteId)
    .eq("formula_id", id)
    .maybeSingle();
  if (readError) {
    return NextResponse.json({ ok: false, error: readError.message }, { status: 500 });
  }
  if (!existing) {
    return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  }
  if (existing.author_email !== user.email) {
    return NextResponse.json({ ok: false, error: "not_author" }, { status: 403 });
  }

  const { data, error } = await supabase
    .from("gummy_formula_notes")
    .update({ body: noteBody })
    .eq("id", noteId)
    .select("id, body, author_email, created_at")
    .single();

  if (error || !data) {
    return NextResponse.json(
      { ok: false, error: error?.message ?? "update_failed" },
      { status: 500 },
    );
  }

  const displayName = await resolveDisplayName(supabase, data.author_email);
  const note: GummyFormulaNote = {
    id: data.id,
    body: data.body,
    authorEmail: data.author_email,
    authorDisplayName: displayName,
    createdAt: data.created_at,
  };

  return NextResponse.json({ ok: true, note });
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string; noteId: string }> },
) {
  const gated = await gatedClient();
  if (gated.error) return gated.error;
  const { supabase, user } = gated;
  const { id, noteId } = await params;

  const { data: existing, error: readError } = await supabase
    .from("gummy_formula_notes")
    .select("id, author_email")
    .eq("id", noteId)
    .eq("formula_id", id)
    .maybeSingle();
  if (readError) {
    return NextResponse.json({ ok: false, error: readError.message }, { status: 500 });
  }
  if (!existing) {
    return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  }
  if (existing.author_email !== user.email) {
    return NextResponse.json({ ok: false, error: "not_author" }, { status: 403 });
  }

  const { error } = await supabase
    .from("gummy_formula_notes")
    .delete()
    .eq("id", noteId);

  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
