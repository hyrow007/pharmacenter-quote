// Shared Supabase client. Both quote and packing-list apps point at the same
// Supabase project. Env vars are Team-level Shared variables in Vercel:
//
//   NEXT_PUBLIC_SUPABASE_URL              project URL (https://<id>.supabase.co)
//   NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY  publishable key (sb_publishable_*)
//
// Fallback to legacy NEXT_PUBLIC_SUPABASE_ANON_KEY for transitional projects.

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key =
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ||
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

export const supabase: SupabaseClient | null =
  url && key ? createClient(url, key) : null;

// Customer schema — matches the shared "customers" table maintained by the
// packing-list project (populated via Fishbowl sync).
export type Customer = {
  id: string;
  name: string;
  default_ship_to: string | null;
  active?: boolean;
  source?: string | null;
  external_id?: string | null;
};

// Product schema — matches the shared "products" table maintained by the
// packing-list project (populated via Fishbowl sync). fp_code is the Fishbowl
// product code; name is the descriptive label.
export type Product = {
  id: string;
  fp_code: string;
  name: string;
  default_unit: string | null;
  active?: boolean;
  source?: string | null;
  external_id?: string | null;
  notes?: string | null;
};
