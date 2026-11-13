// fedex.com Ship Manager "Shipment Report" → one record per shipment.
//
// The report (Ship Manager → Shipments → Download, .xlsx) has a header row of
// camelCase field names (shipDate, masterTrackingNumber, pieceTrackingNumber,
// serviceType, recipientCompany, estimatedShippingCosts, …) and one row PER BOX.
// Rows sharing a masterTrackingNumber are one shipment; the other boxes'
// tracking numbers are kept as pieces. Verified against the 2026-11-13 export
// (62 rows, 49 shipments, account …0562).
//
// What is NOT kept: phone numbers, emails, tax IDs, the sender's full account
// number (last 4 only). This is a shipping log, not a contact list.

export type ExternalShipment = {
  master_tracking_number: string;
  piece_tracking_numbers: string[];
  ship_date: string | null;
  created_date: string | null;
  service_type: string | null;
  fedex_status: string | null;
  reference: string | null;
  invoice_number: string | null;
  po_number: string | null;
  department: string | null;
  payment_type: string | null;
  account_last4: string | null;
  recipient_contact: string | null;
  recipient_company: string | null;
  recipient_street_lines: string[];
  recipient_city: string | null;
  recipient_state: string | null;
  recipient_postal_code: string | null;
  recipient_country: string | null;
  recipient_residential: boolean | null;
  packages: number | null;
  total_weight: number | null;
  weight_units: string | null;
  estimated_cost: number | null;
  base_rate: number | null;
  etd: boolean | null;
};

const REQUIRED = ["shipDate", "masterTrackingNumber", "serviceType", "recipientCity", "recipientCountry"];
export const MAX_ROWS = 10_000;

const str = (v: unknown) => {
  const s = typeof v === "string" ? v.trim() : v == null ? "" : String(v).trim();
  return s ? s.slice(0, 300) : null;
};
const num = (v: unknown) => {
  const s = str(v);
  if (s == null) return null;
  const n = Number(s.replace(/[$,]/g, ""));
  return Number.isFinite(n) ? n : null;
};
const yn = (v: unknown) => {
  const s = str(v)?.toUpperCase();
  return s === "Y" || s === "TRUE" ? true : s === "N" || s === "FALSE" ? false : null;
};
const tracking = (v: unknown) => {
  const s = str(v)?.replace(/\s+/g, "");
  return s && /^\d{10,22}$/.test(s) ? s : null;
};
// Dates arrive as "2026-11-10"; an Excel serial number is handled just in case.
const day = (v: unknown) => {
  const s = str(v);
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  if (/^\d{5}(\.\d+)?$/.test(s)) {
    const d = new Date(Date.UTC(1899, 11, 30) + Math.floor(Number(s)) * 86400000);
    return d.toISOString().slice(0, 10);
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
};

export function shipmentsFromReport(
  table: unknown,
): { ok: true; shipments: ExternalShipment[]; rows: number } | { ok: false; error: "not_shipment_report" | "too_large" } {
  if (!Array.isArray(table) || table.length < 1 || !Array.isArray(table[0])) return { ok: false, error: "not_shipment_report" };
  if (table.length > MAX_ROWS + 1) return { ok: false, error: "too_large" };
  const header = (table[0] as unknown[]).map((h) => String(h ?? "").trim());
  if (!REQUIRED.every((k) => header.includes(k))) return { ok: false, error: "not_shipment_report" };
  const col = (r: unknown[], k: string) => {
    const i = header.indexOf(k);
    return i < 0 ? undefined : r[i];
  };

  const byMaster = new Map<string, ExternalShipment>();
  let rows = 0;
  for (const raw of table.slice(1)) {
    if (!Array.isArray(raw)) continue;
    const master = tracking(col(raw, "masterTrackingNumber")) ?? tracking(col(raw, "pieceTrackingNumber"));
    if (!master) continue;
    rows++;
    const piece = tracking(col(raw, "pieceTrackingNumber"));
    const have = byMaster.get(master);
    if (have) {
      if (piece && piece !== master && !have.piece_tracking_numbers.includes(piece)) have.piece_tracking_numbers.push(piece);
      continue;
    }
    const acct = str(col(raw, "senderAccountNumber"))?.replace(/\D/g, "") ?? "";
    byMaster.set(master, {
      master_tracking_number: master,
      piece_tracking_numbers: piece && piece !== master ? [piece] : [],
      ship_date: day(col(raw, "shipDate")),
      created_date: day(col(raw, "creationDate")),
      service_type: str(col(raw, "serviceType")),
      fedex_status: str(col(raw, "status")),
      reference: str(col(raw, "reference")),
      invoice_number: str(col(raw, "invoiceNumber")),
      po_number: str(col(raw, "poNumber")),
      department: str(col(raw, "departmentNumber")),
      payment_type: str(col(raw, "paymentType")),
      account_last4: acct ? acct.slice(-4) : null,
      recipient_contact: str(col(raw, "recipientContactName")),
      recipient_company: str(col(raw, "recipientCompany")),
      recipient_street_lines: [str(col(raw, "recipientLine1")), str(col(raw, "recipientLine2"))].filter(
        (x): x is string => !!x,
      ),
      recipient_city: str(col(raw, "recipientCity")),
      recipient_state: str(col(raw, "recipientState")),
      recipient_postal_code: str(col(raw, "recipientPostcode")),
      recipient_country: str(col(raw, "recipientCountry")),
      recipient_residential: yn(col(raw, "recipientResidential")),
      packages: num(col(raw, "numberOfPackages")),
      total_weight: num(col(raw, "totalShipmentWeight")),
      weight_units: str(col(raw, "weightUnits")),
      estimated_cost: num(col(raw, "estimatedShippingCosts")),
      base_rate: num(col(raw, "baseRate")),
      etd: yn(col(raw, "etdEnabled")),
    });
  }
  // Multi-box shipments sometimes leave numberOfPackages blank: count the boxes.
  for (const s of byMaster.values()) {
    if (!s.packages) s.packages = 1 + s.piece_tracking_numbers.length;
  }
  return { ok: true, shipments: [...byMaster.values()], rows };
}
