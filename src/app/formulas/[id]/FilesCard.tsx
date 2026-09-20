"use client";

// FilesCard — per-formula file attachments (v73). Each formula gets a
// collapsible "Files" card (sits with Notes/Activity) where the team
// parks CoAs, customer specs, label artwork, lab reports.
//
// Files attach at the FORMULA level, not per-version: documents
// shouldn't fork on every save. Binary lives in the public-read
// `formula-files` Supabase Storage bucket; gummy_formula_files is the
// metadata layer (see sql/gummy_formula_files.sql).
//
// All I/O goes through /api/formulas/[id]/files — the browser supabase
// client is anonymous (auth lives in httpOnly cookies), so like notes
// and audit, only server routes can act as the signed-in user. Uploads
// use the sign → PUT → commit dance: the route signs a storage URL
// (RLS-checked against the real user), the browser PUTs the raw file
// straight to storage (dodging Vercel's ~4.5 MB body cap), then the
// route records the metadata row. Delete is domain-wide, not
// author-only — pruning someone else's stale CoA is routine ops work —
// so the UI double-confirms per row instead.

import { useCallback, useEffect, useRef, useState } from "react";

type FormulaFile = {
  id: string;
  filename: string;
  storagePath: string;
  /** Signed view URL, or null when signing failed. Not public: the
   *  formula-files bucket is private as of 2026-09-20. */
  url: string | null;
  sizeBytes: number;
  mimeType: string | null;
  uploadedByEmail: string;
  uploadedAt: string;
};

function fmtSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function FilesCard({ formulaId }: { formulaId: string }) {
  const [expanded, setExpanded] = useState(false);
  const [files, setFiles] = useState<FormulaFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploadingCount, setUploadingCount] = useState(0);
  const [dragOver, setDragOver] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`/api/formulas/${formulaId}/files`);
      const json = (await res.json()) as {
        ok: boolean;
        files?: FormulaFile[];
        error?: string;
      };
      if (json.ok && json.files) {
        setFiles(json.files);
      } else {
        setError(json.error ?? "Couldn't load files.");
      }
    } catch {
      setError("Couldn't load files.");
    }
    setLoading(false);
  }, [formulaId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function uploadOne(file: File): Promise<string | null> {
    // 1. Ask the server to sign a storage path for this file.
    const signRes = await fetch(`/api/formulas/${formulaId}/files`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "sign",
        filename: file.name,
        sizeBytes: file.size,
        mimeType: file.type || null,
      }),
    });
    const sign = (await signRes.json()) as {
      ok: boolean;
      path?: string;
      signedUrl?: string;
      error?: string;
    };
    if (!sign.ok || !sign.signedUrl || !sign.path) {
      return sign.error ?? "sign failed";
    }

    // 2. PUT the raw bytes straight to storage (browser → Supabase).
    const putRes = await fetch(sign.signedUrl, {
      method: "PUT",
      headers: {
        "content-type": file.type || "application/octet-stream",
        "x-upsert": "false",
      },
      body: file,
    });
    if (!putRes.ok) {
      return `storage upload failed (${putRes.status})`;
    }

    // 3. Record the metadata row.
    const commitRes = await fetch(`/api/formulas/${formulaId}/files`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "commit",
        path: sign.path,
        filename: file.name,
        sizeBytes: file.size,
        mimeType: file.type || null,
      }),
    });
    const commit = (await commitRes.json()) as { ok: boolean; error?: string };
    if (!commit.ok) {
      return commit.error ?? "commit failed";
    }
    return null;
  }

  async function uploadFiles(list: FileList | File[]) {
    const picked = Array.from(list);
    if (picked.length === 0) return;
    setError(null);
    setUploadingCount((c) => c + picked.length);
    for (const file of picked) {
      try {
        const err = await uploadOne(file);
        if (err) setError(`Upload failed for ${file.name}: ${err}`);
      } catch {
        setError(`Upload failed for ${file.name}.`);
      }
      setUploadingCount((c) => c - 1);
    }
    await refresh();
  }

  async function deleteFile(f: FormulaFile) {
    setError(null);
    try {
      const res = await fetch(`/api/formulas/${formulaId}/files/${f.id}`, {
        method: "DELETE",
      });
      const json = (await res.json()) as { ok: boolean; error?: string };
      if (!json.ok) {
        setError(`Couldn't delete ${f.filename}: ${json.error ?? "unknown error"}`);
        return;
      }
    } catch {
      setError(`Couldn't delete ${f.filename}.`);
      return;
    }
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
                href={f.url ?? undefined}
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
