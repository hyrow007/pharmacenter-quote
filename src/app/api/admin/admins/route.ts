import { NextResponse } from "next/server";
import { createClient } from "@/lib/auth/server";
import { isAdmin as checkIsAdmin } from "@/lib/workflows";

// POST   /api/admin/admins        { email }         add an admin
// DELETE /api/admin/admins?email=  remove an admin
//
// Caller MUST themselves be an admin (and on the @pharmacenterusa.com
// domain). RLS on the admins table also enforces this; the gate here just
// gives the UI a clean 403 instead of a generic Postgres rejection.

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
  const admin = await checkIsAdmin(supabase, user.email);
  if (!admin) {
    return {
      error: NextResponse.json({ ok: false, error: "not_admin" }, { status: 403 }),
    } as const;
  }
  return { supabase, user: { email: user.email } } as const;
}

function normaliseEmail(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim().toLowerCase();
  if (trimmed.length === 0) return null;
  // Loose shape check — full RFC validation is overkill here. We require
  // the @pharmacenterusa.com domain (mirrors the auth gate).
  if (!/^[^\s@]+@pharmacenterusa\.com$/.test(trimmed)) return null;
  return trimmed;
}

export async function POST(request: Request) {
  const g = await gated();
  if ("error" in g) return g.error;
  const { supabase } = g;

  let body: { email?: string };
  try {
    body = (await request.json()) as { email?: string };
  } catch {
    return NextResponse.json({ ok: false, error: "bad_json" }, { status: 400 });
  }
  const email = normaliseEmail(body.email);
  if (!email) {
    return NextResponse.json({ ok: false, error: "invalid_email" }, { status: 400 });
  }

  // Upsert-style behaviour: if they're already an admin, treat as success.
  const { error } = await supabase
    .from("admins")
    .insert({ email })
    .select("email")
    .maybeSingle();
  if (error && !/duplicate key/i.test(error.message)) {
    console.error("admins insert failed:", error.message);
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true, email });
}

export async function DELETE(request: Request) {
  const g = await gated();
  if ("error" in g) return g.error;
  const { supabase, user } = g;

  const url = new URL(request.url);
  const target = normaliseEmail(url.searchParams.get("email"));
  if (!target) {
    return NextResponse.json({ ok: false, error: "invalid_email" }, { status: 400 });
  }
  // Refuse self-deletion. The admin panel hides the X for the caller's own
  // row but this guards against curl + the URL bar trick.
  if (target === user.email.toLowerCase()) {
    return NextResponse.json({ ok: false, error: "cannot_remove_self" }, { status: 400 });
  }

  const { error, count } = await supabase
    .from("admins")
    .delete({ count: "exact" })
    .eq("email", target);
  if (error) {
    console.error("admins delete failed:", error.message);
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }
  if (!count || count === 0) {
    return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
