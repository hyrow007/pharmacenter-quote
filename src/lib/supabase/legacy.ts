// LEGACY module-scope Supabase client. Prefer ./server.ts or ./client.ts.
//
// This is NOT the request-aware SSR client the rest of the app uses. It is a
// single anon client created once at module load, with no cookies and no
// signed-in user attached, so every query it makes runs as `anon` no matter
// who is looking at the page. Four files still import it -- FormulaEditor,
// PricingCalculator, /start and workflow actions -- and they work because the
// tables they touch are readable by anon.
//
// It was called `@/lib/supabase` until 2026-09-20, which was a genuine trap
// worth naming: in the packing-list repo `@/lib/supabase/server` is the real
// auth-aware client, so the same-looking import meant two different things in
// the two repos, and neither one failed loudly when pasted into the other.
// Renamed to `legacy` so the import itself says which one you got. (H5.)
//
// Env vars are set in Vercel as Team-level Shared variables, so one rotation
// flows to every linked project:
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
  default_ship_to?: string | null;
};

// Convenience type matching the shared "products" table schema — the same
// row shape /start/page.tsx and PricingCalculator both consume when the
// existing-products dropdown is hydrated. `fp_code` is the Fishbowl part
// number ("PC-BK-1234" and friends); `default_unit` is the UoM label
// synced from Fishbowl's `uom` table (e.g. "kg", "ea", "L").
export type Product = {
  id: string;
  name: string;
  fp_code: string | null;
  default_unit?: string | null;
  active?: boolean;
  external_id?: string | null;
};
