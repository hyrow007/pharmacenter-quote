"use client";

import { useState, type FormEvent } from "react";

// Client-side island for the Feedback page. Owns the in-flight list of
// posts, the textarea, the Post button, and the delete affordance on each
// card. Mirrors the Packing List version visually so the two apps feel
// like a matched pair.

export type FeedbackDisplayRow = {
  id: string;
  createdAt: string;
  body: string;
  /** v49.1: which app the post came from — 'quote' | 'formulas' | 'packing-list'. */
  app: string;
  authorEmail: string;
  authorName: string;
  canDelete: boolean;
};

type Props = {
  initialRows: FeedbackDisplayRow[];
  currentUserEmail: string;
  /** v49.1: app tag applied to new posts (derived from ?from= on the server). */
  postApp: string;
};

// Small human label for the app tag under each comment.
const APP_LABELS: Record<string, string> = {
  quote: "Quote — Work Flows",
  formulas: "Formulas",
  "packing-list": "Packing List",
};

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-US", {
    year: "numeric",
    month: "numeric",
    day: "numeric",
  });
}

export default function FeedbackBoard({ initialRows, currentUserEmail, postApp }: Props) {
  const [rows, setRows] = useState<FeedbackDisplayRow[]>(initialRows);
  const [body, setBody] = useState("");
  const [posting, setPosting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const text = body.trim();
    if (text.length === 0 || posting) return;
    setPosting(true);
    setError(null);
    try {
      const res = await fetch("/api/feedback", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ body: text, app: postApp }),
      });
      const data = (await res.json().catch(() => null)) as {
        ok?: boolean;
        error?: string;
        feedback?: {
          id: string;
          created_at: string;
          author_email: string;
          body: string;
        };
        // Server-resolved display name from user_directory. Null when the
        // directory has no entry, in which case we fall back to the local
        // part of the email like the original behaviour.
        authorName?: string | null;
      } | null;
      if (!res.ok || !data?.ok || !data.feedback) {
        throw new Error(data?.error || `post_failed_${res.status}`);
      }
      const fresh: FeedbackDisplayRow = {
        id: data.feedback.id,
        createdAt: data.feedback.created_at,
        body: data.feedback.body,
        authorEmail: data.feedback.author_email,
        // Prefer the server-resolved display name (Google SSO full_name)
        // so the optimistic insert immediately renders "Jairo Osorno"
        // instead of "Josorno". Fall back to local-part if the directory
        // lookup came back empty.
        authorName: data.authorName || localFallback(data.feedback.author_email),
        app: postApp,
        canDelete: true,
      };
      setRows((prev) => [fresh, ...prev]);
      setBody("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "post_failed");
    } finally {
      setPosting(false);
    }
  }

  async function onDelete(id: string) {
    if (!window.confirm("Delete this feedback?")) return;
    // Optimistic remove — if the server rejects we put it back.
    const before = rows;
    setRows((prev) => prev.filter((r) => r.id !== id));
    try {
      const res = await fetch(`/api/feedback?id=${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(data?.error || `delete_failed_${res.status}`);
      }
    } catch (err) {
      setRows(before);
      window.alert(
        `Couldn't delete that post: ${err instanceof Error ? err.message : "unknown"}`,
      );
    }
  }

  return (
    <>
      {/* Post form ------------------------------------------------- */}
      <form
        onSubmit={onSubmit}
        style={{
          background: "var(--paper, #fffdf8)",
          border: "1px solid var(--line, #e3dcc9)",
          borderRadius: 12,
          padding: 16,
          marginBottom: 20,
        }}
      >
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="What's on your mind?"
          rows={4}
          maxLength={4000}
          style={{
            width: "100%",
            background: "transparent",
            border: "1.5px solid #e3dcc9",
            borderRadius: 8,
            padding: "10px 12px",
            fontSize: 14,
            lineHeight: 1.5,
            fontFamily: "inherit",
            color: "var(--ink-1, #1f2a2d)",
            resize: "vertical",
            outline: "none",
          }}
        />
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "flex-end",
            gap: 12,
            marginTop: 10,
          }}
        >
          {error ? (
            <span style={{ fontSize: 13, color: "#b91c1c" }}>{error}</span>
          ) : null}
          <button
            type="submit"
            disabled={posting || body.trim().length === 0}
            style={{
              background:
                posting || body.trim().length === 0 ? "#f5f1e6" : "var(--paper, #fff)",
              color:
                posting || body.trim().length === 0 ? "var(--ink-3, #8a9498)" : "var(--ink-1, #1f2a2d)",
              border: "1.5px solid var(--line, #e3dcc9)",
              padding: "7px 18px",
              borderRadius: 8,
              fontSize: 13,
              fontWeight: 700,
              cursor:
                posting || body.trim().length === 0 ? "not-allowed" : "pointer",
              fontFamily: "inherit",
            }}
          >
            {posting ? "Posting…" : "Post"}
          </button>
        </div>
      </form>

      {/* List ------------------------------------------------------ */}
      {rows.length === 0 ? (
        <p style={{ color: "var(--ink-3, #8a9498)", fontSize: 14 }}>
          No feedback yet. Be the first to post.
        </p>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          {rows.map((r) => (
            <article
              key={r.id}
              style={{
                background: "var(--paper, #fffdf8)",
                border: "1px solid var(--line, #e3dcc9)",
                borderRadius: 12,
                padding: 14,
                position: "relative",
              }}
            >
              <header
                style={{
                  display: "flex",
                  alignItems: "baseline",
                  gap: 8,
                  marginBottom: 6,
                }}
              >
                <span
                  style={{
                    color: "var(--teal-700, #1d6c7b)",
                    fontWeight: 700,
                    fontSize: 14,
                  }}
                >
                  {r.authorName}
                </span>
                <span style={{ color: "var(--ink-3, #8a9498)", fontSize: 12 }}>
                  {formatDate(r.createdAt)}
                </span>
                {r.canDelete ? (
                  <button
                    type="button"
                    onClick={() => onDelete(r.id)}
                    title="Delete this post"
                    aria-label="Delete this post"
                    style={{
                      marginLeft: "auto",
                      background: "transparent",
                      border: "none",
                      color: "var(--ink-3, #8a9498)",
                      cursor: "pointer",
                      fontSize: 16,
                      lineHeight: 1,
                      padding: 4,
                    }}
                  >
                    ×
                  </button>
                ) : null}
              </header>
              <p
                style={{
                  margin: 0,
                  whiteSpace: "pre-wrap",
                  color: "var(--ink-1, #1f2a2d)",
                  fontSize: 14,
                  lineHeight: 1.5,
                }}
              >
                {r.body}
              </p>
              {/* v49.1: origin note — which app this post came from. */}
              <div
                style={{
                  marginTop: 6,
                  fontSize: 11,
                  color: "var(--ink-3, #8a9498)",
                  letterSpacing: "0.03em",
                }}
              >
                via {APP_LABELS[r.app] ?? APP_LABELS.quote}
              </div>
            </article>
          ))}
        </div>
      )}
      {/* Tiny self-reference so the linter doesn't flag the unused prop */}
      <span hidden>{currentUserEmail}</span>
    </>
  );
}

// Bare-bones "jairo.osorno@pharmacenterusa.com" → "Jairo Osorno" fallback.
// Used only for the optimistic insert after a successful POST — the next
// page load pulls the real display name from the user_directory view.
function localFallback(email: string): string {
  const at = email.indexOf("@");
  const local = at > 0 ? email.slice(0, at) : email;
  return local
    .replace(/[._-]+/g, " ")
    .split(" ")
    .filter((w) => w.length > 0)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(" ");
}
