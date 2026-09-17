import { redirect } from "next/navigation";
import { headers } from "next/headers";
import Link from "next/link";
import { createClient } from "@/lib/auth/server";
import AppHeader from "../_components/AppHeader";
import { getLangFromCookie } from "@/lib/i18n/server";
import { makeT } from "@/lib/i18n/dict";

// /orders
//
// Sales-order status tracker landing. Every OPEN SO (Fishbowl statusId
// 10 Estimate / 20 Issued / 25 In Progress) grouped by customer, with
// per-SO context — AI key points, last Plaud/Monday touch, ship date,
// mismatch/staleness warnings — visible without a click.
//
// The old /meetings/sales-orders hub still works; this is the new
// front door when visiting order.pharmacenter.app / orders.pharmacenter.app.

export const metadata = { title: "Sales Order Tracker" };

// SO statuses we treat as "in flight" and show on this landing.
const OPEN_STATUS_IDS = [10, 20, 25];

// Ship-date urgency thresholds (days from today).
const OVERDUE_THRESHOLD_DAYS = 0;
const IMMINENT_THRESHOLD_DAYS = 7;

// Staleness threshold — SO hasn't been mentioned in a meeting or had a
// Monday update in >= this many days.
const STALE_THRESHOLD_DAYS = 14;

type SoRow = {
  so_number: string;
  status_id: number | null;
  status_name: string | null;
  is_open: boolean;
  customer_name: string | null;
  customer_po: string | null;
  salesman: string | null;
  date_issued: string | null;
  date_first_ship: string | null;
  subtotal: number | null;
  total_price: number | null;
  items: Array<{
    type_id: number | null;
    product_num: string | null;
    description: string | null;
    qty_ordered: number | null;
  }> | null;
  synced_at: string | null;
};

const SO_COLS =
  "so_number, status_id, status_name, is_open, customer_name, customer_po, " +
  "salesman, date_issued, date_first_ship, subtotal, total_price, items, synced_at";

