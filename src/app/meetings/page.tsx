import { redirect } from "next/navigation";
import { headers } from "next/headers";
import Link from "next/link";
import { createClient } from "@/lib/auth/server";
import AppHeader from "../_components/AppHeader";
import { getLangFromCookie } from "@/lib/i18n/server";
import { makeT } from "@/lib/i18n/dict";

// /meetings — the hub.
//
// meeting.pharmacenter.app fronts this route (via the host rewrite in
// middleware.ts). One card per active meeting type — Sales Orders ships
// first; production, leadership, and whatever else you add later drop
// in as rows in the `meeting_types` table without a code change to
// this page.
//
// Every card links into its own detail area (e.g. /meetings/sales-orders)
// where the sessions list and per-type views live.

export const metadata = { title: "Meetings" };

type MeetingType = {
  id: string;
  slug: string;
  name: string;
  tagline: string | null;
  cadence: string | null;
  active: boolean;
  sort_order: number;
  latest_session_date?: string | null;
  session_count?: number;
};

export default async function MeetingsHubPage() {
  const lang = await getLangFromCookie();
  const t = makeT(lang);
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user || !user.email?.endsWith("@pharmacenterusa.com")) {
    // Loop guard mirrors /formulas — on the meeting subdomain the
    // middleware rewrites "/" → "/meetings", so a naive redirect("/")
    // would bounce us right back here with stale cookies. The
    // "showSignIn=1" query flag tells the middleware to pass through
    // untouched so the sign-in card renders.
    const hostHeader = (await headers()).get("host") ?? "";
    const isMeetingHost = hostHeader.startsWith("meeting.");
    redirect(isMeetingHost ? "/?showSignIn=1" : "/");
  }

  // Active meeting types, hub order. name_es / tagline_es are shown to
  // ES visitors; English fields remain canonical.
  const { data: typeRows } = await supabase
    .from("meeting_types")
    .select(
      "id, slug, name, name_es, tagline, tagline_es, cadence, active, sort_order",
    )
    .eq("active", true)
    .order("sort_order", { ascending: true });

  const types: MeetingType[] = (typeRows ?? []).map((r) => {
    const name_es = r.name_es as string | null | undefined;
    const tagline_es = r.tagline_es as string | null | undefined;
    return {
      id: r.id as string,
      slug: r.slug as string,
      name:
        lang === "es" && typeof name_es === "string" && name_es
          ? name_es
          : (r.name as string),
      tagline:
        lang === "es" && typeof tagline_es === "string" && tagline_es
          ? tagline_es
          : ((r.tagline as string | null) ?? null),
      cadence: (r.cadence as string | null) ?? null,
      active: r.active as boolean,
      sort_order: r.sort_order as number,
    };
  });

  // Sidecar: latest session date + session count per meeting type. Small
  // extra query on purpose — the count and "last held" line show on the
  // hub card without another round trip in the client.
  if (types.length > 0) {
    const { data: sessionRows } = await supabase
      .from("meeting_sessions")
      .select("meeting_type_id, session_date");
    const byType = new Map<
      string,
      { count: number; latest: string | null }
    >();
    (sessionRows ?? []).forEach((r) => {
      const key = r.meeting_type_id as string;
      const cur = byType.get(key) ?? { count: 0, latest: null };
      cur.count += 1;
      const date = r.session_date as string;
      if (!cur.latest || date > cur.latest) cur.latest = date;
      byType.set(key, cur);
    });
    types.forEach((t) => {
      const info = byType.get(t.id);
      t.latest_session_date = info?.latest ?? null;
      t.session_count = info?.count ?? 0;
    });
  }

  return (
    <div className="app-shell">
      <AppHeader user={{ email: user.email! }} appContext="meetings" />
      <main className="page">
        <div className="page__inner--narrow">
          <div style={{ marginBottom: 22 }}>
            <p className="eyebrow" style={{ marginBottom: 6 }}>
              {t("meetingsBreadcrumb")}
            </p>
            <h1 className="page-header__title" style={{ marginBottom: 6 }}>
              {t("meetingsTitle")}
            </h1>
            <p className="lede" style={{ marginTop: 4, marginBottom: 0 }}>
              {t("meetingsHubLede")}
            </p>
          </div>

          {types.length === 0 ? (
            <div
              style={{
                padding: "32px 16px",
                border: "1px dashed var(--stone, #e3dcc9)",
                borderRadius: 8,
                textAlign: "center",
                color: "var(--ink-3, #8a9498)",
                fontSize: 14,
                background: "var(--cream-soft, #fbf6ec)",
              }}
            >
              {t("meetingsNoTypes")}
            </div>
          ) : (
            <div
              style={{
                display: "grid",
                gridTemplateColumns:
                  "repeat(auto-fill, minmax(280px, 1fr))",
                gap: 16,
              }}
            >
              {types.map((mt) => (
                <Link
                  key={mt.id}
                  href={`/meetings/${mt.slug}`}
                  style={{
                    display: "block",
                    padding: "20px 22px",
                    background: "var(--paper, #fffdf8)",
                    border: "1px solid var(--stone, #e3dcc9)",
                    borderRadius: 12,
                    textDecoration: "none",
                    color: "inherit",
                    transition:
                      "border-color 0.15s ease, transform 0.15s ease, box-shadow 0.15s ease",
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      alignItems: "baseline",
                      justifyContent: "space-between",
                      gap: 12,
                    }}
                  >
                    <h2
                      style={{
                        fontFamily:
                          "'Cormorant Garamond', Georgia, serif",
                        fontSize: 26,
                        fontWeight: 600,
                        color: "var(--teal-900, #0f4a56)",
                        lineHeight: 1.1,
                        margin: 0,
                      }}
                    >
                      {mt.name}
                    </h2>
                    {mt.cadence ? (
                      <span
                        style={{
                          display: "inline-block",
                          padding: "2px 10px",
                          background: "var(--cream, #f6efe3)",
                          border: "1px solid var(--stone, #e3dcc9)",
                          borderRadius: 999,
                          fontSize: 10.5,
                          fontWeight: 700,
                          letterSpacing: "0.12em",
                          textTransform: "uppercase",
                          color: "var(--teal-700, #1d6c7b)",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {mt.cadence}
                      </span>
                    ) : null}
                  </div>
                  {mt.tagline ? (
                    <p
                      style={{
                        fontSize: 13,
                        lineHeight: 1.55,
                        color: "var(--ink-2, #415056)",
                        marginTop: 8,
                        marginBottom: 0,
                      }}
                    >
                      {mt.tagline}
                    </p>
                  ) : null}
                  <div
                    style={{
                      marginTop: 14,
                      display: "flex",
                      gap: 14,
                      fontSize: 11,
                      fontWeight: 700,
                      letterSpacing: "0.14em",
                      textTransform: "uppercase",
                      color: "var(--ink-3, #8a9498)",
                    }}
                  >
                    <span>
                      {mt.session_count ?? 0}{" "}
                      {(mt.session_count ?? 0) === 1
                        ? t("meetingsSessionCountOne")
                        : t("meetingsSessionsCount")}
                    </span>
                    {mt.latest_session_date ? (
                      <span>
                        {t("meetingsLastHeld", {
                          date: formatDate(mt.latest_session_date),
                        })}
                      </span>
                    ) : (
                      <span>{t("meetingsNoSessionsYet")}</span>
                    )}
                  </div>
                </Link>
              ))}
            </div>
          )}
        </div>
      </main>
    </div>
  );
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "";
  return d.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}
