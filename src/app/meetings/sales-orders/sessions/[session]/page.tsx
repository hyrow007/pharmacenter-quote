import { redirect, notFound } from "next/navigation";
import { headers } from "next/headers";
import Link from "next/link";
import { createClient } from "@/lib/auth/server";
import AppHeader from "../../../../_components/AppHeader";

// /meetings/sales-orders/sessions/[session]
//
// A single weekly meeting session. Shows the session summary, attendees,
// and each SO discussed with its meeting note + action items. Every note
// carries a snapshot of the Fishbowl state at ingest time — this page
// cross-references that against the live fishbowl_sales_orders row so
// you can see what has moved since the meeting.
//
// The page is fully wired for Plaud-ingested content already; until that
// pipeline lands the SO note list is just empty.

export const metadata = { title: "Meetings · Session" };

export default async function SessionDetailPage({
  params,
}: {
  params: Promise<{ session: string }>;
}) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user || !user.email?.endsWith("@pharmacenterusa.com")) {
    const hostHeader = (await headers()).get("host") ?? "";
    const isMeetingHost = hostHeader.startsWith("meeting.");
    redirect(isMeetingHost ? "/?showSignIn=1" : "/");
  }

  const { session: sessionId } = await params;

  const { data: sessionRaw } = await supabase
    .from("meeting_sessions")
    .select(
      "id, session_date, source, summary_md, attendees, created_at, meeting_type_id",
    )
    .eq("id", sessionId)
    .maybeSingle();

  if (!sessionRaw) notFound();

  // Cast through unknown — supabase-js is inconsistent about typing
  // runtime `.select(string)` calls, so we lock the shape ourselves.
  const session = sessionRaw as unknown as {
    id: string;
    session_date: string;
    source: string;
    summary_md: string | null;
    attendees: string[] | null;
    created_at: string;
    meeting_type_id: string;
  };

  const { data: notesRaw } = await supabase
    .from("meeting_so_notes")
    .select(
      "id, so_number, note_md, action_items, status_flag, fishbowl_snapshot, created_at",
    )
    .eq("session_id", sessionId)
    .order("so_number", { ascending: true });

  const notes = (notesRaw ?? []) as unknown as Array<{
    id: string;
    so_number: string;
    note_md: string | null;
    action_items: Array<{
      text?: string;
      owner?: string;
      due_date?: string;
      done?: boolean;
    }> | null;
    status_flag: string | null;
    fishbowl_snapshot: Record<string, unknown> | null;
    created_at: string;
  }>;

  // Live Fishbowl state for every SO mentioned — one query, joined
  // client-side, so we can render "at meeting vs. now" deltas.
  const soNumbers = notes.map((n) => n.so_number);
  const liveById = new Map<
    string,
    {
      status_name: string | null;
      is_open: boolean;
      date_first_ship: string | null;
      total_price: number | null;
    }
  >();
  if (soNumbers.length > 0) {
    const { data: liveRowsRaw } = await supabase
      .from("fishbowl_sales_orders")
      .select("so_number, status_name, is_open, date_first_ship, total_price")
      .in("so_number", soNumbers);
    const liveRows = (liveRowsRaw ?? []) as unknown as Array<{
      so_number: string;
      status_name: string | null;
      is_open: boolean;
      date_first_ship: string | null;
      total_price: number | null;
    }>;
    liveRows.forEach((r) => {
      liveById.set(r.so_number, {
        status_name: r.status_name,
        is_open: r.is_open,
        date_first_ship: r.date_first_ship,
        total_price: r.total_price,
      });
    });
  }

  const attendees = session.attendees ?? [];

  return (
    <div className="app-shell">
      <AppHeader user={{ email: user.email! }} appContext="meetings" />
      <main className="page">
        <div className="page__inner--narrow">
          <Link
            href="/meetings/sales-orders"
            className="meetings-noprint"
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
            <span aria-hidden="true">&larr;</span> Sales Orders
          </Link>

          <div style={{ marginBottom: 18 }}>
            <p className="eyebrow" style={{ marginBottom: 6 }}>
              PharmaCenter · Meetings · Sales Orders
            </p>
            <h1 className="page-header__title" style={{ marginBottom: 6 }}>
              {formatDate(session.session_date as string)}
            </h1>
            <p
              className="lede"
              style={{ marginTop: 4, marginBottom: 0, fontSize: 14 }}
            >
              {attendees.length > 0
                ? `Attendees: ${attendees.join(", ")}`
                : (session.source as string) === "plaud"
                  ? "Plaud recording"
                  : "Manual entry"}
            </p>
          </div>

          {session.summary_md ? (
            <div
              style={{
                fontSize: 13,
                color: "var(--ink-2, #415056)",
                background: "var(--cream-soft, #fbf6ec)",
                border: "1px solid var(--stone, #e3dcc9)",
                borderRadius: 8,
                padding: "12px 14px",
                marginBottom: 18,
                whiteSpace: "pre-wrap",
              }}
            >
              {session.summary_md as string}
            </div>
          ) : null}

          <h2
            style={{
              fontFamily: "'Cormorant Garamond', Georgia, serif",
              fontSize: 24,
              fontWeight: 600,
              color: "var(--teal-900, #0f4a56)",
              margin: "0 0 10px",
            }}
          >
            Sales orders discussed
          </h2>

          {(notes ?? []).length === 0 ? (
            <div
              style={{
                padding: "24px 16px",
                border: "1px dashed var(--stone, #e3dcc9)",
                borderRadius: 8,
                textAlign: "center",
                color: "var(--ink-3, #8a9498)",
                fontSize: 13,
                background: "var(--cream-soft, #fbf6ec)",
              }}
            >
              No SO notes on this session yet.
            </div>
          ) : (
            <div style={{ display: "grid", gap: 12 }}>
              {(notes ?? []).map((n) => {
                const so = n.so_number as string;
                const snap = (n.fishbowl_snapshot as Record<
                  string,
                  unknown
                > | null) ?? null;
                const live = liveById.get(so) ?? null;
                const deltas = diffSnapshot(snap, live);
                const actionItems = (n.action_items ?? []) as Array<{
                  text?: string;
                  owner?: string;
                  due_date?: string;
                  done?: boolean;
                }>;
                return (
                  <div
                    key={n.id as string}
                    style={{
                      padding: "14px 16px",
                      background: "var(--paper, #fffdf8)",
                      border: "1px solid var(--stone, #e3dcc9)",
                      borderRadius: 8,
                    }}
                  >
                    <div
                      style={{
                        display: "flex",
                        alignItems: "baseline",
                        gap: 12,
                        marginBottom: 6,
                        flexWrap: "wrap",
                      }}
                    >
                      <Link
                        href={`/meetings/sales-orders/orders/${so}`}
                        style={{
                          fontFamily:
                            "'IBM Plex Mono', ui-monospace, monospace",
                          fontSize: 14,
                          fontWeight: 700,
                          color: "var(--teal-900, #0f4a56)",
                          textDecoration: "none",
                        }}
                      >
                        SO {so} &rarr;
                      </Link>
                      {live ? (
                        <span
                          style={{
                            fontSize: 12,
                            color: "var(--ink-2, #415056)",
                          }}
                        >
                          Now: {live.status_name ?? "—"} ·{" "}
                          ship {formatDate(live.date_first_ship)}
                        </span>
                      ) : (
                        <span
                          style={{
                            fontSize: 12,
                            color: "var(--ink-3, #8a9498)",
                            fontStyle: "italic",
                          }}
                        >
                          (not in current Fishbowl mirror)
                        </span>
                      )}
                    </div>
                    {deltas.length > 0 ? (
                      <ul
                        style={{
                          margin: "0 0 8px",
                          paddingLeft: 18,
                          fontSize: 12,
                          color: "var(--sage-700, #5f8e3a)",
                        }}
                      >
                        {deltas.map((d, i) => (
                          <li key={i}>{d}</li>
                        ))}
                      </ul>
                    ) : null}
                    {n.note_md ? (
                      <div
                        style={{
                          fontSize: 13,
                          lineHeight: 1.55,
                          color: "var(--ink-1, #1f2a2d)",
                          whiteSpace: "pre-wrap",
                        }}
                      >
                        {n.note_md as string}
                      </div>
                    ) : null}
                    {actionItems.length > 0 ? (
                      <ul
                        style={{
                          margin: "8px 0 0",
                          paddingLeft: 18,
                          fontSize: 12.5,
                          color: "var(--ink-2, #415056)",
                        }}
                      >
                        {actionItems.map((ai, idx) => (
                          <li key={idx}>
                            {ai.text}
                            {ai.owner ? ` — ${ai.owner}` : ""}
                            {ai.due_date
                              ? ` (due ${formatDate(ai.due_date)})`
                              : ""}
                            {ai.done ? " ✓" : ""}
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </main>
    </div>
  );
}

// Snapshot → live diff. Only surfaces fields we care about — status
// transition, scheduled ship movement, order closed since meeting.
// Returns human-readable lines; empty when nothing changed.
function diffSnapshot(
  snap: Record<string, unknown> | null,
  live: {
    status_name: string | null;
    is_open: boolean;
    date_first_ship: string | null;
    total_price: number | null;
  } | null,
): string[] {
  if (!snap || !live) return [];
  const out: string[] = [];
  const snapStatus = (snap.status_name as string | null) ?? null;
  if (snapStatus && live.status_name && snapStatus !== live.status_name) {
    out.push(`Status: ${snapStatus} → ${live.status_name}`);
  }
  if (snap.is_open === true && live.is_open === false) {
    out.push(`Closed since this meeting.`);
  }
  const snapShip = (snap.date_first_ship as string | null) ?? null;
  if (
    snapShip &&
    live.date_first_ship &&
    snapShip !== live.date_first_ship
  ) {
    out.push(
      `Scheduled ship: ${formatDate(snapShip)} → ${formatDate(
        live.date_first_ship,
      )}`,
    );
  }
  return out;
}

function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "—";
  return d.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}
