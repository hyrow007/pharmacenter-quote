import {
  CUSTOMS_ITEM_KEYS,
  DEFAULT_DECLARED_VALUE_USD,
  MAX_DECLARED_VALUE_USD,
  needsCustoms,
  type Customs,
  type CustomsItemKey,
} from "./customs";

// The shipment draft: what the agent fills in and the person confirms.
//
// The agent never creates a label. It can only propose a draft with
// set_draft; the label is created by a server action that runs when a person
// presses Confirm on the screen that shows recipient, service, rated cost and
// payer. checkDraft() is the one validator, run on every set_draft and again
// on the server before anything is sent to FedEx -- the browser's copy of the
// draft is never trusted.

export const PURPOSES = [
  "sample_prospect",
  "sample_customer",
  "lab_submission",
  "vendor_return",
  "document",
  "order_shipment",
  "other",
] as const;
export type Purpose = (typeof PURPOSES)[number];

export const RECIPIENT_KINDS = ["customer", "prospect", "vendor", "lab", "other"] as const;
export type RecipientKind = (typeof RECIPIENT_KINDS)[number];

/** Rated cost above this needs an admin's approval before the label exists. */
export const APPROVAL_THRESHOLD_USD = 150;

export type DraftRecipient = {
  kind: RecipientKind;
  company: string | null;
  contactName: string | null;
  phone: string | null;
  email: string | null;
  streetLines: string[];
  city: string;
  stateProvince: string | null;
  postalCode: string | null;
  countryCode: string;
  residential: boolean | null;
  validated: boolean;
};

export type DraftPackage = {
  weightLb: number;
  lengthIn: number | null;
  widthIn: number | null;
  heightIn: number | null;
  presetId: string | null;
};

export type Draft = {
  recipientId: string | null;
  recipient: DraftRecipient;
  purpose: Purpose;
  purposeNote: string | null;
  customerId: string | null;
  vendorId: string | null;
  soNumber: string | null;
  contents: string;
  packages: DraftPackage[];
  serviceType: string;
  serviceName: string | null;
  payer: "shipper" | "recipient";
  payerAccount: string | null;
  signatureRequired: boolean;
  saturdayDelivery: boolean;
  /** Last rate the agent fetched for this service -- shown, never trusted. */
  quotedCost: number | null;
  quotedCurrency: string | null;
  /** Only for destinations that need customs paperwork. */
  customs: Customs | null;
};

const str = (v: unknown, max = 200): string | null => {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t ? t.slice(0, max) : null;
};
const num = (v: unknown): number | null => {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
};
const bool = (v: unknown) => v === true;
const uuid = (v: unknown) =>
  typeof v === "string" && /^[0-9a-f-]{36}$/i.test(v) ? v : null;

/** Needs customs paperwork (Puerto Rico and the other US territories do not). */
export function isInternational(d: Pick<Draft, "recipient">): boolean {
  return needsCustoms(d.recipient.countryCode);
}

function checkCustoms(raw: unknown, problems: string[]): Customs {
  const c = (raw ?? {}) as Record<string, unknown>;
  const documentsOnly = c.documentsOnly === true;
  const lines = Array.isArray(c.lines)
    ? c.lines.slice(0, 10).flatMap((l) => {
        const o = (l ?? {}) as Record<string, unknown>;
        const item = CUSTOMS_ITEM_KEYS.includes(o.item as CustomsItemKey) ? (o.item as CustomsItemKey) : null;
        const quantity = Math.round(num(o.quantity) ?? 0);
        return item ? [{ item, quantity: quantity > 0 ? quantity : 1, note: str(o.note, 60) }] : [];
      })
    : [];
  const v = num(c.declaredValue);
  const declaredValue = v == null ? DEFAULT_DECLARED_VALUE_USD : Math.round(v * 100) / 100;
  if (!documentsOnly && lines.length === 0) problems.push("customs_items");
  if (!(declaredValue > 0)) problems.push("customs_value");
  if (declaredValue > MAX_DECLARED_VALUE_USD) problems.push("customs_over_limit");
  return { documentsOnly, lines: documentsOnly ? [] : lines, declaredValue, recipientTaxId: str(c.recipientTaxId, 30) };
}

