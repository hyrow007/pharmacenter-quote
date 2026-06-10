// Server-side Supabase client wired into Next.js cookies(). Used inside
// Route Handlers, Server Components, and the OAuth callback to read the
// signed-in user.

import { type CookieOptions, createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

type CookiePayload = { name: string; value: string; options: CookieOptions };

export async function createClient() {
  const cookieStore = await cookies();

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ||
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet: CookiePayload[]) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options),
            );
          } catch {
            // The `setAll` method was called from a Server Component.
            // Safe to ignore — middleware refreshes the session on every request.
          }
        },
      },
    },
  );
}
