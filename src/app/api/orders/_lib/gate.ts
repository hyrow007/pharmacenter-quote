import { NextResponse } from "next/server";
import { createClient as createSupabaseClient, type SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";

// Shared auth for the SO assistant routes: signed in, @pharmacenterusa.com,
// plus a service-role client for the writes RLS deliberately does not allow
// (meeting notes, key points, the action log).

export type Gate =
  | { error: NextResponse }
  | {
      error: null;
      supabase: SupabaseClient;
      admin: SupabaseClient;
      email: string;
      name: string | null;
    };

export async function gate(): Promise<Gate> {
  const supabase = (await createClient()) as unknown as SupabaseClient;
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user?.email) {
    return { error: NextResponse.json({ ok: false, error: "not_signed_in" }, { status: 401 }) };
  }
  if (!user.email.endsWith("@pharmacenterusa.com")) {
    return { error: NextResponse.json({ ok: false, error: "wrong_domain" }, { status: 403 }) };
  }
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    return { error: NextResponse.json({ ok: false, error: "server_misconfigured" }, { status: 500 }) };
  }
  const admin = createSupabaseClient(url, key, { auth: { persistSession: false } });
  const meta = (user.user_metadata ?? {}) as Record<string, unknown>;
  const name =
    (typeof meta.full_name === "string" && meta.full_name) ||
    (typeof meta.name === "string" && meta.name) ||
    null;
  return { error: null, supabase, admin, email: user.email, name };
}

/** SO numbers are short alphanumerics ("14628", "13915-2", "M13177"). */
export function cleanSo(raw: string): string | null {
  const so = decodeURIComponent(raw).trim();
  return /^[A-Za-z0-9-]{1,20}$/.test(so) ? so : null;
}
