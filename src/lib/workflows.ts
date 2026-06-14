// Shared workflow types + a couple of server helpers.
//
// The shape here is the canonical version of the form state that lives in
// /start (and used to be duplicated in /workflow/review). The DB persists it
// as the JSONB `state` column on `workflows`. Keep this file as the single
// source of truth — when the form gets new fields, update here first, then
// the page / API surface.

import type { WorkflowAttachment } from "./storage";

// We don't have generated Database types, so trying to use the real
// SupabaseClient generic from either @supabase/ssr or @supabase/supabase-js
// here makes TS attempt to unify two different deeply-instantiated query
// builders and trip the "Type instantiation is excessively deep" check.
// `any` here is intentional and contained — it leaks into one helper only.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnySupabase = any;

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

// Lifecycle of a workflow. "in_progress" is the default until the user
// explicitly marks a quote as Won or Lost. Mirrors the DB CHECK constraint.
export type WorkflowStatus = "in_progress" | "won" | "lost";

export const WORKFLOW_STATUS_LABELS: Record<WorkflowStatus, string> = {
  in_progress: "In Progress",
  won: "Won",
  lost: "Lost",
};

// Recorded when a workflow is marked Won — one entry per Sales Order tied to
// this quote. Persisted as the JSONB `sales_orders` column on `workflows`.
// `value` is in whole-dollar units (no currency code, en-US assumed).
export type SalesOrder = {
  so_number: string;
  value: number; // dollars
};

export type WorkflowRow = {
  id: string;
  // Per-workflow sequential number backed by a Postgres sequence. Display
  // form is "Q" followed by the number zero-padded to 4 digits (Q0001).
  // Stable for the life of the row even after edits.
  quote_number: number;
  created_by_email: string;
  created_at: string;
  updated_at: string;
  state: WorkflowState;
  status: WorkflowStatus;
  sales_orders: SalesOrder[];
  monday_item_id: string | null;
  monday_item_url: string | null;
  monday_last_pushed_at: string | null;
};

/** Format a quote_number as the user-facing "Q0001" string. */
export function formatQuoteNumber(n: number): string {
  return `Q${String(n).padStart(4, "0")}`;
}

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