/**
 * Normalize anything (model output, a browser POST) into a Draft, and list
 * what is still missing. A draft with problems can be shown but not confirmed.
 */
export function checkDraft(raw: unknown): { draft: Draft; problems: string[] } {
  const r = (raw ?? {}) as Record<string, unknown>;
  const rc = (r.recipient ?? {}) as Record<string, unknown>;
  const problems: string[] = [];

  const kind = RECIPIENT_KINDS.includes(rc.kind as RecipientKind) ? (rc.kind as RecipientKind) : "other";
  const streetLines = Array.isArray(rc.streetLines)
    ? rc.streetLines.map((l) => str(l, 35)).filter((l): l is string => !!l).slice(0, 3)
    : [];
  const country = (str(rc.countryCode, 2) ?? "").toUpperCase();

  const recipient: DraftRecipient = {
    kind,
    company: str(rc.company, 35),
    contactName: str(rc.contactName, 35),
    phone: str(rc.phone, 20),
    email: str(rc.email, 80),
    streetLines,
    city: str(rc.city, 35) ?? "",
    stateProvince: str(rc.stateProvince, 20),
    postalCode: str(rc.postalCode, 12),
    countryCode: country,
    residential: typeof rc.residential === "boolean" ? rc.residential : null,
    validated: bool(rc.validated),
  };
  if (!recipient.company && !recipient.contactName) problems.push("recipient_name");
  // Many address-book entries are company-only (the fedex.com import). FedEx
  // takes the company name in the contact slot, so a contact is only needed
  // when there is no company.
  if (!recipient.contactName && !recipient.company) problems.push("contact_name");
  if (!recipient.phone) problems.push("phone");
  if (streetLines.length === 0) problems.push("street");
  if (!recipient.city) problems.push("city");
  if (!/^[A-Z]{2}$/.test(country)) problems.push("country");
  if ((country === "US" || country === "PR") && (!recipient.stateProvince || !recipient.postalCode)) problems.push("state_zip");
  if (!recipient.validated) problems.push("address_not_validated");

  const purpose = PURPOSES.includes(r.purpose as Purpose) ? (r.purpose as Purpose) : null;
  if (!purpose) problems.push("purpose");

  const packages: DraftPackage[] = Array.isArray(r.packages)
    ? r.packages.slice(0, 10).map((p) => {
        const o = (p ?? {}) as Record<string, unknown>;
        return {
          weightLb: num(o.weightLb) ?? 0,
          lengthIn: num(o.lengthIn),
          widthIn: num(o.widthIn),
          heightIn: num(o.heightIn),
          presetId: uuid(o.presetId),
        };
      })
    : [];
  if (packages.length === 0 || packages.some((p) => !(p.weightLb > 0 && p.weightLb <= 150))) problems.push("weight");

  const contents = str(r.contents, 200) ?? "";
  if (!contents) problems.push("contents");

  const serviceType = str(r.serviceType, 40) ?? "";
  if (!/^[A-Z0-9_]+$/.test(serviceType)) problems.push("service");

  const payer = r.payer === "recipient" ? "recipient" : "shipper";
  const payerAccount = str(r.payerAccount, 12);
  if (payer === "recipient" && !(payerAccount && /^\d{9}$/.test(payerAccount))) problems.push("payer_account");

  const draft: Draft = {
    recipientId: uuid(r.recipientId),
    recipient,
    purpose: purpose ?? "other",
    purposeNote: str(r.purposeNote, 200),
    customerId: uuid(r.customerId),
    vendorId: uuid(r.vendorId),
    soNumber: str(r.soNumber, 20),
    contents,
    packages,
    serviceType,
    serviceName: str(r.serviceName, 60),
    payer,
    payerAccount: payer === "recipient" ? payerAccount : null,
    signatureRequired: bool(r.signatureRequired),
    saturdayDelivery: bool(r.saturdayDelivery),
    quotedCost: num(r.quotedCost),
    quotedCurrency: str(r.quotedCurrency, 3),
    customs: null,
  };
  if (isInternational(draft)) draft.customs = checkCustoms(r.customs, problems);
  return { draft, problems };
}
