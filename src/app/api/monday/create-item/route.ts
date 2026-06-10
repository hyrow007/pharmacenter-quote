import { NextResponse } from "next/server";
import { createClient } from "@/lib/auth/server";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { createQuoteItem, findUserByEmail } from "@/lib/monday";

const TYPE_LABELS: Record<string, string> = {
  "bulk": "Bulk",
  "contract-packaging": "Contract Packaging",
  "finished-product": "Finished Product",
  "other": "Other",
};
const FORM_LABELS: Record<string, string> = {
  "softgel": "Softgels",
  "gummy": "Gummies",
  "tablet": "Tablets",
  "capsule": "Capsules",
  "other": "Other",
};
const SOURCE_LABELS: Record<string, string> = {
  "third-party": "Third party",
  "pharmacenter": "Manufactured at PharmaCenter",
  "other": "Other source",
};

type Body = {
  type?: string;
  form?: string;
  source?: string;
  customer?: string;
  customerName?: string;
  product?: string;
  productName?: string;
  notes?: string;
};

export async function POST(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ ok: false, error: "not_signed_in" }, { status: 401 });
  }
  if (!user.email?.endsWith("@pharmacenterusa.com")) {
    return NextResponse.json({ ok: false, error: "wrong_domain" }, { status: 403 });
  }

  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return NextResponse.json({ ok: false, error: "bad_json" }, { status: 400 });
  }

  const sbUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const sbKey =
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ||
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!sbUrl || !sbKey) {
    return NextResponse.json({ ok: false, error: "supabase_not_configured" }, { status: 500 });
  }
  const dataClient = createSupabaseClient(sbUrl, sbKey);

  let customerName = body.customerName || "New customer";
  if (body.customer && body.customer !== "new") {
    const { data } = await dataClient
      .from("customers")
      .select("name")
      .eq("id", body.customer)
      .maybeSingle();
    if (data?.name) customerName = data.name;
  }

  let productName = body.productName || "New product";
  let productCode: string | null = null;
  if (body.product && body.product !== "new") {
    const { data } = await dataClient
      .from("products")
      .select("name, fp_code")
      .eq("id", body.product)
      .maybeSingle();
    if (data?.name) productName = data.name;
    if (data?.fp_code) productCode = data.fp_code;
  }

  const itemName = productCode
    ? `${productName} (${productCode})`
    : productName;

  const typeParts = [
    body.type ? TYPE_LABELS[body.type] || body.type : null,
    body.form ? FORM_LABELS[body.form] || body.form : null,
    body.source ? SOURCE_LABELS[body.source] || body.source : null,
  ].filter(Boolean) as string[];
  const typeLabel = typeParts.join(" · ");

  let submitterId: string | null = null;
  try {
    const mondayUser = await findUserByEmail(user.email);
    if (mondayUser) submitterId = mondayUser.id;
  } catch (err) {
    console.warn("Submitter lookup failed; continuing without it:", err);
  }

  try {
    const item = await createQuoteItem({
      itemName,
      customerName,
      typeLabel,
      submitterMondayId: submitterId,
    });
    return NextResponse.json({ ok: true, item });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("create_item failed:", msg);
    return NextResponse.json({ ok: false, error: msg }, { status: 502 });
  }
}

