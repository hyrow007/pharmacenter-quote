// Row shapes for the shared reference tables every PharmaCenter app reads.
//
// These lived in the anon client module (now ./legacy) purely because that is
// where they were first written. They describe TABLES, not a client, and
// keeping them there meant a file that only wanted a type had to import the
// module with the session-less client in it -- which is how a "legacy" module
// keeps acquiring importers it does not need.
//
// Keep in sync with the Supabase project. Add columns as the tables grow.

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
