import { NextResponse } from "next/server";
import { createClient } from "@/lib/auth/server";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { QUOTES_COLUMNS, createQuoteItem, findUserByEmail, postUpdate, uploadFileToColumn } from "@/lib/monday";

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
  quantities?: string[];
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

  // Body is either JSON (no attachments) or multipart/form-data (with files).
  // In multipart, the JSON payload is the "data" field and each File is
  // appended under "files".
  let body: Body;
  const attachments: File[] = [];
  const contentType = request.headers.get("content-type") ?? "";
  try {
    if (contentType.startsWith("multipart/form-data")) {
      const fd = await request.formData();
      const dataStr = fd.get("data");
      body = JSON.parse(typeof dataStr === "string" ? dataStr : "{}") as Body;
      for (const v of fd.getAll("files")) {
        if (v instanceof File) attachments.push(v);
      }
    } else {
      body = (await request.json()) as Body;
    }
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

  const cleanQuantities = (body.quantities ?? [])
    .map((q) => String(q).trim())
    .filter((q) => q.length > 0 && /^\d+(\.\d+)?$/.test(q));
  const qtyJoined = cleanQuantities.map((q) => Number(q).toLocaleString()).join(" / ");
  const qtyTail = qtyJoined ? ` — ${qtyJoined} units` : "";
  const qtyColumnText = qtyJoined ? (body.type === "bulk" ? `${qtyJoined} units (1 unit = 1,000)` : `${qtyJoined} units`) : "";

  const itemName = (productCode
    ? `${productName} (${productCode})`
    : productName) + qtyTail;

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
      qtyText: qtyColumnText, submitterMondayId: submitterId,
    });

    // Compose the Rosy comment that introduces the quote on the item.
    const lines: string[] = [
      "Hi Rosy,",
      "",
      "Can we please start the quoting process for the following:",
      "",
      `• Customer: ${customerName}`,
      `• Quote type: ${typeLabel || "—"}`,
      productCode
        ? `• Product: ${productName} (${productCode})`
        : `• Product: ${productName}`,
    ];
    if (cleanQuantities.length > 0) {
      lines.push(
        `• Quantities: ${cleanQuantities.map((q) => Number(q).toLocaleString()).join(" / ")} units${body.type === "bulk" ? " (1 unit = 1,000)" : ""}`,
      );
    }
    if (body.notes?.trim()) {
      lines.push(`• Notes: ${body.notes.trim()}`);
    }
    if (attachments.length > 0) {
      lines.push(
        `• Attachments: ${attachments.length} file${attachments.length === 1 ? "" : "s"} uploaded — see the Files column.`,
      );
    }
    const updateBody = lines.join("\n");

    // Upload attachments first so the comment's "see Files column" pointer is
    // accurate by the time Rosy reads it. Errors per file are logged but
    // don't fail the whole request.
    const uploadResults = await Promise.all(
      attachments.map((f) => uploadFileToColumn(item.id, QUOTES_COLUMNS.files, f)),
    );
    const uploadedCount = uploadResults.filter((r) => r !== null).length;

    // Post the comment. Failure here is non-fatal — the item is already created.
    await postUpdate(item.id, updateBody);

    return NextResponse.json({
      ok: true,
      item,
      uploaded: uploadedCount,
      attempted: attachments.length,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("create_item failed:", msg);
    return NextResponse.json({ ok: false, error: msg }, { status: 502 });
  }
}
