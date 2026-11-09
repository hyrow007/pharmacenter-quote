import "server-only";
import { createClient } from "@/lib/supabase/server";
import { isAdmin } from "@/lib/workflows";

/** Signed-in PharmaCenter admin, or null. */
export async function adminEmail(): Promise<string | null> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user?.email || !user.email.endsWith("@pharmacenterusa.com")) return null;
  return (await isAdmin(supabase, user.email)) ? user.email : null;
}

export const STATE_COOKIE = "qbo_oauth_state";
export const PAGE = "https://quote.pharmacenter.app/admin/overhead";

export function back(outcome: string, detail?: string): string {
  const q = new URLSearchParams({ qbo: outcome });
  if (detail) q.set("d", detail.slice(0, 300));
  return `${PAGE}?${q}#quickbooks`;
}
