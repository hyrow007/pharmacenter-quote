"use client";

import { useState, type FormEvent } from "react";

// Interactive island for /admin. Owns:
//   - The user directory list (with promote/demote buttons).
//   - The "Add admin" form for an email that isn't in the directory yet.
//   - The "Promote unknown email" affordance for granting access to
//     someone who hasn't signed in yet (they show up in the directory
//     after their first sign-in but the admins row is what gates access).
//
// All writes route through /api/admin/admins, which RLS-checks too.

export type AdminPanelUser = {
  email: string;
  displayName: string | null;
  isAdmin: boolean;
};

type Stats = {
  workflows: number;
  customers: number;
  vendors: number;
  feedback: number;
};

type Props = {
  currentUserEmail: string;
  initialUsers: AdminPanelUser[];
  stats: Stats;
};

export default function AdminPanel({
  currentUserEmail,
  initialUsers,
  stats,
}: Props) {
  const [users, setUsers] = useState<AdminPanelUser[]>(initialUsers);
  const [newEmail, setNewEmail] = useState("");
  const [submitting, setSubmitting] = useState<string | null>(null); // null = idle, otherwise the email being mutated
  const [error, setError] = useState<string | null>(null);

  function readableError(code: string): string {
    switch (code) {
      case "not_signed_in": return "You're not signed in.";
      case "wrong_domain": return "Only @pharmacenterusa.com accounts are allowed.";
      case "not_admin": return "You're not an admin.";
      case "invalid_email": return "That email doesn't look right — it must end with @pharmacenterusa.com.";
      case "cannot_remove_self": return "You can't remove yourself. Ask another admin.";
      case "not_found": return "That admin record is already gone.";
      default: return code;
    }
  }

  async function promote(email: string) {
    setSubmitting(email);
    setError(null);
    try {
      const res = await fetch("/api/admin/admins", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const data = (await res.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
      if (!res.ok || !data?.ok) throw new Error(data?.error || `http_${res.status}`);
      setUsers((prev) => {
        const next = prev.slice();
        const existing = next.findIndex((u) => u.email.toLowerCase() === email.toLowerCase());
        if (existing >= 0) {
          next[existing] = { ...next[existing], isAdmin: true };
        } else {
          next.unshift({ email, displayName: null, isAdmin: true });
        }
        // Re-sort: admins first.
        next.sort((a, b) => {
          if (a.isAdmin !== b.isAdmin) return a.isAdmin ? -1 : 1;
          return a.email.localeCompare(b.email);
        });
        return next;
      });
    } catch (err) {
      setError(readableError(err instanceof Error ? err.message : "unknown"));
    } finally {
      setSubmitting(null);
    }
  }

  async function demote(email: string) {
    if (email.toLowerCase() === currentUserEmail.toLowerCase()) return;
    if (!window.confirm(`Remove admin access from ${email}?`)) return;
    setSubmitting(email);
    setError(null);
    try {
      const res = await fetch(
        `/api/admin/admins?email=${encodeURIComponent(email)}`,
        { method: "DELETE" },
      );
      const data = (await res.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
      if (!res.ok || !data?.ok) throw new Error(data?.error || `http_${res.status}`);
      setUsers((prev) =>
        prev
          .map((u) => (u.email.toLowerCase() === email.toLowerCase() ? { ...u, isAdmin: false } : u))
          .sort((a, b) => {
            if (a.isAdmin !== b.isAdmin) return a.isAdmin ? -1 : 1;
            return a.email.localeCompare(b.email);
          }),
      );
    } catch (err) {
      setError(readableError(err instanceof Error ? err.message : "unknown"));
    } finally {
      setSubmitting(null);
    }
  }

  async function onAdd(e: FormEvent) {
    e.preventDefault();
    const email = newEmail.trim().toLowerCase();
    if (!email) return;
    await promote(email);
    setNewEmail("");
  }

  // Display label helpers.
  function nameFor(u: AdminPanelUser): string {
    if (u.displayName && u.displayName.trim().length > 0) return u.displayName.trim();
    const at = u.email.indexOf("@");
    const local = at > 0 ? u.email.slice(0, at) : u.email;
    return local
      .replace(/[._-]+/g, " ")
      .split(" ")
      .filter(Boolean)
      .map((w) => w[0].toUpperCase() + w.slice(1))
      .join(" ");
  }

  const adminCount = users.filter((u) => u.isAdmin).length;
  const userCount = users.length;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      {/* Stats row -------------------------------------------------- */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))",
          gap: 10,
        }}
      >
        <StatCard label="Admins" value={adminCount} />
        <StatCard label="Users" value={userCount} />
        <StatCard label="Workflows" value={stats.workflows} />
        <StatCard label="Customers" value={stats.customers} />
        <StatCard label="Vendors" value={stats.vendors} />
        <StatCard label="Feedback" value={stats.feedback} />
      </div>

      {/* Add admin form -------------------------------------------- */}
      <section
        style={{
          background: "var(--paper, #fffdf8)",
          border: "1px solid var(--line, #e3dcc9)",
          borderRadius: 12,
          padding: 14,
        }}
      >
        <h2 style={{ margin: "0 0 8px", fontSize: 16, color: "var(--teal-900, #0f4a56)" }}>
          Promote someone to admin
        </h2>
        <p style={{ margin: "0 0 12px", fontSize: 13, color: "var(--ink-3, #8a9498)" }}>
          Type an @pharmacenterusa.com email. They&rsquo;ll get admin access the next time they reload.
        </p>
        <form onSubmit={onAdd} style={{ display: "flex", gap: 8 }}>
          <input
            type="email"
            value={newEmail}
            onChange={(e) => setNewEmail(e.target.value)}
            placeholder="someone@pharmacenterusa.com"
            style={{
              flex: 1,
              padding: "8px 12px",
              border: "1.5px solid #e3dcc9",
              borderRadius: 8,
              fontSize: 14,
              fontFamily: "inherit",
              background: "transparent",
              outline: "none",
            }}
          />
          <button
            type="submit"
            disabled={!!submitting || newEmail.trim().length === 0}
            style={{
              background: "var(--teal-700, #1d6c7b)",
              color: "#fff",
              border: "1px solid var(--teal-900, #0f4a56)",
              padding: "8px 16px",
              borderRadius: 8,
              fontSize: 13,
              fontWeight: 700,
              cursor: submitting ? "not-allowed" : "pointer",
              fontFamily: "inherit",
            }}
          >
            Add admin
          </button>
        </form>
      </section>

      {error ? (
        <div
          style={{
            background: "#fff1f1",
            border: "1px solid #f5c2c2",
            borderRadius: 8,
            color: "#7a1d1d",
            fontSize: 13,
            padding: "10px 14px",
          }}
        >
          {error}
        </div>
      ) : null}

      {/* Users list ------------------------------------------------ */}
      <section
        style={{
          background: "var(--paper, #fffdf8)",
          border: "1px solid var(--line, #e3dcc9)",
          borderRadius: 12,
          padding: 14,
        }}
      >
        <h2 style={{ margin: "0 0 10px", fontSize: 16, color: "var(--teal-900, #0f4a56)" }}>
          Users ({users.length})
        </h2>
        {users.length === 0 ? (
          <p style={{ margin: 0, color: "var(--ink-3, #8a9498)", fontSize: 13 }}>
            Nobody&rsquo;s signed in yet.
          </p>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {users.map((u) => {
              const isSelf = u.email.toLowerCase() === currentUserEmail.toLowerCase();
              return (
                <div
                  key={u.email}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 12,
                    padding: "10px 12px",
                    background: u.isAdmin ? "#ecfeff" : "transparent",
                    border: `1px solid ${u.isAdmin ? "#a7e3df" : "#efe9da"}`,
                    borderRadius: 8,
                  }}
                >
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div
                      style={{
                        fontWeight: 700,
                        fontSize: 14,
                        color: "var(--teal-900, #0f4a56)",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {nameFor(u)}
                      {isSelf ? (
                        <span style={{ marginLeft: 6, fontSize: 11, color: "var(--ink-3, #8a9498)", fontWeight: 500 }}>
                          (you)
                        </span>
                      ) : null}
                    </div>
                    <div
                      style={{
                        fontSize: 12,
                        color: "var(--ink-3, #8a9498)",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {u.email}
                    </div>
                  </div>
                  {u.isAdmin ? (
                    <span
                      style={{
                        background: "var(--teal-700, #1d6c7b)",
                        color: "#fff",
                        padding: "4px 10px",
                        borderRadius: 999,
                        fontSize: 11,
                        fontWeight: 700,
                        letterSpacing: "0.06em",
                        textTransform: "uppercase",
                      }}
                    >
                      Admin
                    </span>
                  ) : null}
                  {u.isAdmin && !isSelf ? (
                    <button
                      type="button"
                      onClick={() => demote(u.email)}
                      disabled={submitting === u.email}
                      title={`Remove admin access from ${u.email}`}
                      style={{
                        background: "transparent",
                        border: "1px solid #e3dcc9",
                        color: "var(--ink-2, #415056)",
                        padding: "6px 10px",
                        borderRadius: 6,
                        fontSize: 12,
                        fontWeight: 600,
                        cursor: submitting === u.email ? "not-allowed" : "pointer",
                        fontFamily: "inherit",
                      }}
                    >
                      Remove
                    </button>
                  ) : !u.isAdmin ? (
                    <button
                      type="button"
                      onClick={() => promote(u.email)}
                      disabled={submitting === u.email}
                      title={`Promote ${u.email} to admin`}
                      style={{
                        background: "var(--paper, #fff)",
                        border: "1px solid var(--teal-700, #1d6c7b)",
                        color: "var(--teal-700, #1d6c7b)",
                        padding: "6px 10px",
                        borderRadius: 6,
                        fontSize: 12,
                        fontWeight: 700,
                        cursor: submitting === u.email ? "not-allowed" : "pointer",
                        fontFamily: "inherit",
                      }}
                    >
                      Make admin
                    </button>
                  ) : null}
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: number }) {
  return (
    <div
      style={{
        background: "var(--paper, #fffdf8)",
        border: "1px solid var(--line, #e3dcc9)",
        borderRadius: 10,
        padding: "12px 14px",
      }}
    >
      <div
        style={{
          fontSize: 10,
          fontWeight: 700,
          letterSpacing: "0.14em",
          textTransform: "uppercase",
          color: "var(--ink-3, #8a9498)",
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontSize: 24,
          fontWeight: 700,
          color: "var(--teal-900, #0f4a56)",
          marginTop: 2,
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {value.toLocaleString("en-US")}
      </div>
    </div>
  );
}
