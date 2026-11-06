// Parse a fedex.com Address Book export (Import/Export > Export from Personal
// Address Book) into address-book rows. Pure functions: no I/O, so the same
// code builds the preview and re-checks the rows on import.
//
// House rules, decided with the user 2026-11-06:
// - Placeholder phones (000-000-0000, 111-111-1111) become PharmaCenter's
//   number, (954) 384-8728: FedEx requires a recipient phone and that is the
//   workaround the person shipping already used.
// - BillCode 2 (recipient) or 3 (third party) with an account that is not
//   PharmaCenter's becomes "recipient pays" with that account. BillCode 1 is
//   PharmaCenter's own account and is not stored.
// - ResidentialFlag R = residential, C = commercial, anything else unknown.

import { SHIPPER } from "./shipper";
import type { RecipientKind } from "./draft";

export type ImportRow = {
  key: string;                    // stable id for the preview
  include: boolean;
  kind: RecipientKind;
  kindReason: string;             // why this kind was suggested
  company: string | null;
  contactName: string | null;
  phone: string;
  phoneNote: string | null;
  email: string | null;
  streetLines: string[];
  city: string;
  stateProvince: string | null;
  postalCode: string | null;
  countryCode: string;
  residential: boolean | null;
  billToAccount: string | null;
  customerId: string | null;
  vendorId: string | null;
  notes: string | null;
  duplicateOf: string | null;     // existing address-book id, when already there
  problems: string[];
};

/** RFC-4180-ish CSV: quoted fields, doubled quotes, commas and newlines inside quotes. */
export function parseCsv(text: string): string[][] {
  const out: string[][] = [];
  let row: string[] = [];
  let field = "";
  let q = false;
  const s = text.replace(/^﻿/, "");
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) {
      if (ch === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i++;
        } else q = false;
      } else field += ch;
    } else if (ch === '"') q = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && s[i + 1] === "\n") i++;
      row.push(field);
      out.push(row);
      row = [];
      field = "";
    } else field += ch;
  }
  if (field || row.length) {
    row.push(field);
    out.push(row);
  }
  return out.filter((r) => r.some((c) => c.trim()));
}

