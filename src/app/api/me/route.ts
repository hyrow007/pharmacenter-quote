import { NextResponse } from "next/server";
import { createClient } from "@/lib/auth/server";
import { isAdmin as checkIsAdmin } from "@/lib/workflows";

// GET /api/me
// Lightweight identity endpoint used by client components that need to
// know whether the signed-in user is an admin. Returns:
//   { ok: true, email, isAdmin }   when signed in
//   { ok: false, error: "..." }    otherwise
//
// Used by /start to decide which workflow type / dosage form / source
// buttons to disable for non-admin (or "viewing-as-user") sessions.

export async function GET() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user || !user.email) {
    return NextResponse.json({ ok: false, error: "not_signed_in" }, { status: 401 });
  }
  if (!user.email.endsWith("@pharmacenterusa.com")) {
    return NextResponse.json({ ok: false, error: "wrong_domain" }, { status: 403 });
  }
  const isAdmin = await checkIsAdmin(supabase, user.email);
  return NextResponse.json({
    ok: true,
    email: user.email,
    isAdmin,
  });
}
