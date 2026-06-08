// Shared Supabase client. Used by all PharmaCenter quote/packing/etc. apps that
// point at the same Supabase project. Set the env vars in Vercel:
//
//   NEXT_PUBLIC_SUPABASE_URL       = same value as pharmacenter-packing-list
//   NEXT_PUBLIC_SUPABASE_ANON_KEY  = same value as pharmacenter-packing-list
//
// If either is missing the client is null and the calling code should fall
// back to mock data (so local development without env vars still renders).

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

export const supabase: SupabaseClient | null =
  url && anonKey ? createClient(url, anonKey) : null;

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
