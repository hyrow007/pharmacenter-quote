// Who is asking. Signed in with a @pharmacenterusa.com account, plus a
// service-role client for the writes RLS does not allow, and whether they are
// an admin (public.admins, the one admin source).

import "server-only";
import { createClient as createServiceClient, type SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { isAdmin } from "@/lib/workflows";

export type ShipGate =
  | { ok: false; error: "not_signed_in" | "wrong_domain" | "server_misconfigured" }
  | { ok: true; supabase: SupabaseClient; service: SupabaseClient; email: string; name: string | null; admin: boolean };

export async function shipGate(): Promise<ShipGate> {
  const supabase = (await createClient()) as unknown as SupabaseClient;
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user?.email) return { ok: false, error: "not_signed_in" };
  if (!user.email.endsWith("@pharmacenterusa.com")) return { ok: false, error: "wrong_domain" };
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return { ok: false, error: "server_misconfigured" };
  const service = createServiceClient(url, key, { auth: { persistSession: false } });
  const meta = (user.user_metadata ?? {}) as Record<string, unknown>;
  const name =
    (typeof meta.full_name === "string" && meta.full_name) || (typeof meta.name === "string" && meta.name) || null;
  return { ok: true, supabase, service, email: user.email, name, admin: await isAdmin(supabase, user.email) };
}