export default async function OrdersLandingPage() {
  const lang = await getLangFromCookie();
  const t = makeT(lang);
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user || !user.email?.endsWith("@pharmacenterusa.com")) {
    const hostHeader = (await headers()).get("host") ?? "";
    const isBrandedHost =
      hostHeader.startsWith("meeting.") ||
      hostHeader.startsWith("meetings.") ||
      hostHeader.startsWith("order.") ||
      hostHeader.startsWith("orders.");
    redirect(isBrandedHost ? "/?showSignIn=1" : "/");
  }

  // Fan out three reads in parallel — main SO list, key-points cache,
  // and per-SO Monday activity. Meeting notes need a per-SO latest so
  // we roll that up in Node after the fetch (Postgres group-by-max
  // would need a view; overkill for < 100 SOs).
  const [soRes, synRes, mondayRes, notesRes] = await Promise.all([
    supabase
      .from("fishbowl_sales_orders")
      .select(SO_COLS)
      .in("status_id", OPEN_STATUS_IDS)
      .order("customer_name", { ascending: true })
      .order("so_number", { ascending: true })
      .limit(500),
    supabase
      .from("so_synthesis")
      .select("so_number, headline, points, generated_at"),
    supabase
      .from("so_monday_activity")
      .select("so_number, status, item_updated_at, last_synced_at, updates"),
    supabase
      .from("meeting_so_notes")
      .select(
        "so_number, customer_mismatch, product_mismatch, status_flag, created_at, " +
          "meeting_sessions(session_date)",
      )
      .order("created_at", { ascending: false })
      .limit(500),
  ]);

  const rows = (soRes.data ?? []) as unknown as SoRow[];

  const synBy = new Map<
    string,
    {
      headline: string | null;
      points: Array<{ text: string; source?: string }> | null;
      generated_at: string;
    }
  >();
  for (const raw of (synRes.data ?? []) as unknown[]) {
    const s = raw as {
      so_number: string;
      headline: string | null;
      points: Array<{ text: string; source?: string }> | null;
      generated_at: string;
    };
    synBy.set(s.so_number, s);
  }

  const mondayBy = new Map<
    string,
    {
      status: string | null;
      item_updated_at: string | null;
      last_synced_at: string | null;
      update_count: number;
      latest_update_at: string | null;
    }
  >();
  for (const raw of (mondayRes.data ?? []) as unknown[]) {
    const m = raw as {
      so_number: string;
      status: string | null;
      item_updated_at: string | null;
      last_synced_at: string | null;
      updates:
        | Array<{
            id: string;
            text_body: string;
            created_at: string;
            creator_name: string | null;
          }>
        | null;
    };
    const updates = Array.isArray(m.updates) ? m.updates : [];
    const latest = updates.reduce<string | null>(
      (a, u) => (a && a > u.created_at ? a : u.created_at ?? a),
      null,
    );
    mondayBy.set(m.so_number, {
      status: m.status,
      item_updated_at: m.item_updated_at,
      last_synced_at: m.last_synced_at,
      update_count: updates.length,
      latest_update_at: latest,
    });
  }

  const notesBy = new Map<
    string,
    {
      last_session_date: string | null;
      last_created_at: string | null;
      note_count: number;
      customer_mismatch: boolean;
      product_mismatch: boolean;
      status_flag: string | null;
    }
  >();
  for (const raw of (notesRes.data ?? []) as unknown[]) {
    const n = raw as {
      so_number: string;
      customer_mismatch: boolean | null;
      product_mismatch: boolean | null;
      status_flag: string | null;
      created_at: string;
      meeting_sessions: { session_date: string | null } | null;
    };
    const cur = notesBy.get(n.so_number) ?? {
      last_session_date: null,
      last_created_at: null,
      note_count: 0,
      customer_mismatch: false,
      product_mismatch: false,
      status_flag: null as string | null,
    };
    cur.note_count += 1;
    const sd = n.meeting_sessions?.session_date ?? null;
    if (sd && (!cur.last_session_date || sd > cur.last_session_date)) {
      cur.last_session_date = sd;
    }
    if (!cur.last_created_at || n.created_at > cur.last_created_at) {
      cur.last_created_at = n.created_at;
    }
    if (n.customer_mismatch) cur.customer_mismatch = true;
    if (n.product_mismatch) cur.product_mismatch = true;
    if (n.status_flag && !cur.status_flag) cur.status_flag = n.status_flag;
    notesBy.set(n.so_number, cur);
  }

  // Group SOs by customer_name, preserving alphabetical order.
  const byCustomer = new Map<string, SoRow[]>();
  for (const r of rows) {
    const key = r.customer_name?.trim() || "—";
    if (!byCustomer.has(key)) byCustomer.set(key, []);
    byCustomer.get(key)!.push(r);
  }
  const customerGroups = Array.from(byCustomer.entries())
    .map(([customer, sos]) => ({
      customer,
      sos: sos.sort((a, b) => {
        // ship-date soonest first; SOs without a ship date sink to the bottom
        const av = a.date_first_ship || "9999-99-99";
        const bv = b.date_first_ship || "9999-99-99";
        return av.localeCompare(bv);
      }),
    }))
    .sort((a, b) => a.customer.localeCompare(b.customer));

  const totalOpen = rows.filter((r) => (r.status_id ?? 0) !== 10).length;
  const totalEstimate = rows.filter((r) => r.status_id === 10).length;
  const freshness = describeFreshness(
    rows.reduce<string | null>(
      (m, r) =>
        typeof r.synced_at === "string" && (!m || r.synced_at > m)
          ? r.synced_at
          : m,
      null,
    ),
  );

  return (
    <div className="app-shell">
      <AppHeader user={{ email: user.email! }} appContext="meetings" />
      <main className="page">
        <div className="page__inner">
          <div style={{ marginBottom: 22 }}>
            <p className="eyebrow" style={{ marginBottom: 6 }}>
              {t("ordersEyebrow")}
            </p>
            <h1 className="page-header__title" style={{ marginBottom: 6 }}>
              {t("ordersTitle")}
            </h1>
            <p
              className="lede"
              style={{ marginTop: 4, marginBottom: 8 }}
            >
              {t("ordersLede")}
            </p>
            <div
              style={{
                fontSize: 12,
                color: "var(--ink-3, #8a9498)",
                display: "flex",
                gap: 14,
                flexWrap: "wrap",
              }}
            >
              <span>
                {totalOpen} {t("ordersOpenCount")}
                {totalEstimate > 0
                  ? ` · ${totalEstimate} ${t("ordersEstimateCount")}`
                  : ""}
              </span>
              <span>
                {t("ordersCustomerCount", { n: String(customerGroups.length) })}
              </span>
              <span>
                {t("syncedAgo", { rel: freshness.relative })}
              </span>
              <Link
                href="/meetings/sales-orders"
                style={{
                  color: "var(--teal-700, #1d6c7b)",
                  textDecoration: "none",
                  fontWeight: 700,
                }}
              >
                {t("ordersMeetingsLink")} →
              </Link>
            </div>
          </div>

          {customerGroups.length === 0 ? (
            <div style={emptyStyle()}>{t("ordersNoOpen")}</div>
          ) : (
            <div style={{ display: "grid", gap: 24 }}>
              {customerGroups.map(({ customer, sos }) => (
                <section key={customer}>
                  <div
                    style={{
                      display: "flex",
                      alignItems: "baseline",
                      gap: 12,
                      marginBottom: 8,
                      paddingBottom: 4,
                      borderBottom: "1px solid var(--stone-2, #efe9da)",
                    }}
                  >
                    <h2
                      style={{
                        fontFamily:
                          "'Cormorant Garamond', Georgia, serif",
                        fontSize: 24,
                        fontWeight: 600,
                        color: "var(--teal-900, #0f4a56)",
                        margin: 0,
                      }}
                    >
                      {customer}
                    </h2>
                    <span
                      style={{
                        fontSize: 11,
                        fontWeight: 700,
                        letterSpacing: "0.14em",
                        textTransform: "uppercase",
                        color: "var(--ink-3, #8a9498)",
                      }}
                    >
                      {sos.length}{" "}
                      {sos.length === 1 ? t("soCountSingle") : t("soCountPlural")}
                    </span>
                  </div>
                  <div style={{ display: "grid", gap: 10 }}>
                    {sos.map((so) => {
                      const key = so.so_number;
                      const syn = synBy.get(key);
                      const monday = mondayBy.get(key);
                      const notes = notesBy.get(key);
                      const ship = classifyShipDate(so.date_first_ship);
                      const lastTouches: string[] = [];
                      if (notes?.last_session_date)
                        lastTouches.push(
                          `${t("touchPlaud")} ${formatShort(notes.last_session_date)}`,
                        );
                      if (monday?.latest_update_at)
                        lastTouches.push(
                          `${t("touchMonday")} ${describeFreshness(monday.latest_update_at).relative}`,
                        );
                      if (so.synced_at)
                        lastTouches.push(
                          `${t("touchFishbowl")} ${describeFreshness(so.synced_at).relative}`,
                        );

                      const warnings: string[] = [];
                      if (ship.overdue)
                        warnings.push(t("warnShipOverdue"));
                      else if (ship.imminent)
                        warnings.push(
                          t("warnShipImminent", { days: String(ship.daysAway) }),
                        );
                      if (notes?.customer_mismatch)
                        warnings.push(t("warnCustomerMismatchShort"));
                      if (notes?.product_mismatch)
                        warnings.push(t("warnProductMismatchShort"));
                      const stale = isStale(
                        notes?.last_session_date,
                        monday?.latest_update_at,
                      );
                      if (stale)
                        warnings.push(
                          t("warnStale", { days: String(STALE_THRESHOLD_DAYS) }),
                        );

                      const topPoints = (syn?.points ?? []).slice(0, 2);

                      return (
                        <Link
                          key={key}
                          href={`/meetings/sales-orders/orders/${key}`}
                          style={cardStyle(so.status_id, ship)}
                        >
                          <div
                            style={{
                              display: "flex",
                              alignItems: "baseline",
                              gap: 12,
                              flexWrap: "wrap",
                              marginBottom: syn || warnings.length ? 6 : 0,
                            }}
                          >
                            <span
                              style={{
                                fontFamily:
                                  "'IBM Plex Mono', ui-monospace, monospace",
                                fontSize: 15,
                                fontWeight: 700,
                                color: "var(--teal-900, #0f4a56)",
                              }}
                            >
                              {t("soPrefix")} {so.so_number}
                            </span>
                            <StatusPill
                              status={so.status_name}
                              statusId={so.status_id}
                            />
                            {so.date_first_ship ? (
                              <ShipDatePill
                                date={so.date_first_ship}
                                classification={ship}
                                t={t}
                              />
                            ) : null}
                            {so.salesman ? (
                              <span
                                style={{
                                  fontSize: 11,
                                  color: "var(--ink-3, #8a9498)",
                                }}
                              >
                                {so.salesman}
                              </span>
                            ) : null}
                            {so.total_price != null ? (
                              <span
                                style={{
                                  marginLeft: "auto",
                                  fontFamily:
                                    "'IBM Plex Mono', ui-monospace, monospace",
                                  fontSize: 13,
                                  color: "var(--ink-2, #415056)",
                                }}
                              >
                                {formatMoney(so.total_price)}
                              </span>
                            ) : null}
                          </div>

                          {syn && topPoints.length > 0 ? (
                            <div
                              style={{
                                background: "#f6f9f0",
                                border: "1px solid var(--sage-200, #d5e5b7)",
                                borderRadius: 8,
                                padding: "8px 12px",
                                marginBottom: warnings.length ? 6 : 0,
                              }}
                            >
                              {syn.headline ? (
                                <div
                                  style={{
                                    fontSize: 13,
                                    fontWeight: 700,
                                    color: "var(--teal-900, #0f4a56)",
                                    marginBottom: 4,
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
                                {topPoints.map((p, i) => (
                                  <li key={i}>{p.text}</li>
                                ))}
                              </ul>
                            </div>
                          ) : null}

                          {warnings.length > 0 ? (
                            <div
                              style={{
                                display: "flex",
                                flexWrap: "wrap",
                                gap: 6,
                                marginBottom: lastTouches.length ? 6 : 0,
                              }}
                            >
                              {warnings.map((w, i) => (
                                <span
                                  key={i}
                                  style={{
                                    fontSize: 11,
                                    fontWeight: 700,
                                    padding: "2px 8px",
                                    borderRadius: 999,
                                    background: "#fef1d6",
                                    color: "#8a5a0b",
                                    border: "1px solid #f2d38a",
                                  }}
                                >
                                  ⚠ {w}
                                </span>
                              ))}
                            </div>
                          ) : null}

                          {lastTouches.length > 0 ? (
                            <div
                              style={{
                                fontSize: 11,
                                color: "var(--ink-3, #8a9498)",
                                display: "flex",
                                gap: 10,
                                flexWrap: "wrap",
                              }}
                            >
                              {lastTouches.map((t2, i) => (
                                <span key={i}>{t2}</span>
                              ))}
                            </div>
                          ) : null}
                        </Link>
                      );
                    })}
                  </div>
                </section>
              ))}
            </div>
          )}
        </div>
      </main>
    </div>
  );
}

// ---- helpers -----------------------------------------------------------

type ShipClassification = {
  overdue: boolean;
  imminent: boolean;
  daysAway: number;
};

function classifyShipDate(dateStr: string | null): ShipClassification {
  if (!dateStr) return { overdue: false, imminent: false, daysAway: Infinity };
  const now = Date.now();
  const t = new Date(dateStr).getTime();
  if (!Number.isFinite(t))
    return { overdue: false, imminent: false, daysAway: Infinity };
  const daysAway = Math.round((t - now) / (24 * 60 * 60 * 1000));
  return {
    overdue: daysAway < OVERDUE_THRESHOLD_DAYS,
    imminent:
      daysAway >= OVERDUE_THRESHOLD_DAYS && daysAway <= IMMINENT_THRESHOLD_DAYS,
    daysAway,
  };
}

function isStale(
  lastSession: string | null | undefined,
  lastMonday: string | null | undefined,
): boolean {
  const now = Date.now();
  const threshold = STALE_THRESHOLD_DAYS * 24 * 60 * 60 * 1000;
  const candidates = [lastSession, lastMonday]
    .filter((d): d is string => typeof d === "string")
    .map((d) => new Date(d).getTime())
    .filter((n) => Number.isFinite(n));
  if (candidates.length === 0) return true; // never mentioned = stale
  const newest = Math.max(...candidates);
  return now - newest > threshold;
}

function describeFreshness(iso: string | null): { relative: string } {
  if (!iso) return { relative: "—" };
  const d = new Date(iso).getTime();
  if (!Number.isFinite(d)) return { relative: iso };
  const diff = Date.now() - d;
  const mins = Math.round(diff / 60000);
  if (mins < 1) return { relative: "just now" };
  if (mins < 60) return { relative: `${mins} min ago` };
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return { relative: `${hrs}h ago` };
  const days = Math.round(hrs / 24);
  if (days < 30) return { relative: `${days}d ago` };
  return { relative: new Date(iso).toLocaleDateString() };
}

function formatShort(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

function formatMoney(v: number | null): string {
  if (v == null || !Number.isFinite(v)) return "";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(v);
}

function cardStyle(
  statusId: number | null,
  ship: ShipClassification,
): React.CSSProperties {
  // Left border color signals urgency at a glance: red overdue, amber
  // imminent, sage otherwise.
  const border = ship.overdue
    ? "#c34a3b"
    : ship.imminent
      ? "#c88a1f"
      : statusId === 10
        ? "#bfa960" // estimate — muted gold
        : "var(--sage-500, #7fb04f)";
  return {
    display: "block",
    padding: "12px 14px",
    background: "var(--paper, #fffdf8)",
    border: "1px solid var(--stone, #e3dcc9)",
    borderLeft: `4px solid ${border}`,
    borderRadius: 8,
    textDecoration: "none",
    color: "inherit",
  };
}

function emptyStyle(): React.CSSProperties {
  return {
    padding: "40px 20px",
    border: "1px dashed var(--stone, #e3dcc9)",
    borderRadius: 10,
    textAlign: "center",
    color: "var(--ink-3, #8a9498)",
    fontSize: 14,
    background: "var(--cream-soft, #fbf6ec)",
  };
}

function StatusPill({
  status,
  statusId,
}: {
  status: string | null;
  statusId: number | null;
}) {
  if (!status) return null;
  const bg =
    statusId === 25
      ? "#e7f0d8"
      : statusId === 20
        ? "#e0eef2"
        : "#f4ecd2"; // estimate
  const fg = "var(--teal-900, #0f4a56)";
  return (
    <span
      style={{
        fontSize: 11,
        fontWeight: 700,
        padding: "2px 10px",
        borderRadius: 999,
        background: bg,
        color: fg,
        border: "1px solid var(--stone, #e3dcc9)",
      }}
    >
      {status}
    </span>
  );
}

function ShipDatePill({
  date,
  classification,
  t,
}: {
  date: string;
  classification: ShipClassification;
  t: (k: string, vars?: Record<string, string>) => string;
}) {
  const bg = classification.overdue
    ? "#f7dfda"
    : classification.imminent
      ? "#fbecd0"
      : "#eaf1e3";
  const fg = classification.overdue
    ? "#8a2618"
    : classification.imminent
      ? "#8a5a0b"
      : "#2f5416";
  const label = classification.overdue
    ? t("shipOverdueLabel")
    : classification.imminent
      ? t("shipInDaysLabel", { days: String(classification.daysAway) })
      : formatShort(date);
  return (
    <span
      style={{
        fontSize: 11,
        fontWeight: 700,
        padding: "2px 10px",
        borderRadius: 999,
        background: bg,
        color: fg,
        border: "1px solid var(--stone, #e3dcc9)",
      }}
    >
      {t("shipPrefix")} {label}
    </span>
  );
}
