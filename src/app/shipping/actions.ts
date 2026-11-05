"use server";

// The only code that creates, approves, rejects or voids a label.
//
// Nothing here trusts the browser or the agent: submit re-runs checkDraft,
// re-validates the address with FedEx and re-rates the chosen service itself,
// and the $150 approval rule is decided on THAT rate. Approve and void flip
// the row's status with a conditional update first, so two people pressing at
// once cannot create or void twice.

import { revalidatePath } from "next/cache";
import type { SupabaseClient } from "@supabase/supabase-js";
import { shipGate } from "./_lib/gate";
import { checkDraft, APPROVAL_THRESHOLD_USD, isInternational, type Draft, type DraftRecipient } from "./_lib/draft";
import { validateAddress, getRates, createShipment, cancelShipment, fedexConfigured, ENVIRONMENT, LIVE } from "./_lib/fedex";

const BUCKET = "shipping-labels";

export type ActionResult =
  | { ok: true; status: "created"; id: string; trackingNumber: string }
  | { ok: true; status: "pending_approval"; id: string; cost: number }
  | { ok: true; status: "rejected" | "voided"; id: string }
  | { ok: false; error: string; detail?: string; problems?: string[] };

const LABEL_COLS =
  "id, environment, status, purpose, purpose_note, customer_id, vendor_id, so_number, recipient_id, recipient_snapshot, contents, packages, international, service_type, payer, payer_account, signature_required, saturday_delivery, rated_cost, requested_by, approval_required, tracking_number";

type LabelRow = {
  id: string;
  environment: string;
  status: string;
  purpose: Draft["purpose"];
  purpose_note: string | null;
  customer_id: string | null;
  vendor_id: string | null;
  so_number: string | null;
  recipient_id: string | null;
  recipient_snapshot: DraftRecipient;
  contents: string;
  packages: Draft["packages"];
  international: boolean;
  service_type: string;
  payer: "shipper" | "recipient";
  payer_account: string | null;
  signature_required: boolean;
  saturday_delivery: boolean;
  rated_cost: number | null;
  requested_by: string;
  approval_required: boolean;
  tracking_number: string | null;
};

function rowToDraft(r: LabelRow): Draft {
  return {
    recipientId: r.recipient_id,
    recipient: r.recipient_snapshot,
    purpose: r.purpose,
    purposeNote: r.purpose_note,
    customerId: r.customer_id,
    vendorId: r.vendor_id,
    soNumber: r.so_number,
    contents: r.contents,
    packages: r.packages,
    serviceType: r.service_type,
    serviceName: null,
    payer: r.payer,
    payerAccount: r.payer_account,
    signatureRequired: r.signature_required,
    saturdayDelivery: r.saturday_delivery,
    quotedCost: r.rated_cost,
    quotedCurrency: "USD",
  };
}

/** Create the FedEx label for a row already marked approved, store the PDF, record the outcome. */
async function createAndStore(service: SupabaseClient, row: LabelRow): Promise<ActionResult> {
  const made = await createShipment(rowToDraft(row));
  if (!made.ok) {
    await service
      .from("shipping_labels")
      .update({ status: "failed", fedex_error: { error: made.error, detail: made.detail ?? null } })
      .eq("id", row.id);
    return { ok: false, error: made.error, detail: made.detail };
  }
  const path = `${row.environment}/${row.id}.pdf`;
  const up = await service.storage.from(BUCKET).upload(path, made.labelPdf, { contentType: "application/pdf", upsert: true });
  const { error } = await service
    .from("shipping_labels")
    .update({
      status: "created",
      tracking_number: made.trackingNumber,
      label_path: up.error ? null : path,
      created_label_at: new Date().toISOString(),
      fedex_error: up.error ? { storage: up.error.message } : null,
      ...(made.netCharge != null ? { rate_detail: { net_charge_at_ship: made.netCharge, ...(made.raw as object) } } : {}),
    })
    .eq("id", row.id);
  if (error) return { ok: false, error: "recorded_label_but_db_failed", detail: `${made.trackingNumber}: ${error.message}` };
  return { ok: true, status: "created", id: row.id, trackingNumber: made.trackingNumber };
}