const clean = (v: string | undefined) => {
  const t = (v ?? "").replace(/\s+/g, " ").trim();
  return t ? t : null;
};
const digits = (v: string | null) => (v ?? "").replace(/\D/g, "");
export const normName = (v: string | null | undefined) =>
  (v ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\b(inc|llc|corp|co|ltd|s de rl de cv|sa de cv)\b/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

const LAB_WORDS = /\b(lab|labs|laboratory|laboratories|assay|eurofins|testing|analytical|analysis|extraction)\b/i;
const PHARMA_PHONE = digits(SHIPPER.phone);
const OWN_STREET = "15851 sw 41";

function titleCaseIfShouting(v: string | null): string | null {
  if (!v || v !== v.toUpperCase() || !/[A-Z]{3}/.test(v)) return v;
  return v.toLowerCase().replace(/\b([a-z])/g, (m) => m.toUpperCase());
}

export type MatchLists = {
  customers: Array<{ id: string; name: string }>;
  vendors: Array<{ id: string; name: string }>;
  existing: Array<{ id: string; company: string | null; contact_name: string | null; street_lines: string[]; postal_code: string | null }>;
};

function findByName(list: Array<{ id: string; name: string }>, ...names: Array<string | null>) {
  for (const n of names) {
    const a = normName(n);
    if (a.length < 4) continue;
    const hit = list.find((c) => {
      const b = normName(c.name);
      return b.length >= 4 && (a === b || a.startsWith(b + " ") || b.startsWith(a + " ") || a.includes(b) || b.includes(a));
    });
    if (hit) return hit;
  }
  return null;
}

export function rowsFromFedexExport(text: string, lists: MatchLists): { rows: ImportRow[]; error: string | null } {
  const grid = parseCsv(text);
  if (grid.length < 2) return { rows: [], error: "empty" };
  const head = grid[0].map((h) => h.trim());
  const col = (name: string) => head.indexOf(name);
  for (const need of ["Nickname", "FullName", "Company", "AddressOne", "City", "CountryCode"]) {
    if (col(need) < 0) return { rows: [], error: "not_fedex_export" };
  }
  const get = (r: string[], name: string) => (col(name) >= 0 ? r[col(name)] : undefined);

  // PharmaCenter's own account is whichever account the "sender pays" rows
  // (BillCode 1) use most. Read from the file so no account number lives in code.
  const senderAccts = new Map<string, number>();
  for (const r of grid.slice(1)) {
    if (clean(get(r, "BillCode")) === "1") {
      const a = digits(clean(get(r, "BillAccountNumber")));
      if (a) senderAccts.set(a, (senderAccts.get(a) ?? 0) + 1);
    }
  }
  const ownAcct = [...senderAccts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

  const rows: ImportRow[] = grid.slice(1).map((r, i) => {
    const problems: string[] = [];
    const nickname = clean(get(r, "Nickname"));
    // Companies stay exactly as typed in FedEx (title-casing breaks acronyms
    // like USPL); only people's names and cities are tidied.
    let company = clean(get(r, "Company"));
    let contact = titleCaseIfShouting(clean(get(r, "FullName")));
    if (contact && /^attn:?\s*/i.test(contact)) contact = contact.replace(/^attn:?\s*/i, "");
    // FedEx keeps a branch as the whole company field: "(PLANTATION)" under
    // the contact "QUICK WEIGHT LOSS CENTER". Put the two back together.
    if (company && /^\(.*\)$/.test(company) && contact) {
      company = `${clean(get(r, "FullName"))} ${company}`;
      contact = null;
    }
    if (company && contact && normName(company) === normName(contact)) contact = null;
    if (!company && !contact) contact = nickname;

    const country = (clean(get(r, "CountryCode")) ?? "").toUpperCase();
    const street = [clean(get(r, "AddressOne")), clean(get(r, "AddressTwo"))]
      .filter((x): x is string => !!x)
      .map((x) => x.replace(/,+$/, "").slice(0, 35));
    const city = titleCaseIfShouting(clean(get(r, "City"))) ?? "";
    let zip = clean(get(r, "Zip"));
    if (zip && country === "US" && /^\d{9}$/.test(zip)) zip = `${zip.slice(0, 5)}-${zip.slice(5)}`;

    let phone = digits(clean(get(r, "PhoneNumber")));
    let phoneNote: string | null = null;
    if (!phone || /^(\d)\1+$/.test(phone)) {
      phone = PHARMA_PHONE;
      phoneNote = "placeholder";
    } else if (phone === PHARMA_PHONE) phoneNote = "pharmacenter";
    const ext = clean(get(r, "ExtensionNumber"));

    const billCode = clean(get(r, "BillCode"));
    const billAcct = digits(clean(get(r, "BillAccountNumber")));
    let billToAccount: string | null = null;
    if ((billCode === "2" || billCode === "3") && /^\d{9}$/.test(billAcct) && billAcct !== ownAcct) {
      billToAccount = billAcct;
    }

    const residentialFlag = clean(get(r, "ResidentialFlag"));
    const residential = residentialFlag === "R" ? true : residentialFlag === "C" ? false : null;

    const customer = findByName(lists.customers, company, nickname, contact);
    const vendor = customer ? null : findByName(lists.vendors, company, nickname, contact);
    const ownAddress = street.join(" ").toLowerCase().replace(/[.,]/g, "").includes(OWN_STREET);
    let kind: RecipientKind = "other";
    let kindReason = "no match";
    if (customer) {
      kind = "customer";
      kindReason = `Fishbowl customer: ${customer.name}`;
    } else if (vendor) {
      kind = "vendor";
      kindReason = `Fishbowl vendor: ${vendor.name}`;
    } else if (LAB_WORDS.test([company, nickname, contact].join(" "))) {
      kind = "lab";
      kindReason = "name looks like a lab";
    } else if (ownAddress) {
      kind = "other";
      kindReason = "PharmaCenter's own address";
    } else if (company) {
      kind = "prospect";
      kindReason = "company not in Fishbowl";
    }

    const ref = clean(get(r, "ReferenceDescription"));
    const notes =
      [
        nickname && normName(nickname) !== normName(company) && normName(nickname) !== normName(contact) && !/^\d{10,}$/.test(nickname)
          ? `FedEx nickname: ${nickname}`
          : null,
        ref ? `Last reference: ${ref}` : null,
        ext ? `Phone ext. ${ext}` : null,
        clean(get(r, "DeliveryInstructions")),
      ]
        .filter(Boolean)
        .join(" · ") || null;

    if (!street.length) problems.push("street");
    if (!city) problems.push("city");
    if (!/^[A-Z]{2}$/.test(country)) problems.push("country");

    const dup = lists.existing.find(
      (e) =>
        normName(e.company ?? e.contact_name) === normName(company ?? contact) &&
        normName(e.street_lines?.[0]) === normName(street[0]) &&
        (e.postal_code ?? "").slice(0, 5) === (zip ?? "").slice(0, 5),
    );

    return {
      key: `r${i}`,
      include: !dup && problems.length === 0,
      kind,
      kindReason,
      company: company ? company.slice(0, 35) : null,
      contactName: contact ? contact.slice(0, 35) : null,
      phone,
      phoneNote,
      email: clean(get(r, "EmailAddress")),
      streetLines: street.slice(0, 3),
      city: city.slice(0, 35),
      stateProvince: clean(get(r, "State")),
      postalCode: zip,
      countryCode: country,
      residential,
      billToAccount,
      customerId: customer?.id ?? null,
      vendorId: vendor?.id ?? null,
      notes,
      duplicateOf: dup?.id ?? null,
      problems,
    };
  });
  return { rows, error: null };
}
