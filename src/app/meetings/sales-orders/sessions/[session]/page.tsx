import { redirect, notFound } from "next/navigation";
import { headers } from "next/headers";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import AppHeader from "../../../../_components/AppHeader";
import { getLangFromCookie } from "@/lib/i18n/server";
import { makeT } from "@/lib/i18n/dict";

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

  const { session: sessionId } = await params;

  const { data: sessionRaw } = await supabase
    .from("meeting_sessions")
    .select(
      "id, session_date, source, summary_md, summary_md_es, attendees, other_business, other_business_es, created_at, meeting_type_id",
    )
    .eq("id", sessionId)
    .maybeSingle();

  if (!sessionRaw) notFound();

  type OtherBusinessItem = {
    title: string;
    note_md?: string | null;
    action_items?: Array<{
      text?: string;
      owner?: string;
      due_date?: string;
      done?: boolean;
    }>;
  };
  // Cast through unknown — supabase-js is inconsistent about typing
  // runtime `.select(string)` calls, so we lock the shape ourselves.
  const session = sessionRaw as unknown as {
    id: string;
    session_date: string;
    source: string;
    summary_md: string | null;
    summary_md_es: string | null;
    attendees: string[] | null;
    other_business: OtherBusinessItem[] | null;
    other_business_es: OtherBusinessItem[] | null;
    created_at: string;
    meeting_type_id: string;
  };
  // Prefer Spanish variants when the visitor's language is ES; fall
  // back to the canonical English so nothing goes blank if a translation
  // hasn't been produced yet.
  const summaryDisplay =
    lang === "es" && session.summary_md_es
      ? session.summary_md_es
      : session.summary_md;
  const otherBusiness =
    lang === "es" && Array.isArray(session.other_business_es) && session.other_business_es.length > 0
      ? session.other_business_es
      : (session.other_business ?? []);

  const { data: notesRaw } = await supabase
    .from("meeting_so_notes")
    .select(
      "id, so_number, note_md, note_md_es, action_items, action_items_es, status_flag, fishbowl_snapshot, customer_mismatch, customer_hint, product_mismatch, product_hint, created_at",
    )
    .eq("session_id", sessionId)
    .order("so_number", { ascending: true });

  const notesUntyped = (notesRaw ?? []) as unknown as Array<{
    id: string;
    so_number: string;
    note_md: string | null;
    note_md_es: string | null;
    action_items: Array<{
      text?: string;
      owner?: string;
      due_date?: string;
      done?: boolean;
    }> | null;
    action_items_es: Array<{
      text?: string;
      owner?: string;
      due_date?: string;
      done?: boolean;
    }> | null;
    status_flag: string | null;
    fishbowl_snapshot: Record<string, unknown> | null;
    customer_mismatch: boolean | null;
    customer_hint: string | null;
    product_mismatch: boolean | null;
    product_hint: string | null;
    created_at: string;
  }>;
  // Bake the language choice into the note shape once here so the
  // rendering path stays simple. `note_md` is what the UI reads —
  // it's the Spanish variant when available and the visitor is on ES,
  // otherwise the canonical English.
  const notes = notesUntyped.map((n) => ({
    ...n,
    note_md:
      lang === "es" && n.note_md_es ? n.note_md_es : n.note_md,
    action_items:
      lang === "es" &&
      Array.isArray(n.action_items_es) &&
      n.action_items_es.length > 0
        ? n.action_items_es
        : n.action_items,
  }));

  // Live Fishbowl state for every SO mentioned — one query, joined
  // client-side, so we can render "at meeting vs. now" deltas.
  const soNumbers = notes.map((n) => n.so_number);
  type LiveItem = {
    line?: number | null;
    type_id?: number | null;
    product_num?: string | null;
    description?: string | null;
    qty_ordered?: number | null;
    qty_picked?: number | null;
    qty_fulfilled?: number | null;
    unit_price?: number | null;
    total_price?: number | null;
  };
  const liveById = new Map<
    string,
    {
      status_name: string | null;
      is_open: boolean;
      date_first_ship: string | null;
      total_price: number | null;
      customer_name: string | null;
      note: string | null;
      items: LiveItem[];
    }
  >();
  if (soNumbers.length > 0) {
    const { data: liveRowsRaw } = await supabase
      .from("fishbowl_sales_orders")
      .select(
        "so_number, status_name, is_open, date_first_ship, total_price, customer_name, note, items",
      )
      .in("so_number", soNumbers);
    const liveRows = (liveRowsRaw ?? []) as unknown as Array<{
      so_number: string;
      status_name: string | null;
      is_open: boolean;
      date_first_ship: string | null;
      total_price: number | null;
      customer_name: string | null;
      note: string | null;
      items: LiveItem[] | null;
    }>;
    liveRows.forEach((r) => {
      liveById.set(r.so_number, {
        status_name: r.status_name,
        is_open: r.is_open,
        date_first_ship: r.date_first_ship,
        total_price: r.total_price,
        customer_name: r.customer_name,
        note: r.note,
        items: Array.isArray(r.items) ? r.items : [],
      });
    });
  }

  // AI-synthesized key points per SO — cached in so_synthesis by the
  // Cowork scheduled task that pulls Fishbowl + Monday + meeting notes
  // and generates 3-5 bullets via Claude.
  type SynthesisPoint = { text: string; source?: string };
  const synthesisBy = new Map<
    string,
    {
      headline: string | null;
      points: SynthesisPoint[];
      generated_at: string;
    }
  >();
  if (soNumbers.length > 0) {
    const { data: synRaw } = await supabase
      .from("so_synthesis")
      .select("so_number, headline, points, generated_at")
      .in("so_number", soNumbers);
    const synRows = (synRaw ?? []) as unknown as Array<{
      so_number: string;
      headline: string | null;
      points: SynthesisPoint[] | null;
      generated_at: string;
    }>;
    synRows.forEach((r) => {
      synthesisBy.set(r.so_number, {
        headline: r.headline,
        points: Array.isArray(r.points) ? r.points : [],
        generated_at: r.generated_at,
      });
    });
  }

  // Monday activity per SO — cached in so_monday_activity by the
  // /api/sync/monday route. Read-only join at render time.
  type MondayUpdate = {
    id: string;
    text_body: string;
    created_at: string;
    creator_name: string | null;
  };
  const mondayById = new Map<
    string,
    {
      monday_url: string | null;
      status: string | null;
      item_updated_at: string | null;
      updates: MondayUpdate[];
      last_synced_at: string;
    }
  >();
  if (soNumbers.length > 0) {
    const { data: mondayRowsRaw } = await supabase
      .from("so_monday_activity")
      .select(
        "so_number, monday_url, status, item_updated_at, updates, last_synced_at",
      )
      .in("so_number", soNumbers);
    const mondayRows = (mondayRowsRaw ?? []) as unknown as Array<{
      so_number: string;
      monday_url: string | null;
      status: string | null;
      item_updated_at: string | null;
      updates: MondayUpdate[] | null;
      last_synced_at: string;
    }>;
    mondayRows.forEach((r) => {
      mondayById.set(r.so_number, {
        monday_url: r.monday_url,
        status: r.status,
        item_updated_at: r.item_updated_at,
        updates: Array.isArray(r.updates) ? r.updates : [],
        last_synced_at: r.last_synced_at,
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
            <span aria-hidden="true">&larr;</span> {t("salesOrdersTitle")}
          </Link>

          <div style={{ marginBottom: 18 }}>
            <p className="eyebrow" style={{ marginBottom: 6 }}>
              {t("salesOrdersBreadcrumb")}
            </p>
            <h1 className="page-header__title" style={{ marginBottom: 6 }}>
              {formatDate(session.session_date as string)}
            </h1>
            <p
              className="lede"
              style={{ marginTop: 4, marginBottom: 0, fontSize: 14 }}
            >
              {attendees.length > 0
                ? `${t("attendeesLabel")}: ${attendees.join(", ")}`
                : (session.source as string) === "plaud"
                  ? t("plaudRecording")
                  : t("manualEntry")}
            </p>
          </div>

          {summaryDisplay ? (
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
              {summaryDisplay as string}
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
            {t("salesOrdersDiscussed")}
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
              {t("noSoNotesYet")}
            </div>
          ) : (
            <div style={{ display: "grid", gap: 24 }}>
              {groupNotesByCustomer(notes, liveById).map(
                ([customer, customerNotes]) => (
                  <section key={customer}>
                    {/* Customer group header — serif, matches the 8/25 PDF
                        format Olivia's team already uses on paper. */}
                    <div
                      style={{
                        display: "flex",
                        alignItems: "baseline",
                        justifyContent: "space-between",
                        gap: 12,
                        marginBottom: 10,
                        paddingBottom: 6,
                        borderBottom: "1px solid var(--stone, #e3dcc9)",
                      }}
                    >
                      <h3
                        style={{
                          fontFamily:
                            "'Cormorant Garamond', Georgia, serif",
                          fontSize: 22,
                          fontWeight: 600,
                          color: "var(--teal-900, #0f4a56)",
                          margin: 0,
                          lineHeight: 1.1,
                        }}
                      >
                        {customer}
                      </h3>
                      <span
                        style={{
                          fontSize: 10.5,
                          fontWeight: 700,
                          letterSpacing: "0.14em",
                          textTransform: "uppercase",
                          color: "var(--ink-3, #8a9498)",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {customerNotes.length}{" "}
                        {customerNotes.length === 1
                          ? t("soCountSingle")
                          : t("soCountPlural")}
                      </span>
                    </div>
                    <div style={{ display: "grid", gap: 10 }}>
                      {customerNotes.map((n) => {
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
                          {t("nowLabel")} {live.status_name ?? "—"} ·{" "}
                          {t("shipLabel")} {formatDate(live.date_first_ship)}
                        </span>
                      ) : (
                        <span
                          style={{
                            fontSize: 12,
                            color: "var(--ink-3, #8a9498)",
                            fontStyle: "italic",
                          }}
                        >
                          {t("notInFishbowl")}
                        </span>
                      )}
                    </div>
                    {(() => {
                      // AI key points — Claude-generated synthesis of
                      // Fishbowl + Monday + meeting notes. Rendered as
                      // a green-tinted "Key points" callout so it
                      // stands apart from raw data.
                      const syn = synthesisBy.get(so);
                      if (!syn || syn.points.length === 0) return null;
                      return (
                        <div
                          style={{
                            marginBottom: 10,
                            padding: "10px 12px",
                            background: "#f0f6ea",
                            border: "1px solid var(--sage-300, #bcd596)",
                            borderRadius: 8,
                          }}
                        >
                          <div
                            style={{
                              fontSize: 10,
                              fontWeight: 700,
                              letterSpacing: "0.14em",
                              textTransform: "uppercase",
                              color: "var(--sage-700, #5f8e3a)",
                              marginBottom: 6,
                            }}
                          >
                            {t("keyPointsLabel")}
                          </div>
                          {syn.headline ? (
                            <div
                              style={{
                                fontSize: 13,
                                fontWeight: 700,
                                color: "var(--teal-900, #0f4a56)",
                                marginBottom: 6,
                              }}
                            >
                              {syn.headline}
                            </div>
                          ) : null}
                          <ul
                            style={{
                              margin: 0,
                              paddingLeft: 18,
                              fontSize: 12.5,
                              lineHeight: 1.5,
                              color: "var(--ink-1, #1f2a2d)",
                            }}
                          >
                            {syn.points.map((p, i) => (
                              <li key={i}>{p.text}</li>
                            ))}
                          </ul>
                        </div>
                      );
                    })()}
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
                    {(() => {
                      // Localized mismatch warnings — emitted from
                      // structured flags rather than stitched into the
                      // note text so they translate cleanly.
                      const warnings: string[] = [];
                      if (n.customer_mismatch) {
                        warnings.push(
                          n.customer_hint
                            ? t("warnCustomerHint", { hint: n.customer_hint })
                            : t("warnCustomerNoHint", {
                                customer:
                                  ((n.fishbowl_snapshot as Record<
                                    string,
                                    unknown
                                  > | null)?.customer_name as
                                    | string
                                    | undefined) ?? "—",
                              }),
                        );
                      }
                      if (n.product_mismatch && n.product_hint) {
                        const [said, has] = String(n.product_hint).split("|");
                        warnings.push(
                          t("warnProduct", {
                            said: said ?? "",
                            has: has && has.length > 0 ? has : t("noMatchingProduct"),
                          }),
                        );
                      }
                      if (warnings.length === 0) return null;
                      return (
                        <div
                          style={{
                            marginTop: 8,
                            padding: "8px 10px",
                            background: "#fbf1e8",
                            border: "1px solid #e7c19a",
                            borderRadius: 6,
                            fontSize: 12,
                            color: "#7a4b1a",
                            display: "grid",
                            gap: 4,
                          }}
                        >
                          {warnings.map((w, i) => (
                            <div key={i}>{w}</div>
                          ))}
                        </div>
                      );
                    })()}
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
                              ? ` (${t("dueLabel")} ${formatDate(ai.due_date)})`
                              : ""}
                            {ai.done ? " ✓" : ""}
                          </li>
                        ))}
                      </ul>
                    ) : null}
                    {/* Fishbowl memo — the free-text note attached to
                        this SO inside Fishbowl. Meeting reviewers see
                        what Fishbowl already knows alongside what was
                        said in the meeting. */}
                    {live?.note ? (
                      <div
                        style={{
                          marginTop: 10,
                          padding: "8px 10px",
                          background: "var(--cream-soft, #fbf6ec)",
                          border: "1px solid var(--stone, #e3dcc9)",
                          borderRadius: 6,
                          fontSize: 12,
                          color: "var(--ink-2, #415056)",
                          whiteSpace: "pre-wrap",
                        }}
                      >
                        <span
                          style={{
                            fontSize: 10,
                            fontWeight: 700,
                            letterSpacing: "0.14em",
                            textTransform: "uppercase",
                            color: "var(--teal-700, #1d6c7b)",
                            marginRight: 6,
                          }}
                        >
                          {t("fishbowlMemoLabel")}
                        </span>
                        {live.note}
                      </div>
                    ) : null}
                    {/* Compact line items — sale + drop-ship rows only,
                        with product #, description, qty ordered, unit $,
                        ext $. Meeting reviewers see what's actually on
                        the SO. Type 40/50/70 (shipping/tax/discount) are
                        excluded. */}
                    {(() => {
                      const saleItems = (live?.items ?? []).filter(
                        (it) =>
                          it.type_id === 10 || it.type_id === 30,
                      );
                      if (saleItems.length === 0) return null;
                      return (
                        <div style={{ marginTop: 10, overflowX: "auto" }}>
                          <table
                            style={{
                              width: "100%",
                              fontSize: 11.5,
                              borderCollapse: "collapse",
                              border: "1px solid var(--stone, #e3dcc9)",
                              borderRadius: 6,
                              overflow: "hidden",
                            }}
                          >
                            <thead>
                              <tr
                                style={{
                                  background: "var(--cream, #f6efe3)",
                                }}
                              >
                                <MiniTh>{t("colProductNum")}</MiniTh>
                                <MiniTh>{t("colDescription")}</MiniTh>
                                <MiniTh align="right">{t("colQty")}</MiniTh>
                                <MiniTh align="right">{t("colUnitDollar")}</MiniTh>
                                <MiniTh align="right">{t("colExtDollar")}</MiniTh>
                              </tr>
                            </thead>
                            <tbody>
                              {saleItems.map((it, i) => (
                                <tr
                                  key={i}
                                  style={{
                                    borderTop:
                                      "1px solid var(--stone-2, #efe9da)",
                                  }}
                                >
                                  <MiniTd
                                    style={{
                                      fontFamily:
                                        "'IBM Plex Mono', ui-monospace, monospace",
                                      fontWeight: 700,
                                    }}
                                  >
                                    {it.product_num ?? "—"}
                                  </MiniTd>
                                  <MiniTd>{it.description ?? "—"}</MiniTd>
                                  <MiniTd align="right">
                                    {Number(it.qty_ordered ?? 0).toLocaleString()}
                                  </MiniTd>
                                  <MiniTd align="right">
                                    {formatMoney(it.unit_price)}
                                  </MiniTd>
                                  <MiniTd align="right">
                                    {formatMoney(it.total_price)}
                                  </MiniTd>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      );
                    })()}
                    {/* Recent Monday activity — the item's Updates
                        (comments/posts) from the Monday "Open Sales
                        Orders" board, cached in so_monday_activity by
                        /api/sync/monday. Meeting reviewers see the
                        latest day-to-day chatter on the SO alongside
                        the weekly Plaud notes. */}
                    {(() => {
                      const monday = mondayById.get(so);
                      if (!monday || monday.updates.length === 0) return null;
                      return (
                        <div
                          style={{
                            marginTop: 10,
                            padding: "8px 10px",
                            background: "var(--paper, #fffdf8)",
                            border: "1px solid var(--stone, #e3dcc9)",
                            borderRadius: 6,
                          }}
                        >
                          <div
                            style={{
                              display: "flex",
                              alignItems: "baseline",
                              justifyContent: "space-between",
                              gap: 10,
                              marginBottom: 6,
                            }}
                          >
                            <span
                              style={{
                                fontSize: 10,
                                fontWeight: 700,
                                letterSpacing: "0.14em",
                                textTransform: "uppercase",
                                color: "var(--teal-700, #1d6c7b)",
                              }}
                            >
                              {t("mondayActivityLabel")}
                              {monday.status ? ` · ${monday.status}` : ""}
                            </span>
                            {monday.monday_url ? (
                              <a
                                href={monday.monday_url}
                                target="_blank"
                                rel="noreferrer"
                                style={{
                                  fontSize: 11,
                                  color: "var(--teal-700, #1d6c7b)",
                                  textDecoration: "none",
                                }}
                              >
                                {t("openInMonday")}
                              </a>
                            ) : null}
                          </div>
                          <ul
                            style={{
                              listStyle: "none",
                              margin: 0,
                              padding: 0,
                              display: "grid",
                              gap: 6,
                            }}
                          >
                            {monday.updates.slice(0, 3).map((u) => (
                              <li
                                key={u.id}
                                style={{
                                  fontSize: 12,
                                  lineHeight: 1.5,
                                  color: "var(--ink-1, #1f2a2d)",
                                }}
                              >
                                <span
                                  style={{
                                    color: "var(--ink-3, #8a9498)",
                                    fontVariantNumeric: "tabular-nums",
                                    marginRight: 6,
                                  }}
                                >
                                  [{formatDate(u.created_at)}]
                                </span>
                                {u.creator_name ? (
                                  <strong>{u.creator_name}: </strong>
                                ) : null}
                                {u.text_body}
                              </li>
                            ))}
                          </ul>
                        </div>
                      );
                    })()}
                  </div>
                );
              })}
                    </div>
                  </section>
                ),
              )}
            </div>
          )}

          {/* Other business — cross-cutting topics that don't tie to a
              single SO. Shandong load status, line 2 sequence, film/cash
              questions, etc. Mirrors the "Otros temas" section from the
              8/25 curated PDF. Only rendered when the session has any. */}
          {otherBusiness.length > 0 ? (
            <div style={{ marginTop: 32 }}>
              <h2
                style={{
                  fontFamily: "'Cormorant Garamond', Georgia, serif",
                  fontSize: 24,
                  fontWeight: 600,
                  color: "var(--teal-900, #0f4a56)",
                  margin: "0 0 12px",
                }}
              >
                {t("otherBusiness")}
              </h2>
              <div style={{ display: "grid", gap: 10 }}>
                {otherBusiness.map((item, i) => {
                  const ai = item.action_items ?? [];
                  return (
                    <div
                      key={i}
                      style={{
                        padding: "14px 16px",
                        background: "var(--paper, #fffdf8)",
                        border: "1px solid var(--stone, #e3dcc9)",
                        borderRadius: 8,
                      }}
                    >
                      <div
                        style={{
                          fontFamily:
                            "'Cormorant Garamond', Georgia, serif",
                          fontSize: 18,
                          fontWeight: 600,
                          color: "var(--teal-900, #0f4a56)",
                          lineHeight: 1.2,
                          marginBottom: 8,
                        }}
                      >
                        {item.title}
                      </div>
                      {item.note_md ? (
                        <div
                          style={{
                            fontSize: 13,
                            lineHeight: 1.55,
                            color: "var(--ink-1, #1f2a2d)",
                            whiteSpace: "pre-wrap",
                          }}
                        >
                          {item.note_md}
                        </div>
                      ) : null}
                      {ai.length > 0 ? (
                        <ul
                          style={{
                            margin: "8px 0 0",
                            paddingLeft: 18,
                            fontSize: 12.5,
                            color: "var(--ink-2, #415056)",
                          }}
                        >
                          {ai.map((a, idx) => (
                            <li key={idx}>
                              {a.text}
                              {a.owner ? ` — ${a.owner}` : ""}
                              {a.due_date
                                ? ` (${t("dueLabel")} ${formatDate(a.due_date)})`
                                : ""}
                              {a.done ? " ✓" : ""}
                            </li>
                          ))}
                        </ul>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            </div>
          ) : null}
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

function formatMoney(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(Number(n))) return "—";
  return `$${Number(n).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

// Compact table cells used inside the per-SO line-items block on the
// session view. Kept small — the parent SO card is already dense.
function MiniTh({
  children,
  align,
}: {
  children: React.ReactNode;
  align?: "left" | "right";
}) {
  return (
    <th
      style={{
        textAlign: align ?? "left",
        padding: "5px 8px",
        fontSize: 9.5,
        fontWeight: 700,
        letterSpacing: "0.12em",
        textTransform: "uppercase",
        color: "var(--ink-3, #8a9498)",
        borderBottom: "1px solid var(--stone, #e3dcc9)",
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </th>
  );
}
function MiniTd({
  children,
  align,
  style,
}: {
  children: React.ReactNode;
  align?: "left" | "right";
  style?: React.CSSProperties;
}) {
  return (
    <td
      style={{
        textAlign: align ?? "left",
        padding: "5px 8px",
        fontSize: 11.5,
        verticalAlign: "middle",
        ...style,
      }}
    >
      {children}
    </td>
  );
}

// Group the session's SO notes by customer, matching the 8/25 curated
// PDF layout (customer header, then the SOs under it). Resolution order
// for a note's customer:
//   1. fishbowl_snapshot.customer_name  — Fishbowl at ingest time (truth)
//   2. liveById[so_number].customer_name — falls back to right-now Fishbowl
//      if the snapshot is null (SO wasn't in the mirror at ingest)
//   3. Extract the "**Customer**" bold prefix from note_md — the auto
//      extractor and hand-refined seeds both put the customer name in a
//      leading bold span
//   4. "Not in current Fishbowl mirror" — last resort so orphan notes
//      still land in a bucket rather than falling out of the render
//
// Customer groups sort alphabetically (case-insensitive). Within each,
// SOs sort by numeric-aware so_number (14221 before 14328 before M-14221),
// so master orders and dash-suffixed variants sit alongside their siblings.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type NoteRow = any;

function customerFor(
  n: NoteRow,
  liveById: Map<
    string,
    {
      status_name: string | null;
      is_open: boolean;
      date_first_ship: string | null;
      total_price: number | null;
      customer_name?: string | null;
    }
  >,
  knownCustomers: string[],
): string {
  const snap = (n.fishbowl_snapshot as Record<string, unknown> | null) ?? null;
  const snapCust =
    typeof snap?.customer_name === "string" && snap.customer_name.trim()
      ? (snap.customer_name as string).trim()
      : null;
  if (snapCust) return snapCust;
  const live = liveById.get(n.so_number as string);
  if (live && typeof live.customer_name === "string" && live.customer_name.trim()) {
    return live.customer_name.trim();
  }
  // Look for a leading bold span in note_md: "**Customer Name** — product"
  const noteMd = (n.note_md as string | null) ?? "";
  const boldMatch = /^\*\*([^*\n]+)\*\*/m.exec(noteMd.trim());
  if (boldMatch) {
    const raw = boldMatch[1].trim();
    // Merge with a known Fishbowl customer if the note-md fallback is a
    // substring either way — catches "Cunsa" ↔ "Cunsa International LLC",
    // "Worldwide" ↔ "WORLDWIDE COSMETICS INC.", etc. so the same customer
    // doesn't get split across two buckets.
    const rawL = raw.toLowerCase();
    const merged = knownCustomers.find((k) => {
      const kL = k.toLowerCase();
      return kL.includes(rawL) || rawL.includes(kL);
    });
    return merged ?? raw;
  }
  return "Not in current Fishbowl mirror";
}

function soSortKey(so: string): [number, string] {
  // Numeric-aware: pull leading digits (ignoring an optional M- prefix)
  // as the primary sort key so 14221 < 14328 numerically, while master
  // orders (M-14221) and dashed sub-orders (14814-1) still sort with
  // their siblings by the base number.
  const m = /^M-?(\d+)/.exec(so) ?? /^(\d+)/.exec(so);
  const n = m ? Number(m[1]) : Number.MAX_SAFE_INTEGER;
  return [n, so];
}

function groupNotesByCustomer(
  notes: NoteRow[],
  liveById: Map<
    string,
    {
      status_name: string | null;
      is_open: boolean;
      date_first_ship: string | null;
      total_price: number | null;
      customer_name?: string | null;
    }
  >,
): Array<[string, NoteRow[]]> {
  // First pass: collect every Fishbowl-verified customer name in this
  // session, so the note-md fallback can fuzzy-merge into a known bucket
  // rather than spawning a duplicate.
  const knownCustomers = new Set<string>();
  for (const n of notes) {
    const snap = (n.fishbowl_snapshot as Record<string, unknown> | null) ?? null;
    if (typeof snap?.customer_name === "string" && snap.customer_name.trim()) {
      knownCustomers.add((snap.customer_name as string).trim());
    }
    const live = liveById.get(n.so_number as string);
    if (live?.customer_name && live.customer_name.trim()) {
      knownCustomers.add(live.customer_name.trim());
    }
  }
  const knownList = Array.from(knownCustomers);

  const buckets = new Map<string, NoteRow[]>();
  for (const n of notes) {
    const cust = customerFor(n, liveById, knownList);
    const arr = buckets.get(cust) ?? [];
    arr.push(n);
    buckets.set(cust, arr);
  }
  for (const arr of buckets.values()) {
    arr.sort((a, b) => {
      const [aN, aS] = soSortKey(a.so_number);
      const [bN, bS] = soSortKey(b.so_number);
      if (aN !== bN) return aN - bN;
      return aS.localeCompare(bS);
    });
  }
  return Array.from(buckets.entries()).sort((a, b) =>
    a[0].localeCompare(b[0], undefined, { sensitivity: "base" }),
  );
}
