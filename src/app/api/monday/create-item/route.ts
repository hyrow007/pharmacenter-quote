import { NextResponse } from "next/server";
import { createClient } from "@/lib/auth/server";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import {
  QUOTES_COLUMNS,
  createQuoteItem,
  findUserByEmail,
  postUpdate,
  uploadFileToColumn,
} from "@/lib/monday";

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

async function fetchAttachmentAsBlob(att: Attachment): Promise<Blob | null> {
  try {
    const res = await fetch(att.url, { cache: "no-store" });
    if (!res.ok) {
      console.error(`Attachment fetch failed: ${att.url} -> ${res.status}`);
      return null;
    }
    const ab = await res.arrayBuffer();
    return new Blob([ab], { type: att.type || "application/octet-stream" });
  } catch (err) {
    console.error(`Attachment fetch errored: ${att.url}`, err);
    return null;
  }
}

export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
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

  let customerName = body.customerName || body.newCustomer?.name || "New customer";
  if (body.customer && body.customer !== "new") {
    const { data } = await dataClient
      .from("customers")
      .select("name")
      .eq("id", body.customer)
      .maybeSingle();
    if (data?.name) customerName = data.name;
  }

  const productIdsToResolve = (body.products ?? [])
    .map((p) => p.productId)
    .filter((id): id is string => !!id && id !== "new");
  const resolvedProducts: Record<string, { name: string | null; fp_code: string | null }> = {};
  if (productIdsToResolve.length > 0) {
    const { data } = await dataClient.from("products")
      .select("id, name, fp_code")
      .in("id", productIdsToResolve);
    for (const row of (data ?? []) as Array<{ id: string; name: string | null; fp_code: string | null }>) {
      resolvedProducts[row.id] = { name: row.name, fp_code: row.fp_code };
    }
  }

  const products = (body.products ?? []).map((p) => {
    const resolved = p.productId && p.productId !== "new" ? resolvedProducts[p.productId] : null;
    const name = (resolved?.name) ?? p.productName ?? "New product";
    const code = (resolved?.fp_code) ?? p.productCode ?? null;
    const cleanQs = (p.quantities ?? [])
      .map((q) => String(q).trim())
      .filter((q) => q.length > 0 && /^\d+(\.\d+)?$/.test(q));
    return {
      name,
      code,
      notes: (p.notes ?? "").trim(),
      qtys: cleanQs,
      attachments: p.attachments ?? [],
    };
  });

  let itemName: string;
  if (products.length === 1) {
    const p = products[0];
    const qtyJoined = p.qtys.map((q) => Number(q).toLocaleString()).join(" / ");
    const tail = qtyJoined ? ` — ${qtyJoined} units` : "";
    itemName = (p.code ? `${p.name} (${p.code})` : p.name) + tail;
  } else if (products.length > 1) {
    itemName = `${customerName} — ${products.length} products`;
  } else {
    itemName = `${customerName} — quote request`;
  }

  const typeParts = [
    body.type ? TYPE_LABELS[body.type] || body.type : null,
    body.form ? FORM_LABELS[body.form] || body.form : null,
    body.source ? SOURCE_LABELS[body.source] || body.source : null,
  ].filter(Boolean) as string[];
  const typeLabel = typeParts.join(" · ");

  const isBulk = body.type === "bulk";
  let qtyColumnText = "";
  if (products.length === 1) {
    const qtyJoined = products[0].qtys.map((q) => Number(q).toLocaleString()).join(" / ");
    if (qtyJoined) {
      qtyColumnText = isBulk
        ? `${qtyJoined} units (1 unit = 1,000)`
        : `${qtyJoined} units`;
    }
  } else if (products.length > 1) {
    const parts: string[] = [];
    for (const p of products) {
      const qtyJoined = p.qtys.map((q) => Number(q).toLocaleString()).join(" / ");
      if (qtyJoined) parts.push(`${p.name}: ${qtyJoined}`);
    }
    if (parts.length > 0) {
      qtyColumnText = parts.join(" | ") + (isBulk ? " (units of 1,000)" : " units");
    }
  }

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
      qtyText: qtyColumnText,
      submitterMondayId: submitterId,
    });

    const lines: string[] = [
      "Hi Rosy,",
      "",
      "Can we please start the quoting process for the following:",
      "",
      `• Customer: ${customerName}`,
      `• Quote type: ${typeLabel || "—"}`,
    ];

    if (products.length === 1) {
      const p = products[0];
      lines.push(p.code ? `• Product: ${p.name} (${p.code})` : `• Product: ${p.name}`);
      if (p.qtys.length > 0) {
        const unitNote = isBulk ? " (1 unit = 1,000)" : "";
        lines.push(`• Quantities: ${p.qtys.map((q) => Number(q).toLocaleString()).join(" / ")} units${unitNote}`);
      }
      if (p.notes) lines.push(`• Notes: ${p.notes}`);
    } else {
      lines.push(`• Products (${products.length}):`);
      for (const p of products) {
        const header = p.code ? `${p.name} (${p.code})` : p.name;
        lines.push(`    – ${header}`);
        if (p.qtys.length > 0) {
          const unitNote = isBulk ? " (1 unit = 1,000)" : "";
          lines.push(`        Quantities: ${p.qtys.map((q) => Number(q).toLocaleString()).join(" / ")} units${unitNote}`);
        }
        if (p.notes) lines.push(`        Notes: ${p.notes}`);
        if (p.attachments.length > 0) {
          lines.push(`        Attachments: ${p.attachments.length} file${p.attachments.length === 1 ? "" : "s"}`);
        }
      }
    }

    const totalAttachments = products.reduce((n, p) => n + p.attachments.length, 0);
    if (products.length === 1 && totalAttachments > 0) {
      lines.push(`• Attachments: ${totalAttachments} file${totalAttachments === 1 ? "" : "s"} uploaded — see the Files column.`);
    } else if (products.length > 1 && totalAttachments > 0) {
      lines.push(`• Attachments total: ${totalAttachments} file${totalAttachments === 1 ? "" : "s"} — see the Files column.`);
    }

    const updateBody = lines.join("\n");

    const allAttachments: Attachment[] = products.flatMap((p) => p.attachments);
    const uploadResults = await Promise.all(
      allAttachments.map(async (att) => {
        const blob = await fetchAttachmentAsBlob(att);
        if (!blob) return null;
        return uploadFileToColumn(item.id, QUOTES_COLUMNS.files, blob, att.name);
      }),
    );
    const uploadedCount = uploadResults.filter((r) => r !== null).length;

    await postUpdate(item.id, updateBody);

    return NextResponse.json({
      ok: true,
      item,
      uploaded: uploadedCount,
      attempted: allAttachments.length,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("create_item failed:", msg);
    return NextResponse.json({ ok: false, error: msg }, { status: 502 });
  }
}
