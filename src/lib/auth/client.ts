"use client";

// SSR-aware browser Supabase client used for sign-in / sign-out actions.
// Sits alongside src/lib/supabase.ts (the publishable-key data client used
// by the customer + product pickers). Two clients are fine — they share the
// same project. Only this one manages session cookies.

import { createBrowserClient } from "@supabase/ssr";

export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ||
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  );
}
