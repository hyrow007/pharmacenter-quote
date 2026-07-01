// Shared Supabase client. Used by all PharmaCenter quote/packing/etc. apps that
// point at the same Supabase project. Set the env vars in Vercel as Team-level
// Shared variables so a single rotation flows to all linked projects:
//
//   NEXT_PUBLIC_SUPABASE_URL              project URL (https://<id>.supabase.co)
//   NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY  publishable key (sb_publishable_*)
//
// The publishable key is the new Supabase name for what was historically
// called "anon key". If you still have the legacy NEXT_PUBLIC_SUPABASE_ANON_KEY
// set, we fall back to it so the migration can happen one project at a time.
// New deployments should prefer PUBLISHABLE_KEY.
//
// If both are missing the client is null and the calling code should fall
// back to mock data (so local dev / previews without env vars still render).

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key =
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ||
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

export const supabase: SupabaseClient | null =
  url && key ? createClient(url, key) : null;

// Convenience type matching the shared "customers" table schema.
// Add columns as the table grows — keep this in sync with the Supabase project.
export type Customer = {
  id: string;            // Fishbowl customer ID or generated UUID for new entries
  name: string;
  location: string | null;
  contact_name?: string | null;
  email?: string | null;
  phone?: string | null;
  fishbowl_id?: string | null;
};
