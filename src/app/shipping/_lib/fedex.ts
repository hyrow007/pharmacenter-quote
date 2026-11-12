// FedEx REST client: OAuth, address validation, rates, create, cancel.
// Server only. Raw fetch, like the rest of this repo.
//
// The live gate: SHIPPING_LIVE=1 selects https://apis.fedex.com; anything else
// uses the sandbox. FedEx issues separate credentials for each, so going live
// is: put the production FEDEX_CLIENT_ID / FEDEX_CLIENT_SECRET in Vercel and
// set SHIPPING_LIVE=1. Nothing else about the code path changes.
//
// Verified against developer.fedex.com 2026-11-04: OAuth client_credentials
// (form-encoded, token ~3600 s), POST /rate/v1/rates/quotes with the total at
// output.rateReplyDetails[].ratedShipmentDetails[].totalNetCharge,
// POST /ship/v1/shipments, PUT /ship/v1/shipments/cancel,
// POST /address/v1/addresses/resolve, and "no non-ASCII in Create Shipment".
// NOT verified from FedEx's pages (behind their interactive reference): the
// label spec enum values and the create-shipment response paths. Those are
// read defensively below and must be confirmed on the first sandbox run --
// see claude/shipping.md.

import "server-only";
import type { Draft, DraftRecipient, DraftPackage } from "./draft";
import { CUSTOMS_ITEMS, splitValue, type Customs } from "./customs";
import { SHIPPER } from "./shipper";

export const LIVE = process.env.SHIPPING_LIVE === "1";
export const ENVIRONMENT: "live" | "sandbox" = LIVE ? "live" : "sandbox";
const BASE = LIVE ? "https://apis.fedex.com" : "https://apis-sandbox.fedex.com";

export type FedexError = { ok: false; error: string; detail?: string };

function creds() {
  const id = process.env.FEDEX_CLIENT_ID;
  const secret = process.env.FEDEX_CLIENT_SECRET;
  const account = process.env.FEDEX_ACCOUNT_NUMBER;
  if (!id || !secret || !account) return null;
  return { id, secret, account };
}

export function fedexConfigured(): { ok: boolean; missing: string[] } {
  const missing = ["FEDEX_CLIENT_ID", "FEDEX_CLIENT_SECRET", "FEDEX_ACCOUNT_NUMBER"].filter(
    (k) => !process.env[k],
  );
  if (!SHIPPER.streetLines.length) missing.push("shipper address (src/app/shipping/_lib/shipper.ts)");
  return { ok: missing.length === 0, missing };
}

// One token per warm function instance, refreshed a minute early.
let token: { value: string; until: number; base: string } | null = null;

