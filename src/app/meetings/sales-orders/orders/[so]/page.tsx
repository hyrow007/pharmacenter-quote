import { redirect, notFound } from "next/navigation";
import { headers } from "next/headers";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import AppHeader from "../../../../_components/AppHeader";
import { getLangFromCookie } from "@/lib/i18n/server";
import { makeT } from "@/lib/i18n/dict";
import SoChat from "@/app/orders/_components/SoChat";
import { describeFreshness } from "@/lib/freshness";

// /meetings/sales-orders/orders/[so]
//
// Single-SO detail view. Shows the live Fishbowl row (customer/PO/
// status/dates/items) plus every meeting note about this SO across
// sessions — so you can scroll the SO's history through the weekly
// meetings alongside its current state.
//
// Line items are filtered to sale + drop-ship (type_id 10 or 30);
// shipping / tax / discount rows (40 / 50 / 70) are excluded from the
// item table by design.

export const metadata = { title: "Meetings · Sales Order" };

const SALE_TYPE_IDS = new Set([10, 30]);
const COLS =
  "fb_so_id, so_number, status_id, status_name, is_open, customer_name, " +
  "customer_po, salesman, note, date_issued, date_created, date_first_ship, " +
  "date_last_modified, subtotal, total_price, items, synced_at";

type SoItem = {
  line: number | null;
  type_id: number | null;
  product_num: string | null;
  description: string | null;
  qty_ordered: number | null;
  qty_fulfilled: number | null;
  qty_picked: number | null;
  unit_price: number | null;
  total_price: number | null;
  date_scheduled: string | null;
};

