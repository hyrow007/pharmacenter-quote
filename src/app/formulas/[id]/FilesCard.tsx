"use client";

// FilesCard — per-formula file attachments (v73). Each formula gets a
// collapsible "Files" card (sits with Notes/Activity) where the team
// parks CoAs, customer specs, label artwork, lab reports.
//
// Files attach at the FORMULA level, not per-version: documents
// shouldn't fork on every save. Binary lives in the public-read
// `formula-files` Supabase Storage bucket (uuid-prefixed paths, same
// tradeoff as quote-attachments); the gummy_formula_files table is the
// domain-gated listing layer (see sql/gummy_formula_files.sql).
//
// All I/O runs client-side through the shared supabase client — RLS is
// the enforcement, mirroring how src/lib/storage.ts handles workflow
// attachments. Delete is domain-wide (pruning someone else's stale CoA
// is routine ops work) but the UI double-confirms per row.

import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "@/lib/supabase";

const FILES_BUCKET = "formula-files";

type FormulaFile = {
  id: string;
  filename: string;
  storagePath: string;
  sizeBytes: number;
  mimeType: string | null;
  uploadedByEmail: string;
  uploadedAt: string;
};

function uid(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

// Storage keys disallow most non-ASCII characters — keep letters,
// numbers, .-_ and collapse the rest (same rule as storage.ts).
function safeFilename(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120);
}

function fmtSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function publicUrl(path: string): string {
  if (!supabase) return "#";
  return supabase.storage.from(FILES_BUCKET).getPublicUrl(path).data.publicUrl;
}

