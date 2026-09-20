"use client";

// SSR-aware browser Supabase client. This is the one that carries the
// signed-in user's session, because @supabase/ssr reads and writes the same
// auth cookies the server client uses.
//
// createClient() is the sign-in / sign-out path and always makes a fresh
// instance. getBrowserClient() is for data reads and writes from client
// components, and memoizes -- a Supabase client opens a token-refresh timer,
// so building a new one inside a useEffect that re-runs on every keystroke is
// not free.
//
// Both of these replaced ./legacy for data access on 2026-09-20. The
// difference that matters is not ergonomics: ./legacy runs every query as the
// `anon` role no matter who is signed in, so any table it reads has to be
// readable by anonymous visitors holding the publishable key -- which ships in
// this app's public JavaScript bundle. Moving these reads onto the session is
// what allows those tables to be closed to anon at all.

import { createBrowserClient } from "@supabase/ssr";

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const KEY =
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ||
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

export function createClient() {
  return createBrowserClient(URL!, KEY!);
}

let memo: ReturnType<typeof createBrowserClient> | null = null;

/**
 * The shared browser client, or null when the env vars are absent.
 *
 * Returning null rather than throwing is deliberate: it preserves exactly the
 * contract ./legacy had (`SupabaseClient | null`), so the `if (!sb) return;`
 * guards already written at every call site keep their meaning. A preview
 * build with no env vars renders an empty picker instead of a crashed page,
 * which is what it did before.
 */
export function getBrowserClient(): ReturnType<typeof createBrowserClient> | null {
  if (!URL || !KEY) return null;
  if (!memo) memo = createBrowserClient(URL, KEY);
  return memo;
}
