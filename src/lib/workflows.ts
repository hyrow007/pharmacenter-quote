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

// A saved pricing-calculator snapshot. A workflow can have many — they show
// up as Excel-style tabs in the calculator. Each tab targets one workflow
// product (optional) so a single workflow with multiple products can have
// independent pricing per product without losing context.
// All money/percent inputs are stored as their string representation (matches
// what the calculator UI uses) so re-hydration is lossless. Results are also
// included so the workflow detail view can summarise without re-doing math.
export type PricingSnapshot = {
  // Stable id for this tab — generated client-side, never reused.
  tabId: string;
  // Optional user-facing tab label. When null we auto-derive from the picked
  // product name (or fall back to "Tab N" via the tab index).
  label: string | null;
  // The workflow product this tab is pricing. Empty string = not picked yet.
  workflowProductUid: string;

  // Vendor context — either a saved vendor row or a free-form new vendor name
  // typed in the calculator.
  vendorMode: "existing" | "new";
  vendorId: string | null;
  vendorLabel: string | null; // human-readable vendor name at save time
  newVendorName: string;

  // Cost inputs (strings to preserve exact formatting the user typed).
  shippingOrigin: "usa" | "international";
  incoterm: "EXW" | "FOB" | "CFR" | "CIF" | "DAP" | "DDP";
  unitCost: string;
  quantity: string;
  freight: string;
  insurance: string;
  customsBroker: string;
  dutiesPct: string;
  handling: string;
  testing: string;
  margin: string;
  marginMode: "markup" | "gross-margin";

  // Snapshot of computed results at the moment of save. Stored as plain
  // numbers in dollars — useful for the workflow listing summary so it
  // doesn't have to redo arithmetic.
  result: {
    landedTotal: number;
    landedPerUnit: number;
    salePerUnit: number;
    totalRevenue: number;
    grossProfit: number;
    effectiveMargin: number;
    effectiveMarkup: number;
  };

  savedAt: string; // ISO timestamp
  savedByEmail: string;
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
  // Pricing tabs in order. Each entry is the saved state of one calculator
  // tab. Order is meaningful (it matches the order shown in the calculator
  // tab bar). Optional for backward compatibility with workflows created
  // before this feature.
  //
  // Historical note: an earlier version of this field used a
  // Record<productUid, snapshot> shape. The hydration code accepts both
  // shapes so existing rows still load.
  pricing?: PricingSnapshot[];
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
  // Optional user-typed override for the description that shows in the
  // /workflows listing. When null/empty, the server falls back to a label
  // computed from the products + form (see buildAutoDescription).
  description_override: string | null;
  monday_item_id: string | null;
  monday_item_url: string | null;
  monday_last_pushed_at: string | null;
};

/** Format a quote_number as the user-facing "Q0001" string. */
export function formatQuoteNumber(n: number): string {
  return `Q${String(n).padStart(4, "0")}`;
}

// Dosage form labels — kept here (not in the page) so the auto-description
// helper can share them with the listing/management pages.
const DESCRIPTION_FORM_LABELS: Record<string, string> = {
  softgel: "Softgels",
  gummy: "Gummies",
  tablet: "Tablets",
  capsule: "Capsules",
  other: "Other",
};

/**
 * Single-line "Description" summary used in both the workflows table and the
 * inline description editor placeholder. Built from product names + the
 * dosage form (for bulk) so "Omega 3 + Vitamin D3 Softgels" comes out
 * verbatim. Callers pass in their own lookup of productId → display name so
 * this helper doesn't need to know about the DB schema.
 *
 * Empty string when there are no products — callers decide whether to show
 * "—" or a different placeholder.
 */
export function buildAutoDescription(
  state: WorkflowState,
  productNameById: Record<string, string>,
): string {
  const products = state.products ?? [];
  const names = products.map((p) => {
    if (p.mode === "new") return p.newProduct?.name_desc || "New product";
    if (p.productId && productNameById[p.productId]) return productNameById[p.productId];
    return "Product";
  });
  if (names.length === 0) return "";
  const joined = names.join(" + ");
  const formLabel =
    state.type === "bulk" && state.form
      ? DESCRIPTION_FORM_LABELS[state.form] || state.form
      : "";
  return formLabel ? `${joined} ${formLabel}` : joined;
}

/** Picks the user-typed override when present, otherwise the auto-label. */
export function resolveDescription(
  override: string | null | undefined,
  auto: string,
): string {
  const trimmed = override?.trim();
  if (trimmed) return trimmed;
  return auto;
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