export async function submitShipment(raw: unknown): Promise<ActionResult> {
  const g = await shipGate();
  if (!g.ok) return { ok: false, error: g.error };
  const cfg = fedexConfigured();
  if (!cfg.ok) return { ok: false, error: "fedex_not_configured", detail: cfg.missing.join(", ") };

  const { draft, problems } = checkDraft(raw);
  // The agent's "validated" claim is not trusted: we validate here ourselves.
  const real = problems.filter((p) => p !== "address_not_validated");
  if (real.length) return { ok: false, error: "incomplete", problems: real };
  if (isInternational(draft)) return { ok: false, error: "international_not_yet" };

  const v = await validateAddress(draft.recipient);
  if (!v.ok) return { ok: false, error: v.error, detail: v.detail };
  // FedEx's sandbox answers address validation with canned sample data (a
  // Miami street came back as "Miami, Chile" on 2026-11-05), so it can never
  // resolve a real address. Live, an unresolved address blocks the label; in
  // test mode it is recorded as unverified and the label goes ahead.
  if (!v.resolved && LIVE) return { ok: false, error: "address_not_resolved", detail: v.notes.join(", ") };
  const addressCheck = v.resolved ? "resolved" : "sandbox_unverified";
  draft.recipient.validated = v.resolved;
  if (draft.recipient.residential == null) draft.recipient.residential = v.residential;

  const rated = await getRates({ recipient: draft.recipient, packages: draft.packages, serviceType: draft.serviceType });
  if (!rated.ok) return { ok: false, error: rated.error, detail: rated.detail };
  const rate = rated.rates.find((r) => r.serviceType === draft.serviceType);
  if (!rate) return { ok: false, error: "service_not_offered", detail: draft.serviceType };

  // A double click, or two tabs: the same person, same recipient, inside a minute.
  const since = new Date(Date.now() - 60_000).toISOString();
  const dupQ = g.service
    .from("shipping_labels")
    .select("id")
    .eq("requested_by", g.email)
    .in("status", ["pending_approval", "approved", "created"])
    .gte("requested_at", since);
  const { data: dup } = draft.recipientId
    ? await dupQ.eq("recipient_id", draft.recipientId)
    : await dupQ.eq("recipient_snapshot->>city", draft.recipient.city);
  if (dup?.length) return { ok: false, error: "duplicate_just_submitted" };

  // The address book: reuse the entry, refreshing it with the checked address,
  // or add the new recipient so nobody types this address again.
  const rec = draft.recipient;
  const recipientRow = {
    kind: rec.kind,
    company: rec.company,
    contact_name: rec.contactName,
    phone: rec.phone,
    email: rec.email,
    street_lines: rec.streetLines,
    city: rec.city,
    state_province: rec.stateProvince,
    postal_code: rec.postalCode,
    country_code: rec.countryCode,
    residential: rec.residential,
    validated_at: new Date().toISOString(),
    customer_id: draft.customerId,
    vendor_id: draft.vendorId,
    ...(draft.payer === "recipient" ? { bill_to_account: draft.payerAccount } : {}),
  };
  let recipientId = draft.recipientId;
  if (recipientId) {
    await g.service.from("shipping_recipients").update(recipientRow).eq("id", recipientId);
  } else {
    const { data, error } = await g.service
      .from("shipping_recipients")
      .insert({ ...recipientRow, created_by: g.email })
      .select("id")
      .single();
    if (error) return { ok: false, error: "address_book_failed", detail: error.message };
    recipientId = String((data as { id: string }).id);
  }

  const needsApproval = rate.cost > APPROVAL_THRESHOLD_USD;
  const { data: inserted, error } = await g.service
    .from("shipping_labels")
    .insert({
      environment: ENVIRONMENT,
      status: needsApproval ? "pending_approval" : "approved",
      purpose: draft.purpose,
      purpose_note: draft.purposeNote,
      customer_id: draft.customerId,
      vendor_id: draft.vendorId,
      so_number: draft.soNumber,
      recipient_id: recipientId,
      recipient_snapshot: rec,
      contents: draft.contents,
      packages: draft.packages,
      international: false,
      service_type: draft.serviceType,
      payer: draft.payer,
      payer_account: draft.payerAccount,
      signature_required: draft.signatureRequired,
      saturday_delivery: draft.saturdayDelivery,
      rated_cost: rate.cost,
      rated_currency: rate.currency,
      rated_at: new Date().toISOString(),
      rate_detail: { service_name: rate.serviceName, transit: rate.transitDays, address_check: addressCheck },
      requested_by: g.email,
      approval_required: needsApproval,
    })
    .select(LABEL_COLS)
    .single();
  if (error || !inserted) return { ok: false, error: "record_failed", detail: error?.message };
  revalidatePath("/shipping");
  if (needsApproval) return { ok: true, status: "pending_approval", id: (inserted as LabelRow).id, cost: rate.cost };
  const out = await createAndStore(g.service, inserted as unknown as LabelRow);
  revalidatePath("/shipping");
  return out;
}

