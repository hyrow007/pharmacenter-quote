import { NextResponse } from "next/server";
import { createClient } from "@/lib/auth/server";

// Feedback API.
//
// POST /api/feedback   { body: string }       → create a row
// DELETE /api/feedback?id=<uuid>               → delete a row (RLS gated)
//
// Listing is server-rendered on /feedback/page.tsx instead of a GET here,
// so this route is just write paths.

const MAX_BODY = 4000;

async function gated() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return {
      error: NextResponse.json({ ok: false, error: "not_signed_in" }, { status: 401 }),
    } as const;
  }
  if (!user.email?.endsWith("@pharmacenterusa.com")) {
    return {
      error: NextResponse.json({ ok: false, error: "wrong_domain" }, { status: 403 }),
    } as const;
  }
  return { supabase, user: { email: user.email } } as const;
}

export async function POST(request: Request) {
  const g = await gated();
  if ("error" in g) return g.error;
  const { supabase, user } = g;

  let body: { body?: string };
  try {
    body = (await request.json()) as { body?: string };
  } catch {
    return NextResponse.json({ ok: false, error: "bad_json" }, { status: 400 });
  }

  const text = (body.body ?? "").trim();
  if (text.length === 0) {
    return NextResponse.json({ ok: false, error: "empty_body" }, { status: 400 });
  }
  if (text.length > MAX_BODY) {
    return NextResponse.json({ ok: false, error: "body_too_long" }, { status: 400 });
  }

  const { data, error } = await supabase
    .from("feedback")
    .insert({ author_email: user.email, body: text })
    .select("id, created_at, author_email, body")
    .single();
  if (error || !data) {
    console.error("feedback insert failed:", error?.message);
    return NextResponse.json(
      { ok: false, error: error?.message || "insert_failed" },
      { status: 500 },
    );
  }

  // Resolve the poster's display name server-side so the client can show
  // it immediately on the optimistic insert (instead of falling back to a
  // title-cased email local-part for the lifetime of this session).
  let authorName: string | null = null;
  try {
    const { data: dirRow } = await supabase
      .from("user_directory")
      .select("display_name")
      .eq("email", user.email)
      .maybeSingle();
    const name = (dirRow?.display_name as string | undefined) ?? null;
    if (name && name.trim().length > 0) authorName = name.trim();
  } catch {
    // Non-fatal — client will fall back to its own local-part guess.
  }

  return NextResponse.json({ ok: true, feedback: data, authorName });
}

export async function DELETE(request: Request) {
  const g = await gated();
  if ("error" in g) return g.error;
  const { supabase } = g;

  const url = new URL(request.url);
  const id = url.searchParams.get("id");
  if (!id) {
    return NextResponse.json({ ok: false, error: "missing_id" }, { status: 400 });
  }

  // RLS handles the "you can only delete your own (unless admin)" check —
  // if it rejects, the row count comes back as 0 and we surface a 403 so
  // the UI can tell the user why nothing happened.
  const { error, count } = await supabase
    .from("feedback")
    .delete({ count: "exact" })
    .eq("id", id);
  if (error) {
    console.error("feedback delete failed:", error.message);
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }
  if (!count || count === 0) {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }
  return NextResponse.json({ ok: true });
}
