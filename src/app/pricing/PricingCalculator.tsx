"use client";

// Nudge build: force Vercel to redeploy the latest signature-trim change.
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { supabase } from "@/lib/supabase";
import type { PricingSnapshot, WorkflowState } from "@/lib/workflows";

// Pricing calculator client component. All math is dollar-and-percent simple
// arithmetic, derived from input strings live as the user types. Inputs are
// kept as strings (with comma formatting for dollars) so we can render
// exactly what the user typed and re-parse to numbers per render.

type Mode = "markup" | "gross-margin";
type VendorMode = "existing" | "new";
// Shipping origin — affects whether duties apply. "usa" treats the duties
// percentage as zero and hides the input; "international" exposes it. The
// product cost stays whatever the user types regardless of origin.
type ShippingOrigin = "usa" | "international";

// Incoterms 2020 for international shipments. Each term flips which cost
// inputs the buyer is responsible for. The matrix below (INCOTERM_FIELDS)
// is the source of truth — change there to update the visible inputs.
type Incoterm = "EXW" | "FOB" | "CFR" | "CIF" | "DAP" | "DDP";

const INCOTERM_LABELS: Record<Incoterm, string> = {
  EXW: "EXW — Ex Works",
  FOB: "FOB — Free On Board",
  CFR: "CFR — Cost & Freight",
  CIF: "CIF — Cost, Insurance & Freight",
  DAP: "DAP — Delivered at Place",
  DDP: "DDP — Delivered Duty Paid",
};

const INCOTERM_DESCRIPTIONS: Record<Incoterm, string> = {
  EXW: "You pay everything from the supplier's door — international freight, insurance, duties, and customs clearance.",
  FOB: "Supplier delivers to the ship at the origin port. You pay international freight, insurance, duties, and customs clearance.",
  CFR: "Supplier pays freight to the destination port. You pay insurance, duties, and customs clearance.",
  CIF: "Supplier pays freight + insurance to the destination port. You pay duties and customs clearance.",
  DAP: "Supplier delivers to the place you name. You pay duties and customs clearance.",
  DDP: "Supplier handles everything including duties. Your only extras are lab testing and any other miscellaneous fees.",
};

// Which buyer-side cost fields show up for each Incoterm. Lab testing and
// "other fees" are always shown (constants across all terms).
const INCOTERM_FIELDS: Record<
  Incoterm,
  { freight: boolean; insurance: boolean; duties: boolean; customs: boolean }
> = {
  EXW: { freight: true, insurance: true, duties: true, customs: true },
  FOB: { freight: true, insurance: true, duties: true, customs: true },
  CFR: { freight: false, insurance: true, duties: true, customs: true },
  CIF: { freight: false, insurance: false, duties: true, customs: true },
  DAP: { freight: false, insurance: false, duties: true, customs: true },
  DDP: { freight: false, insurance: false, duties: false, customs: false },
};

// Per-workflow-product dropdown option passed in from the server.
export type WorkflowProductOption = {
  uid: string;
  label: string;
  sub: string | null;
  // Pre-fill value for the calculator's quantity input when the user picks
  // this product. Already formatted with commas if applicable.
  quantity: string | null;
  // "stock" products skip the inbound-cost section because the landed cost
  // is already known in Fishbowl. Optional for back-compat — older workflow
  // products without the field behave like "purchase".
  sourceMode?: "purchase" | "stock";
};

// Row shape we get back from the vendors table search. Mirrors the columns
// declared by the vendors schema migration.
type VendorRow = {
  id: string;
  name: string;
};

const VENDOR_SEARCH_LIMIT = 12;

// ---------- input formatters ----------

function formatValueInput(raw: string): string {
  const cleaned = raw.replace(/[^\d.]/g, "");
  const firstDot = cleaned.indexOf(".");
  const safe =
    firstDot === -1
      ? cleaned
      : cleaned.slice(0, firstDot + 1) + cleaned.slice(firstDot + 1).replace(/\./g, "");
  const [intPart, decPart] = safe.split(".");
  const withCommas = (intPart || "").replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  if (decPart === undefined) return withCommas;
  return `${withCommas}.${decPart.slice(0, 2)}`;
}

function formatPercentInput(raw: string): string {
  const cleaned = raw.replace(/[^\d.]/g, "");
  const firstDot = cleaned.indexOf(".");
  const safe =
    firstDot === -1
      ? cleaned
      : cleaned.slice(0, firstDot + 1) + cleaned.slice(firstDot + 1).replace(/\./g, "");
  const [intPart, decPart] = safe.split(".");
  if (decPart === undefined) return intPart;
  return `${intPart}.${decPart.slice(0, 4)}`;
}