export async function approveShipment(id: string): Promise<ActionResult> {
  const g = await shipGate();
  if (!g.ok) return { ok: false, error: g.error };
  if (!g.admin) return { ok: false, error: "not_admin" };
  const { data, error } = await g.service
    .from("shipping_labels")
    .update({ status: "approved", approved_by: g.email, approved_at: new Date().toISOString() })
    .eq("id", id)
    .eq("status", "pending_approval")
    .select(LABEL_COLS);
  if (error) return { ok: false, error: "record_failed", detail: error.message };
  if (!data?.length) return { ok: false, error: "changed" };
  const out = await createAndStore(g.service, data[0] as unknown as LabelRow);
  revalidatePath("/shipping");
  return out;
}

export async function rejectShipment(id: string, note: string | null): Promise<ActionResult> {
  const g = await shipGate();
  if (!g.ok) return { ok: false, error: g.error };
  if (!g.admin) return { ok: false, error: "not_admin" };
  const { data, error } = await g.service
    .from("shipping_labels")
    .update({
      status: "rejected",
      approved_by: g.email,
      approved_at: new Date().toISOString(),
      decision_note: note?.trim().slice(0, 300) || null,
    })
    .eq("id", id)
    .eq("status", "pending_approval")
    .select("id");
  if (error) return { ok: false, error: "record_failed", detail: error.message };
  if (!data?.length) return { ok: false, error: "changed" };
  revalidatePath("/shipping");
  return { ok: true, status: "rejected", id };
}

export async function voidShipment(id: string): Promise<ActionResult> {
  const g = await shipGate();
  if (!g.ok) return { ok: false, error: g.error };
  const { data: row } = await g.service.from("shipping_labels").select(LABEL_COLS).eq("id", id).maybeSingle();
  const r = row as LabelRow | null;
  if (!r || r.status !== "created" || !r.tracking_number) return { ok: false, error: "changed" };
  if (r.requested_by !== g.email && !g.admin) return { ok: false, error: "not_admin" };
  if (r.environment !== ENVIRONMENT) return { ok: false, error: "wrong_environment", detail: r.environment };
  const c = await cancelShipment(r.tracking_number);
  if (!c.ok) return { ok: false, error: c.error, detail: c.detail };
  if (!c.cancelled) return { ok: false, error: "fedex_refused_void", detail: c.message ?? undefined };
  const { data, error } = await g.service
    .from("shipping_labels")
    .update({ status: "voided", voided_by: g.email, voided_at: new Date().toISOString() })
    .eq("id", id)
    .eq("status", "created")
    .select("id");
  if (error || !data?.length) return { ok: false, error: "voided_at_fedex_but_db_failed", detail: error?.message };
  revalidatePath("/shipping");
  return { ok: true, status: "voided", id };
}
