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

// Job titles for the "Name and title" line, from PharmaCenter's staff
// directory (Directory.xlsx, "Updated 11/05/25", given by the user
// 2026-11-17). Matched by sign-in name, then by the email's local part
// (directory emails are @pharmacenter.health; sign-ins @pharmacenterusa.com --
// same local parts). Anyone not listed signs as "PharmaCenter LLC".
const STAFF: Array<{ name: string; title: string; emails: string[] }> = [
  { name: "Andrea Acurero", title: "Operations Manager", emails: ["andrea"] },
  { name: "Andreina Nunez", title: "Secondary Packaging Leader", emails: ["andreina"] },
  { name: "Dionel Davila", title: "Maintenance Technician", emails: ["dionel"] },
  { name: "Elvira Odoardi", title: "Quality Associate", emails: ["elvira"] },
  { name: "Glendy Acosta", title: "Office Admin / Controller", emails: ["glendy"] },
  { name: "Jairo Osorno", title: "President", emails: ["jairo", "josorno"] },
  { name: "Jay Salerno", title: "Warehouse Manager", emails: ["warehouse", "jay"] },
  { name: "Jessica Medri", title: "Sales Department Manager", emails: ["jessica", "jessicam"] },
  { name: "Leonardo Lacruz", title: "Manufacturing Team Member", emails: ["leonardo"] },
  { name: "Luisa Sosa", title: "Warehouse Assistant", emails: ["luisa"] },
  { name: "Maria Williams", title: "Quality Control Floor Inspector", emails: ["maria"] },
  { name: "Mario Medri", title: "Managing Member / CTO", emails: ["mmedri", "mario"] },
  { name: "Melissa Medri", title: "HR Manager / Sales Rep", emails: ["melissa", "melissam", "hr"] },
  { name: "Rosie Gutierrez", title: "Purchasing/Logistics Coordinator", emails: ["rosie"] },
  { name: "Sebastian Garcia", title: "Manufacturing Coordinator", emails: ["sebastian"] },
  { name: "Wilmer Torres", title: "Quality Assurance Manager", emails: ["wilmer"] },
];
const norm = (x: string) => x.normalize("NFD").replace(/[^a-z]/gi, "").toLowerCase();
function staffFor(name: string | null, email: string) {
  const local = email.toLowerCase().replace(/@.*/, "");
  return (
    (name ? STAFF.find((p) => norm(p.name) === norm(name)) : undefined) ??
    STAFF.find((p) => p.emails.includes(local))
  );
}

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
type Pkg = { weightLb?: number; weight_lb?: number; lengthIn?: number; widthIn?: number; heightIn?: number; length_in?: number; width_in?: number; height_in?: number };

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await shipGate();
  if (!g.ok) return NextResponse.json({ ok: false, error: g.error }, { status: 401 });
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ ok: false, error: "bad_id" }, { status: 400 });
  const { data: row } = await g.supabase
    .from("shipping_labels")
    .select("id, status, environment, international, customs, recipient_snapshot, packages, service_type, tracking_number, created_label_at, requested_at, requested_by, so_number, purpose, purpose_note, contents")
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
        // The person's own words for the item (e.g. "250cc PET bottle, yellow,
        // 45/400 neck") when given; the house wording otherwise.
        const note = (l.note ?? "").trim();
        return {
          description: note ? `${note}${/sample/i.test(note) ? "" : ". Sample."}` : item?.description ?? String(l.item),
          hs: item?.hs ?? "",
          qty: Number(l.quantity) || 1,
        };
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
      a.email ? `Email: ${a.email}` : null,
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
  const dims = pkgs
    .map((p) => [p.lengthIn ?? p.length_in, p.widthIn ?? p.width_in, p.heightIn ?? p.height_in])
    .filter((d) => d.every((x) => Number(x) > 0))
    .map((d) => d.join(" × ") + " in");
  const stamp = new Date(row.created_label_at ?? row.requested_at)
    .toLocaleDateString("en-CA", { timeZone: "America/New_York" })
    .replace(/-/g, "");
  const nameTag = String(to.company || to.contactName || "SHIP")
    .normalize("NFD")
    .replace(/[^A-Za-z0-9]+/g, " ")
    .trim()
    .split(" ")[0]
    .toUpperCase()
    .slice(0, 10);
  const invoiceNo = `CI-${stamp}-${nameTag}`;
  // Signed by the person printing it -- they are the one attesting to the
  // declaration. A typed signature ("/s/ Name"), the usual electronic form;
  // there is no handwritten signature image on file. Title from the signer
  // list below, else the company.
  const staff = staffFor(g.name, g.email);
  const signer =
    staff?.name || g.name?.trim() || g.email.replace(/@.*/, "").replace(/[._]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  const title = staff?.title ?? "PharmaCenter LLC";
  const signedOn = new Date().toLocaleDateString("en-US", { timeZone: "America/New_York", year: "numeric", month: "long", day: "numeric" });
  const reference = [row.so_number ? `SO ${row.so_number}` : null, row.purpose_note || null].filter(Boolean).join(" · ");
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
  .sig { display: grid; grid-template-columns: 2fr 2fr 1fr; gap: 24px; margin-top: 34px; }
  .line { border-top: 1px solid #222; padding-top: 4px; font-size: 10px; color: #444; }
  .val { min-height: 18px; padding: 0 2px 3px; font-size: 13px; }
  .sigval { font-family: "Brush Script MT", "Segoe Script", cursive; font-size: 18px; }
  .test { border: 2px solid #b00; color: #b00; font-weight: bold; padding: 6px 10px; margin-bottom: 12px; text-align: center; }
  .noprint { margin: 0 auto 12px; max-width: 8in; padding: 12px 0.45in 0; font-family: Arial, sans-serif; }
  .noprint button { font: inherit; padding: 6px 14px; cursor: pointer; }
  @media print { .noprint { display: none; } .page { padding: 0; } @page { size: letter; margin: 0.5in; } }
</style></head>
<body>
<div class="noprint"><button onclick="window.print()">Print</button> Print 4: 3 go in the clear FedEx pouch behind the label pages (1 original + 2 copies), 1 stays on file. Nothing goes inside the sealed box.</div>
<div class="page">
  ${test ? '<div class="test">TEST LABEL — NOT A REAL SHIPMENT</div>' : ""}
  <h1>COMMERCIAL INVOICE</h1>
  <div class="sub">Samples, no commercial value. ${row.contents ? `${esc(row.contents)}. ` : ""}Not for resale.</div>
  <div class="grid">
    <div class="cell"><div class="k">Shipper / Exporter</div>${shipper}</div>
    <div class="cell"><div class="k">Consignee</div>${addr(to)}${customs.recipientTaxId ? `<br>Tax ID: ${esc(customs.recipientTaxId)}` : ""}</div>
    <div class="cell"><div class="k">Date</div>${esc(date)}</div>
    <div class="cell"><div class="k">Air waybill / FedEx tracking no.</div>${esc(row.tracking_number ?? "—")}</div>
    <div class="cell"><div class="k">Invoice no.</div>${esc(invoiceNo)}</div>
    <div class="cell"><div class="k">Carrier / service</div>FedEx ${esc(String(row.service_type ?? "").replace(/^FEDEX_/, "").replace(/_/g, " ").toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase()))}</div>
    <div class="cell"><div class="k">Reference</div>${reference ? esc(reference) : "—"}</div>
    <div class="cell"><div class="k">Reason for export</div>Samples</div>
    <div class="cell"><div class="k">Packages · Dimensions</div>${pkgs.length || 1} box${(pkgs.length || 1) > 1 ? "es" : ""}${dims.length ? ` · ${esc(dims.join("; "))}` : ""}</div>
    <div class="cell"><div class="k">Total gross weight</div>${weight ? `${weight.toFixed(2)} lb (${(weight * 0.4536).toFixed(2)} kg)` : "—"}</div>
    <div class="cell"><div class="k">Duties and taxes · Transportation</div>Billed to shipper (PharmaCenter) · Billed to shipper (PharmaCenter)</div>
    <div class="cell"><div class="k">Terms of sale · Currency</div>DDP · USD</div>
    <div class="cell" style="border-bottom:0"><div class="k">Country of origin</div>United States</div>
    <div class="cell" style="border-bottom:0"><div class="k">Export statement</div>${eei}</div>
  </div>
  <table>
    <thead><tr><th>Description of goods</th><th>HS code</th><th>Origin</th><th class="n">Qty</th><th class="n">Unit value</th><th class="n">Total value</th></tr></thead>
    <tbody>
      ${lines
        .map(
          (l, i) =>
            `<tr><td>${esc(l.description)}</td><td>${esc(hs(l.hs))}</td><td>US</td><td class="n">${l.qty} ${l.qty === 1 ? "pc" : "pcs"}</td><td class="n">${usd(values[i] / l.qty)}</td><td class="n">${usd(values[i])}</td></tr>`,
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
    <div><div class="val sigval">/s/ ${esc(signer)}</div><div class="line">Signature</div></div>
    <div><div class="val">${esc(signer)}, ${esc(title)}</div><div class="line">Name and title</div></div>
    <div><div class="val">${esc(signedOn)}</div><div class="line">Date</div></div>
  </div>
</div>
<script>window.addEventListener("load", function () { setTimeout(function () { window.print(); }, 300); });</script>
</body></html>`;

  return new Response(html, {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "private, no-store" },
  });
}
