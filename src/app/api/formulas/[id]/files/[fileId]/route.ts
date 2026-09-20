import { NextResponse } from "next/server";
import { createClient } from "@/lib/auth/server";

// DELETE /api/formulas/[id]/files/[fileId] → { ok: true }
//
// Row first (RLS on gummy_formula_files is the real gate), then the
// storage object — a leftover object with no row is invisible to the UI,
// whereas a row with no object is a broken link. Delete is domain-wide,
// not author-only (pruning someone else's stale CoA is routine ops work);
// the Files card double-confirms in the UI instead.

const FILES_BUCKET = "formula-files";

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string; fileId: string }> },
) {
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

  const { id, fileId } = await params;

  const { data: row, error: findErr } = await supabase
    .from("gummy_formula_files")
    .select("id, storage_path")
    .eq("id", fileId)
    .eq("formula_id", id)
    .maybeSingle();
  if (findErr) {
    return NextResponse.json({ ok: false, error: findErr.message }, { status: 500 });
  }
  if (!row) {
    return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  }

  const { error: delErr } = await supabase
    .from("gummy_formula_files")
    .delete()
    .eq("id", fileId);
  if (delErr) {
    return NextResponse.json({ ok: false, error: delErr.message }, { status: 500 });
  }

  await supabase.storage.from(FILES_BUCKET).remove([row.storage_path]);

  return NextResponse.json({ ok: true });
}