async function getToken(): Promise<string | FedexError> {
  if (token && token.base === BASE && token.until > Date.now()) return token.value;
  const c = creds();
  if (!c) return { ok: false, error: "fedex_not_configured" };
  const res = await fetch(`${BASE}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: c.id, client_secret: c.secret }),
    cache: "no-store",
  }).catch(() => null);
  if (!res) return { ok: false, error: "fedex_unreachable" };
  const j = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number };
  if (!res.ok || !j.access_token) return { ok: false, error: `fedex_auth_${res.status}` };
  token = { value: j.access_token, until: Date.now() + ((j.expires_in ?? 3600) - 60) * 1000, base: BASE };
  return token.value;
}

async function call(method: "POST" | "PUT", path: string, body: unknown): Promise<{ ok: true; json: any } | FedexError> {
  const t = await getToken();
  if (typeof t !== "string") return t;
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { "content-type": "application/json", authorization: `Bearer ${t}`, "x-locale": "en_US" },
    body: JSON.stringify(body),
    cache: "no-store",
  }).catch(() => null);
  if (!res) return { ok: false, error: "fedex_unreachable" };
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const errs = Array.isArray(json?.errors) ? json.errors : [];
    const detail = errs.map((e: any) => `${e.code ?? ""} ${e.message ?? ""}`.trim()).join("; ");
    return { ok: false, error: `fedex_${res.status}`, detail: detail.slice(0, 500) || undefined };
  }
  return { ok: true, json };
}

/** Diagnostics only (sandbox): send a raw body and return FedEx's raw reply. */
export async function rawFedex(method: "POST" | "PUT", path: string, body: unknown) {
  return call(method, path, body);
}

/** The sandbox/live account number in use, for diagnostics (last 4 only). */
export function accountLast4(): string | null {
  const a = process.env.FEDEX_ACCOUNT_NUMBER;
  return a ? a.slice(-4) : null;
}

// FedEx rejects non-ASCII in Create Shipment. The address book keeps the real
// spelling ("María Núñez"); only what is sent is folded ("Maria Nunez").
export function ascii(s: string | null | undefined): string {
  if (!s) return "";
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/ß/g, "ss")
    .replace(/[æÆ]/g, "ae")
    .replace(/[øØ]/g, "o")
    .replace(/[^\x20-\x7E]/g, "")
    .trim();
}

function fxAddress(r: Pick<DraftRecipient, "streetLines" | "city" | "stateProvince" | "postalCode" | "countryCode">) {
  return {
    streetLines: r.streetLines.map(ascii).filter(Boolean),
    city: ascii(r.city),
    ...(r.stateProvince ? { stateOrProvinceCode: ascii(r.stateProvince) } : {}),
    ...(r.postalCode ? { postalCode: ascii(r.postalCode) } : {}),
    countryCode: r.countryCode,
  };
}

function fxPackages(pkgs: DraftPackage[]) {
  return pkgs.map((p, i) => ({
    sequenceNumber: i + 1,
    weight: { units: "LB", value: Math.max(0.1, Math.round(p.weightLb * 10) / 10) },
    ...(p.lengthIn && p.widthIn && p.heightIn
      ? {
          dimensions: {
            length: Math.ceil(p.lengthIn),
            width: Math.ceil(p.widthIn),
            height: Math.ceil(p.heightIn),
            units: "IN",
          },
        }
      : {}),
  }));
}

const shipperBlock = () => ({
  contact: {
    personName: ascii(SHIPPER.contactName),
    companyName: ascii(SHIPPER.company),
    phoneNumber: SHIPPER.phone.replace(/\D/g, ""),
  },
  address: fxAddress(SHIPPER),
});

// ---------------------------------------------------------------- validate

export type Validated = {
  ok: true;
  resolved: boolean;
  classification: string | null;
  residential: boolean | null;
  suggestion: { streetLines: string[]; city: string; stateProvince: string | null; postalCode: string | null; countryCode: string } | null;
  notes: string[];
};

export async function validateAddress(
  r: Pick<DraftRecipient, "streetLines" | "city" | "stateProvince" | "postalCode" | "countryCode">,
): Promise<Validated | FedexError> {
  const out = await call("POST", "/address/v1/addresses/resolve", {
    addressesToValidate: [{ address: fxAddress(r) }],
  });
  if (!out.ok) return out;
  const a = out.json?.output?.resolvedAddresses?.[0];
  if (!a) return { ok: true, resolved: false, classification: null, residential: null, suggestion: null, notes: ["no_result"] };
  const attr = (a.attributes ?? {}) as Record<string, unknown>;
  const yes = (k: string) => attr[k] === true || attr[k] === "true";
  const resolved = yes("Resolved") && !yes("InterpolatedStreetAddress") && (r.countryCode !== "US" || yes("DPV"));
  const classification = typeof a.classification === "string" ? a.classification : null;
  const lines = Array.isArray(a.streetLinesToken) ? a.streetLinesToken : Array.isArray(a.streetLines) ? a.streetLines : [];
  const notes = Array.isArray(a.customerMessages) ? a.customerMessages.map((m: any) => String(m?.code ?? m)) : [];
  return {
    ok: true,
    resolved,
    classification,
    residential: classification === "RESIDENTIAL" ? true : classification === "BUSINESS" ? false : null,
    suggestion: lines.length
      ? {
          streetLines: lines.map(String),
          city: String(a.city ?? r.city),
          stateProvince: a.stateOrProvinceCode ? String(a.stateOrProvinceCode) : r.stateProvince,
          postalCode: a.postalCode ? String(a.postalCode) : r.postalCode,
          countryCode: String(a.countryCode ?? r.countryCode),
        }
      : null,
    notes,
  };
}

// ---------------------------------------------------------------- customs

/**
 * The customsClearanceDetail block. Duties are billed to PharmaCenter
 * (SENDER), origin is the US, purpose is a sample, and the shipment's one
 * declared value is spread across the lines in whole cents.
 */
function fxCustoms(c: Customs, packages: DraftPackage[]) {
  const total = Math.max(0.01, c.declaredValue);
  const money = (amount: number) => ({ amount, currency: "USD" });
  const totalLb = packages.reduce((a, p) => a + p.weightLb, 0) || 1;
  const lines = c.documentsOnly
    ? [{ description: "Business documents", quantity: 1, weight: totalLb, hs: null as string | null }]
    : c.lines.map((l, i, all) => ({
        description: ascii(CUSTOMS_ITEMS[l.item].description).slice(0, 450),
        quantity: l.quantity,
        weight: Math.max(0.1, Math.round((totalLb / all.length) * 10) / 10),
        hs: CUSTOMS_ITEMS[l.item].hs as string | null,
      }));
  const values = splitValue(total, lines.length);
  return {
    dutiesPayment: { paymentType: "SENDER" },
    isDocumentOnly: c.documentsOnly,
    commercialInvoice: { shipmentPurpose: "SAMPLE" },
    totalCustomsValue: money(total),
    commodities: lines.map((l, i) => ({
      description: l.description,
      countryOfManufacture: "US",
      quantity: l.quantity,
      quantityUnits: "PCS",
      numberOfPieces: 1,
      unitPrice: money(Math.round((values[i] / l.quantity) * 10000) / 10000),
      customsValue: money(values[i]),
      weight: { units: "LB", value: l.weight },
      ...(l.hs ? { harmonizedCode: l.hs } : {}),
    })),
  };
}

// ---------------------------------------------------------------- rate

export type Rate = { serviceType: string; serviceName: string | null; cost: number; currency: string; transitDays: string | null };

export async function getRates(
  d: Pick<Draft, "recipient" | "packages"> & { serviceType?: string | null; customs?: Customs | null },
): Promise<{ ok: true; rates: Rate[] } | FedexError> {
  const c = creds();
  if (!c) return { ok: false, error: "fedex_not_configured" };
  const out = await call("POST", "/rate/v1/rates/quotes", {
    accountNumber: { value: c.account },
    requestedShipment: {
      shipper: { address: fxAddress(SHIPPER) },
      recipient: { address: { ...fxAddress(d.recipient), residential: d.recipient.residential === true } },
      pickupType: "DROPOFF_AT_FEDEX_LOCATION",
      ...(d.serviceType ? { serviceType: d.serviceType } : {}),
      rateRequestType: ["ACCOUNT"],
      // International rates can come back in the destination's currency (a
      // Mexico quote arrived in EUR on 2026-11-07). Ask for dollars.
      preferredCurrency: "USD",
      ...(d.customs ? { customsClearanceDetail: fxCustoms(d.customs, d.packages) } : {}),
      requestedPackageLineItems: fxPackages(d.packages),
    },
  });
  if (!out.ok) return out;
  const rows = Array.isArray(out.json?.output?.rateReplyDetails) ? out.json.output.rateReplyDetails : [];
  const rates: Rate[] = [];
  for (const r of rows) {
    const details = Array.isArray(r.ratedShipmentDetails) ? r.ratedShipmentDetails : [];
    // Prefer the account rate in USD, then any USD rate, then the account
    // rate, then whatever came first. The $150 rule is in dollars, so a
    // non-USD rate is flagged and treated as needing approval.
    const usd = (x: any) => String(x?.currency ?? "").toUpperCase() === "USD";
    const pick =
      details.find((x: any) => x.rateType === "ACCOUNT" && usd(x)) ??
      details.find(usd) ??
      details.find((x: any) => x.rateType === "ACCOUNT") ??
      details[0];
    const cost = Number(pick?.totalNetCharge);
    if (!Number.isFinite(cost)) continue;
    rates.push({
      serviceType: String(r.serviceType),
      serviceName: r.serviceName ? String(r.serviceName) : null,
      cost,
      currency: String(pick?.currency ?? "USD"),
      transitDays: r.commit?.transitDays?.description
        ? String(r.commit.transitDays.description)
        : r.operationalDetail?.transitTime
          ? String(r.operationalDetail.transitTime)
          : null,
    });
  }
  rates.sort((a, b) => a.cost - b.cost);
  return { ok: true, rates };
}

// ---------------------------------------------------------------- ship

export type Created = {
  ok: true;
  trackingNumber: string;
  labelPdf: Buffer;
  /** The FedEx-generated commercial invoice, international only. */
  invoicePdf: Buffer | null;
  netCharge: number | null;
  raw: unknown;
};

export async function createShipment(d: Draft): Promise<Created | FedexError> {
  const c = creds();
  if (!c) return { ok: false, error: "fedex_not_configured" };
  const r = d.recipient;
  const specials: string[] = [];
  if (d.saturdayDelivery) specials.push("SATURDAY_DELIVERY");
  const out = await call("POST", "/ship/v1/shipments", {
    labelResponseOptions: "LABEL",
    accountNumber: { value: c.account },
    requestedShipment: {
      shipper: shipperBlock(),
      recipients: [
        {
          contact: {
            personName: ascii(r.contactName ?? r.company),
            ...(r.company ? { companyName: ascii(r.company) } : {}),
            phoneNumber: (r.phone ?? "").replace(/[^\d+]/g, ""),
            ...(r.email ? { emailAddress: r.email } : {}),
          },
          address: { ...fxAddress(r), residential: r.residential === true },
          ...(d.customs?.recipientTaxId
            ? { tins: [{ number: ascii(d.customs.recipientTaxId), tinType: "BUSINESS_NATIONAL" }] }
            : {}),
        },
      ],
      shipDatestamp: new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" }),
      serviceType: d.serviceType,
      packagingType: "YOUR_PACKAGING",
      pickupType: "DROPOFF_AT_FEDEX_LOCATION",
      shippingChargesPayment:
        d.payer === "recipient"
          ? { paymentType: "RECIPIENT", payor: { responsibleParty: { accountNumber: { value: d.payerAccount } } } }
          : { paymentType: "SENDER" },
      ...(specials.length ? { shipmentSpecialServices: { specialServiceTypes: specials } } : {}),
      labelSpecification: {
        imageType: "PDF",
        labelStockType: "PAPER_85X11_TOP_HALF_LABEL",
      },
      ...(d.customs
        ? {
            customsClearanceDetail: fxCustoms(d.customs, d.packages),
            shippingDocumentSpecification: {
              shippingDocumentTypes: ["COMMERCIAL_INVOICE"],
              commercialInvoiceDetail: { documentFormat: { stockType: "PAPER_LETTER", docType: "PDF" } },
            },
          }
        : {}),
      requestedPackageLineItems: fxPackages(d.packages).map((p) => ({
        ...p,
        ...(d.signatureRequired
          ? { packageSpecialServices: { specialServiceTypes: ["SIGNATURE_OPTION"], signatureOptionType: "DIRECT" } }
          : {}),
        customerReferences: [{ customerReferenceType: "CUSTOMER_REFERENCE", value: ascii(d.soNumber ? `SO ${d.soNumber}` : d.purpose).slice(0, 30) }],
      })),
    },
  });
  if (!out.ok) return out;
  // Read defensively: confirm these paths on the first sandbox run.
  const ts = out.json?.output?.transactionShipments?.[0];
  const piece = ts?.pieceResponses?.[0];
  const doc =
    (Array.isArray(piece?.packageDocuments) ? piece.packageDocuments : []).find((x: any) => x?.encodedLabel) ??
    (Array.isArray(ts?.shipmentDocuments) ? ts.shipmentDocuments : []).find((x: any) => x?.encodedLabel);
  const tracking = String(ts?.masterTrackingNumber ?? piece?.trackingNumber ?? "");
  if (!tracking || !doc?.encodedLabel) {
    return { ok: false, error: "fedex_unexpected_response", detail: JSON.stringify(out.json).slice(0, 500) };
  }
  // The commercial invoice usually comes back among the shipment documents,
  // but look everywhere FedEx returns documents: an Ecuador shipment on
  // 2026-11-07 came back without one where the Mexico ones had it.
  const shipDocs = Array.isArray(ts?.shipmentDocuments) ? ts.shipmentDocuments : [];
  const pieceDocs = (Array.isArray(ts?.pieceResponses) ? ts.pieceResponses : []).flatMap((p: any) =>
    Array.isArray(p?.packageDocuments) ? p.packageDocuments : [],
  );
  const allDocs = [...shipDocs, ...pieceDocs];
  const kind = (x: any) => String(x?.contentType ?? x?.docType ?? x?.type ?? "");
  const inv = allDocs.find((x: any) => /INVOICE/i.test(kind(x)) && x?.encodedLabel);
  const docTypes = allDocs.map((x: any) => `${kind(x) || "?"}${x?.encodedLabel ? "" : "(no data)"}`);
  const net = Number(
    ts?.completedShipmentDetail?.shipmentRating?.shipmentRateDetails?.[0]?.totalNetCharge ??
      piece?.netChargeAmount,
  );
  return {
    ok: true,
    trackingNumber: tracking,
    labelPdf: Buffer.from(String(doc.encodedLabel), "base64"),
    invoicePdf: inv ? Buffer.from(String(inv.encodedLabel), "base64") : null,
    netCharge: Number.isFinite(net) ? net : null,
    raw: {
      serviceType: ts?.serviceType,
      shipDatestamp: ts?.shipDatestamp,
      alerts: ts?.alerts ?? out.json?.output?.alerts,
      documents: docTypes,
    },
  };
}

export async function cancelShipment(trackingNumber: string): Promise<{ ok: true; cancelled: boolean; message: string | null } | FedexError> {
  const c = creds();
  if (!c) return { ok: false, error: "fedex_not_configured" };
  const out = await call("PUT", "/ship/v1/shipments/cancel", {
    accountNumber: { value: c.account },
    trackingNumber,
    deletionControl: "DELETE_ALL_PACKAGES",
  });
  if (!out.ok) return out;
  const o = out.json?.output ?? {};
  return {
    ok: true,
    cancelled: o.cancelledShipment === true || o.cancelledShipment === "true",
    message: o.message ? String(o.message) : null,
  };
}
