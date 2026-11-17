import { NextResponse } from "next/server";
import { shipGate } from "@/app/shipping/_lib/gate";
import { CUSTOMS_ITEMS, splitValue, type Customs, type CustomsItemKey } from "@/app/shipping/_lib/customs";
import { SHIPPER } from "@/app/shipping/_lib/shipper";

// GET /api/shipping/labels/[id]/invoice -- a commercial invoice made by the app,
// for an international label FedEx did not return one for (FedEx sometimes
// doesn't: an Ecuador International Economy label came back without it,
// 2026-11-08). Built only from what was declared on the label -- the same
// descriptions, HS codes, quantities and values sent to FedEx -- so it matches
// the shipment's electronic data. A printable page: the browser's Print
// dialog opens on load; the on-screen note (not printed) says how many copies.
//
// /api/shipping/labels/[id]/pdf?doc=invoice sends people here when there is no
// FedEx PDF, so every "Invoice" link works for every international label.

export const runtime = "nodejs";

const esc = (s: unknown) =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
const usd = (n: number) => n.toLocaleString("en-US", { style: "currency", currency: "USD" });

type Snap = {
  company?: string | null;
  contactName?: string | null;
  phone?: string | null;
  email?: string | null;
  streetLines?: string[];
  city?: string;
  stateProvince?: string | null;
  postalCode?: string | null;
  countryCode?: string;
};
type Pkg = { weightLb?: number; weight_lb?: number };

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await shipGate();
  if (!g.ok) return NextResponse.json({ ok: false, error: g.error }, { status: 401 });
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ ok: false, error: "bad_id" }, { status: 400 });
  const { data: row } = await g.supabase
    .from("shipping_labels")
    .select("id, status, environment, international, customs, recipient_snapshot, packages, service_type, tracking_number, created_label_at, requested_at, requested_by, so_number")
    .eq("id", id)
    .maybeSingle();
  if (!row) return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  const customs = row.customs as Customs | null;
  if (!row.international || !customs) return NextResponse.json({ ok: false, error: "not_international" }, { status: 404 });

  const to = (row.recipient_snapshot ?? {}) as Snap;
  const pkgs = (Array.isArray(row.packages) ? row.packages : []) as Pkg[];
  const weight = pkgs.reduce((a, p) => a + Number(p.weightLb ?? p.weight_lb ?? 0), 0);
  const total = Math.max(0.01, Number(customs.declaredValue) || 0.01);
  const lines = customs.documentsOnly
    ? [{ description: "Business documents, no commercial value", hs: "", qty: 1 }]
    : customs.lines.map((l) => {
        const item = CUSTOMS_ITEMS[l.item as CustomsItemKey];
        return { description: item?.description ?? String(l.item), hs: item?.hs ?? "", qty: Number(l.quantity) || 1 };
      });
  const values = splitValue(total, lines.length);
  const date = new Date(row.created_label_at ?? row.requested_at).toLocaleDateString("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
  const hs = (h: string) => (h.length === 6 ? `${h.slice(0, 4)}.${h.slice(4)}` : h);
  const addr = (a: Snap) =>
    [
      a.company,
      a.contactName && a.contactName !== a.company ? `Attn: ${a.contactName}` : null,
      ...(a.streetLines ?? []),
      [a.city, a.stateProvince, a.postalCode].filter(Boolean).join(", "),
      a.countryCode,
      a.phone ? `Tel. ${a.phone}` : null,
    ]
      .filter(Boolean)
      .map(esc)
      .join("<br>");
  const shipper = addr({
    company: `${SHIPPER.company} LLC`,
    contactName: SHIPPER.contactName,
    streetLines: SHIPPER.streetLines,
    city: SHIPPER.city,
    stateProvince: SHIPPER.stateProvince,
    postalCode: SHIPPER.postalCode,
    countryCode: SHIPPER.countryCode,
    phone: "(954) 384-8728",
  });
  const eei = to.countryCode === "CA" ? "NO EEI 30.36" : "NO EEI 30.37(a)";
  const test = row.environment !== "live";

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Commercial invoice ${esc(row.tracking_number ?? "")}</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { margin: 0; background: #fff; color: #111; font: 12px/1.45 Arial, Helvetica, sans-serif; }
  .page { max-width: 8in; margin: 0 auto; padding: 0.5in 0.45in; }
  h1 { font-size: 20px; margin: 0 0 2px; letter-spacing: .5px; }
  .sub { color: #444; margin-bottom: 14px; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 0; border: 1px solid #222; }
  .cell { padding: 8px 10px; border-bottom: 1px solid #222; }
  .cell:nth-child(odd) { border-right: 1px solid #222; }
  .k { font-size: 10px; text-transform: uppercase; letter-spacing: .4px; color: #555; margin-bottom: 3px; }
  table { width: 100%; border-collapse: collapse; margin-top: 14px; }
  th, td { border: 1px solid #222; padding: 6px 7px; text-align: left; vertical-align: top; }
  th { font-size: 10px; text-transform: uppercase; letter-spacing: .4px; background: #f2f2f2; }
  td.n, th.n { text-align: right; white-space: nowrap; }
  .tot td { font-weight: bold; }
  .decl { margin-top: 16px; }
  .sig { display: grid; grid-template-columns: 2fr 1fr; gap: 24px; margin-top: 34px; }
  .line { border-top: 1px solid #222; padding-top: 4px; font-size: 10px; color: #444; }
  .test { border: 2px solid #b00; color: #b00; font-weight: bold; padding: 6px 10px; margin-bottom: 12px; text-align: center; }
  .noprint { margin: 0 auto 12px; max-width: 8in; padding: 12px 0.45in 0; font-family: Arial, sans-serif; }
  .noprint button { font: inherit; padding: 6px 14px; cursor: pointer; }
  @media print { .noprint { display: none; } .page { padding: 0; } @page { size: letter; margin: 0.5in; } }
</style></head>
<body>
<div class="noprint"><button onclick="window.print()">Print</button> Print 3 copies: 2 in the clear pouch on the box, 1 for the file.</div>
<div class="page">
  ${test ? '<div class="test">TEST LABEL — NOT A REAL SHIPMENT</div>' : ""}
  <h1>COMMERCIAL INVOICE</h1>
  <div class="sub">Samples · No commercial value · Not for sale</div>
  <div class="grid">
    <div class="cell"><div class="k">Shipper / Exporter</div>${shipper}</div>
    <div class="cell"><div class="k">Consignee</div>${addr(to)}${customs.recipientTaxId ? `<br>Tax ID: ${esc(customs.recipientTaxId)}` : ""}</div>
    <div class="cell"><div class="k">Date</div>${esc(date)}</div>
    <div class="cell"><div class="k">FedEx tracking / air waybill</div>${esc(row.tracking_number ?? "—")}</div>
    <div class="cell"><div class="k">Service</div>${esc(String(row.service_type ?? "").replace(/_/g, " "))}</div>
    <div class="cell"><div class="k">Reason for export</div>Sample${row.so_number ? ` · SO ${esc(row.so_number)}` : ""}</div>
    <div class="cell"><div class="k">Terms of sale · Duties and taxes</div>DDP — duties and taxes paid by shipper</div>
    <div class="cell"><div class="k">Packages · Total weight</div>${pkgs.length || 1} · ${weight ? `${weight} lb (${(weight * 0.4536).toFixed(2)} kg)` : "—"}</div>
    <div class="cell" style="border-bottom:0"><div class="k">Country of origin</div>United States</div>
    <div class="cell" style="border-bottom:0"><div class="k">Export statement</div>${eei}</div>
  </div>
  <table>
    <thead><tr><th>Description of goods</th><th>HS code</th><th>Origin</th><th class="n">Qty</th><th class="n">Unit value</th><th class="n">Total value</th></tr></thead>
    <tbody>
      ${lines
        .map(
          (l, i) =>
            `<tr><td>${esc(l.description)}</td><td>${esc(hs(l.hs))}</td><td>US</td><td class="n">${l.qty} PCS</td><td class="n">${usd(values[i] / l.qty)}</td><td class="n">${usd(values[i])}</td></tr>`,
        )
        .join("")}
      <tr class="tot"><td colspan="5" class="n">Total declared value (USD)</td><td class="n">${usd(total)}</td></tr>
    </tbody>
  </table>
  <p class="decl">These goods are samples of no commercial value, not for resale. The value shown is for customs purposes only.
  I declare that all the information contained in this invoice is true and correct, and that the contents of this
  shipment are as stated above. These commodities, technology or software were exported from the United States in
  accordance with the Export Administration Regulations. Diversion contrary to U.S. law is prohibited.</p>
  <div class="sig">
    <div class="line">Name and signature of shipper</div>
    <div class="line">Date</div>
  </div>
</div>
<script>window.addEventListener("load", function () { setTimeout(function () { window.print(); }, 300); });</script>
</body></html>`;

  return new Response(html, {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "private, no-store" },
  });
}
