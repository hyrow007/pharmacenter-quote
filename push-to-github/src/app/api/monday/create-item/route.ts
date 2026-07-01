import { NextResponse } from "next/server";
import { createClient } from "@/lib/auth/server";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { QUOTES_COLUMNS, createQuoteItem, findUserByEmail, postUpdate, uploadFileToColumn } from "@/lib/monday";

// POST /api/monday/create-item
//
// Auth: requires a signed-in Supabase user (Google SSO restricted to
// pharmacenterusa.com).
//
// Body shape (v2 — multi-product):
//   {
//     type: "bulk" | "contract-packaging" | "finished-product" | "other",
//     form?: string,
//     source?: string,
//     customer: "<uuid>" | "new",
//     customerName?: string,
//     newCustomer?: { name, contact, email },
//     products: [
//       {
//         productId: "<uuid>" | "new" | null,
//         productName: string | null,
//         productCode: string | null,
//         notes: string,
//         quantities: string[],
//         attachments: [{ path, name, size, type, url }, ...],
//       },
//       ...
//     ],
//   }
//
// Response: { ok: true, item: { id, url }, uploaded, attempted } or { ok: false, error }

const TYPE_LABELS: Record<string, string> = {
  "bulk": "Bulk",
  "contract-packaging": "Contract Packaging",
  "finished-product": "Finished Product",
  "other": "Other",
};
const FORM_LABELS: Record<string, string> = {
  "softgel": "Softgels", "gummy": "Gummies", "tablet": "Tablets", "capsule": "Capsules", "other": "Other",
};
const SOURCE_LABELS: Record<string, string> = {
  "third-party": "Third party",
  "pharmacenter": "Manufactured at PharmaCenter",
  "other": "Other source",
};

type Attachment = {
  path: string;
  name: string;
  size: number;
  type: string;
  url: string;
};

type ProductPayload = {
  productId?: string | null;
  productName?: string | null;
  productCode?: string | null;
  notes?: string;
  quantities?: string[];
  attachments?: Attachment[];
};

type Body = {
  type?: string;
  form?: string;
  source?: string;
  customer?: string;
  customerName?: string;
  newCustomer?: { name?: string; contact?: string; email?: string };
  products?: ProductPayload[];
};

// Fetch a file from Supabase Storage (public URL) and wrap it as a File for
// monday's multipart upload helper. We use the runtime File class (Vercel
// node 20+ has it global). For older runtimes, the Blob would also work.
async function fetchAttachmentAsFile(att: Attachment): Promise<File | null> {
  try {
    const res = await fetch(att.url, { cache: "no-store" });
    if (!res.ok) {
      console.error(`Attachment fetch failed: ${att.url} -> ${res.status}`);
      return null;
    }
    const ab = await res.arrayBuffer();
    return new File([ab], att.name, { type: att.type || "application/octet-stream" });
  } catch (err) {
    console.error(`Attachment fetch errored: ${att.url}`, err);
    return null;
  }
}

export async function POST(request: Request) {
  // 1. Gate on Supabase Auth.
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ ok: false, error: "not_signed_in" }, { status: 401 });
  }
  if (!user.email?.endsWith("@pharmacenterusa.com")) {
    return NextResponse.json({ ok: false, error: "wrong_domain" }, { status: 403 });
  }

  // 2. Parse body. v2 is always JSON (no multipart) since attachments now
  // ride along as URLs to Supabase Storage.
  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return NextResponse.json({ ok: false, error: "bad_json" }, { status: 400 });
  }

  // 3. Resolve customer + product names via a public-data Supabase client
  // (publishable key — rows are anon-readable, synced from Fishbowl).
  const sbUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const sbKey =
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ||
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!sbUrl || !sbKey) {
    return NextResponse.json({ ok: false, error: "supabase_not_configured" }, { status: 500 });
  }
  const dataClient = createSupabaseClient(sbUrl, sbKey);

  // Customer name resolution.
  let customerName = body.customerName || body.newCustomer?.name || "New customer";
  if (body.customer && body.customer !== "new") {
    const { data } = await dataClient
      .from("customers")
      .select("name")
      .eq("id", body.customer)
      .maybeSingle();
    if (data?.name) customerName = data.name;
  }

  // Resolve product names/codes for any "existing" products that came in
  // without them (defensive — the client should send productName/productCode,
  // but we re-resolve fro