// Shared workflow types + a couple of server helpers.
//
// The shape here is the canonical version of the form state that lives in
// /start (and used to be duplicated in /workflow/review). The DB persists it
// as the JSONB `state` column on `workflows`. Keep this file as the single
// source of truth — when the form gets new fields, update here first, then
// the page / API surface.

import type { WorkflowAttachment } from "./storage";

// Loose Supabase client surface — we only need `.from(...).select(...).eq(...).maybeSingle()`,
// which both the @supabase/ssr server client and the @supabase/supabase-js
// anon client expose. Typing the full generic SupabaseClient<Database> would
// require feeding it the project's table types, which we don't currently have.
type AnySupabase = {
  from: (table: string) => {
    select: (cols: string) => {
      eq: (
        col: string,
        val: string,
      ) => {
        maybeSingle: () => Promise<{
          data: { email: string } | null;
          error: { message: string } | null;
        }>;
      };
    };
  };
};

export type WorkflowMode = "existing" | "new";

export type ProductEntry = {
  uid: string;
  mode: WorkflowMode;
  productId: string | null;
  newProduct: { name_desc: string; notes: string };
  quantities: string[];
  attachments: WorkflowAttachment[];
  // Hydrated display fields — not persisted to JSONB. Marked optional so the
  // server-loaded rows (which won't have them) typecheck.
  _name?: string | null;
  _code?: string | null;
};

export type WorkflowState = {
  // Storage prefix for attachments. Generated once on the client when a fresh
  // workflow is created. Stays stable even after the DB row's UUID is known.
  workflowUid: string;
  customerMode: WorkflowMode;
  customerId: string | null;
  newCustomer: { name: string; contact: string; email: string };
  type: string | null;
  form: string | null;
  source: string | null;
  products: ProductEntry[];
};

export type WorkflowRow = {
  id: string;
  created_by_email: string;
  created_at: string;
  updated_at: string;
  state: WorkflowState;
  monday_item_id: string | null;
  monday_item_url: string | null;
  monday_last_pushed_at: string | null;
};

/**
 * Check whether an email is registered in the `admins` table. Used by the
 * /workflow/[id] page to decide whether to show the delete button — RLS
 * still enforces the rule on DELETE, this is purely UI.
 *
 * Accepts a Supabase client (server-side `createClient()`) so this can be
 * called from route handlers or RSCs without re-creating one.
 */
export async function isAdmin(
  supabase: AnySupabase,
  email: string | null | undefined,
): Promise<boolean> {
  if (!email) return false;
  const { data, error } = await supabase
    .from("admins")
    .select("email")
    .eq("email", email)
    .maybeSingle();
  if (error) {
    // Don't throw — surface as "not admin" so the page still renders.
    console.error("isAdmin lookup failed:", error.message);
    return false;
  }
  return !!data;
}
