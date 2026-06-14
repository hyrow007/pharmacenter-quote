import Link from "next/link";
import { redirect } from "next/navigation";
import type { CSSProperties } from "react";
import { createClient } from "@/lib/auth/server";
import type { WorkflowRow } from "@/lib/workflows";

// Workflow inbox — every quote workflow visible to the signed-in user.
// Server component so the customer/product joins happen on the server in one
// round-trip instead of N debounced fetches in the browser.

const TYPE_LABELS: Record<string, string> = {
  "bulk": "Bulk",
  "contract-packaging": "Contract Packaging",
  "finished-product": "Finished Product",
  "other": "Other",
};
const FORM_LABELS: Record<string, string> = {
  softgel: "Softgels", gummy: "Gummies", tablet: "Tablets", capsule: "Capsules", other: "Other",
};

function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  const now = Date.now();
  const diff = Math.max(0, now - then);
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return "just now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d ago`;
  if (day < 30) return `${Math.floor(day / 7)}w ago`;
  if (day < 365) return `${Math.floor(day / 30)}mo ago`;
  return `${Math.floor(day / 365)}y ago`;
}

export default async function WorkflowsPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user || !user.email?.endsWith("@pharmacenterusa.com")) {
    redirect("/");
  }

  const { data: rawRows } = await supabase
    .from("workflows")
    .select(
      "id, created_by_email, created_at, updated_at, state, monday_item_id, monday_item_url, monday_last_pushed_at",
    )
    .order("updated_at", { ascending: false });

  const rows: WorkflowRow[] = (rawRows ?? []) as WorkflowRow[];

  // Resolve customer names in one query.
  const customerIds = Array.from(
    new Set(
      rows
        .map((r) => (r.state.customerMode === "existing" ? r.state.customerId : null))
        .filter((id): id is string => !!id),
    ),
  );
  const customerNames: Record<string, string> = {};
  if (customerIds.length > 0) {
    const { data } = await supabase.from("customers").select("id, name").in("id", customerIds);
    for (const c of (data ?? []) as Array<{ id: string; name: string }>) {
      customerNames[c.id] = c.name;
    }
  }

  // ----- styles --------------------------------------------------------
  const cardStyle: CSSProperties = {
    display: "block", textDecoration: "none",
    padding: "16px 18px", borderRadius: 12,
    border: "1.5px solid #e3dcc9", background: "#fffdf8",
    color: "var(--ink-1)", marginBottom: 10,
    transition: "border-color 0.15s ease, transform 0.15s ease, box-shadow 0.15s ease",
  };
  const rowGrid: CSSProperties = {
    display: "grid",
    gridTemplateColumns: "1.4fr 1fr auto auto",
    gap: 14, alignItems: "center",
  };
  const badgePushed: CSSProperties = {
    display: "inline-block", padding: "3px 10px", borderRadius: 999,
    background: "var(--sage)", color: "var(--teal-900)",
    fontSize: 11, fontWeight: 700, letterSpacing: "0.04em",
  };
  const badgeUnpushed: CSSProperties = {
    display: "inline-block", padding: "3px 10px", borderRadius: 999,
    background: "#fff", border: "1.5px solid #e3dcc9",
    color: "var(--ink-3)", fontSize: 11, fontWeight: 700, letterSpacing: "0.04em",
  };
  const newButton: CSSProperties = {
    display: "inline-flex", alignItems: "center", gap: 8,
    padding: "10px 18px", background: "var(--teal-900)",
    color: "#fff", border: "none", borderRadius: 10,
    fontSize: 14, fontWeight: 700, cursor: "pointer",
    fontFamily: "inherit", letterSpacing: "0.01em", textDecoration: "none",
  };

  return (
    <main className="hero">
      <div className="card card--wide">
        <p className="eyebrow">PharmaCenter · Workflow</p>
        <h1>Quote workflows</h1>
        <p className="lede">Every quote workflow we&rsquo;ve got in flight, newest activity on top.</p>

        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 18, gap: 12 }}>
          <span style={{ fontSize: 12, color: "var(--ink-3)" }}>
            {rows.length} workflow{rows.length === 1 ? "" : "s"}
          </span>
          <Link href="/start" style={newButton}>Start new workflow →</Link>
        </div>

        {rows.length === 0 ? (
          <div
            style={{
              padding: "32px 24px", textAlign: "center",
              border: "1.5px dashed #e3dcc9", borderRadius: 12,
              color: "var(--ink-3)",
            }}
          >
            <p style={{ fontSize: 14, marginBottom: 12 }}>No workflows yet.</p>
            <Link href="/start" style={{ color: "var(--teal-700)", fontWeight: 700, textDecoration: "none" }}>
              Start the first one →
            </Link>
          </div>
        ) : (
          <div>
            {rows.map((row) => {
              const state = row.state;
              const customerLabel =
                state.customerMode === "new"
                  ? state.newCustomer?.name || "New customer"
                  : (state.customerId && customerNames[state.customerId]) || "Unknown customer";
              const typeParts = [
                state.type ? TYPE_LABELS[state.type] || state.type : null,
                state.form ? FORM_LABELS[state.form] || state.form : null,
              ].filter(Boolean) as string[];
              const productCount = state.products?.length ?? 0;
              const pushed = !!row.monday_item_id;
              return (
                <Link key={row.id} href={`/workflow/${row.id}`} style={cardStyle}>
                  <div style={rowGrid}>
                    <div>
                      <div style={{ fontSize: 15, fontWeight: 700, color: "var(--ink-1)" }}>
                        {customerLabel}
                      </div>
                      <div style={{ fontSize: 12, color: "var(--ink-3)", marginTop: 4 }}>
                        {typeParts.length > 0 ? typeParts.join(" · ") : "—"}
                        {productCount > 0
                          ? ` · ${productCount} product${productCount === 1 ? "" : "s"}`
                          : ""}
                      </div>
                    </div>
                    <div style={{ fontSize: 12, color: "var(--ink-3)" }}>
                      <div>{row.created_by_email}</div>
                      <div style={{ marginTop: 2 }}>Updated {relativeTime(row.updated_at)}</div>
                    </div>
                    <div>
                      {pushed ? (
                        <span style={badgePushed}>Pushed</span>
                      ) : (
                        <span style={badgeUnpushed}>Not pushed</span>
                      )}
                    </div>
                    <div style={{ fontSize: 18, color: "var(--teal-700)" }}>→</div>
                  </div>
                </Link>
              );
            })}
          </div>
        )}
      </div>
    </main>
  );
}