export default function FilesCard({
  formulaId,
  currentUserEmail,
}: {
  formulaId: string;
  currentUserEmail: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const [files, setFiles] = useState<FormulaFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploadingCount, setUploadingCount] = useState(0);
  const [dragOver, setDragOver] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const refresh = useCallback(async () => {
    if (!supabase) {
      setLoading(false);
      return;
    }
    const { data, error: err } = await supabase
      .from("gummy_formula_files")
      .select(
        "id, filename, storage_path, size_bytes, mime_type, uploaded_by_email, uploaded_at",
      )
      .eq("formula_id", formulaId)
      .order("uploaded_at", { ascending: false });
    if (err) {
      setError(err.message);
    } else {
      setFiles(
        (data ?? []).map((r) => ({
          id: r.id as string,
          filename: r.filename as string,
          storagePath: r.storage_path as string,
          sizeBytes: Number(r.size_bytes) || 0,
          mimeType: (r.mime_type as string | null) ?? null,
          uploadedByEmail: r.uploaded_by_email as string,
          uploadedAt: r.uploaded_at as string,
        })),
      );
    }
    setLoading(false);
  }, [formulaId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function uploadFiles(list: FileList | File[]) {
    if (!supabase) {
      setError("Storage client not configured.");
      return;
    }
    const picked = Array.from(list);
    if (picked.length === 0) return;
    setError(null);
    setUploadingCount((c) => c + picked.length);
    for (const file of picked) {
      const path = `formulas/${formulaId}/${uid()}-${safeFilename(file.name)}`;
      const { error: upErr } = await supabase.storage
        .from(FILES_BUCKET)
        .upload(path, file, {
          cacheControl: "3600",
          upsert: false,
          contentType: file.type || "application/octet-stream",
        });
      if (upErr) {
        setError(`Upload failed for ${file.name}: ${upErr.message}`);
        setUploadingCount((c) => c - 1);
        continue;
      }
      const { error: rowErr } = await supabase.from("gummy_formula_files").insert({
        formula_id: formulaId,
        filename: file.name,
        storage_path: path,
        size_bytes: file.size,
        mime_type: file.type || null,
        uploaded_by_email: currentUserEmail,
      });
      if (rowErr) {
        // Orphaned binary is worse than a failed upload — clean it up.
        await supabase.storage.from(FILES_BUCKET).remove([path]);
        setError(`Couldn't record ${file.name}: ${rowErr.message}`);
      }
      setUploadingCount((c) => c - 1);
    }
    await refresh();
  }

  async function deleteFile(f: FormulaFile) {
    if (!supabase) return;
    setError(null);
    // Row first (RLS is the gate), then the binary — a leftover object
    // with no row is invisible; a row with no object is a broken link.
    const { error: rowErr } = await supabase
      .from("gummy_formula_files")
      .delete()
      .eq("id", f.id);
    if (rowErr) {
      setError(`Couldn't delete ${f.filename}: ${rowErr.message}`);
      return;
    }
    await supabase.storage.from(FILES_BUCKET).remove([f.storagePath]);
    setConfirmDeleteId(null);
    await refresh();
  }

  const countLabel = loading
    ? "loading…"
    : files.length === 0
      ? "no files yet"
      : `${files.length} file${files.length === 1 ? "" : "s"}`;

  return (
    <section
      className="fe-print-hide"
      style={{
        marginTop: 24,
        border: "1px solid var(--line, #e3dcc9)",
        borderRadius: 8,
        background: "var(--paper, #fffdf8)",
        overflow: "hidden",
      }}
    >
      <button
        type="button"
        onClick={() => setExpanded((s) => !s)}
        aria-expanded={expanded}
        style={{
          width: "100%",
          padding: "10px 14px",
          background: "var(--cream, #f6efe3)",
          borderTop: "none",
          borderLeft: "none",
          borderRight: "none",
          borderBottom: expanded
            ? "1.5px solid var(--teal-700, #1d6c7b)"
            : "none",
          display: "flex",
          alignItems: "center",
          gap: 8,
          cursor: "pointer",
          textAlign: "left",
        }}
      >
        <span
          aria-hidden="true"
          style={{
            fontSize: 10,
            color: "var(--teal-900, #0f4a56)",
            transform: expanded ? "rotate(90deg)" : "rotate(0deg)",
            transition: "transform 120ms ease",
            display: "inline-block",
            width: 10,
          }}
        >
          ▶
        </span>
        <span
          style={{
            fontSize: 10.5,
            fontWeight: 700,
            letterSpacing: "0.14em",
            textTransform: "uppercase",
            color: "var(--teal-900, #0f4a56)",
          }}
        >
          Files
        </span>
        <span style={{ fontSize: 11, color: "var(--ink-3, #8a9498)" }}>
          {countLabel}
        </span>
        <span style={{ flex: 1 }} />
        <span
          style={{
            fontSize: 10.5,
            fontWeight: 700,
            letterSpacing: "0.08em",
            textTransform: "uppercase",
            color: "var(--teal-700, #1d6c7b)",
          }}
        >
          {expanded ? "Hide" : "Show"}
        </span>
      </button>

      {expanded ? (
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={(e) => {
            const nxt = e.relatedTarget as Node | null;
            if (nxt && e.currentTarget.contains(nxt)) return;
            setDragOver(false);
          }}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(false);
            void uploadFiles(e.dataTransfer.files);
          }}
          style={{
            padding: 14,
            background: dragOver ? "var(--cream-soft, #fbf6ec)" : undefined,
            outline: dragOver
              ? "2px dashed var(--teal-700, #1d6c7b)"
              : "none",
            outlineOffset: -6,
          }}
        >
          {/* Upload row */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              marginBottom: files.length > 0 ? 12 : 0,
            }}
          >
            <input
              ref={inputRef}
              type="file"
              multiple
              style={{ display: "none" }}
              onChange={(e) => {
                if (e.target.files) void uploadFiles(e.target.files);
                e.target.value = "";
              }}
            />
            <button
              type="button"
              onClick={() => inputRef.current?.click()}
              style={{
                padding: "7px 14px",
                background: "var(--paper, #fffdf8)",
                border: "1px solid var(--teal-700, #1d6c7b)",
                borderRadius: 6,
                fontSize: 11.5,
                fontWeight: 700,
                letterSpacing: "0.06em",
                textTransform: "uppercase",
                color: "var(--teal-900, #0f4a56)",
                cursor: "pointer",
                whiteSpace: "nowrap",
              }}
            >
              + Add files
            </button>
            <span style={{ fontSize: 11.5, color: "var(--ink-3, #8a9498)" }}>
              {uploadingCount > 0
                ? `Uploading ${uploadingCount} file${uploadingCount === 1 ? "" : "s"}…`
                : "or drag files anywhere on this card"}
            </span>
          </div>

          {error ? (
            <div
              style={{
                margin: "8px 0",
                padding: "8px 10px",
                fontSize: 12,
                color: "#7a2e22",
                background: "#f9e9e5",
                border: "1px solid #e5b8ad",
                borderRadius: 6,
              }}
            >
              {error}
            </div>
          ) : null}

          {/* File rows */}
          {files.map((f) => (
            <div
              key={f.id}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                padding: "8px 2px",
                borderTop: "1px solid var(--line-2, #efe9da)",
              }}
            >
              <a
                href={publicUrl(f.storagePath)}
                target="_blank"
                rel="noreferrer"
                style={{
                  fontSize: 13,
                  fontWeight: 600,
                  color: "var(--teal-700, #1d6c7b)",
                  textDecoration: "none",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  maxWidth: 420,
                }}
                title={f.filename}
              >
                {f.filename}
              </a>
              <span style={{ fontSize: 11, color: "var(--ink-3, #8a9498)" }}>
                {fmtSize(f.sizeBytes)}
              </span>
              <span style={{ flex: 1 }} />
              <span style={{ fontSize: 11, color: "var(--ink-3, #8a9498)" }}>
                {f.uploadedByEmail.split("@")[0]} ·{" "}
                {new Date(f.uploadedAt).toLocaleDateString("en-US", {
                  month: "short",
                  day: "numeric",
                  year: "numeric",
                })}
              </span>
              {confirmDeleteId === f.id ? (
                <span style={{ display: "inline-flex", gap: 4 }}>
                  <button
                    type="button"
                    onClick={() => void deleteFile(f)}
                    style={{
                      padding: "3px 10px",
                      background: "#a13a2a",
                      color: "#fff",
                      border: "none",
                      borderRadius: 4,
                      fontSize: 11,
                      fontWeight: 700,
                      letterSpacing: "0.04em",
                      textTransform: "uppercase",
                      cursor: "pointer",
                    }}
                  >
                    Delete
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmDeleteId(null)}
                    style={{
                      padding: "3px 10px",
                      background: "transparent",
                      color: "var(--ink-2, #4a5c60)",
                      border: "1px solid var(--line, #e3dcc9)",
                      borderRadius: 4,
                      fontSize: 11,
                      fontWeight: 600,
                      cursor: "pointer",
                    }}
                  >
                    Keep
                  </button>
                </span>
              ) : (
                <button
                  type="button"
                  onClick={() => setConfirmDeleteId(f.id)}
                  title="Delete file"
                  aria-label={`Delete ${f.filename}`}
                  style={{
                    width: 26,
                    height: 26,
                    background: "transparent",
                    border: "1px solid var(--line, #e3dcc9)",
                    borderRadius: 6,
                    color: "var(--ink-3, #8a9498)",
                    fontSize: 13,
                    fontWeight: 700,
                    cursor: "pointer",
                    lineHeight: 1,
                  }}
                >
                  ×
                </button>
              )}
            </div>
          ))}

          {!loading && files.length === 0 ? (
            <div
              style={{
                marginTop: 10,
                padding: "14px 12px",
                fontSize: 12,
                color: "var(--ink-3, #8a9498)",
                border: "1px dashed var(--line, #e3dcc9)",
                borderRadius: 6,
                textAlign: "center",
              }}
            >
              No files yet. CoAs, customer specs, label artwork, lab reports —
              anything that belongs to this formula.
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
