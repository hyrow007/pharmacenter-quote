import { redirect } from "next/navigation";
import { headers } from "next/headers";
import Link from "next/link";
import { createClient } from "@/lib/auth/server";
import AppHeader from "../../_components/AppHeader";

// /meetings/sales-orders — landing page for the weekly Sales Orders
// meeting.
//
// Two entry points side by side:
//   1. "Open orders" — the always-current, un-siloed table of every
//      open Fishbowl SO. Used in the actual meeting as the working
//      document.
//   2. Session history — one row per weekly meeting. When Plaud
//      ingestion lights up (Deploy 2) this fills in automatically;
//      today it is scaffold + empty state so the shape is visible.

export const metadata = { title: "Meetings · Sales Orders" };

export default async function SalesOrdersMeetingPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user || !user.email?.endsWith("@pharmacenterusa.com")) {
    const hostHeader = (await headers()).get("host") ?? "";
    const isMeetingHost = hostHeader.startsWith("meeting.");
    redirect(isMeetingHost ? "/?showSignIn=1" : "/");
  }

  // Resolve the meeting_type row so we know it's configured; if the
  // seed row didn't land yet, render an inline heads-up rather than a
  // blank page.
  const { data: typeRow } = await supabase
    .from("meeting_types")
    .select("id, name, tagline, cadence")
    .eq("slug", "sales-orders")
    .maybeSingle();

  // Session history for this meeting type — newest first.
  const { data: sessionRows } = typeRow
    ? await supabase
        .from("meeting_sessions")
        .select(
          "id, session_date, source, summary_md, attendees, created_at",
        )
        .eq("meeting_type_id", typeRow.id as string)
        .order("session_date", { ascending: false })
        .limit(200)
    : { data: [] };

  // Count of SO notes per session so the row hints at density.
  const sessionIds = (sessionRows ?? []).map(
    (s) => s.id as string,
  );
  const notesBySession: Record<string, number> = {};
  if (sessionIds.length > 0) {
    const { data: noteRows } = await supabase
      .from("meeting_so_notes")
      .select("session_id")
      .in("session_id", sessionIds);
    (noteRows ?? []).forEach((r) => {
      const key = r.session_id as string;
      notesBySession[key] = (notesBySession[key] ?? 0) + 1;
    });
  }

  return (
    <div className="app-shell">
      <AppHeader user={{ email: user.email! }} appContext="meetings" />
      <main className="page">
        <div className="page__inner--narrow">
          <Link
            href="/meetings"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              padding: "8px 14px",
              background: "var(--paper, #fffdf8)",
              border: "1px solid var(--stone, #e3dcc9)",
              borderRadius: 999,
              fontSize: 13,
              fontWeight: 700,
              color: "var(--teal-900, #0f4a56)",
              textDecoration: "none",
              marginBottom: 16,
              whiteSpace: "nowrap",
            }}
          >
            <span aria-hidden="true">&larr;</span> Meetings
          </Link>

          <div style={{ marginBottom: 22 }}>
            <p className="eyebrow" style={{ marginBottom: 6 }}>
              PharmaCenter · Meetings
            </p>
            <h1 className="page-header__title" style={{ marginBottom: 6 }}>
              {typeRow ? (typeRow.name as string) : "Sales Orders"}
            </h1>
            <p className="lede" style={{ marginTop: 4, marginBottom: 0 }}>
              {(typeRow?.tagline as string | undefined) ??
                "Weekly review of open Fishbowl sales orders."}
            </p>
          </div>

          {/* Two entry cards ---------------------------------------- */}
          <div
            style={{
              display: "grid",
              gridTemplateColumns:
                "repeat(auto-fit, minmax(260px, 1fr))",
              gap: 14,
              marginBottom: 28,
            }}
          >
            <Link
              href="/meetings/sales-orders/all"
              style={cardStyle()}
            >
              <div style={cardEyebrow()}>Working document</div>
              <div style={cardTitle()}>Open orders</div>
              <div style={cardBody()}>
                Every open Fishbowl SO right now — search, sort, expand
                for line items. This is what you drive the meeting from.
              </div>
            </Link>
            <div style={{ ...cardStyle(), cursor: "default" }}>
              <div style={cardEyebrow()}>Coming with Plaud</div>
              <div style={cardTitle()}>Weekly sessions</div>
              <div style={cardBody()}>
                Each Plaud recording of the meeting becomes a session
                below. Notes are extracted per SO and cross-referenced
                against current Fishbowl state.
              </div>
            </div>
          </div>

          {/* Session history --------------------------------------- */}
          <h2
            style={{
              fontFamily: "'Cormorant Garamond', Georgia, serif",
              fontSize: 28,
              fontWeight: 600,
              color: "var(--teal-900, #0f4a56)",
              margin: "0 0 12px",
            }}
          >
            Session history
          </h2>

          {!typeRow ? (
            <div style={emptyStyle()}>
              Meeting type <code>sales-orders</code> isn&rsquo;t seeded
              yet. Run <code>sql/meetings.sql</code> against the shared
              Supabase project.
            </div>
          ) : (sessionRows ?? []).length === 0 ? (
            <div style={emptyStyle()}>
              No sessions yet. Once Plaud is wired up, each weekly
              recording will appear here automatically.
            </div>
          ) : (
            <div
              style={{
                background: "var(--paper, #fffdf8)",
                border: "1px solid var(--stone, #e3dcc9)",
                borderRadius: 8,
                overflow: "hidden",
              }}
            >
              {(sessionRows ?? []).map((s, i) => {
                const id = s.id as string;
                const date = s.session_date as string;
                const attendees = (s.attendees as string[] | null) ?? [];
                const noteCount = notesBySession[id] ?? 0;
                return (
                  <Link
                    key={id}
                    href={`/meetings/sales-orders/sessions/${id}`}
                    style={{
                      display: "grid",
                      gridTemplateColumns: "140px 1fr auto",
                      alignItems: "center",
                      gap: 16,
                      padding: "14px 18px",
                      borderTop:
                        i === 0
                          ? "none"
                          : "1px solid var(--stone-2, #efe9da)",
                      textDecoration: "none",
                      color: "inherit",
                    }}
                  >
                    <span
                      style={{
                        fontFamily: "'IBM Plex Mono', ui-monospace, monospace",
                        fontSize: 13,
                        fontWeight: 700,
                        color: "var(--teal-900, #0f4a56)",
                      }}
                    >
                      {formatDate(date)}
                    </span>
                    <span
                      style={{
                        fontSize: 13,
                        color: "var(--ink-2, #415056)",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {attendees.length > 0
                        ? attendees.join(", ")
                        : (s.source as string) === "plaud"
                          ? "Plaud recording"
                          : "Manual entry"}
                    </span>
                    <span
                      style={{
                        fontSize: 11,
                        fontWeight: 700,
                        letterSpacing: "0.14em",
                        textTransform: "uppercase",
                        color: "var(--ink-3, #8a9498)",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {noteCount} SO{noteCount === 1 ? "" : "s"}
                    </span>
                  </Link>
                );
              })}
            </div>
          )}
        </div>
      </main>
    </div>
  );
}

function cardStyle(): React.CSSProperties {
  return {
    display: "block",
    padding: "18px 20px",
    background: "var(--paper, #fffdf8)",
    border: "1px solid var(--stone, #e3dcc9)",
    borderRadius: 12,
    textDecoration: "none",
    color: "inherit",
  };
}
function cardEyebrow(): React.CSSProperties {
  return {
    fontSize: 10.5,
    fontWeight: 700,
    letterSpacing: "0.16em",
    textTransform: "uppercase",
    color: "var(--teal-700, #1d6c7b)",
    marginBottom: 6,
  };
}
function cardTitle(): React.CSSProperties {
  return {
    fontFamily: "'Cormorant Garamond', Georgia, serif",
    fontSize: 26,
    fontWeight: 600,
    color: "var(--teal-900, #0f4a56)",
    lineHeight: 1.1,
    marginBottom: 6,
  };
}
function cardBody(): React.CSSProperties {
  return {
    fontSize: 13,
    lineHeight: 1.55,
    color: "var(--ink-2, #415056)",
  };
}
function emptyStyle(): React.CSSProperties {
  return {
    padding: "32px 16px",
    border: "1px dashed var(--stone, #e3dcc9)",
    borderRadius: 8,
    textAlign: "center",
    color: "var(--ink-3, #8a9498)",
    fontSize: 13.5,
    background: "var(--cream-soft, #fbf6ec)",
  };
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return iso;
  return d.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}