function formatQtyInput(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function num(formatted: string): number {
  const cleaned = formatted.replace(/,/g, "");
  if (cleaned.trim() === "") return 0;
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : 0;
}

const usd = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

// Kept as a separate formatter in case we ever want sub-cent precision back,
// but for now every price/cost display uses 2 decimal places — the per-unit
// values were too noisy when shown to 4 decimals.
const usdFine = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const pct = new Intl.NumberFormat("en-US", {
  style: "percent",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

// Escape a value for safe interpolation into the issued-quote HTML. We're
// building the doc as a raw string before window.open()ing it, so any
// customer/vendor/product field could otherwise inject markup.
function htmlEscape(s: string | number | null | undefined): string {
  if (s === null || s === undefined) return "";
  const str = String(s);
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Tiny "just now / 2m ago" helper used in the save-status text. Lives here
// to avoid pulling in a full date library for one label.
function relativeFromNow(iso: string): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "";
  const diffSec = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (diffSec < 30) return "just now";
  if (diffSec < 60) return `${diffSec}s ago`;
  const min = Math.floor(diffSec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}

// ----------------------------------------------------------------------
// Customer-facing quote PDF builder.
// Spits out a complete self-contained HTML document we can window.open()
// and then trigger window.print() on. Styled with PharmaCenter brand
// tokens lifted from the Packing List generator so the two documents
// feel like a matched set.
//
// `lineItems` is whatever the calculator's tabs computed to — one row per
// tab. The `notes` and `terms` blocks are baked in (from the Excel quote
// template the team currently uses).
// ----------------------------------------------------------------------
type QuoteLineItem = {
  itemRef: string;       // e.g. "ITEM 1"
  description: string;
  quantity: number;
  unitPrice: number;
};

function buildQuoteHtml(args: {
  customerName: string | null;
  customerAddress: string | null;       // multi-line ok
  customerContact: string | null;       // e.g. for new customers
  customerEmail: string | null;
  workflowLabel: string | null;         // doubles as the QUOTE #
  preparerName: string;
  preparerEmail: string;
  lineItems: QuoteLineItem[];
}): string {
  const today = new Date();
  const validUntil = new Date(today);
  validUntil.setDate(validUntil.getDate() + 15);
  const fmtDate = (d: Date) =>
    d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
  const fmtMoney = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

  const total = args.lineItems.reduce(
    (sum, li) => sum + li.unitPrice * li.quantity,
    0,
  );

  const itemRowsHtml = args.lineItems
    .map((li, idx) => `
      <tr data-row>
        <td class="q-items__item" contenteditable="true">${htmlEscape(li.itemRef || `ITEM ${idx + 1}`)}</td>
        <td class="q-items__desc" contenteditable="true">${htmlEscape(li.description)}</td>
        <td class="q-items__qty" contenteditable="true" data-qty>${li.quantity.toLocaleString("en-US")}</td>
        <td class="q-items__price" contenteditable="true" data-price>${htmlEscape(fmtMoney.format(li.unitPrice))}</td>
        <td class="q-items__amount" data-amount>${htmlEscape(fmtMoney.format(li.unitPrice * li.quantity))}</td>
      </tr>
    `).join("");

  // No padding rows — the table sits tight against the real line items so
  // a one-item quote doesn't look like it has half a page of empty rows.

  const preparedForLines: string[] = [];
  if (args.customerName) preparedForLines.push(args.customerName);
  if (args.customerAddress) {
    for (const line of args.customerAddress.split(/\r?\n/)) {
      const t = line.trim();
      if (t) preparedForLines.push(t);
    }
  }
  if (args.customerContact && !preparedForLines.includes(args.customerContact)) {
    preparedForLines.push(args.customerContact);
  }
  if (args.customerEmail && !preparedForLines.includes(args.customerEmail)) {
    preparedForLines.push(args.customerEmail);
  }
  const preparedForHtml = preparedForLines
    .map((l, i) => `<div class="q-prep__line${i === 0 ? " q-prep__line--strong" : ""}" contenteditable="true">${htmlEscape(l)}</div>`)
    .join("");

  const quoteNumber = args.workflowLabel ?? "—";
  const preparedBy = args.preparerName?.trim() || args.preparerEmail || "Sales";

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Quote ${htmlEscape(quoteNumber)} · ${htmlEscape(args.customerName ?? "PharmaCenter")}</title>
<style>
  /* PharmaCenter brand tokens — lifted from the Packing List stylesheet so
     this quote sits next to it as a matched pair. */
  :root {
    --teal-900:#0f4a56;
    --teal-700:#1d6c7b;
    --teal-500:#3a8d9c;
    --sage-700:#5f8e3a;
    --sage-500:#7fb04f;
    --cream:#f6efe3;
    --cream-soft:#fbf6ec;
    --paper:#fffdf8;
    --ink:#1f2a2d;
    --ink-2:#415056;
    --ink-3:#8a9498;
    --line:#e3dcc9;
    --line-2:#efe9da;
    --bg:#e7ddc8;
    --sans:"Nunito", -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, Arial, sans-serif;
    --serif:"Cormorant Garamond", Georgia, serif;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    background: var(--bg);
    color: var(--ink);
    font-family: var(--sans);
    font-size: 10.5pt;
    line-height: 1.45;
    -webkit-font-smoothing: antialiased;
    font-feature-settings: "tnum" 1;
  }
  .q-stage {
    display: flex; justify-content: center; padding: 26px 0 60px;
  }
  .q-sheet {
    width: 8.5in;
    min-height: 11in;
    background: var(--paper);
    padding: 0.62in;
    display: flex; flex-direction: column;
    box-shadow: 0 1px 0 rgba(15,74,86,.04), 0 18px 44px -22px rgba(15,74,86,.32);
  }

  /* Letterhead ----------------------------------------------------- */
  .q-lh {
    display: flex; align-items: flex-start; justify-content: space-between;
    gap: 24px; padding-bottom: 14px;
    border-bottom: 2.5px solid var(--teal-700);
  }
  .q-lh__brand {
    display: flex; flex-direction: column; gap: 4px;
  }
  .q-lh__co {
    font-family: var(--serif);
    font-size: 30px; font-weight: 500; line-height: 1;
    color: var(--teal-900); letter-spacing: -0.01em;
  }
  .q-lh__tag {
    font-size: 9px; font-weight: 700; letter-spacing: 0.18em;
    text-transform: uppercase; color: var(--sage-700);
  }
  .q-lh__info {
    text-align: right; font-size: 8.8px; line-height: 1.62; color: var(--ink-2);
  }
  .q-lh__addr-label {
    font-size: 9.6px; font-weight: 700; color: var(--teal-900);
  }
  .q-lh__addr {
    margin-top: 5px; color: var(--teal-700); font-weight: 700; font-size: 9.4px;
    white-space: pre-line;
  }

  /* Title band ---------------------------------------------------- */
  .q-title {
    display: flex; align-items: flex-end; justify-content: space-between;
    padding-top: 16px; margin-bottom: 6px;
  }
  .q-title h1 {
    margin: 0;
    font-family: var(--serif);
    font-size: 56px; font-weight: 500; letter-spacing: -0.005em;
    color: var(--teal-900); line-height: 0.9;
  }
  .q-title__meta {
    display: grid;
    grid-template-columns: auto auto;
    gap: 6px 14px;
    text-align: right;
    font-size: 9px;
  }
  .q-title__meta dt {
    font-weight: 700; letter-spacing: 0.16em; text-transform: uppercase;
    color: var(--ink-3);
  }
  .q-title__meta dd {
    margin: 0; font-weight: 600; color: var(--ink); font-size: 11px;
  }

  /* Prepared For block ------------------------------------------- */
  .q-prep {
    margin-top: 22px; display: flex; gap: 32px;
  }
  .q-prep__col {
    flex: 1;
  }
  .q-prep__heading {
    font-size: 8.5px; font-weight: 700; letter-spacing: 0.18em;
    text-transform: uppercase; color: var(--ink-3);
    border-bottom: 1px solid var(--line); padding-bottom: 4px; margin-bottom: 8px;
  }
  .q-prep__line { font-size: 11px; color: var(--ink-2); line-height: 1.45; }
  .q-prep__line--strong { font-weight: 700; color: var(--teal-900); font-size: 12.5px; }

  /* Items table -------------------------------------------------- */
  .q-items {
    margin-top: 22px;
    border-collapse: collapse;
    width: 100%;
  }
  .q-items thead th {
    background: var(--cream);
    color: var(--teal-900);
    font-size: 8.5px; font-weight: 700; letter-spacing: 0.14em;
    text-transform: uppercase;
    text-align: left;
    padding: 8px 10px;
    border-bottom: 1.5px solid var(--teal-700);
  }
  .q-items th.q-items__qty,
  .q-items th.q-items__price,
  .q-items th.q-items__amount { text-align: right; }
  .q-items td {
    padding: 10px;
    font-size: 10.5px;
    border-bottom: 1px solid var(--line-2);
    vertical-align: top;
  }
  .q-items__item { width: 80px; font-weight: 700; color: var(--teal-700); font-size: 9.5px; letter-spacing: 0.06em; text-transform: uppercase; }
  .q-items__desc { color: var(--ink); }
  .q-items__qty { width: 80px; text-align: right; font-variant-numeric: tabular-nums; }
  .q-items__price { width: 110px; text-align: right; font-variant-numeric: tabular-nums; }
  .q-items__amount { width: 130px; text-align: right; font-variant-numeric: tabular-nums; font-weight: 600; }

  .q-totals {
    display: flex; justify-content: flex-end; align-items: center;
    gap: 14px;
    margin-top: 14px;
  }
  .q-totals__inner {
    min-width: 280px; display: grid; grid-template-columns: auto auto;
    gap: 6px 18px; align-items: center;
  }
  .q-totals dt { font-size: 9px; font-weight: 700; letter-spacing: 0.14em; text-transform: uppercase; color: var(--ink-3); text-align: right; }
  .q-totals dd { margin: 0; font-size: 14px; font-weight: 700; color: var(--teal-900); text-align: right; font-variant-numeric: tabular-nums; }
  .q-totals .q-totals__grand dd { font-size: 17px; }

  /* Notes block --------------------------------------------------- */
  .q-notes {
    margin-top: 18px; padding: 12px 14px;
    background: var(--cream-soft); border: 1px solid var(--line);
    border-radius: 8px;
  }
  .q-notes__heading {
    font-size: 8.5px; font-weight: 700; letter-spacing: 0.18em; text-transform: uppercase;
    color: var(--ink-3); margin-bottom: 6px;
  }
  .q-notes ul { margin: 0; padding-left: 18px; font-size: 10px; color: var(--ink-2); }
  .q-notes li { margin: 2px 0; }

  /* Preparer line ------------------------------------------------- */
  .q-prepared-by {
    margin-top: 18px;
    font-size: 10px; color: var(--ink-2);
  }
  .q-prepared-by strong { color: var(--teal-900); }

  /* Terms --------------------------------------------------------- */
  .q-terms {
    margin-top: 22px; padding-top: 14px;
    border-top: 1px solid var(--line);
    page-break-before: always;
  }
  .q-terms__title {
    font-size: 10px; font-weight: 800; letter-spacing: 0.14em; text-transform: uppercase;
    color: var(--teal-900); margin-bottom: 10px;
  }
  .q-terms p { margin: 6px 0; font-size: 9.5px; line-height: 1.55; color: var(--ink-2); }
  .q-terms strong { color: var(--teal-900); }

  /* Signature block --------------------------------------------- */
  .q-sign {
    margin-top: 26px; padding-top: 18px;
    border-top: 2px solid var(--teal-700);
  }
  .q-sign__heading {
    font-size: 10px; font-weight: 800; letter-spacing: 0.14em; text-transform: uppercase;
    color: var(--teal-900); margin-bottom: 18px;
  }
  .q-sign__grid {
    display: grid; grid-template-columns: 1.4fr 1.6fr 1fr;
    gap: 22px;
  }
  .q-sign__cell { display: flex; flex-direction: column; }
  .q-sign__line {
    border-bottom: 1.2px solid var(--ink); height: 26px;
  }
  .q-sign__caption {
    margin-top: 4px;
    font-size: 8.5px; font-weight: 700; letter-spacing: 0.16em; text-transform: uppercase;
    color: var(--ink-3);
  }

  /* Editable affordance --------------------------------------- */
  /* Subtle hover/focus halo so users know the fields are editable
     without it looking like a form on the printed PDF. */
  [contenteditable="true"] { outline: none; transition: background-color 0.15s; }
  [contenteditable="true"]:hover {
    background: rgba(29, 108, 123, 0.05);
    box-shadow: 0 0 0 2px rgba(29, 108, 123, 0.12);
    border-radius: 3px;
  }
  [contenteditable="true"]:focus {
    background: rgba(29, 108, 123, 0.08);
    box-shadow: 0 0 0 2px rgba(29, 108, 123, 0.35);
    border-radius: 3px;
  }

  /* Floating toolbar --------------------------------------- */
  .q-toolbar {
    position: fixed; top: 16px; right: 16px; z-index: 100;
    display: flex; gap: 8px; align-items: center;
    padding: 8px 12px;
    background: #fff;
    border: 1px solid var(--line);
    border-radius: 10px;
    box-shadow: 0 4px 16px rgba(15, 74, 86, 0.18);
  }
  .q-toolbar__hint {
    font-size: 11px; color: var(--ink-3); margin-right: 4px;
  }
  .q-toolbar__btn {
    background: var(--teal-700); color: #fff;
    border: 1px solid var(--teal-900);
    padding: 7px 14px;
    border-radius: 7px;
    font-size: 13px; font-weight: 600; cursor: pointer;
    font-family: inherit;
  }
  .q-toolbar__btn:hover { background: var(--teal-900); }
  /* Show-total checkbox lives next to the Total row, on its left. The
     print-hide rule on .q-totals__toggle below removes it from the printed
     PDF. When the checkbox is unchecked the inner dl gets
     .q-totals--hidden, which collapses the number but leaves the toggle
     visible so the editor can flip it back. */
  .q-totals__toggle {
    display: inline-flex; align-items: center; gap: 6px;
    font-size: 11px; color: var(--ink-3);
    background: var(--cream-soft); border: 1px dashed var(--line);
    border-radius: 6px; padding: 4px 8px; cursor: pointer;
    user-select: none;
  }
  .q-totals__toggle input { margin: 0; cursor: pointer; }
  .q-totals--hidden { visibility: hidden; }

  /* Print ---------------------------------------------------- */
  @page { margin: 0.4in; size: letter; }
  @media print {
    body { background: #fff !important; }
    .q-stage { padding: 0 !important; }
    .q-sheet { box-shadow: none !important; }
    /* Hide editing chrome on the printed copy. */
    .q-toolbar { display: none !important; }
    .q-totals__toggle { display: none !important; }
    [contenteditable="true"]:hover,
    [contenteditable="true"]:focus {
      background: transparent !important;
      box-shadow: none !important;
    }
  }
</style>
</head>
<body>
  <div class="q-toolbar" aria-hidden="true">
    <span class="q-toolbar__hint">Editable — click any field to change.</span>
    <button type="button" class="q-toolbar__btn" id="q-print-btn">Save / Print PDF</button>
  </div>
  <div class="q-stage">
    <div class="q-sheet">

      <header class="q-lh">
        <div class="q-lh__brand">
          <div class="q-lh__co">PharmaCenter</div>
          <div class="q-lh__tag">Bulk Quote</div>
        </div>
        <div class="q-lh__info">
          <div class="q-lh__addr-label">PharmaCenter, LLC</div>
          <div class="q-lh__addr">15851 SW 41st Street, Suite #300
Davie, FL 33331
(954) 384-8728</div>
        </div>
      </header>

      <section class="q-title">
        <h1>Quote</h1>
        <dl class="q-title__meta">
          <dt>Prepared Date</dt><dd contenteditable="true">${htmlEscape(fmtDate(today))}</dd>
          <dt>Valid Until</dt><dd contenteditable="true">${htmlEscape(fmtDate(validUntil))}</dd>
          <dt>Quote&nbsp;#</dt><dd contenteditable="true">${htmlEscape(quoteNumber)}</dd>
        </dl>
      </section>

      <section class="q-prep">
        <div class="q-prep__col">
          <div class="q-prep__heading">Prepared For</div>
          ${preparedForHtml || '<div class="q-prep__line" contenteditable="true">—</div>'}
        </div>
      </section>

      <table class="q-items">
        <thead>
          <tr>
            <th class="q-items__item">Items</th>
            <th class="q-items__desc">Description</th>
            <th class="q-items__qty">Quantity</th>
            <th class="q-items__price">Price</th>
            <th class="q-items__amount">Amount</th>
          </tr>
        </thead>
        <tbody>
          ${itemRowsHtml}
        </tbody>
      </table>

      <div class="q-totals" id="q-totals-block">
        <label class="q-totals__toggle" aria-hidden="true">
          <input type="checkbox" id="q-show-total" checked />
          <span>Show total</span>
        </label>
        <dl class="q-totals__inner q-totals__grand" id="q-totals-dl">
          <dt>Total</dt>
          <dd data-total>${htmlEscape(fmtMoney.format(total))}</dd>
        </dl>
      </div>

      <div class="q-notes">
        <div class="q-notes__heading">Notes</div>
        <ul contenteditable="true">
          <li>All pricing is ex-works PharmaCenter LLC (Davie, FL).</li>
          <li>Pallet fee of $15.00 will be applied per pallet unless replacements in good condition are provided.</li>
        </ul>
      </div>

      <p class="q-prepared-by" contenteditable="true">
        This quote was prepared by <strong>${htmlEscape(preparedBy)}</strong>.
        If you have any questions concerning this quotation, contact ${htmlEscape(preparedBy)} at (954) 384-8728 or ${htmlEscape(args.preparerEmail || "sales@pharmacenterusa.com")}.
      </p>

      <section class="q-terms">
        <div class="q-terms__title">This quotation is subject to the following terms and conditions:</div>
        <p>The ability of PharmaCenter, LLC to manufacture or package product(s) will depend upon the combination of ingredients, bulk product and/or packaging components and their behaviours on production equipment. This will be determined on the equipment during the manufacturing of your order. Additionally, if non-stock ingredients and/or packaging components are included, additional testing and verification may be needed, and manufacturing/packaging restrictions may be encountered.</p>

        <p><strong>APPROVAL:</strong> To approve an order for the proceeding quoted product(s)/service(s), please sign, and return the quote with purchase order. Digital signatures from authorized personnel shall be considered adequate for approval. For additional order information please contact your account manager.</p>

        <p><strong>ACKNOWLEDGMENT:</strong> The information and Product(s)/service(s) herein are to the best of PharmaCenter, LLC's knowledge, true, and accurate. PharmaCenter, LLC warrants that it will manufacture/package products, or cause to have manufactured/packaged the Product(s) in conformity with all the information, formulas and specifications set forth herein. Provided the Product(s) were handled with reasonable care after leaving PharmaCenter LLC's possession, and within no later than fifteen (15) business days after arrival of products at customer's location, a written notice to PharmaCenter, LLC should be given of any defect or failure to conform with the herein specifications. PharmaCenter LLC at its option agrees to provide a credit in the amount of the purchase price of the non-confirming products, or to replace such products. PharmaCenter LLC shall not be responsible for any delay in the performance or orders or in the delivery of the products, or for any loss or damages arising from such delay, if such delay is directly or indirectly caused by, or arises from events beyond our control, including but not limited to strikes or other labor difficulties, fire, flood, accidents, riots, electrical or other power failure or shortage, delays or defaults of carriers or customs, failure or curtailment in PharmaCenter LLC's usual sources of supply or government orders. No warranty is given or is to be implied in respect of any recommendations or suggestions which may be made or that any use will not infringe any intellectual property. Customer acknowledges that this order may contain proprietary ingredients, which are subject to specifications, guidelines, and protection under the law. Customer represents and agrees to follow all guidelines and specifications for any proprietary product(s). Due to manufacturing of customer Product(s), Customers may be subject to an industry standard 10% overage of the quantity ordered, a percentage that will be reflected on the Customer's Invoice.</p>

        <p><strong>FINANCIAL TERMS:</strong> Please contact your account manager or PharmaCenter, LLC's finance department for payment terms beyond those represented herein by this final quote.</p>

        <p><strong>PURCHASE ORDER STATEMENTS:</strong> PharmaCenter, LLC will not accept any order accompanied by any purchase terms and conditions statements without prior authorization by an officer of PharmaCenter, LLC.</p>

        <p><strong>CONFIDENTIALITY:</strong> This document and the information within this document, including the product formula, is confidential information. Nothing contained herein may be disclosed to any third party without PharmaCenter LLC's prior approval. DO NOT use this document or the information contained within this document to obtain a competitive quote(s).</p>

        <p><strong>PRODUCT SAFETY:</strong> Persons taking prescription or OTC medications should consult with a healthcare professional prior to taking any dietary supplements.</p>

        <p><strong>SHIPMENT:</strong> Lead times are contingent upon receipt and lab release of all materials and packaging components at time of order. To ensure your inventory is not disrupted by the newly mandated, additional testing requirements of the FDA, we strongly encourage you to incorporate a few extra weeks into your inventory level review to minimize the impact new ingredient testing requirements may have throughout the supply chain. PharmaCenter is not responsible for any loss or damaged items that may occur during delivery or shipping of goods to the customer's location.</p>

        <p><strong>SHELF LIFE:</strong> Suggested Expiration Date from Date of Manufacture *3 year* Initial shelf-life estimate based on ingredients and similar product data which has been collected from properly-stored materials. Each unique combination of ingredients, packaging, and storage conditions present uncertainty to the shelf-life estimate. This is only an estimation of shelf life, packaging, and storage quality, and not a real-time analysis. Customers are highly encouraged to independently verify the stability performance of their product. Since PharmaCenter, LLC has no control over individual storage practices, we must disclaim any liability or warranty for particular results.</p>
      </section>

      <section class="q-sign">
        <div class="q-sign__heading">Agreed and Accepted</div>
        <div class="q-sign__grid">
          <div class="q-sign__cell">
            <div class="q-sign__line"></div>
            <div class="q-sign__caption">Name</div>
          </div>
          <div class="q-sign__cell">
            <div class="q-sign__line"></div>
            <div class="q-sign__caption">Signature</div>
          </div>
          <div class="q-sign__cell">
            <div class="q-sign__line"></div>
            <div class="q-sign__caption">Date</div>
          </div>
        </div>
      </section>

    </div>
  </div>
  <script>
    // Quote editor — runs after the document loads. Lets the user tweak
    // any contenteditable field, auto-recomputes line-item Amount and the
    // Total when Qty or Price are edited, and wires the "Save / Print PDF"
    // button to window.print() (where the user picks "Save as PDF").
    (function () {
      var money = new Intl.NumberFormat("en-US", {
        style: "currency", currency: "USD",
        minimumFractionDigits: 2, maximumFractionDigits: 2,
      });

      // Parse a user-typed cell value as a number. Strip currency symbols,
      // commas, whitespace; allow a leading minus. Returns 0 on garbage so
      // a typo doesn't blow up the total.
      function parseNum(s) {
        if (s == null) return 0;
        var cleaned = String(s).replace(/[^0-9.\\-]/g, "");
        if (cleaned === "" || cleaned === "-" || cleaned === ".") return 0;
        var n = parseFloat(cleaned);
        return isFinite(n) ? n : 0;
      }

      function recompute() {
        var rows = document.querySelectorAll("[data-row]");
        var total = 0;
        rows.forEach(function (row) {
          var qtyCell = row.querySelector("[data-qty]");
          var priceCell = row.querySelector("[data-price]");
          var amtCell = row.querySelector("[data-amount]");
          if (!qtyCell || !priceCell || !amtCell) return;
          var qty = parseNum(qtyCell.textContent);
          var price = parseNum(priceCell.textContent);
          var amt = qty * price;
          amtCell.textContent = money.format(amt);
          total += amt;
        });
        var totalCell = document.querySelector("[data-total]");
        if (totalCell) totalCell.textContent = money.format(total);
      }

      // Reformat the cell when the user finishes editing so the qty/price
      // visually snaps back to canonical form (1,000 / $22.14) even if
      // they typed "1000" or "22.1".
      function reformatCell(cell, mode) {
        var n = parseNum(cell.textContent);
        if (mode === "qty") {
          cell.textContent = n.toLocaleString("en-US");
        } else if (mode === "price") {
          cell.textContent = money.format(n);
        }
      }

      // Wire input + blur events on every Qty / Price cell.
      document.querySelectorAll("[data-qty]").forEach(function (el) {
        el.addEventListener("input", recompute);
        el.addEventListener("blur", function () { reformatCell(el, "qty"); recompute(); });
      });
      document.querySelectorAll("[data-price]").forEach(function (el) {
        el.addEventListener("input", recompute);
        el.addEventListener("blur", function () { reformatCell(el, "price"); recompute(); });
      });

      // "Show total" checkbox — flip the hidden class on the totals dl.
      // The toggle itself stays put so the user can re-show the value.
      // Defaults to checked, so the total is visible unless the user opts out.
      var showTotalCb = document.getElementById("q-show-total");
      var totalsDl = document.getElementById("q-totals-dl");
      if (showTotalCb && totalsDl) {
        showTotalCb.addEventListener("change", function () {
          if (showTotalCb.checked) {
            totalsDl.classList.remove("q-totals--hidden");
          } else {
            totalsDl.classList.add("q-totals--hidden");
          }
        });
      }

      // Print button.
      var btn = document.getElementById("q-print-btn");
      if (btn) {
        btn.addEventListener("click", function () {
          // Blur whatever's focused so any in-flight edit gets reformatted
          // + folded into the total before we print.
          if (document.activeElement && document.activeElement.blur) {
            document.activeElement.blur();
          }
          setTimeout(function () { window.print(); }, 50);
        });
      }
    })();
  </script>
</body>
</html>`;
}

type Props = {
  workflowProducts: WorkflowProductOption[];
  workflowLabel: string | null;
  // When non-null, the calculator was opened from /workflow/[id]?from=... and
  // is allowed to write pricing snapshots back into that workflow's state.
  workflowId: string | null;
  // Full workflow.state needed for the PUT — we merge our pricing changes
  // into it and send the whole object back, since the workflow update
  // endpoint replaces state wholesale rather than deep-merging.
  workflowState: WorkflowState | null;
  // Saved tabs, in display order. Empty array = no saved tabs yet.
  initialPricingTabs: PricingSnapshot[];
  // Resolved customer name from the workflow (existing customer or
  // newly-entered name). Null when not in workflow context or unresolved.
  customerName: string | null;
  // Customer ship-to address (only present for existing customers).
  customerAddress: string | null;
  // Contact / email captured at workflow-creation time when the customer
  // was entered as "new". Populates the PREPARED FOR block on the quote.
  newCustomerContact: string | null;
  newCustomerEmail: string | null;
  // Signed-in preparer's email + display name. Used in the quote footer.
  preparerEmail: string;
  preparerName: string | null;
};

// Per-tab persisted state. We keep every input + the last-save timestamp
// here so switching tabs is "save current state into the old tab, hydrate
// from the new tab". Vendor search/edit UX flags live alongside the rest
// so they survive a tab switch too.
type TabState = {
  tabId: string;
  label: string | null;
  workflowProductUid: string;
  vendorMode: VendorMode;
  vendorId: string | null;
  vendorName: string | null;
  vendorSearch: string;
  vendorEditing: boolean;
  newVendorName: string;
  shippingOrigin: ShippingOrigin;
  incoterm: Incoterm;
  unitCost: string;
  quantity: string;
  freight: string;
  insurance: string;
  customsBroker: string;
  dutiesPct: string;
  handling: string;
  testing: string;
  margin: string;
  marginMode: Mode;
  savedAt: string | null;
};

function newTabId(): string {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return `tab-${crypto.randomUUID()}`;
  }
  return `tab-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// Defaults for a freshly added blank tab.
function blankTab(): TabState {
  return {
    tabId: newTabId(),
    label: null,
    workflowProductUid: "",
    vendorMode: "existing",
    vendorId: null,
    vendorName: null,
    vendorSearch: "",
    vendorEditing: true,
    newVendorName: "",
    shippingOrigin: "usa",
    incoterm: "CIF",
    unitCost: "",
    quantity: "",
    freight: "",
    insurance: "",
    customsBroker: "",
    dutiesPct: "",
    handling: "",
    testing: "",
    margin: "30",
    marginMode: "gross-margin",
    savedAt: null,
  };
}

// Pull a TabState out of a saved PricingSnapshot. We can't recover the
// vendorSearch / vendorEditing UX flags, so reset them to sensible defaults
// based on whether a vendor was selected.
function tabFromSnapshot(snap: PricingSnapshot): TabState {
  const hasVendor = snap.vendorMode === "existing" && !!snap.vendorId;
  return {
    tabId: snap.tabId || newTabId(),
    label: snap.label ?? null,
    workflowProductUid: snap.workflowProductUid || "",
    vendorMode: snap.vendorMode,
    vendorId: snap.vendorId,
    vendorName: snap.vendorLabel,
    vendorSearch: hasVendor ? (snap.vendorLabel ?? "") : "",
    vendorEditing: !hasVendor,
    newVendorName: snap.newVendorName,
    shippingOrigin: snap.shippingOrigin,
    incoterm: snap.incoterm,
    unitCost: snap.unitCost,
    quantity: snap.quantity,
    freight: snap.freight,
    insurance: snap.insurance,
    customsBroker: snap.customsBroker,
    dutiesPct: snap.dutiesPct,
    handling: snap.handling,
    testing: snap.testing,
    margin: snap.margin,
    marginMode: snap.marginMode,
    savedAt: snap.savedAt,
  };
}

// Extracted math — used by both the live useMemo for the active tab and the
// save handler when it needs to snapshot results for inactive tabs.
function computeResults(input: {
  unitCost: string;
  quantity: string;
  freight: string;
  insurance: string;
  customsBroker: string;
  dutiesPct: string;
  handling: string;
  testing: string;
  margin: string;
  marginMode: Mode;
  shippingOrigin: ShippingOrigin;
  incoterm: Incoterm;
}) {
  const u = num(input.unitCost);
  const q = num(input.quantity);
  const visibility = input.shippingOrigin === "usa"
    ? { freight: true, insurance: false, duties: false, customs: false }
    : INCOTERM_FIELDS[input.incoterm];
  const fr = visibility.freight ? num(input.freight) : 0;
  const ins = visibility.insurance ? num(input.insurance) : 0;
  const cb = visibility.customs ? num(input.customsBroker) : 0;
  const dp = visibility.duties ? num(input.dutiesPct) / 100 : 0;
  const hd = num(input.handling);
  const ts = num(input.testing);
  const mPct = num(input.margin) / 100;

  const productCost = u * q;
  const dutiesAmount = productCost * dp;
  const landedTotal = productCost + fr + ins + cb + dutiesAmount + hd + ts;
  const landedPerUnit = q > 0 ? landedTotal / q : 0;
  let salePerUnit = 0;
  if (landedPerUnit > 0) {
    if (input.marginMode === "markup") {
      salePerUnit = landedPerUnit * (1 + mPct);
    } else {
      const capped = Math.min(mPct, 0.9999);
      salePerUnit = landedPerUnit / (1 - capped);
    }
  }
  const totalRevenue = salePerUnit * q;
  const grossProfit = totalRevenue - landedTotal;
  const effectiveMargin = totalRevenue > 0 ? grossProfit / totalRevenue : 0;
  const effectiveMarkup = landedTotal > 0 ? grossProfit / landedTotal : 0;

  return {
    productCost,
    dutiesAmount,
    landedTotal,
    landedPerUnit,
    salePerUnit,
    totalRevenue,
    grossProfit,
    effectiveMargin,
    effectiveMarkup,
    hasInputs: u > 0 && q > 0,
  };
}

export default function PricingCalculator({
  workflowProducts,
  workflowLabel,
  workflowId,
  workflowState,
  initialPricingTabs,
  customerName,
  customerAddress,
  newCustomerContact,
  newCustomerEmail,
  preparerEmail,
  preparerName,
}: Props) {
  // --- Tabs ------------------------------------------------------------
  // Excel-style tabs at the top. Each tab is one independent calculator
  // state. Switching tabs writes the current input state into the old
  // tab's slot, then hydrates from the new tab's slot.
  const [tabs, setTabs] = useState<TabState[]>(() =>
    initialPricingTabs.length > 0
      ? initialPricingTabs.map(tabFromSnapshot)
      : [blankTab()],
  );
  const [activeTabIndex, setActiveTabIndex] = useState<number>(0);
  // Auto-numbered fallback when a tab doesn't have a label / picked product.
  // We just use "Tab N" based on display position.

  // --- Workflow product picker ----------------------------------------
  // Only relevant when we were launched from a workflow. "" means "not picked"
  // — the dropdown shows "Choose product" in that state. Tab-scoped.
  const [workflowProductUid, setWorkflowProductUid] = useState<string>(
    () => tabs[0]?.workflowProductUid ?? "",
  );

  // --- Save-to-workflow state ----------------------------------------
  // Only used when workflowId is set. We track the in-flight save plus the
  // last-known save timestamp so the UI can render "Saved · just now".
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // --- Print portal ---------------------------------------------------
  // We render the print summary into a portal attached directly to <body>
  // so the @media print stylesheet can `display: none` every sibling.
  // This avoids the blank-page bug we'd get when keeping the calculator
  // form in the print layout with `visibility: hidden`.
  const [printRoot, setPrintRoot] = useState<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = document.createElement("div");
    el.className = "pricing-print-portal";
    document.body.appendChild(el);
    setPrintRoot(el);
    return () => {
      el.remove();
    };
  }, []);
  const [lastSavedAt, setLastSavedAt] = useState<string | null>(
    () => tabs[0]?.savedAt ?? null,
  );

  const pickedProduct = useMemo(
    () => workflowProducts.find((p) => p.uid === workflowProductUid) ?? null,
    [workflowProducts, workflowProductUid],
  );
  // True when the user picked an "existing stock" product on the workflow.
  // Hides every inbound-cost input (freight/insurance/duties/customs/lab/
  // other fees) because the landed cost is already known from Fishbowl —
  // the calculator collapses to unit cost × qty + margin = sale price.
  const isStockProduct = pickedProduct?.sourceMode === "stock";

  // --- Vendor picker --------------------------------------------------
  // Mirrors the customer selector UX on /start: toggle between existing
  // (autocomplete from vendors table) and new (free-text). All vendor
  // fields are tab-scoped — switching tabs replaces them via applyTab.
  const [vendorMode, setVendorMode] = useState<VendorMode>(
    () => tabs[0]?.vendorMode ?? "existing",
  );
  const [vendorId, setVendorId] = useState<string | null>(
    () => tabs[0]?.vendorId ?? null,
  );
  const [vendorName, setVendorName] = useState<string | null>(
    () => tabs[0]?.vendorName ?? null,
  );
  const [vendorSearch, setVendorSearch] = useState<string>(
    () => tabs[0]?.vendorSearch ?? "",
  );
  const [vendorResults, setVendorResults] = useState<VendorRow[]>([]);
  const [vendorSearching, setVendorSearching] = useState(false);
  // True when the user is actively browsing the dropdown — once they pick a
  // vendor we collapse the search list. The "Change" link reopens it.
  const [vendorEditing, setVendorEditing] = useState(
    () => tabs[0]?.vendorEditing ?? true,
  );
  const [newVendorName, setNewVendorName] = useState<string>(
    () => tabs[0]?.newVendorName ?? "",
  );

  // Debounced search against the vendors table. We use ilike so any
  // substring matches, matching how the customer selector behaves.
  useEffect(() => {
    if (vendorMode !== "existing") {
      setVendorResults([]);
      return;
    }
    const term = vendorSearch.trim();
    if (term.length === 0) {
      setVendorResults([]);
      return;
    }
    const sb = supabase;
    if (!sb) return;
    setVendorSearching(true);
    const handle = setTimeout(async () => {
      const { data, error } = await sb
        .from("vendors")
        .select("id, name")
        .eq("active", true)
        .ilike("name", `%${term}%`)
        .order("name")
        .limit(VENDOR_SEARCH_LIMIT);
      // Table may not exist yet in the schema (early bootstrap); swallow
      // and treat as "no results" so the UI doesn't surface a scary error.
      if (error) {
        console.warn("vendors search failed:", error.message);
        setVendorResults([]);
      } else {
        setVendorResults((data ?? []) as VendorRow[]);
      }
      setVendorSearching(false);
    }, 180);
    return () => {
      clearTimeout(handle);
      setVendorSearching(false);
    };
  }, [vendorSearch, vendorMode]);

  const pickVendor = (v: VendorRow) => {
    setVendorId(v.id);
    setVendorName(v.name);
    setVendorSearch(v.name);
    setVendorEditing(false);
    setVendorResults([]);
  };

  const resetVendor = () => {
    setVendorId(null);
    setVendorName(null);
    setVendorSearch("");
    setVendorEditing(true);
    setVendorResults([]);
  };

  const onVendorModeChange = (next: VendorMode) => {
    setVendorMode(next);
    // Clear cross-mode state so we don't keep stale picks lingering.
    setVendorId(null);
    setVendorName(null);
    setVendorSearch("");
    setVendorResults([]);
    setVendorEditing(true);
  };

  const selectedVendorDisplay =
    vendorMode === "existing"
      ? vendorName
      : newVendorName.trim().length > 0
        ? newVendorName.trim()
        : null;

  // --- Inputs ----------------------------------------------------------
  // Every cost-input hook seeds from tabs[0] so a workflow that already has
  // saved tabs lands on the first tab pre-filled. Switching tabs writes the
  // current values into the previous tab and replays setters with the new
  // tab's values (see switchTab below).
  const [shippingOrigin, setShippingOrigin] = useState<ShippingOrigin>(
    () => tabs[0]?.shippingOrigin ?? "usa",
  );
  // Default Incoterm. Only meaningful when shippingOrigin is "international".
  // CIF is the most common term we quote against — supplier pays freight +
  // insurance to the destination port and we cover duties + customs.
  const [incoterm, setIncoterm] = useState<Incoterm>(
    () => tabs[0]?.incoterm ?? "CIF",
  );
  const [unitCost, setUnitCost] = useState<string>(() => tabs[0]?.unitCost ?? "");
  const [quantity, setQuantity] = useState<string>(() => tabs[0]?.quantity ?? "");
  const [freight, setFreight] = useState<string>(() => tabs[0]?.freight ?? "");
  // International-shipment specific cost slots. Each is a total-dollar
  // amount distributed across qty (same as freight/handling).
  const [insurance, setInsurance] = useState<string>(() => tabs[0]?.insurance ?? "");
  const [customsBroker, setCustomsBroker] = useState<string>(
    () => tabs[0]?.customsBroker ?? "",
  );
  const [dutiesPct, setDutiesPct] = useState<string>(() => tabs[0]?.dutiesPct ?? "");
  const [handling, setHandling] = useState<string>(() => tabs[0]?.handling ?? "");
  // Lab / analytical testing fee. Constant on all terms — always shown.
  const [testing, setTesting] = useState<string>(() => tabs[0]?.testing ?? "");
  const [margin, setMargin] = useState<string>(() => tabs[0]?.margin ?? "30");
  const [marginMode, setMarginMode] = useState<Mode>(
    () => tabs[0]?.marginMode ?? "gross-margin",
  );

  // Which buyer-side cost inputs to show for the current shipping mode.
  // For USA we hide everything Incoterm-related and only keep freight +
  // testing + other fees. For international we let the Incoterm decide.
  // For stock products every inbound cost is hidden — the landed cost is
  // already in Fishbowl, so unit cost × qty IS the landed total.
  const visibility = isStockProduct
    ? { freight: false, insurance: false, duties: false, customs: false }
    : shippingOrigin === "usa"
      ? { freight: true, insurance: false, duties: false, customs: false }
      : INCOTERM_FIELDS[incoterm];

  // When the user picks a workflow product, copy its quantity into the qty
  // field (overwriting whatever was there). Saved-snapshot hydration lives
  // at the tab level now — switching tabs handles the full hydrate path.
  const onPickWorkflowProduct = (uid: string) => {
    setWorkflowProductUid(uid);
    const product = workflowProducts.find((p) => p.uid === uid);
    if (product?.quantity) {
      setQuantity(formatQtyInput(product.quantity));
    }
  };

  // --- Can we save right now? -----------------------------------------
  // True whenever the calculator was opened from a workflow. We don't gate
  // on workflowProductUid anymore because tabs may legitimately be unlabelled
  // (e.g. a scratch tab the user hasn't picked a product for yet).
  const canSave = !!workflowId && !!workflowState;

  // --- Derived ---------------------------------------------------------
  // Active-tab live results. Delegates to the shared computeResults helper
  // so the save handler can re-derive results for inactive tabs from their
  // stored inputs without duplicating math. For stock products we zero
  // out every inbound cost so the landed total collapses to product cost
  // (which the user enters as the known landed unit cost from Fishbowl).
  const results = useMemo(
    () =>
      computeResults({
        unitCost,
        quantity,
        freight: isStockProduct ? "" : freight,
        insurance: isStockProduct ? "" : insurance,
        customsBroker: isStockProduct ? "" : customsBroker,
        dutiesPct: isStockProduct ? "" : dutiesPct,
        handling: isStockProduct ? "" : handling,
        testing: isStockProduct ? "" : testing,
        margin,
        marginMode,
        shippingOrigin,
        incoterm,
      }),
    [
      unitCost, quantity,
      freight, insurance, customsBroker, dutiesPct, handling, testing,
      margin, marginMode,
      shippingOrigin, incoterm,
      isStockProduct,
    ],
  );

  // --- Tab swap helpers -----------------------------------------------
  // Grab every current input field as a TabState. Used right before we
  // change activeTabIndex so the previous tab keeps the user's edits.
  function snapshotCurrentTab(): TabState {
    const current = tabs[activeTabIndex];
    return {
      tabId: current?.tabId ?? newTabId(),
      label: current?.label ?? null,
      workflowProductUid,
      vendorMode,
      vendorId,
      vendorName,
      vendorSearch,
      vendorEditing,
      newVendorName,
      shippingOrigin,
      incoterm,
      unitCost,
      quantity,
      freight,
      insurance,
      customsBroker,
      dutiesPct,
      handling,
      testing,
      margin,
      marginMode,
      savedAt: lastSavedAt,
    };
  }

  // Push a TabState into every input setter. Order-sensitive only inasmuch as
  // React batches setters in event handlers, so we don't need to be careful.
  function applyTab(t: TabState) {
    setWorkflowProductUid(t.workflowProductUid);
    setVendorMode(t.vendorMode);
    setVendorId(t.vendorId);
    setVendorName(t.vendorName);
    setVendorSearch(t.vendorSearch);
    setVendorEditing(t.vendorEditing);
    setVendorResults([]);
    setNewVendorName(t.newVendorName);
    setShippingOrigin(t.shippingOrigin);
    setIncoterm(t.incoterm);
    setUnitCost(t.unitCost);
    setQuantity(t.quantity);
    setFreight(t.freight);
    setInsurance(t.insurance);
    setCustomsBroker(t.customsBroker);
    setDutiesPct(t.dutiesPct);
    setHandling(t.handling);
    setTesting(t.testing);
    setMargin(t.margin);
    setMarginMode(t.marginMode);
    setLastSavedAt(t.savedAt);
    setSaveError(null);
  }

  function switchTab(newIndex: number) {
    if (newIndex === activeTabIndex) return;
    if (newIndex < 0 || newIndex >= tabs.length) return;
    const snap = snapshotCurrentTab();
    setTabs((prev) =>
      prev.map((t, i) => (i === activeTabIndex ? snap : t)),
    );
    setActiveTabIndex(newIndex);
    applyTab(tabs[newIndex]);
  }

  function addTab() {
    const snap = snapshotCurrentTab();
    const fresh = blankTab();
    setTabs((prev) => [
      ...prev.map((t, i) => (i === activeTabIndex ? snap : t)),
      fresh,
    ]);
    // The new tab is at the end of the freshly-extended array.
    setActiveTabIndex(tabs.length);
    applyTab(fresh);
  }

  function removeTab(index: number) {
    if (tabs.length <= 1) return; // always keep at least one tab
    const nextTabs = tabs.filter((_, i) => i !== index);
    setTabs(nextTabs);
    if (index === activeTabIndex) {
      // Closing the active tab — focus the neighbour to the left (or 0).
      const newIndex = Math.max(0, index - 1);
      setActiveTabIndex(newIndex);
      applyTab(nextTabs[newIndex]);
    } else if (index < activeTabIndex) {
      // Closing a tab to the left of the active one shifts our index down.
      setActiveTabIndex(activeTabIndex - 1);
    }
  }

  // Move the tab at `index` one slot to the left (-1) or right (+1). Keeps
  // the in-memory `tabs` array in sync with the displayed order and updates
  // `activeTabIndex` so the currently-selected tab stays selected after
  // the swap. We snapshot the active tab's in-flight edits first so a tab
  // the user was typing into doesn't lose data when its position changes.
  function moveTab(index: number, direction: -1 | 1) {
    const target = index + direction;
    if (target < 0 || target >= tabs.length) return;
    const snap = snapshotCurrentTab();
    setTabs((prev) => {
      // Apply the latest in-flight edits to the previously-active tab so
      // its position-swap doesn't fork from what the user sees.
      const withSnap = prev.map((t, i) => (i === activeTabIndex ? snap : t));
      const next = withSnap.slice();
      const [tab] = next.splice(index, 1);
      next.splice(target, 0, tab);
      return next;
    });
    // Track the active index across the swap.
    if (activeTabIndex === index) {
      setActiveTabIndex(target);
    } else if (activeTabIndex === target) {
      setActiveTabIndex(index);
    }
  }

  // Update just the active tab's label (used by the inline tab-rename UI).
  function setActiveTabLabel(next: string) {
    const trimmed = next.trim();
    setTabs((prev) =>
      prev.map((t, i) =>
        i === activeTabIndex ? { ...t, label: trimmed.length === 0 ? null : trimmed } : t,
      ),
    );
  }

  // Display labels for the tab bar. Falls back to picked-product name, then
  // to "Tab N" so every tab has something visible.
  const tabDisplayLabels = useMemo(() => {
    return tabs.map((t, i) => {
      if (t.label && t.label.trim().length > 0) return t.label.trim();
      const picked = workflowProducts.find((p) => p.uid === t.workflowProductUid);
      if (picked) return picked.label;
      return `Tab ${i + 1}`;
    });
  }, [tabs, workflowProducts]);

  // Take a TabState → PricingSnapshot ready for the workflow PUT. We
  // re-derive `result` from the inputs so each tab (even inactive ones)
  // carries an accurate result snapshot.
  function snapshotFromTab(t: TabState, fallbackSavedAt: string): PricingSnapshot {
    const r = computeResults({
      unitCost: t.unitCost,
      quantity: t.quantity,
      freight: t.freight,
      insurance: t.insurance,
      customsBroker: t.customsBroker,
      dutiesPct: t.dutiesPct,
      handling: t.handling,
      testing: t.testing,
      margin: t.margin,
      marginMode: t.marginMode,
      shippingOrigin: t.shippingOrigin,
      incoterm: t.incoterm,
    });
    const vendorLabel =
      t.vendorMode === "existing" ? t.vendorName : t.newVendorName.trim() || null;
    return {
      tabId: t.tabId,
      label: t.label,
      workflowProductUid: t.workflowProductUid,
      vendorMode: t.vendorMode,
      vendorId: t.vendorMode === "existing" ? t.vendorId : null,
      vendorLabel,
      newVendorName: t.vendorMode === "new" ? t.newVendorName : "",
      shippingOrigin: t.shippingOrigin,
      incoterm: t.incoterm,
      unitCost: t.unitCost,
      quantity: t.quantity,
      freight: t.freight,
      insurance: t.insurance,
      customsBroker: t.customsBroker,
      dutiesPct: t.dutiesPct,
      handling: t.handling,
      testing: t.testing,
      margin: t.margin,
      marginMode: t.marginMode,
      result: {
        landedTotal: r.landedTotal,
        landedPerUnit: r.landedPerUnit,
        salePerUnit: r.salePerUnit,
        totalRevenue: r.totalRevenue,
        grossProfit: r.grossProfit,
        effectiveMargin: r.effectiveMargin,
        effectiveMarkup: r.effectiveMarkup,
      },
      savedAt: t.savedAt ?? fallbackSavedAt,
      savedByEmail: "",
    };
  }

  // Open a brand-new browser window with a fully-styled customer-facing
  // quote HTML, then auto-trigger print so the user can Save as PDF. Each
  // tab on the calculator becomes one line item on the quote — line item
  // description prefers a saved tab label, else the picked product name,
  // else "Tab N".
  const onIssueQuote = () => {
    // Snapshot the active tab so its latest in-flight edits show up.
    const current = snapshotCurrentTab();
    const snapshotted = tabs.map((t, i) => (i === activeTabIndex ? current : t));
    const lineItems: QuoteLineItem[] = snapshotted.map((t, i) => {
      const r = computeResults({
        unitCost: t.unitCost,
        quantity: t.quantity,
        // For stock items the inbound costs don't apply — match what the
        // calculator UI shows.
        freight: t.freight,
        insurance: t.insurance,
        customsBroker: t.customsBroker,
        dutiesPct: t.dutiesPct,
        handling: t.handling,
        testing: t.testing,
        margin: t.margin,
        marginMode: t.marginMode,
        shippingOrigin: t.shippingOrigin,
        incoterm: t.incoterm,
      });
      const product = workflowProducts.find((p) => p.uid === t.workflowProductUid);
      const desc =
        (t.label && t.label.trim().length > 0 && t.label.trim()) ||
        product?.label ||
        `Tab ${i + 1}`;
      const qty = num(t.quantity);
      return {
        itemRef: `ITEM ${i + 1}`,
        description: product?.sub ? `${desc} — ${product.sub}` : desc,
        quantity: qty,
        unitPrice: r.salePerUnit,
      };
    });

    const html = buildQuoteHtml({
      customerName,
      customerAddress,
      customerContact: newCustomerContact,
      customerEmail: newCustomerEmail,
      workflowLabel,
      preparerName: preparerName ?? "",
      preparerEmail,
      lineItems,
    });

    // Use a Blob URL instead of document.write. Two reasons:
    //   1. window.open(..., "noopener") returns null, which used to leave
    //      the user staring at an empty about:blank. Now there's nothing
    //      special to do — the new tab loads the HTML directly.
    //   2. document.write after the new window's initial about:blank loads
    //      is timing-sensitive and sometimes leaves the page blank.
    const blob = new Blob([html], { type: "text/html" });
    const url = URL.createObjectURL(blob);
    const w = window.open(url, "_blank");
    if (!w) {
      window.alert(
        "Couldn't open the quote window — please allow popups for this site and try again.",
      );
      URL.revokeObjectURL(url);
      return;
    }
    // Revoke the URL after a delay so the browser has time to load it.
    // 30 seconds is generous; the blob is tiny so memory pressure isn't
    // a concern even if the user keeps the tab open.
    window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
  };

  const onSave = async () => {
    if (!workflowId || !workflowState) return;
    setSaving(true);
    setSaveError(null);
    try {
      // Snapshot the active tab into the tabs array first so we capture
      // the user's latest edits in this exact save.
      const now = new Date().toISOString();
      const currentSnap = snapshotCurrentTab();
      const stampedActive: TabState = { ...currentSnap, savedAt: now };
      const nextTabs = tabs.map((t, i) =>
        i === activeTabIndex ? stampedActive : t,
      );
      // Build PricingSnapshot[] for every tab — inactive tabs use their
      // existing savedAt if present, otherwise the same `now` stamp.
      const nextPricing = nextTabs.map((t) => snapshotFromTab(t, now));
      const nextState: WorkflowState = {
        ...workflowState,
        pricing: nextPricing,
      };
      const res = await fetch(`/api/workflows/${workflowId}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ state: nextState }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error || `save_failed_${res.status}`);
      }
      setTabs(nextTabs);
      setLastSavedAt(now);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "save_failed");
    } finally {
      setSaving(false);
    }
  };

  const reset = () => {
    setWorkflowProductUid("");
    setShippingOrigin("usa");
    setIncoterm("CIF");
    setUnitCost("");
    setQuantity("");
    setFreight("");
    setInsurance("");
    setCustomsBroker("");
    setDutiesPct("");
    setHandling("");
    setTesting("");
    setMargin("30");
    setMarginMode("gross-margin");
    resetVendor();
    setNewVendorName("");
    setVendorMode("existing");
  };

  return (
    <div className="pricing">
      {/* Header action bar — always shown so the Print/Save-PDF button is
          available even on scratch calculations outside any workflow. The
          Save-to-workflow button only appears when we have workflow context. */}
      <div
        className="pricing-header-bar"
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
          padding: "10px 14px",
          background: "#f8fafc",
          border: "1px solid #e2e8f0",
          borderRadius: 10,
          marginBottom: 14,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          {canSave ? (
            <>
              <span style={{ fontSize: 13, color: "#64748b" }}>
                Workflow
                {workflowLabel ? ` ${workflowLabel}` : ""}
              </span>
              {customerName ? (
                <span style={{ fontSize: 13, color: "#0f172a", fontWeight: 500 }}>
                  · {customerName}
                </span>
              ) : null}
              {saveError ? (
                <span style={{ fontSize: 13, color: "#b91c1c" }}>
                  Couldn&rsquo;t save: {saveError}
                </span>
              ) : lastSavedAt ? (
                <span style={{ fontSize: 13, color: "#64748b" }}>
                  · Saved {relativeFromNow(lastSavedAt)}
                </span>
              ) : (
                <span style={{ fontSize: 13, color: "#64748b" }}>
                  · Not yet saved
                </span>
              )}
            </>
          ) : (
            <span style={{ fontSize: 13, color: "#64748b" }}>
              Scratch calculation — use Print / Save PDF to keep a copy.
            </span>
          )}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <button
            type="button"
            className="button-secondary"
            onClick={() => window.print()}
            title='Open the browser print dialog. Choose "Save as PDF" as the destination to get a one-page PDF of this tab.'
            style={{
              background: "#fff",
              color: "#0f172a",
              border: "1px solid #cbd5e1",
              padding: "8px 14px",
              borderRadius: 8,
              fontSize: 14,
              fontWeight: 500,
              cursor: "pointer",
            }}
          >
            Print / Save PDF
          </button>
          <button
            type="button"
            onClick={onIssueQuote}
            title="Generate a customer-facing quote (PDF) with every tab as a line item."
            style={{
              background: "var(--teal-700, #1d6c7b)",
              color: "#fff",
              border: "1px solid var(--teal-900, #0f4a56)",
              padding: "8px 14px",
              borderRadius: 8,
              fontSize: 14,
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            Issue a Quote
          </button>
          {canSave ? (
            <button
              type="button"
              className="button-primary"
              onClick={onSave}
              disabled={saving}
              title="Save every tab on this calculator to the workflow"
            >
              {saving ? "Saving…" : "Save"}
            </button>
          ) : null}
        </div>
      </div>

      {/* Excel-style tab bar. Only meaningful in workflow context — outside
          a workflow the user has no place to save the tab anyway, so we hide
          the bar entirely. */}
      {canSave ? (
      <div
        role="tablist"
        aria-label="Pricing tabs"
        style={{
          display: "flex",
          alignItems: "flex-end",
          gap: 4,
          borderBottom: "1px solid #e2e8f0",
          marginBottom: 14,
          overflowX: "auto",
        }}
      >
        {tabs.map((t, i) => {
          const active = i === activeTabIndex;
          const label = tabDisplayLabels[i];
          return (
            <div
              key={t.tabId}
              role="tab"
              aria-selected={active}
              onClick={() => switchTab(i)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                padding: "8px 12px",
                borderTopLeftRadius: 8,
                borderTopRightRadius: 8,
                border: "1px solid #e2e8f0",
                borderBottom: active ? "1px solid #fff" : "1px solid #e2e8f0",
                background: active ? "#fff" : "#f1f5f9",
                cursor: active ? "default" : "pointer",
                fontSize: 14,
                fontWeight: active ? 600 : 500,
                color: active ? "#0f172a" : "#475569",
                marginBottom: -1,
                whiteSpace: "nowrap",
              }}
            >
              {/* Reorder arrows. Hidden when there's only one tab. Each
                  shifts this tab one slot left/right; arrows disable at
                  the ends of the row so the user gets visual feedback. */}
              {tabs.length > 1 ? (
                <>
                  <button
                    type="button"
                    aria-label={`Move ${label} left`}
                    disabled={i === 0}
                    onClick={(e) => {
                      e.stopPropagation();
                      moveTab(i, -1);
                    }}
                    style={{
                      background: "transparent",
                      border: "none",
                      color: i === 0 ? "#cbd5e1" : "#475569",
                      cursor: i === 0 ? "not-allowed" : "pointer",
                      fontSize: 12,
                      lineHeight: 1,
                      padding: "0 2px",
                      fontFamily: "inherit",
                    }}
                  >
                    ◀
                  </button>
                  <button
                    type="button"
                    aria-label={`Move ${label} right`}
                    disabled={i === tabs.length - 1}
                    onClick={(e) => {
                      e.stopPropagation();
                      moveTab(i, 1);
                    }}
                    style={{
                      background: "transparent",
                      border: "none",
                      color: i === tabs.length - 1 ? "#cbd5e1" : "#475569",
                      cursor: i === tabs.length - 1 ? "not-allowed" : "pointer",
                      fontSize: 12,
                      lineHeight: 1,
                      padding: "0 2px",
                      fontFamily: "inherit",
                    }}
                  >
                    ▶
                  </button>
                </>
              ) : null}
              <span>{label}</span>
              {tabs.length > 1 ? (
                <button
                  type="button"
                  aria-label={`Close ${label}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (window.confirm(`Remove "${label}" tab?`)) {
                      removeTab(i);
                    }
                  }}
                  style={{
                    background: "transparent",
                    border: "none",
                    color: "#94a3b8",
                    cursor: "pointer",
                    fontSize: 16,
                    lineHeight: 1,
                    padding: "0 2px",
                  }}
                >
                  ×
                </button>
              ) : null}
            </div>
          );
        })}
        <button
          type="button"
          onClick={addTab}
          title="Add a new pricing tab"
          style={{
            background: "transparent",
            border: "1px dashed #cbd5e1",
            borderRadius: 8,
            padding: "6px 10px",
            color: "#475569",
            cursor: "pointer",
            fontSize: 13,
            marginLeft: 4,
            marginBottom: 0,
          }}
        >
          + Add tab
        </button>
      </div>
      ) : null}

      {workflowProducts.length > 0 ? (
        <section className="pricing__section">
          <h2 className="pricing__section-title">
            Workflow product
            {workflowLabel ? (
              <span className="pricing__section-tag">{workflowLabel}</span>
            ) : null}
          </h2>
          <label className="pricing__field">
            <span className="pricing__label">Pricing for</span>
            <div className="pricing__input-wrap">
              <select
                className="pricing__input pricing__input--select"
                value={workflowProductUid}
                onChange={(e) => onPickWorkflowProduct(e.target.value)}
              >
                <option value="">Choose a product…</option>
                {workflowProducts.map((p) => (
                  <option key={p.uid} value={p.uid}>
                    {p.label}
                    {p.sub ? ` — ${p.sub}` : ""}
                    {p.quantity ? ` (${p.quantity} units)` : ""}
                  </option>
                ))}
              </select>
            </div>
          </label>
          <label className="pricing__field" style={{ marginTop: 10 }}>
            <span className="pricing__label">Tab label (optional)</span>
            <div className="pricing__input-wrap">
              <input
                type="text"
                className="pricing__input"
                value={tabs[activeTabIndex]?.label ?? ""}
                onChange={(e) => setActiveTabLabel(e.target.value)}
                placeholder={tabDisplayLabels[activeTabIndex] ?? ""}
                maxLength={48}
              />
            </div>
          </label>
          {pickedProduct ? (
            <p className="pricing__hint">
              Pricing <strong>{pickedProduct.label}</strong>. Each tab carries
              its own product + costs, so use <em>+ Add tab</em> above to
              quote another product without losing this one.
            </p>
          ) : (
            <p className="pricing__hint">
              Pick the product on this workflow you&rsquo;re pricing for. The
              quantity from that product will pre-fill below.
            </p>
          )}
        </section>
      ) : null}

      {/* Vendor block is informational only — hide it for existing-stock
          products since the inventory has no vendor we need to record. */}
      {isStockProduct ? null : (
      <section className="pricing__section">
        <h2 className="pricing__section-title">Vendor</h2>
        <div className="pricing__vendor-toggle" role="radiogroup" aria-label="Vendor mode">
          <button
            type="button"
            role="radio"
            aria-checked={vendorMode === "existing"}
            className={`pricing__mode ${vendorMode === "existing" ? "pricing__mode--active" : ""}`}
            onClick={() => onVendorModeChange("existing")}
          >
            Existing vendor
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={vendorMode === "new"}
            className={`pricing__mode ${vendorMode === "new" ? "pricing__mode--active" : ""}`}
            onClick={() => onVendorModeChange("new")}
          >
            New vendor
          </button>
        </div>

        {vendorMode === "existing" ? (
          vendorName && !vendorEditing ? (
            <div className="pricing__vendor-picked">
              <div>
                <div className="pricing__vendor-picked-name">{vendorName}</div>
                <div className="pricing__vendor-picked-sub">
                  From Fishbowl vendor directory
                </div>
              </div>
              <button
                type="button"
                className="pricing__vendor-change"
                onClick={resetVendor}
              >
                Change
              </button>
            </div>
          ) : (
            <div className="pricing__vendor-search">
              <label className="pricing__field">
                <span className="pricing__label">Search vendors</span>
                <div className="pricing__input-wrap">
                  <input
                    type="text"
                    className="pricing__input"
                    placeholder="Start typing a vendor name…"
                    value={vendorSearch}
                    onChange={(e) => {
                      setVendorSearch(e.target.value);
                      setVendorEditing(true);
                      if (vendorId) {
                        setVendorId(null);
                        setVendorName(null);
                      }
                    }}
                    autoComplete="off"
                  />
                </div>
              </label>
              {vendorSearch.trim().length > 0 ? (
                vendorResults.length > 0 ? (
                  <ul className="pricing__vendor-list">
                    {vendorResults.map((v) => (
                      <li key={v.id}>
                        <button
                          type="button"
                          className="pricing__vendor-option"
                          onClick={() => pickVendor(v)}
                        >
                          {v.name}
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : vendorSearching ? (
                  <p className="pricing__hint pricing__hint--inline">Searching…</p>
                ) : (
                  <p className="pricing__hint pricing__hint--inline">
                    No vendors matched &ldquo;{vendorSearch.trim()}&rdquo;. Try
                    switching to <strong>New vendor</strong> if this one
                    isn&rsquo;t in Fishbowl yet.
                  </p>
                )
              ) : null}
            </div>
          )
        ) : (
          <label className="pricing__field">
            <span className="pricing__label">Vendor name</span>
            <div className="pricing__input-wrap">
              <input
                type="text"
                className="pricing__input"
                placeholder="e.g. New Asia Pharma Co."
                value={newVendorName}
                onChange={(e) => setNewVendorName(e.target.value)}
                autoComplete="off"
              />
            </div>
          </label>
        )}

        <p className="pricing__hint">
          Vendor is informational — it doesn&rsquo;t change the math. Helpful
          when you&rsquo;re comparing quotes from different suppliers.
        </p>
      </section>
      )}

      <section className="pricing__section">
        <h2 className="pricing__section-title">Product cost</h2>
        <div className="pricing__row">
          <label className="pricing__field">
            <span className="pricing__label">Cost per unit</span>
            <div className="pricing__input-wrap">
              <span className="pricing__input-prefix">$</span>
              <input
                type="text"
                inputMode="decimal"
                className="pricing__input pricing__input--money"
                value={unitCost}
                onChange={(e) => setUnitCost(formatValueInput(e.target.value))}
                placeholder="0.00"
                autoComplete="off"
              />
            </div>
          </label>
          <label className="pricing__field">
            <span className="pricing__label">Quantity (units)</span>
            <div className="pricing__input-wrap">
              <input
                type="text"
                inputMode="numeric"
                className="pricing__input"
                value={quantity}
                onChange={(e) => setQuantity(formatQtyInput(e.target.value))}
                placeholder="0"
                autoComplete="off"
              />
            </div>
          </label>
        </div>
      </section>

      {isStockProduct ? (
        <section
          className="pricing__section"
          style={{ background: "#f0fdfa", borderColor: "#99f6e4" }}
        >
          <h2 className="pricing__section-title">Inbound costs</h2>
          <p
            className="pricing__hint"
            style={{ color: "#0f766e", fontWeight: 500 }}
          >
            This product is <strong>existing stock</strong>. The landed cost is
            already in Fishbowl, so freight, duties, insurance, customs broker,
            lab testing, and other fees don&rsquo;t apply here. Enter the known
            landed unit cost above and the calculator will go straight to the
            sale price using just your margin.
          </p>
        </section>
      ) : (
      <section className="pricing__section">
        <h2 className="pricing__section-title">Inbound costs</h2>
        <div className="pricing__row">
          <div className="pricing__field">
            <span className="pricing__label">Shipping origin</span>
            <div
              className="pricing__mode-toggle"
              role="radiogroup"
              aria-label="Shipping origin"
            >
              <button
                type="button"
                role="radio"
                aria-checked={shippingOrigin === "usa"}
                className={`pricing__mode ${shippingOrigin === "usa" ? "pricing__mode--active" : ""}`}
                onClick={() => setShippingOrigin("usa")}
              >
                USA (domestic)
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={shippingOrigin === "international"}
                className={`pricing__mode ${shippingOrigin === "international" ? "pricing__mode--active" : ""}`}
                onClick={() => setShippingOrigin("international")}
              >
                International
              </button>
            </div>
          </div>
          {shippingOrigin === "international" ? (
            <div className="pricing__field">
              <span className="pricing__label">Shipping terms (Incoterm)</span>
              <IncotermSelect value={incoterm} onChange={setIncoterm} />
            </div>
          ) : null}
        </div>

        <div className="pricing__row" style={{ marginTop: 4 }}>
          {visibility.freight ? (
            <label className="pricing__field">
              <span className="pricing__label">
                {shippingOrigin === "international" ? "Freight (international + inland)" : "Freight (total)"}
              </span>
              <div className="pricing__input-wrap">
                <span className="pricing__input-prefix">$</span>
                <input
                  type="text"
                  inputMode="decimal"
                  className="pricing__input pricing__input--money"
                  value={freight}
                  onChange={(e) => setFreight(formatValueInput(e.target.value))}
                  placeholder="0.00"
                  autoComplete="off"
                />
              </div>
            </label>
          ) : null}
          {visibility.insurance ? (
            <label className="pricing__field">
              <span className="pricing__label">Insurance</span>
              <div className="pricing__input-wrap">
                <span className="pricing__input-prefix">$</span>
                <input
                  type="text"
                  inputMode="decimal"
                  className="pricing__input pricing__input--money"
                  value={insurance}
                  onChange={(e) => setInsurance(formatValueInput(e.target.value))}
                  placeholder="0.00"
                  autoComplete="off"
                />
              </div>
            </label>
          ) : null}
          {visibility.duties ? (
            <label className="pricing__field">
              <span className="pricing__label">Duties</span>
              <div className="pricing__input-wrap">
                <input
                  type="text"
                  inputMode="decimal"
                  className="pricing__input pricing__input--pct"
                  value={dutiesPct}
                  onChange={(e) => setDutiesPct(formatPercentInput(e.target.value))}
                  placeholder="0"
                  autoComplete="off"
                />
                <span className="pricing__input-suffix">%</span>
              </div>
            </label>
          ) : null}
          {visibility.customs ? (
            <label className="pricing__field">
              <span className="pricing__label">Customs broker</span>
              <div className="pricing__input-wrap">
                <span className="pricing__input-prefix">$</span>
                <input
                  type="text"
                  inputMode="decimal"
                  className="pricing__input pricing__input--money"
                  value={customsBroker}
                  onChange={(e) => setCustomsBroker(formatValueInput(e.target.value))}
                  placeholder="0.00"
                  autoComplete="off"
                />
              </div>
            </label>
          ) : null}
          <label className="pricing__field">
            <span className="pricing__label">Lab testing</span>
            <div className="pricing__input-wrap">
              <span className="pricing__input-prefix">$</span>
              <input
                type="text"
                inputMode="decimal"
                className="pricing__input pricing__input--money"
                value={testing}
                onChange={(e) => setTesting(formatValueInput(e.target.value))}
                placeholder="0.00"
                autoComplete="off"
              />
            </div>
          </label>
          <label className="pricing__field">
            <span className="pricing__label">Other fees</span>
            <div className="pricing__input-wrap">
              <span className="pricing__input-prefix">$</span>
              <input
                type="text"
                inputMode="decimal"
                className="pricing__input pricing__input--money"
                value={handling}
                onChange={(e) => setHandling(formatValueInput(e.target.value))}
                placeholder="0.00"
                autoComplete="off"
              />
            </div>
          </label>
        </div>
        <p className="pricing__hint">
          {visibility.duties
            ? "Duties are applied as a percent of the product cost. All other inbound costs are total dollar amounts distributed across the full quantity."
            : "All inbound costs shown are total dollar amounts distributed across the full quantity."}
        </p>
      </section>
      )}

      <section className="pricing__section">
        <h2 className="pricing__section-title">Pricing</h2>
        <div className="pricing__row">
          <label className="pricing__field pricing__field--margin">
            <span className="pricing__label">Margin</span>
            <div className="pricing__input-wrap">
              <input
                type="text"
                inputMode="decimal"
                className="pricing__input pricing__input--pct"
                value={margin}
                onChange={(e) => setMargin(formatPercentInput(e.target.value))}
                placeholder="30"
                autoComplete="off"
              />
              <span className="pricing__input-suffix">%</span>
            </div>
          </label>
          <div className="pricing__field pricing__field--mode">
            <span className="pricing__label">Margin type</span>
            <div className="pricing__mode-toggle" role="radiogroup" aria-label="Margin type">
              <button
                type="button"
                role="radio"
                aria-checked={marginMode === "gross-margin"}
                className={`pricing__mode ${marginMode === "gross-margin" ? "pricing__mode--active" : ""}`}
                onClick={() => setMarginMode("gross-margin")}
              >
                Gross margin
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={marginMode === "markup"}
                className={`pricing__mode ${marginMode === "markup" ? "pricing__mode--active" : ""}`}
                onClick={() => setMarginMode("markup")}
              >
                Markup
              </button>
            </div>
          </div>
        </div>
        <p className="pricing__hint">
          {marginMode === "gross-margin"
            ? "Gross margin: the % of the sale price that's profit. Sale = cost ÷ (1 − margin)."
            : "Markup: the % added on top of cost. Sale = cost × (1 + markup)."}
        </p>
      </section>

      <section className="pricing__results">
        <div className="pricing__results-header">
          <h2 className="pricing__section-title pricing__section-title--results">
            Results
          </h2>
          <button type="button" className="pricing__reset" onClick={reset}>
            Reset
          </button>
        </div>

        {pickedProduct || selectedVendorDisplay ? (
          <div className="pricing__context">
            {pickedProduct ? (
              <div className="pricing__context-pair">
                <span className="pricing__context-label">Product</span>
                <span className="pricing__context-value">{pickedProduct.label}</span>
              </div>
            ) : null}
            {selectedVendorDisplay ? (
              <div className="pricing__context-pair">
                <span className="pricing__context-label">Vendor</span>
                <span className="pricing__context-value">
                  {selectedVendorDisplay}
                  {vendorMode === "new" ? " · New" : ""}
                </span>
              </div>
            ) : null}
          </div>
        ) : null}

        {!results.hasInputs ? (
          <p className="pricing__empty">
            Enter a unit cost and quantity to see the math.
          </p>
        ) : (
          <>
            <div className="pricing__breakdown">
              <Row label="Product cost subtotal" value={usd.format(results.productCost)} />
              {visibility.duties ? (
                <Row label="Duties" value={usd.format(results.dutiesAmount)} muted />
              ) : null}
              {visibility.freight ? (
                <Row label="Freight" value={usd.format(num(freight))} muted />
              ) : null}
              {visibility.insurance ? (
                <Row label="Insurance" value={usd.format(num(insurance))} muted />
              ) : null}
              {visibility.customs ? (
                <Row label="Customs broker" value={usd.format(num(customsBroker))} muted />
              ) : null}
              <Row label="Lab testing" value={usd.format(num(testing))} muted />
              <Row label="Other fees" value={usd.format(num(handling))} muted />
              <Row
                label="Landed cost (in warehouse)"
                value={usd.format(results.landedTotal)}
                emphasis
              />
              <Row
                label="Landed cost per unit"
                value={usdFine.format(results.landedPerUnit)}
                muted
              />
            </div>

            <div className="pricing__highlight">
              <div className="pricing__highlight-label">Sale price per unit</div>
              <div className="pricing__highlight-value">
                {usdFine.format(results.salePerUnit)}
              </div>
              <div className="pricing__highlight-sub">
                {pct.format(results.effectiveMargin)} gross margin ·{" "}
                {pct.format(results.effectiveMarkup)} markup
              </div>
            </div>

            <div className="pricing__breakdown">
              <Row
                label="Total revenue at this price"
                value={usd.format(results.totalRevenue)}
              />
              <Row
                label="Gross profit"
                value={usd.format(results.grossProfit)}
                emphasis
              />
            </div>
          </>
        )}
      </section>

      {/* ------------------------------------------------------------------
          Print-only summary, rendered through a portal at document.body.
          The portal lets the @media print stylesheet hide every other body
          child cleanly with `display: none` — no blank pages from leftover
          form layout. We keep the markup the same as before but the wrapper
          class is now controlled by the portal target element class.
          ------------------------------------------------------------------ */}
      {printRoot ? createPortal(
      <div className="pricing-print" aria-hidden>
        <div className="pricing-print__header">
          <div>
            <div className="pricing-print__eyebrow">PharmaCenter · Pricing Summary</div>
            <div className="pricing-print__title">
              {tabDisplayLabels[activeTabIndex] || "Untitled"}
            </div>
            {customerName ? (
              <div className="pricing-print__sub">Customer: {customerName}</div>
            ) : null}
            {workflowLabel ? (
              <div className="pricing-print__sub">Workflow {workflowLabel}</div>
            ) : null}
          </div>
          <div className="pricing-print__date">
            {new Date().toLocaleDateString("en-US", {
              year: "numeric",
              month: "short",
              day: "numeric",
            })}
          </div>
        </div>

        <h3 className="pricing-print__section-title">Context</h3>
        <table className="pricing-print__table">
          <tbody>
            {customerName ? (
              <tr>
                <td>Customer</td>
                <td>{customerName}</td>
              </tr>
            ) : null}
            {pickedProduct ? (
              <tr>
                <td>Product</td>
                <td>
                  {pickedProduct.label}
                  {pickedProduct.sub ? ` — ${pickedProduct.sub}` : ""}
                </td>
              </tr>
            ) : null}
            {pickedProduct ? (
              <tr>
                <td>Source</td>
                <td>
                  {isStockProduct
                    ? "Existing stock (landed cost from Fishbowl)"
                    : "Purchase needed"}
                </td>
              </tr>
            ) : null}
            {isStockProduct ? null : (
              <tr>
                <td>Vendor</td>
                <td>{selectedVendorDisplay || "—"}</td>
              </tr>
            )}
            {isStockProduct ? null : (
              <tr>
                <td>Shipping origin</td>
                <td>{shippingOrigin === "usa" ? "USA (domestic)" : "International"}</td>
              </tr>
            )}
            {!isStockProduct && shippingOrigin === "international" ? (
              <tr>
                <td>Shipping terms</td>
                <td>{INCOTERM_LABELS[incoterm]}</td>
              </tr>
            ) : null}
          </tbody>
        </table>

        <h3 className="pricing-print__section-title">Inputs</h3>
        <table className="pricing-print__table">
          <tbody>
            <tr>
              <td>Unit cost</td>
              <td>{usd.format(num(unitCost))}</td>
            </tr>
            <tr>
              <td>Quantity</td>
              <td>{quantity ? Number(quantity.replace(/,/g, "")).toLocaleString("en-US") : "—"}</td>
            </tr>
            {visibility.freight ? (
              <tr>
                <td>Freight</td>
                <td>{usd.format(num(freight))}</td>
              </tr>
            ) : null}
            {visibility.insurance ? (
              <tr>
                <td>Insurance</td>
                <td>{usd.format(num(insurance))}</td>
              </tr>
            ) : null}
            {visibility.duties ? (
              <tr>
                <td>Duties</td>
                <td>{dutiesPct || "0"}%</td>
              </tr>
            ) : null}
            {visibility.customs ? (
              <tr>
                <td>Customs broker</td>
                <td>{usd.format(num(customsBroker))}</td>
              </tr>
            ) : null}
            <tr>
              <td>Lab testing</td>
              <td>{usd.format(num(testing))}</td>
            </tr>
            <tr>
              <td>Other fees</td>
              <td>{usd.format(num(handling))}</td>
            </tr>
            <tr>
              <td>{marginMode === "markup" ? "Markup" : "Gross margin"}</td>
              <td>{margin || "0"}%</td>
            </tr>
          </tbody>
        </table>

        <h3 className="pricing-print__section-title">Results</h3>
        <table className="pricing-print__table">
          <tbody>
            <tr>
              <td>Product cost subtotal</td>
              <td>{usd.format(results.productCost)}</td>
            </tr>
            {visibility.duties ? (
              <tr>
                <td>Duties</td>
                <td>{usd.format(results.dutiesAmount)}</td>
              </tr>
            ) : null}
            <tr className="pricing-print__row--emphasis">
              <td>Landed cost (in warehouse)</td>
              <td>{usd.format(results.landedTotal)}</td>
            </tr>
            <tr>
              <td>Landed cost per unit</td>
              <td>{usd.format(results.landedPerUnit)}</td>
            </tr>
            <tr className="pricing-print__row--emphasis">
              <td>Sale price per unit</td>
              <td>{usd.format(results.salePerUnit)}</td>
            </tr>
            <tr>
              <td>Total revenue</td>
              <td>{usd.format(results.totalRevenue)}</td>
            </tr>
            <tr>
              <td>Gross profit</td>
              <td>{usd.format(results.grossProfit)}</td>
            </tr>
            <tr>
              <td>Effective margin</td>
              <td>{pct.format(results.effectiveMargin)}</td>
            </tr>
            <tr>
              <td>Effective markup</td>
              <td>{pct.format(results.effectiveMarkup)}</td>
            </tr>
          </tbody>
        </table>

        <div className="pricing-print__footer">
          Generated by PharmaCenter Quote ·{" "}
          {new Date().toLocaleString("en-US")}
        </div>
      </div>,
      printRoot,
      ) : null}

      {/* Print stylesheet — the print summary lives in a portal at body
          level (`.pricing-print-portal`). On print, every other body child
          gets display:none so there's no leftover layout = no blank pages.
          The summary itself stays display:none on screen. */}
      <style>{`
        .pricing-print-portal { display: none; }
        @media print {
          /* Nuke every direct body child except our portal so the print
             pipeline has nothing else to lay out. */
          body > *:not(.pricing-print-portal) { display: none !important; }
          html, body {
            background: #fff !important;
            margin: 0 !important;
            padding: 0 !important;
            height: auto !important;
            overflow: visible !important;
          }
          .pricing-print-portal {
            display: block !important;
            position: static !important;
          }
          .pricing-print {
            display: block !important;
            color: #0f172a;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI",
              Roboto, "Helvetica Neue", Arial, sans-serif;
          }
          .pricing-print__header {
            display: flex;
            justify-content: space-between;
            align-items: flex-start;
            border-bottom: 2px solid #0f172a;
            padding-bottom: 10px;
            margin-bottom: 14px;
          }
          .pricing-print__eyebrow {
            font-size: 11px;
            letter-spacing: 0.08em;
            text-transform: uppercase;
            color: #64748b;
          }
          .pricing-print__title {
            font-size: 20px;
            font-weight: 700;
            margin-top: 2px;
          }
          .pricing-print__sub {
            font-size: 12px;
            color: #475569;
            margin-top: 2px;
          }
          .pricing-print__date {
            font-size: 12px;
            color: #475569;
          }
          .pricing-print__section-title {
            font-size: 12px;
            font-weight: 700;
            text-transform: uppercase;
            letter-spacing: 0.06em;
            color: #475569;
            margin: 14px 0 6px;
            border-bottom: 1px solid #cbd5e1;
            padding-bottom: 4px;
          }
          .pricing-print__table {
            width: 100%;
            border-collapse: collapse;
          }
          .pricing-print__table td {
            padding: 4px 0;
            font-size: 12px;
            border-bottom: 1px solid #e2e8f0;
          }
          .pricing-print__table td:first-child { color: #475569; }
          .pricing-print__table td:last-child {
            text-align: right;
            font-variant-numeric: tabular-nums;
          }
          .pricing-print__row--emphasis td {
            font-weight: 700;
            color: #0f172a;
            border-top: 1px solid #0f172a;
            border-bottom: 1px solid #0f172a;
          }
          .pricing-print__footer {
            margin-top: 18px;
            font-size: 10px;
            color: #94a3b8;
            border-top: 1px solid #e2e8f0;
            padding-top: 8px;
          }
          @page { margin: 0.4in; size: letter; }
        }
      `}</style>
    </div>
  );
}

// Custom Incoterm dropdown — native <select> can't style options with
// descriptions, so we render a button that opens a panel listing each term
// with its full label on top and a small muted description below. Click
// outside or press Escape to close.
function IncotermSelect({
  value,
  onChange,
}: {
  value: Incoterm;
  onChange: (v: Incoterm) => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (!wrapRef.current) return;
      if (!wrapRef.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const terms = Object.keys(INCOTERM_LABELS) as Incoterm[];

  return (
    <div ref={wrapRef} style={{ position: "relative" }}>
      <button
        type="button"
        className="pricing__input pricing__input--select"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        style={{
          display: "block",
          width: "100%",
          textAlign: "left",
          cursor: "pointer",
        }}
      >
        <div style={{ fontWeight: 500 }}>{INCOTERM_LABELS[value]}</div>
        <div style={{ fontSize: 12, color: "#64748b", marginTop: 2, lineHeight: 1.4 }}>
          {INCOTERM_DESCRIPTIONS[value]}
        </div>
      </button>
      {open ? (
        <div
          role="listbox"
          style={{
            position: "absolute",
            top: "calc(100% + 4px)",
            left: 0,
            right: 0,
            background: "#fff",
            border: "1px solid #e5e7eb",
            borderRadius: 8,
            boxShadow: "0 12px 32px rgba(15, 23, 42, 0.12)",
            zIndex: 30,
            maxHeight: 360,
            overflowY: "auto",
            padding: 4,
          }}
        >
          {terms.map((t) => {
            const selected = t === value;
            return (
              <button
                key={t}
                type="button"
                role="option"
                aria-selected={selected}
                onClick={() => {
                  onChange(t);
                  setOpen(false);
                }}
                style={{
                  display: "block",
                  width: "100%",
                  textAlign: "left",
                  padding: "10px 12px",
                  background: selected ? "#f1f5f9" : "transparent",
                  border: "none",
                  borderRadius: 6,
                  cursor: "pointer",
                  marginBottom: 2,
                }}
                onMouseEnter={(e) => {
                  if (!selected) e.currentTarget.style.background = "#f8fafc";
                }}
                onMouseLeave={(e) => {
                  if (!selected) e.currentTarget.style.background = "transparent";
                }}
              >
                <div style={{ fontWeight: 500, fontSize: 14, color: "#0f172a" }}>
                  {INCOTERM_LABELS[t]}
                </div>
                <div style={{ fontSize: 12, color: "#64748b", marginTop: 2, lineHeight: 1.4 }}>
                  {INCOTERM_DESCRIPTIONS[t]}
                </div>
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

function Row({
  label,
  value,
  muted,
  emphasis,
}: {
  label: string;
  value: string;
  muted?: boolean;
  emphasis?: boolean;
}) {
  return (
    <div
      className={`pricing__breakdown-row ${
        emphasis ? "pricing__breakdown-row--emphasis" : ""
      } ${muted ? "pricing__breakdown-row--muted" : ""}`}
    >
      <span className="pricing__breakdown-label">{label}</span>
      <span className="pricing__breakdown-value">{value}</span>
    </div>
  );
}