export default async function SalesOrderDetailPage({
  params,
}: {
  params: Promise<{ so: string }>;
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

  const { so } = await params;

  const { data: rowRaw } = await supabase
    .from("fishbowl_sales_orders")
    .select(COLS)
    .eq("so_number", so)
    .maybeSingle();

  if (!rowRaw) notFound();

  // supabase-js can't statically type a runtime-composed column string, so
  // the query returns `GenericStringError`. Same escape hatch as
  // /api/sales-orders — cast once through unknown to the shape we know
  // Postgres actually returned.
  const row = rowRaw as unknown as {
    so_number: string;
    status_id: number | null;
    status_name: string | null;
    is_open: boolean;
    customer_name: string | null;
    customer_po: string | null;
    salesman: string | null;
    note: string | null;
    date_issued: string | null;
    date_first_ship: string | null;
    subtotal: number | null;
    total_price: number | null;
    items: SoItem[] | null;
    synced_at: string | null;
  };

  // Meeting notes about this SO — newest session first. Joins the
  // session date + type name inline so we can render the timeline
  // without a second lookup.
  const { data: noteRowsRaw } = await supabase
    .from("meeting_so_notes")
    .select(
      "id, session_id, note_md, note_md_es, action_items, action_items_es, status_flag, fishbowl_snapshot, customer_mismatch, customer_hint, product_mismatch, product_hint, created_at, " +
        "meeting_sessions(session_date, source, meeting_type_id)",
    )
    .eq("so_number", so)
    .order("created_at", { ascending: false })
    .limit(100);

  // Same cast-through-unknown escape hatch as the row fetch above —
  // supabase-js can't type a runtime-composed .select() string.
  const noteRowsUntyped = (noteRowsRaw ?? []) as unknown as Array<{
    id: string;
    session_id: string;
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
    meeting_sessions: {
      session_date: string | null;
      source: string | null;
      meeting_type_id: string | null;
    } | null;
  }>;
  // Pick the Spanish variant when the visitor is on ES.
  const noteRows = noteRowsUntyped.map((n) => ({
    ...n,
    note_md: lang === "es" && n.note_md_es ? n.note_md_es : n.note_md,
    action_items:
      lang === "es" &&
      Array.isArray(n.action_items_es) &&
      n.action_items_es.length > 0
        ? n.action_items_es
        : n.action_items,
  }));

  const items = (row.items ?? []).filter((it) =>
    it.type_id ? SALE_TYPE_IDS.has(it.type_id) : false,
  );
  const freshness = describeFreshness(row.synced_at, t, lang);

  // AI-synthesized key points — Claude-generated from Fishbowl +
  // Monday + meeting notes by a Cowork scheduled task, stored in
  // public.so_synthesis. Rendered at the top of the page.
  // Corrections recorded through the SO assistant -- verified facts that
  // outrank every synced source. Shown above the key points.
  const { data: corrRaw } = await supabase
    .from("so_corrections")
    .select("id, text, text_es, created_by, created_by_name, created_at")
    .eq("so_number", row.so_number)
    .is("retracted_at", null)
    .order("created_at", { ascending: false });
  const corrections = ((corrRaw ?? []) as unknown as Array<{
    id: string;
    text: string;
    text_es: string | null;
    created_by: string;
    created_by_name: string | null;
    created_at: string;
  }>).map((c) => ({
    ...c,
    text: lang === "es" && c.text_es ? c.text_es : c.text,
  }));

  const { data: synRaw } = await supabase
    .from("so_synthesis")
    .select("headline, points, generated_at")
    .eq("so_number", row.so_number)
    .maybeSingle();
  const synthesis = synRaw as unknown as {
    headline: string | null;
    points: Array<{ text: string; source?: string }> | null;
    generated_at: string;
  } | null;

  // Purchase orders placed against this SO — Fishbowl links a poitem
  // back to a soitem via poitem.soItemId; the sync side rolls the
  // distinct SO numbers up into fishbowl_purchase_orders.so_numbers[]
  // so we can find POs for one SO with an indexed contains query.
  const { data: purchaseOrdersRaw } = await supabase
    .from("fishbowl_purchase_orders")
    .select(
      "fb_po_id, po_number, status_name, is_open, vendor_name, buyer, " +
        "date_issued, date_created, total_price, items",
    )
    .contains("so_numbers", [row.so_number])
    .order("date_issued", { ascending: false });
  const purchaseOrders = (purchaseOrdersRaw ?? []) as unknown as Array<{
    fb_po_id: number;
    po_number: string;
    status_name: string | null;
    is_open: boolean;
    vendor_name: string | null;
    buyer: string | null;
    date_issued: string | null;
    date_created: string | null;
    total_price: number | null;
    items: Array<{
      line: number | null;
      product_num: string | null;
      description: string | null;
      qty_ordered: number | null;
      qty_fulfilled: number | null;
      unit_cost: number | null;
      total_cost: number | null;
      date_scheduled: string | null;
      so_number: string | null;
      so_item_line: number | null;
      so_item_product_num: string | null;
    }> | null;
  }>;
  // Show every line on each linked PO. In principle we could filter by
  // it.so_number === row.so_number for multi-SO POs, but the sync's
  // per-item attribution is only reliable when Fishbowl links via
  // poitem.soItemId or when product numbers overlap — otherwise the
  // sync falls back to stamping every item with the FIRST SO that
  // matched via vendorPO, so filtering here would hide legitimate lines
  // (e.g. PO 5915's paper items got attributed to SO 14740 even though
  // SO 14769 also lists PO 5915 in its Vendor PO field). Better to show
  // the whole PO — the reader already knows it's linked because it's in
  // this SO's Vendor PO — than to hide it.
  const purchaseOrdersForSo = purchaseOrders.map((po) => ({
    ...po,
    items: po.items ?? [],
  }));

  // Monday activity for this SO — cached in so_monday_activity.
  const { data: mondayRaw } = await supabase
    .from("so_monday_activity")
    .select(
      "monday_url, status, item_updated_at, updates, last_synced_at",
    )
    .eq("so_number", row.so_number)
    .maybeSingle();
  const monday = mondayRaw as unknown as {
    monday_url: string | null;
    status: string | null;
    item_updated_at: string | null;
    updates:
      | Array<{
          id: string;
          text_body: string;
          created_at: string;
          creator_name: string | null;
          // Replies are stored flat, newest first, by /api/sync/monday.
          kind?: "update" | "reply";
        }>
      | null;
    last_synced_at: string | null;
  } | null;

  return (
    <div className="app-shell">
      <AppHeader user={{ email: user.email! }} appContext="meetings" />
      <main className="page">
        <div className="page__inner--narrow">
          <Link
            href="/meetings/sales-orders/all"
            className="meetings-noprint"
            style={backPill()}
          >
            <span aria-hidden="true">&larr;</span> {t("openOrdersTitle")}
          </Link>

          <div style={{ marginBottom: 6 }}>
            <p className="eyebrow" style={{ marginBottom: 6 }}>
              {t("salesOrdersBreadcrumb")}
            </p>
            <div
              style={{
                display: "flex",
                alignItems: "baseline",
                gap: 14,
                flexWrap: "wrap",
                marginBottom: 4,
              }}
            >
              <h1
                className="page-header__title"
                style={{ margin: 0 }}
              >
                {t("soPrefix")} {row.so_number as string}
              </h1>
              <span style={{ color: "var(--ink-2, #415056)", fontSize: 16 }}>
                {(row.customer_name as string | null) ?? "—"}
              </span>
            </div>
            <div
              style={{
                fontSize: 12,
                color: "var(--ink-3, #8a9498)",
                marginBottom: 18,
              }}
            >
              {t("syncedAgo", { rel: freshness.relative })}
              {freshness.stale
                ? ` · ${t("syncedStaleShort")}`
                : ""}
            </div>
          </div>

          {corrections.length > 0 ? (
            <div
              style={{
                marginBottom: 14,
                padding: "12px 16px",
                background: "#fdf6e3",
                border: "1px solid #ecd9a0",
                borderRadius: 10,
              }}
            >
              <div
                style={{
                  fontSize: 10.5,
                  fontWeight: 800,
                  letterSpacing: "0.14em",
                  textTransform: "uppercase",
                  color: "#6b5410",
                  marginBottom: 6,
                }}
              >
                {t("correctionsTitle")}
              </div>
              {corrections.map((c) => (
                <div key={c.id} style={{ fontSize: 13.5, lineHeight: 1.5, marginBottom: 4 }}>
                  {c.text}{" "}
                  <span style={{ fontSize: 11, color: "var(--ink-3, #8a9498)" }}>
                    — {c.created_by_name ?? c.created_by}, {formatDate(c.created_at)}
                  </span>
                </div>
              ))}
            </div>
          ) : null}

          {/* AI key points — synthesized from Fishbowl + Monday +
              meeting notes. Rendered as a green-tinted callout right
              above the order-summary card so a reviewer sees the "3-5
              things that matter" first, before the raw data. */}
          {synthesis && (synthesis.points?.length ?? 0) > 0 ? (
            <div
              style={{
                marginBottom: 18,
                padding: "14px 18px",
                background: "#f0f6ea",
                border: "1px solid var(--sage-300, #bcd596)",
                borderRadius: 10,
              }}
            >
              <div
                style={{
                  fontSize: 10.5,
                  fontWeight: 700,
                  letterSpacing: "0.14em",
                  textTransform: "uppercase",
                  color: "var(--sage-700, #5f8e3a)",
                  marginBottom: 6,
                }}
              >
                {t("keyPointsLabel")}
              </div>
              {synthesis.headline ? (
                <div
                  style={{
                    fontSize: 15,
                    fontWeight: 700,
                    color: "var(--teal-900, #0f4a56)",
                    marginBottom: 8,
                  }}
                >
                  {synthesis.headline}
                </div>
              ) : null}
              <ul
                style={{
                  margin: 0,
                  paddingLeft: 20,
                  fontSize: 13,
                  lineHeight: 1.55,
                  color: "var(--ink-1, #1f2a2d)",
                }}
              >
                {(synthesis.points ?? []).map((p, i) => (
                  <li key={i}>{p.text}</li>
                ))}
              </ul>
              <div
                style={{
                  marginTop: 6,
                  fontSize: 10.5,
                  color: "var(--ink-3, #8a9498)",
                }}
              >
                {t("generatedRelative", { date: formatDate(synthesis.generated_at) })}
              </div>
            </div>
          ) : null}

          {/* Order summary card ----------------------------------- */}
          <div
            style={{
              display: "grid",
              gridTemplateColumns:
                "repeat(auto-fit, minmax(160px, 1fr))",
              gap: 10,
              padding: "14px 16px",
              background: "var(--paper, #fffdf8)",
              border: "1px solid var(--stone, #e3dcc9)",
              borderRadius: 10,
              marginBottom: 18,
            }}
          >
            <Fact label={t("factStatus")} value={row.status_name as string | null} />
            <Fact label={t("factPo")} value={row.customer_po as string | null} />
            <Fact
              label={t("factSalesman")}
              value={row.salesman as string | null}
            />
            <Fact
              label={t("factIssued")}
              value={formatDate(row.date_issued as string | null)}
            />
            <Fact
              label={t("factScheduledShip")}
              value={formatDate(row.date_first_ship as string | null)}
            />
            <Fact
              label={t("factTotal")}
              value={formatMoney(row.total_price as number | null)}
              mono
            />
          </div>

          {row.note ? (
            <div
              style={{
                fontSize: 13,
                color: "var(--ink-2, #415056)",
                background: "var(--cream-soft, #fbf6ec)",
                border: "1px solid var(--stone, #e3dcc9)",
                borderRadius: 8,
                padding: "10px 14px",
                marginBottom: 18,
                whiteSpace: "pre-wrap",
              }}
            >
              <div
                style={{
                  fontSize: 10.5,
                  fontWeight: 700,
                  letterSpacing: "0.14em",
                  textTransform: "uppercase",
                  color: "var(--teal-700, #1d6c7b)",
                  marginBottom: 4,
                }}
              >
                {t("orderNoteLabel")}
              </div>
              {row.note as string}
            </div>
          ) : null}

          {/* Line items --------------------------------------------- */}
          <h2 style={sectionTitle()}>{t("lineItemsTitle")}</h2>
          {items.length === 0 ? (
            <div style={emptyStyle()}>
              {t("noLineItemsForSo")}
            </div>
          ) : (
            <table style={itemsTable()}>
              <thead>
                <tr style={{ background: "var(--cream, #f6efe3)" }}>
                  <SmallTh>{t("colProductNum")}</SmallTh>
                  <SmallTh>{t("colDescription")}</SmallTh>
                  <SmallTh align="right">{t("colOrdered")}</SmallTh>
                  <SmallTh align="right">{t("colPicked")}</SmallTh>
                  <SmallTh align="right">{t("colFulfilled")}</SmallTh>
                  <SmallTh align="right">{t("colUnitDollar")}</SmallTh>
                  <SmallTh align="right">{t("colExtDollar")}</SmallTh>
                  <SmallTh>{t("colScheduled")}</SmallTh>
                </tr>
              </thead>
              <tbody>
                {items.map((it, i) => {
                  const ordered = Number(it.qty_ordered) || 0;
                  const fulfilled = Number(it.qty_fulfilled) || 0;
                  const pct =
                    ordered > 0
                      ? Math.min(
                          100,
                          Math.round((fulfilled / ordered) * 100),
                        )
                      : 0;
                  return (
                    <tr
                      key={i}
                      style={{
                        borderTop: "1px solid var(--stone-2, #efe9da)",
                      }}
                    >
                      <SmallTd
                        style={{
                          fontFamily:
                            "'IBM Plex Mono', ui-monospace, monospace",
                          fontWeight: 700,
                        }}
                      >
                        {it.product_num}
                      </SmallTd>
                      <SmallTd>{it.description}</SmallTd>
                      <SmallTd align="right">
                        {ordered.toLocaleString()}
                      </SmallTd>
                      <SmallTd align="right">
                        {(Number(it.qty_picked) || 0).toLocaleString()}
                      </SmallTd>
                      <SmallTd align="right">
                        <div
                          style={{
                            display: "inline-flex",
                            alignItems: "center",
                            gap: 8,
                          }}
                        >
                          <span>{fulfilled.toLocaleString()}</span>
                          <span
                            aria-hidden="true"
                            title={`${pct}% fulfilled`}
                            style={{
                              display: "inline-block",
                              width: 48,
                              height: 6,
                              background: "var(--stone-2, #efe9da)",
                              borderRadius: 3,
                              overflow: "hidden",
                            }}
                          >
                            <span
                              style={{
                                display: "block",
                                width: `${pct}%`,
                                height: "100%",
                                background: "var(--sage-500, #7fb04f)",
                              }}
                            />
                          </span>
                        </div>
                      </SmallTd>
                      <SmallTd align="right">
                        {formatMoney(it.unit_price)}
                      </SmallTd>
                      <SmallTd align="right">
                        {formatMoney(it.total_price)}
                      </SmallTd>
                      <SmallTd>{formatDate(it.date_scheduled)}</SmallTd>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}

          {/* Purchase orders placed for this SO — one card per PO,
              showing the vendor we bought from, when we placed the
              order, and the lines that were purchased against this
              SO. Only shows up when at least one PO in the mirror
              references this SO number. */}
          {purchaseOrdersForSo.length > 0 ? (
            <>
              <h2 style={{ ...sectionTitle(), marginTop: 26 }}>
                {t("purchaseOrdersTitle")}
              </h2>
              <div style={{ display: "grid", gap: 12, marginBottom: 4 }}>
                {purchaseOrdersForSo.map((po) => (
                  <div
                    key={po.fb_po_id}
                    style={{
                      background: "var(--paper, #fffdf8)",
                      border: "1px solid var(--stone, #e3dcc9)",
                      borderRadius: 10,
                      overflow: "hidden",
                    }}
                  >
                    <div
                      style={{
                        display: "flex",
                        alignItems: "baseline",
                        gap: 14,
                        flexWrap: "wrap",
                        padding: "12px 16px",
                        borderBottom: "1px solid var(--stone-2, #efe9da)",
                        background: "var(--cream-soft, #fbf6ec)",
                      }}
                    >
                      <span
                        style={{
                          fontFamily:
                            "'IBM Plex Mono', ui-monospace, monospace",
                          fontWeight: 700,
                          color: "var(--teal-900, #0f4a56)",
                        }}
                      >
                        {t("poPrefix")} {po.po_number}
                      </span>
                      <span
                        style={{ fontSize: 13, color: "var(--ink-2, #415056)" }}
                      >
                        {po.vendor_name ?? "—"}
                      </span>
                      {po.status_name ? (
                        <span
                          style={{
                            fontSize: 11,
                            fontWeight: 700,
                            letterSpacing: "0.04em",
                            padding: "2px 10px",
                            background: po.is_open
                              ? "var(--sage-100, #e7f0d8)"
                              : "var(--stone-2, #efe9da)",
                            border: "1px solid var(--stone, #e3dcc9)",
                            borderRadius: 999,
                            color: "var(--teal-900, #0f4a56)",
                          }}
                        >
                          {po.status_name}
                        </span>
                      ) : null}
                      <span
                        style={{
                          marginLeft: "auto",
                          fontSize: 12,
                          color: "var(--ink-3, #8a9498)",
                        }}
                      >
                        {t("poPlacedOn", {
                          date:
                            formatDate(po.date_issued) ??
                            formatDate(po.date_created) ??
                            "—",
                        })}
                        {po.buyer ? ` · ${po.buyer}` : ""}
                      </span>
                    </div>
                    <table style={itemsTable()}>
                      <thead>
                        <tr style={{ background: "var(--cream, #f6efe3)" }}>
                          <SmallTh>{t("colProductNum")}</SmallTh>
                          <SmallTh>{t("colDescription")}</SmallTh>
                          <SmallTh align="right">{t("colOrdered")}</SmallTh>
                          <SmallTh align="right">{t("colReceived")}</SmallTh>
                          <SmallTh align="right">{t("colUnitDollar")}</SmallTh>
                          <SmallTh align="right">{t("colExtDollar")}</SmallTh>
                          <SmallTh>{t("colEta")}</SmallTh>
                        </tr>
                      </thead>
                      <tbody>
                        {po.items.map((it, i) => (
                          <tr
                            key={i}
                            style={{
                              borderTop:
                                i === 0
                                  ? "none"
                                  : "1px solid var(--stone-2, #efe9da)",
                            }}
                          >
                            <SmallTd
                              style={{
                                fontFamily:
                                  "'IBM Plex Mono', ui-monospace, monospace",
                                fontWeight: 700,
                              }}
                            >
                              {it.product_num}
                            </SmallTd>
                            <SmallTd>{it.description}</SmallTd>
                            <SmallTd align="right">
                              {(Number(it.qty_ordered) || 0).toLocaleString()}
                            </SmallTd>
                            <SmallTd align="right">
                              {(Number(it.qty_fulfilled) || 0).toLocaleString()}
                            </SmallTd>
                            <SmallTd align="right">
                              {formatMoney(it.unit_cost)}
                            </SmallTd>
                            <SmallTd align="right">
                              {formatMoney(it.total_cost)}
                            </SmallTd>
                            <SmallTd>{formatDate(it.date_scheduled)}</SmallTd>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ))}
              </div>
            </>
          ) : null}

          {/* Recent Monday activity — the Updates feed on this SO's
              Monday item, cached in so_monday_activity by
              /api/sync/monday. Shows the day-to-day chatter (FedEx
              tracking, @-mentions, port updates). */}
          {monday && (monday.updates?.length ?? 0) > 0 ? (
            <>
              <h2 style={{ ...sectionTitle(), marginTop: 26 }}>
                {t("mondayActivityTitle")}
                {monday.status ? (
                  <span
                    style={{
                      fontSize: 12,
                      marginLeft: 12,
                      padding: "2px 10px",
                      background: "var(--cream, #f6efe3)",
                      border: "1px solid var(--stone, #e3dcc9)",
                      borderRadius: 999,
                      color: "var(--teal-900, #0f4a56)",
                      fontWeight: 700,
                      letterSpacing: "0.04em",
                    }}
                  >
                    {monday.status}
                  </span>
                ) : null}
                {monday.monday_url ? (
                  <a
                    href={monday.monday_url}
                    target="_blank"
                    rel="noreferrer"
                    style={{
                      fontSize: 12,
                      marginLeft: 12,
                      color: "var(--teal-700, #1d6c7b)",
                      textDecoration: "none",
                      fontFamily: "inherit",
                    }}
                  >
                    {t("openInMonday")}
                  </a>
                ) : null}
              </h2>
              <div style={{ display: "grid", gap: 8, marginBottom: 16 }}>
                {(monday.updates ?? []).map((u) => (
                  <div
                    key={u.id}
                    style={{
                      padding: "10px 12px",
                      background: "var(--paper, #fffdf8)",
                      border: "1px solid var(--stone, #e3dcc9)",
                      borderRadius: 6,
                      fontSize: 13,
                      lineHeight: 1.55,
                      color: "var(--ink-1, #1f2a2d)",
                    }}
                  >
                    <div
                      style={{
                        fontSize: 11,
                        color: "var(--ink-3, #8a9498)",
                        marginBottom: 4,
                      }}
                    >
                      {u.kind === "reply" ? "↳ " : ""}
                      {u.creator_name ? (
                        <strong style={{ color: "var(--teal-900, #0f4a56)" }}>
                          {u.creator_name}
                        </strong>
                      ) : (
                        "(unknown)"
                      )}
                      {" · "}
                      {formatDate(u.created_at)}
                    </div>
                    <div style={{ whiteSpace: "pre-wrap" }}>{u.text_body}</div>
                  </div>
                ))}
              </div>
            </>
          ) : null}

          {/* Meeting timeline --------------------------------------- */}
          <h2 style={{ ...sectionTitle(), marginTop: 26 }}>
            {t("meetingHistoryTitle")}
          </h2>
          {(noteRows ?? []).length === 0 ? (
            <div style={emptyStyle()}>
              {t("noMeetingsForSo")}
            </div>
          ) : (
            <div style={{ display: "grid", gap: 10 }}>
              {(noteRows ?? []).map((n) => {
                const session = (n.meeting_sessions ?? null) as
                  | {
                      session_date?: string | null;
                      source?: string | null;
                    }
                  | null;
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
                      padding: "12px 14px",
                      background: "var(--paper, #fffdf8)",
                      border: "1px solid var(--stone, #e3dcc9)",
                      borderRadius: 8,
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
                      <strong
                        style={{
                          fontSize: 13,
                          color: "var(--teal-900, #0f4a56)",
                        }}
                      >
                        {formatDate(session?.session_date ?? null)}
                      </strong>
                      {n.status_flag ? (
                        <span
                          style={{
                            fontSize: 10.5,
                            fontWeight: 700,
                            letterSpacing: "0.12em",
                            textTransform: "uppercase",
                            color: "var(--teal-700, #1d6c7b)",
                          }}
                        >
                          {n.status_flag as string}
                        </span>
                      ) : null}
                    </div>
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
                            has:
                              has && has.length > 0
                                ? has
                                : t("noMatchingProduct"),
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
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </main>
      <SoChat so={row.so_number} lang={lang} />
    </div>
  );
}

// --- small components -----------------------------------------------------

function Fact({
  label,
  value,
  mono,
}: {
  label: string;
  value: string | null | undefined;
  mono?: boolean;
}) {
  return (
    <div>
      <div
        style={{
          fontSize: 10,
          fontWeight: 700,
          letterSpacing: "0.14em",
          textTransform: "uppercase",
          color: "var(--ink-3, #8a9498)",
          marginBottom: 2,
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontSize: 14,
          fontWeight: 600,
          color: "var(--teal-900, #0f4a56)",
          fontFamily: mono
            ? "'IBM Plex Mono', ui-monospace, monospace"
            : undefined,
          fontVariantNumeric: mono ? "tabular-nums" : undefined,
        }}
      >
        {value || "—"}
      </div>
    </div>
  );
}

function SmallTh({
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
        padding: "8px 10px",
        fontSize: 10,
        fontWeight: 700,
        letterSpacing: "0.14em",
        textTransform: "uppercase",
        color: "var(--ink-3, #8a9498)",
        borderBottom: "1.5px solid var(--teal-700, #1d6c7b)",
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </th>
  );
}
function SmallTd({
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
        padding: "8px 10px",
        fontSize: 12.5,
        verticalAlign: "middle",
        ...style,
      }}
    >
      {children}
    </td>
  );
}

function backPill(): React.CSSProperties {
  return {
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
  };
}
function sectionTitle(): React.CSSProperties {
  return {
    fontFamily: "'Cormorant Garamond', Georgia, serif",
    fontSize: 24,
    fontWeight: 600,
    color: "var(--teal-900, #0f4a56)",
    margin: "0 0 10px",
  };
}
function emptyStyle(): React.CSSProperties {
  return {
    padding: "24px 16px",
    border: "1px dashed var(--stone, #e3dcc9)",
    borderRadius: 8,
    textAlign: "center",
    color: "var(--ink-3, #8a9498)",
    fontSize: 13,
    background: "var(--cream-soft, #fbf6ec)",
  };
}
function itemsTable(): React.CSSProperties {
  return {
    width: "100%",
    borderCollapse: "collapse",
    background: "var(--paper, #fffdf8)",
    border: "1px solid var(--stone, #e3dcc9)",
    borderRadius: 8,
    overflow: "hidden",
    fontSize: 12.5,
  };
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
