import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

// Per-formula file attachments (Files card).
//
// GET  /api/formulas/[id]/files
//   → { ok: true, files: FormulaFilePayload[] }  (newest first)
// POST /api/formulas/[id]/files
//   { action: "sign", filename, sizeBytes?, mimeType? }
//     → { ok: true, path, token, signedUrl }
//       Client PUTs the raw file body to signedUrl, then commits.
//   { action: "commit", path, filename, sizeBytes, mimeType? }
//     → { ok: true, file: FormulaFilePayload }
//
// Why the two-step signed-URL dance instead of a multipart POST through
// this route: Vercel serverless caps request bodies at ~4.5 MB, and label
// artwork / CoA scans routinely exceed that. Signing here (cookie-authed,
// so the storage insert RLS check runs against the real user) and
// uploading browser→storage directly keeps the function out of the data
// path entirely. The browser supabase client is anonymous (auth lives in
// httpOnly cookies), which is also why none of this can run client-side.
//
// Auth gate matches the notes/audit routes: signed in + company domain.
// uploaded_by_email is always derived from the session, never the client.

const FILES_BUCKET = "formula-files";

type GateResult =
  | { error: NextResponse; supabase?: undefined; user?: undefined }
  | {
      error?: undefined;
      supabase: Awaited<ReturnType<typeof createClient>>;
      user: { email: string };
    };

async function gatedClient(): Promise<GateResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return {
      error: NextResponse.json({ ok: false, error: "not_signed_in" }, { status: 401 }),
    };
  }
  if (!user.email?.endsWith("@pharmacenterusa.com")) {
    return {
      error: NextResponse.json({ ok: false, error: "wrong_domain" }, { status: 403 }),
    };
  }
  return { supabase, user: { email: user.email } };
}

function uid(): string {
  return crypto.randomUUID();
}

// Storage keys reject most non-ASCII characters — same rule as
// src/lib/storage.ts uses for quote attachments.
function safeFilename(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120) || "file";
}

// How long a view link stays good. The list is signed at render, so a link is
// always fresh when the card first draws; this is the window for a tab left
// open. Long enough that nobody hits a dead link mid-session, short enough
// that a URL pasted into a chat stops working the same day.
const VIEW_URL_TTL_SECONDS = 60 * 60;

// Was publicUrlFor(), which hand-built
// `${base}/storage/v1/object/public/formula-files/${path}` -- an endpoint that
// does not consult RLS at all, so every formula document was readable by
// anyone who had or guessed the URL, signed in or not. Replaced 2026-09-20
// when the bucket was made private.

type FileRow = {
  id: string;
  filename: string;
  storage_path: string;
  size_bytes: number;
  mime_type: string | null;
  uploaded_by_email: string;
  uploaded_at: string;
};

function filePayload(row: FileRow, url: string | null) {
  return {
    id: row.id,
    filename: row.filename,
    storagePath: row.storage_path,
    // Named `url`, not `publicUrl`, because it is no longer public and a name
    // that lies is how the old behaviour survived review for as long as it did.
    url,
    sizeBytes: Number(row.size_bytes) || 0,
    mimeType: row.mime_type,
    uploadedByEmail: row.uploaded_by_email,
    uploadedAt: row.uploaded_at,
  };
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const gated = await gatedClient();
  if (gated.error) return gated.error;
  const { supabase } = gated;
  const { id } = await params;

  const { data, error } = await supabase
    .from("gummy_formula_files")
    .select(
      "id, filename, storage_path, size_bytes, mime_type, uploaded_by_email, uploaded_at",
    )
    .eq("formula_id", id)
    .order("uploaded_at", { ascending: false });

  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  const rows = (data ?? []) as FileRow[];

  // One round trip for the whole list rather than one per file. A path that
  // fails to sign yields url: null, and the card renders the row without a
  // link instead of a link that 400s.
  const signed = new Map<string, string>();
  if (rows.length > 0) {
    const { data: urls } = await supabase.storage
      .from(FILES_BUCKET)
      .createSignedUrls(
        rows.map((r) => r.storage_path),
        VIEW_URL_TTL_SECONDS,
      );
    for (const u of urls ?? []) {
      if (u.path && u.signedUrl) signed.set(u.path, u.signedUrl);
    }
  }

  return NextResponse.json({
    ok: true,
    files: rows.map((r) => filePayload(r, signed.get(r.storage_path) ?? null)),
  });
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const gated = await gatedClient();
  if (gated.error) return gated.error;
  const { supabase, user } = gated;
  const { id } = await params;

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }

  const action = typeof body.action === "string" ? body.action : "";

  if (action === "sign") {
    const filename = typeof body.filename === "string" ? body.filename : "";
    if (!filename) {
      return NextResponse.json({ ok: false, error: "missing_filename" }, { status: 400 });
    }
    const path = `formulas/${id}/${uid()}-${safeFilename(filename)}`;
    const { data, error } = await supabase.storage
      .from(FILES_BUCKET)
      .createSignedUploadUrl(path);
    if (error || !data) {
      return NextResponse.json(
        { ok: false, error: error?.message ?? "sign_failed" },
        { status: 500 },
      );
    }
    return NextResponse.json({
      ok: true,
      path: data.path,
      token: data.token,
      signedUrl: data.signedUrl,
    });
  }

  if (action === "commit") {
    const path = typeof body.path === "string" ? body.path : "";
    const filename = typeof body.filename === "string" ? body.filename : "";
    const sizeBytes = Number(body.sizeBytes) || 0;
    const mimeType =
      typeof body.mimeType === "string" && body.mimeType ? body.mimeType : null;
    // Only accept paths this route itself would have signed — a commit for
    // an arbitrary path would let a caller register objects outside this
    // formula's folder.
    if (!path.startsWith(`formulas/${id}/`) || !filename) {
      return NextResponse.json({ ok: false, error: "bad_commit" }, { status: 400 });
    }
    const { data, error } = await supabase
      .from("gummy_formula_files")
      .insert({
        formula_id: id,
        filename,
        storage_path: path,
        size_bytes: sizeBytes,
        mime_type: mimeType,
        uploaded_by_email: user.email,
      })
      .select(
        "id, filename, storage_path, size_bytes, mime_type, uploaded_by_email, uploaded_at",
      )
      .single();
    if (error || !data) {
      // Don't leave the binary orphaned if the metadata insert failed.
      await supabase.storage.from(FILES_BUCKET).remove([path]);
      return NextResponse.json(
        { ok: false, error: error?.message ?? "commit_failed" },
        { status: 500 },
      );
    }
    // Sign the freshly committed file too, so the card can link it without
    // refetching the list.
    const row = data as FileRow;
    const { data: signedOne } = await supabase.storage
      .from(FILES_BUCKET)
      .createSignedUrl(row.storage_path, VIEW_URL_TTL_SECONDS);
    return NextResponse.json({
      ok: true,
      file: filePayload(row, signedOne?.signedUrl ?? null),
    });
  }

  return NextResponse.json({ ok: false, error: "unknown_action" }, { status: 400 });
}
