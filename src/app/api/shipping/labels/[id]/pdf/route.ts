import { NextResponse } from "next/server";
import { shipGate } from "@/app/shipping/_lib/gate";

// GET /api/shipping/labels/[id]/pdf -- the label PDF, for printing and
// reprinting. The bucket is private; any signed-in employee may reprint any
// label (anyone may ship), read here with the service role.

export const runtime = "nodejs";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await shipGate();
  if (!g.ok) return NextResponse.json({ ok: false, error: g.error }, { status: 401 });
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ ok: false, error: "bad_id" }, { status: 400 });
  const { data: row } = await g.supabase
    .from("shipping_labels")
    .select("label_path, tracking_number")
    .eq("id", id)
    .maybeSingle();
  const path = (row as { label_path?: string | null } | null)?.label_path;
  if (!path) return NextResponse.json({ ok: false, error: "no_label" }, { status: 404 });
  const { data, error } = await g.service.storage.from("shipping-labels").download(path);
  if (error || !data) return NextResponse.json({ ok: false, error: "storage" }, { status: 502 });
  const tracking = (row as { tracking_number?: string | null }).tracking_number ?? id;
  return new Response(await data.arrayBuffer(), {
    headers: {
      "content-type": "application/pdf",
      "content-disposition": `inline; filename="FedEx-${tracking}.pdf"`,
      "cache-control": "private, no-store",
    },
  });
}
