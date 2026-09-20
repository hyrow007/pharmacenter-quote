import { redirect } from "next/navigation";
import { headers } from "next/headers";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import AppHeader from "../../_components/AppHeader";
import { getLangFromCookie } from "@/lib/i18n/server";
import { makeT } from "@/lib/i18n/dict";

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
  const lang = await getLangFromCookie();
  const t = makeT(lang);
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
  // blank page. name_es / tagline_es are optional overrides shown when
  // the visitor's language is Spanish; English fields remain canonical.
  const { data: typeRow } = await supabase
    .from("meeting_types")
    .select("id, name, name_es, tagline, tagline_es, cadence")
    .eq("slug", "sales-orders")
    .maybeSingle();

  const typeName =
    lang === "es" && typeof typeRow?.name_es === "string" && typeRow.name_es
      ? (typeRow.name_es as string)
      : typeRow
        ? (typeRow.name as string)
        : null;
  const typeTagline =
    lang === "es" &&
    typeof typeRow?.tagline_es === "string" &&
    typeRow.tagline_es
      ? (typeRow.tagline_es as string)
      : (typeRow?.tagline as string | undefined) ?? null;

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
            <span aria-hidden="true">&larr;</span> {t("navMeetings")}
          </Link>

          <div style={{ marginBottom: 22 }}>
            <p className="eyebrow" style={{ marginBottom: 6 }}>
              {t("meetingsBreadcrumb")}
            </p>
            <h1 className="page-header__title" style={{ marginBottom: 6 }}>
              {typeName ?? t("salesOrdersTitle")}
            </h1>
            <p className="lede" style={{ marginTop: 4, marginBottom: 0 }}>
              {typeTagline ?? t("salesOrdersLede")}
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
              <div style={cardEyebrow()}>{t("workingDocument")}</div>
              <div style={cardTitle()}>{t("cardOpenOrders")}</div>
              <div style={cardBody()}>{t("cardOpenOrdersBody")}</div>
            </Link>
            <div style={{ ...cardStyle(), cursor: "default" }}>
              <div style={cardEyebrow()}>{t("cardComingWithPlaud")}</div>
              <div style={cardTitle()}>{t("cardWeeklySessions")}</div>
              <div style={cardBody()}>{t("cardWeeklySessionsBody")}</div>
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
            {t("sessionHistory")}
          </h2>

          {!typeRow ? (
            <div style={emptyStyle()}>{t("seedNeeded")}</div>
          ) : (sessionRows ?? []).length === 0 ? (
            <div style={emptyStyle()}>{t("noSessionsPlaud")}</div>
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
                          ? t("plaudRecording")
                          : t("manualEntry")}
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
                      {noteCount} {noteCount === 1 ? t("soCountSingle") : t("soCountPlural")}
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
