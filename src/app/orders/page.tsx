import { redirect } from "next/navigation";
import { headers } from "next/headers";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import AppHeader from "../_components/AppHeader";
import PrintButton from "./PrintButton";
import AskChip from "./_components/AskChip";
import OrdersChatHost from "./_components/OrdersChatHost";
import { describeFreshness } from "@/lib/freshness";
import { getLangFromCookie } from "@/lib/i18n/server";
import { makeT } from "@/lib/i18n/dict";
import {
  loadFishbowlLexicon,
  correctPlaudText,
} from "@/lib/plaud/fishbowlLexicon";

type TFn = ReturnType<typeof makeT>;

// How many recent Monday updates to preview on each SO card. Showing
// more than the newest lets the reader spot bursts of chatter and
// context that the AI key points might have missed.
const MONDAY_PREVIEW_COUNT = 3;

// Only keep Monday updates newer than this many days when picking the
// preview — anything older is likely stale housekeeping and clogs the
// card without adding signal. The full history stays on the SO detail
// page for anyone who wants the trail.
const MONDAY_PREVIEW_MAX_AGE_DAYS = 120;

// /orders
//
// Sales-order status tracker landing. Every OPEN SO (Fishbowl statusId
// 10 Estimate / 20 Issued / 25 In Progress) grouped by customer, with
// per-SO context — AI key points, last Plaud/Monday touch, ship date,
// mismatch/staleness warnings — visible without a click.
//
// The old /meetings/sales-orders hub still works; this is the new
// front door when visiting order.pharmacenter.app / orders.pharmacenter.app.

export const metadata = { title: "Sales Orders" };

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
  note: string | null;
  note_es: string | null;
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

// Line items shown on each card are filtered to real product lines —
// sale + drop-ship (type_id 10 / 30) — same rule as the SO detail page.
const SALE_TYPE_IDS = new Set([10, 30]);

const SO_COLS =
  "so_number, status_id, status_name, is_open, customer_name, customer_po, " +
  "salesman, note, note_es, date_issued, date_first_ship, subtotal, total_price, " +
  "items, synced_at";

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

  // Fan out reads in parallel — main SO list, key-points cache, Monday
  // activity, meeting notes, and linked purchase orders. Meeting notes
  // need a per-SO latest so we roll that up in Node after the fetch.
  const [soRes, synRes, mondayRes, notesRes, poRes, corrRes] = await Promise.all([
    supabase
      .from("fishbowl_sales_orders")
      .select(SO_COLS)
      .in("status_id", OPEN_STATUS_IDS)
      // Fishbowl decides what is still open. When an SO moves to
      // Fulfilled / Closed Short / Void it stops appearing in the nightly
      // sync, whose finalize step then flips is_open=false -- but it never
      // rewrites status_id, so the row keeps its last-known Issued /
      // In Progress label. Filtering on status alone left closed orders on
      // the board indefinitely (17 of them as of 2026-09-23).
      .eq("is_open", true)
      .order("customer_name", { ascending: true })
      .order("so_number", { ascending: true })
      .limit(500),
    supabase
      .from("so_synthesis")
      .select(
        "so_number, headline, points, headline_es, points_es, generated_at",
      ),
    supabase
      .from("so_monday_activity")
      .select(
        "so_number, status, item_updated_at, last_synced_at, updates, updates_es",
      ),
    supabase
      .from("meeting_so_notes")
      .select(
        "so_number, customer_mismatch, product_mismatch, status_flag, created_at, " +
          "meeting_sessions(session_date)",
      )
      .order("created_at", { ascending: false })
      .limit(500),
    // POs linked to any open SO via so_numbers[] (populated by the sync
    // from so.vendorPO). Fetching all rows with a non-empty so_numbers
    // is bounded and simpler than an `overlaps` predicate against the
    // dynamic open-SO list.
    supabase
      .from("fishbowl_purchase_orders")
      .select(
        "po_number, vendor_name, buyer, status_name, is_open, " +
          "date_issued, date_created, so_numbers",
      )
      .not("so_numbers", "eq", "{}")
      .order("date_issued", { ascending: false })
      .limit(500),
    // Verified facts recorded through the SO assistant. Outrank every
    // synced source, so they sit above the AI key points on the card.
    supabase
      .from("so_corrections")
      .select("so_number, text, text_es, created_by, created_by_name, created_at")
      .is("retracted_at", null)
      .order("created_at", { ascending: false })
      .limit(1000),
  ]);

  const rows = (soRes.data ?? []) as unknown as SoRow[];

  // When the Plaud ingest last landed a meeting (created_at, not the
  // meeting's own date -- a Tuesday meeting pulled on Friday is two
  // different facts, and this line is about the pipeline).
  const { data: lastSessionRaw } = await supabase
    .from("meeting_sessions")
    .select("created_at, session_date")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const lastSession = lastSessionRaw as {
    created_at: string | null;
    session_date: string | null;
  } | null;

  const correctionsBy = new Map<string, Array<{ text: string; by: string }>>();
  for (const raw of (corrRes.data ?? []) as unknown[]) {
    const c = raw as {
      so_number: string;
      text: string;
      text_es: string | null;
      created_by: string;
      created_by_name: string | null;
    };
    const list = correctionsBy.get(c.so_number) ?? [];
    list.push({
      text: lang === "es" && c.text_es ? c.text_es : c.text,
      by: c.created_by_name ?? c.created_by,
    });
    correctionsBy.set(c.so_number, list);
  }

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
      headline_es: string | null;
      points_es: Array<{ text: string; source?: string }> | null;
      generated_at: string;
    };
    // Prefer Spanish when lang=es AND the ES fields are populated;
    // otherwise render the canonical English (matches the pattern
    // used for meeting notes elsewhere in the app).
    const useEs = lang === "es";
    synBy.set(s.so_number, {
      // (fix: so_number is the map KEY — the value type doesn't carry it;
      // passing it broke the build on three straight deploys.)
      headline:
        useEs && s.headline_es && s.headline_es.trim()
          ? s.headline_es
          : s.headline,
      points:
        useEs &&
        Array.isArray(s.points_es) &&
        s.points_es.length > 0
          ? s.points_es
          : s.points,
      generated_at: s.generated_at,
    });
  }

  type MondayPreview = {
    text_body: string;
    created_at: string;
    creator_name: string | null;
    // "reply" entries answer an earlier update. Stored flat by
    // /api/sync/monday so newest-first sorting surfaces them.
    kind?: "update" | "reply";
  };
  const mondayBy = new Map<
    string,
    {
      status: string | null;
      item_updated_at: string | null;
      last_synced_at: string | null;
      update_count: number;
      latest_update_at: string | null;
      previews: MondayPreview[];
    }
  >();
  const mondayCutoffMs =
    Date.now() - MONDAY_PREVIEW_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
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
            kind?: "update" | "reply";
          }>
        | null;
      updates_es:
        | Array<{
            id?: string;
            text_body?: string;
            created_at?: string;
          }>
        | null;
    };
    const updates = Array.isArray(m.updates) ? m.updates : [];
    // Build a lookup of translated bodies keyed by update id (falling
    // back to created_at when id is absent — Monday exposes stable ids
    // but older synced rows may not have them). When lang=es we swap
    // the text_body for its ES counterpart at preview time.
    const esByKey = new Map<string, string>();
    if (Array.isArray(m.updates_es)) {
      for (const u of m.updates_es) {
        const key = (u.id ?? u.created_at ?? "").trim();
        const body = (u.text_body ?? "").trim();
        if (key && body) esByKey.set(key, body);
      }
    }
    const useEsUpdates = lang === "es" && esByKey.size > 0;
    // Newest first, then keep the top few for the card preview. Filter
    // out anything too old — long-tail history stays on the detail page.
    const sorted = updates
      .slice()
      .sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? ""))
      .filter((u) => {
        const ts = new Date(u.created_at ?? "").getTime();
        return Number.isFinite(ts) && ts >= mondayCutoffMs;
      });
    const previews = sorted.slice(0, MONDAY_PREVIEW_COUNT).map((u) => {
      const key = (u.id ?? u.created_at ?? "").trim();
      const es = useEsUpdates ? esByKey.get(key) : undefined;
      return {
        text_body: es || u.text_body || "",
        created_at: u.created_at ?? "",
        creator_name: u.creator_name ?? null,
        kind: u.kind,
      };
    });
    mondayBy.set(m.so_number, {
      status: m.status,
      item_updated_at: m.item_updated_at,
      last_synced_at: m.last_synced_at,
      update_count: updates.length,
      latest_update_at: previews[0]?.created_at ?? null,
      previews,
    });
  }

  // Fishbowl name lexicon — load once per render pass so we can correct
  // Plaud transcripts (Kunza → Cunsa, Peter Chu → Purechews, …) in every
  // free-text section of the card.
  const lexicon = await loadFishbowlLexicon(supabase);
  const applyCorrections = (text: string | null | undefined): string =>
    text ? correctPlaudText(text, lexicon).corrected : text ?? "";

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

  // POs indexed by every SO number they reference — one PO can list
  // multiple SOs in its so_numbers[] rollup (e.g. one paper order that
  // covered a run of SOs), so it shows on every one of them.
  const posBySo = new Map<
    string,
    Array<{
      po_number: string;
      vendor_name: string | null;
      buyer: string | null;
      status_name: string | null;
      is_open: boolean;
      date_issued: string | null;
      date_created: string | null;
    }>
  >();
  for (const raw of (poRes.data ?? []) as unknown[]) {
    const p = raw as {
      po_number: string;
      vendor_name: string | null;
      buyer: string | null;
      status_name: string | null;
      is_open: boolean;
      date_issued: string | null;
      date_created: string | null;
      so_numbers: string[] | null;
    };
    if (!Array.isArray(p.so_numbers)) continue;
    for (const soNum of p.so_numbers) {
      if (!soNum) continue;
      const arr = posBySo.get(soNum) ?? [];
      arr.push({
        po_number: p.po_number,
        vendor_name: p.vendor_name,
        buyer: p.buyer,
        status_name: p.status_name,
        is_open: p.is_open,
        date_issued: p.date_issued,
        date_created: p.date_created,
      });
      posBySo.set(soNum, arr);
    }
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
      // Sort by SO number sequentially. Numbers can carry a prefix
      // ("M-14221" — no leading digits) or a suffix ("14740-1"). Grab
      // ONLY the leading digit run so 14746-1 stays 14746 (not 147461,
      // which would sort after 14870); tiebreak on the raw string so
      // 14746, 14746-1, 14746-2 land in order.
      sos: sos.sort((a, b) => {
        const aStr = String(a.so_number);
        const bStr = String(b.so_number);
        const aLead = aStr.match(/^\d+/);
        const bLead = bStr.match(/^\d+/);
        const aNum = aLead ? parseInt(aLead[0], 10) : NaN;
        const bNum = bLead ? parseInt(bLead[0], 10) : NaN;
        // Purely-numeric SOs group first, alpha-prefixed ("M-*") after.
        if (Number.isFinite(aNum) && !Number.isFinite(bNum)) return -1;
        if (!Number.isFinite(aNum) && Number.isFinite(bNum)) return 1;
        if (
          Number.isFinite(aNum) &&
          Number.isFinite(bNum) &&
          aNum !== bNum
        ) {
          return aNum - bNum;
        }
        return aStr.localeCompare(bStr);
      }),
    }))
    .sort((a, b) => a.customer.localeCompare(b.customer));

  const totalOpen = rows.filter((r) => (r.status_id ?? 0) !== 10).length;
  const totalEstimate = rows.filter((r) => r.status_id === 10).length;
  const latestSyncIso = rows.reduce<string | null>(
    (m, r) =>
      typeof r.synced_at === "string" && (!m || r.synced_at > m)
        ? r.synced_at
        : m,
    null,
  );
  const freshness = describeFreshness(latestSyncIso, t, lang);

  // Each feed has its own cadence, so each gets its own threshold and its
  // own line. One combined "Synced" stamp hid a 24-day-old Monday cache
  // behind a fresh Fishbowl time for weeks -- see claude/automation.md.
  const mondaySyncIso = ((mondayRes.data ?? []) as unknown[]).reduce<string | null>(
    (m, raw) => {
      const v = (raw as { last_synced_at?: unknown }).last_synced_at;
      return typeof v === "string" && (!m || v > m) ? v : m;
    },
    null,
  );
  const plaudSyncIso = lastSession?.created_at ?? null;
  const absolute = (iso: string | null): string | null =>
    iso
      ? new Date(iso).toLocaleString(lang === "es" ? "es" : "en-US", {
          timeZone: "America/New_York",
          dateStyle: "medium",
          timeStyle: "short",
        })
      : null;
  const feeds = [
    {
      // Nightly Fishbowl sync, ~04:30 ET.
      key: "fishbowl",
      label: "Fishbowl",
      iso: latestSyncIso,
      staleAfterHours: 26,
    },
    {
      // Vercel cron, daily.
      key: "monday",
      label: "Monday",
      iso: mondaySyncIso,
      staleAfterHours: 26,
    },
    {
      // Plaud pull runs Tue + Fri; the meeting itself is weekly, so a
      // gap only means trouble after more than a week.
      key: "plaud",
      label: "Plaud",
      iso: plaudSyncIso,
      staleAfterHours: 8 * 24,
    },
  ].map((f) => {
    const fr = describeFreshness(f.iso, t, lang);
    const ageHours = f.iso
      ? (Date.now() - new Date(f.iso).getTime()) / 3_600_000
      : null;
    return {
      ...f,
      relative: fr.relative,
      absolute: absolute(f.iso),
      stale: ageHours === null || ageHours > f.staleAfterHours,
    };
  });

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
              {/* One stamp per feed. A single combined "Synced" line is
                  what let Monday sit 24 days stale next to a fresh
                  Fishbowl time without anyone noticing. Each shows the
                  exact local time and goes red past its own threshold. */}
              {feeds.map((f) => (
                <span
                  key={f.key}
                  title={f.absolute ?? undefined}
                  style={{
                    color: f.stale ? "#8b2f2f" : undefined,
                    fontWeight: f.stale ? 700 : undefined,
                  }}
                >
                  <strong style={{ fontWeight: 700 }}>{f.label}</strong>{" "}
                  {f.absolute ?? t("syncNever")}
                  {f.absolute ? ` · ${f.relative}` : ""}
                </span>
              ))}
              <Link
                href="/meetings/sales-orders"
                className="meetings-noprint"
                style={{
                  color: "var(--teal-700, #1d6c7b)",
                  textDecoration: "none",
                  fontWeight: 700,
                }}
              >
                {t("ordersMeetingsLink")} →
              </Link>
              <PrintButton label={t("printSavePdf")} />
            </div>
          </div>

          {/* Print rules specific to this page; the shared ones (hide the
              header nav and .meetings-noprint, white page, letter size)
              live in globals.css. Keep each SO card whole on one page and
              keep a customer name with its first card. Status tints and
              the Monday / key-point boxes print because they carry
              meaning, not decoration. */}
          <style>{`
            .orders-print-only { display: none; }
            @media print {
              .orders-print-only { display: inline; }
              .orders-so-card {
                break-inside: avoid;
                page-break-inside: avoid;
                -webkit-print-color-adjust: exact;
                print-color-adjust: exact;
                box-shadow: none !important;
              }
              .orders-customer-head {
                break-after: avoid;
                page-break-after: avoid;
              }
            }
          `}</style>

          {freshness.stale ? (
            <div
              role="status"
              style={{
                margin: "0 0 16px",
                padding: "10px 14px",
                background: "#fdecec",
                border: "1px solid #f5c2c2",
                color: "#8b2f2f",
                borderRadius: 6,
                fontSize: 13,
                fontWeight: 600,
              }}
            >
              {t("syncStale", { rel: freshness.relative })}
            </div>
          ) : null}

          {customerGroups.length === 0 ? (
            <div style={emptyStyle()}>{t("ordersNoOpen")}</div>
          ) : (
            <div style={{ display: "grid", gap: 24 }}>
              {customerGroups.map(({ customer, sos }) => (
                <section key={customer}>
                  <div
                    className="orders-customer-head"
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
                          `${t("touchPlaud")} ${formatShort(notes.last_session_date, lang)}`,
                        );
                      if (monday?.latest_update_at)
                        lastTouches.push(
                          `${t("touchMonday")} ${describeFreshness(monday.latest_update_at, t, lang).relative}`,
                        );
                      if (so.synced_at)
                        lastTouches.push(
                          `${t("touchFishbowl")} ${describeFreshness(so.synced_at, t, lang).relative}`,
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
                      const linkedPos = posBySo.get(key) ?? [];

                      return (
                        <Link
                          key={key}
                          href={`/meetings/sales-orders/orders/${key}`}
                          className="orders-so-card"
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
                              t={t}
                            />
                            {so.date_first_ship ? (
                              <ShipDatePill
                                date={so.date_first_ship}
                                classification={ship}
                                t={t}
                                lang={lang}
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
                            <AskChip
                              so={so.so_number}
                              label={t("soChatOpen")}
                              pushRight={so.total_price == null}
                            />
                          </div>

                          {/* What was ordered — product lines up top,
                              before the meeting context, so the card
                              answers "which product is this?" at a
                              glance (v84: restored per operator request;
                              used to live at the bottom of the card). */}
                          {(() => {
                            const saleItems = (so.items ?? []).filter(
                              (it) =>
                                it.type_id != null &&
                                SALE_TYPE_IDS.has(it.type_id),
                            );
                            if (saleItems.length === 0) return null;
                            return (
                              <div
                                style={{
                                  display: "flex",
                                  flexDirection: "column",
                                  gap: 2,
                                  margin: "2px 0 8px",
                                  fontSize: 12.5,
                                  lineHeight: 1.45,
                                  color: "var(--ink-1, #1f2a2d)",
                                }}
                              >
                                {saleItems.map((it, i) => (
                                  <div
                                    key={i}
                                    style={{
                                      display: "flex",
                                      gap: 8,
                                      alignItems: "baseline",
                                    }}
                                  >
                                    <span
                                      style={{
                                        fontFamily:
                                          "'IBM Plex Mono', ui-monospace, monospace",
                                        fontSize: 11.5,
                                        fontWeight: 600,
                                        color: "var(--teal-700, #1d6c7b)",
                                        whiteSpace: "nowrap",
                                      }}
                                    >
                                      {it.product_num ?? "—"}
                                    </span>
                                    <span
                                      style={{
                                        flex: 1,
                                        minWidth: 0,
                                        overflow: "hidden",
                                        textOverflow: "ellipsis",
                                        whiteSpace: "nowrap",
                                      }}
                                    >
                                      {it.description ?? ""}
                                    </span>
                                    <span
                                      style={{
                                        fontFamily:
                                          "'IBM Plex Mono', ui-monospace, monospace",
                                        fontSize: 12,
                                        color: "var(--ink-2, #415056)",
                                        whiteSpace: "nowrap",
                                      }}
                                    >
                                      ×{" "}
                                      {(
                                        Number(it.qty_ordered) || 0
                                      ).toLocaleString()}
                                    </span>
                                  </div>
                                ))}
                              </div>
                            );
                          })()}

                          {(correctionsBy.get(key) ?? []).length > 0 ? (
                            <div
                              style={{
                                background: "#fdf6e3",
                                border: "1px solid #ecd9a0",
                                borderRadius: 8,
                                padding: "6px 10px",
                                marginBottom: 6,
                                fontSize: 12,
                                lineHeight: 1.5,
                                color: "var(--ink-1, #1f2a2d)",
                              }}
                            >
                              <div
                                style={{
                                  fontSize: 9.5,
                                  fontWeight: 700,
                                  letterSpacing: "0.14em",
                                  textTransform: "uppercase",
                                  color: "#6b5410",
                                }}
                              >
                                {t("correctionsTitle")}
                              </div>
                              {(correctionsBy.get(key) ?? []).slice(0, 3).map((c, i) => (
                                <div key={i}>
                                  {c.text}{" "}
                                  <span style={{ color: "var(--ink-3, #8a9498)", fontSize: 10.5 }}>
                                    — {c.by}
                                  </span>
                                </div>
                              ))}
                            </div>
                          ) : null}

                          {syn && topPoints.length > 0 ? (
                            <div
                              style={{
                                background: "#f6f9f0",
                                border: "1px solid var(--sage-200, #d5e5b7)",
                                borderRadius: 8,
                                padding: "8px 12px",
                                marginBottom: 6,
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
                                  {applyCorrections(syn.headline)}
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
                                  <li key={i}>{applyCorrections(p.text)}</li>
                                ))}
                              </ul>
                            </div>
                          ) : null}

                          {/* Fishbowl memo — the SO's own note field.
                              Small italic block so it reads as "context
                              from the source of truth" without competing
                              with the key points above. */}
                          {(() => {
                            // Prefer the Spanish memo when the toggle is ES
                            // and the translation task has populated it.
                            const noteToShow =
                              lang === "es" &&
                              so.note_es &&
                              so.note_es.trim()
                                ? so.note_es
                                : so.note;
                            if (!noteToShow || !noteToShow.trim()) return null;
                            return (
                              <div
                                style={{
                                  background: "var(--cream-soft, #fbf6ec)",
                                  border:
                                    "1px solid var(--stone-2, #efe9da)",
                                  borderRadius: 8,
                                  padding: "6px 10px",
                                  marginBottom: 6,
                                  fontSize: 12,
                                  lineHeight: 1.5,
                                  color: "var(--ink-2, #415056)",
                                  whiteSpace: "pre-wrap",
                                }}
                              >
                                <span
                                  style={{
                                    fontSize: 9.5,
                                    fontWeight: 700,
                                    letterSpacing: "0.14em",
                                    textTransform: "uppercase",
                                    color: "var(--teal-700, #1d6c7b)",
                                    marginRight: 6,
                                  }}
                                >
                                  {t("touchFishbowl")}
                                </span>
                                {truncate(noteToShow.trim(), 320)}
                              </div>
                            );
                          })()}

                          {/* NOTE: below-here render swaps to the
                              corrector-wrapped Monday preview list — see
                              the sibling block that used to show the
                              single latest update. */}

                          {/* Linked purchase orders — the components /
                              raw materials PharmaCenter placed on
                              vendors for this SO (matched via the SO's
                              Vendor PO field). Shows vendor, status,
                              and placed date so the reviewer knows
                              what's on order and whether it landed. */}
                          {linkedPos.length > 0 ? (
                            <div
                              style={{
                                display: "flex",
                                flexWrap: "wrap",
                                gap: 6,
                                marginBottom: 6,
                              }}
                            >
                              <span
                                style={{
                                  fontSize: 9.5,
                                  fontWeight: 700,
                                  letterSpacing: "0.14em",
                                  textTransform: "uppercase",
                                  color: "var(--teal-700, #1d6c7b)",
                                  alignSelf: "center",
                                }}
                              >
                                {t("purchaseOrdersTitle")}
                              </span>
                              {linkedPos.map((po) => (
                                <span
                                  key={po.po_number}
                                  style={{
                                    fontSize: 11,
                                    padding: "2px 8px",
                                    borderRadius: 999,
                                    background: po.is_open
                                      ? "#e7f0d8"
                                      : "var(--stone-2, #efe9da)",
                                    border: "1px solid var(--stone, #e3dcc9)",
                                    color: "var(--ink-1, #1f2a2d)",
                                    display: "inline-flex",
                                    gap: 6,
                                    alignItems: "baseline",
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
                                  {po.vendor_name ? (
                                    <span>{po.vendor_name}</span>
                                  ) : null}
                                  {po.status_name ? (
                                    <span
                                      style={{
                                        color: "var(--ink-3, #8a9498)",
                                      }}
                                    >
                                      · {translateStatus(po.status_name, t)}
                                    </span>
                                  ) : null}
                                  {po.date_issued || po.date_created ? (
                                    <span
                                      style={{
                                        color: "var(--ink-3, #8a9498)",
                                      }}
                                    >
                                      ·{" "}
                                      {formatShort(
                                        po.date_issued ?? po.date_created,
                                        lang,
                                      )}
                                    </span>
                                  ) : null}
                                </span>
                              ))}
                            </div>
                          ) : null}

                          {/* Recent Monday chatter — top N updates from
                              the last few months, not just the newest.
                              Long-tail history stays on the SO detail
                              page. Each entry runs through the Fishbowl
                              corrector so "Kunza" reads as "Cunsa". */}
                          {monday && monday.previews.length > 0 ? (
                            <div
                              style={{
                                background: "#eff5ff",
                                border: "1px solid #cddffb",
                                borderRadius: 8,
                                padding: "6px 10px",
                                marginBottom: 6,
                                display: "flex",
                                flexDirection: "column",
                                gap: 6,
                              }}
                            >
                              <div
                                style={{
                                  fontSize: 9.5,
                                  fontWeight: 700,
                                  letterSpacing: "0.14em",
                                  textTransform: "uppercase",
                                  color: "#2c4d8f",
                                }}
                              >
                                {t("touchMonday")}
                                {monday.update_count > monday.previews.length
                                  ? ` · ${monday.previews.length} of ${monday.update_count}`
                                  : ""}
                              </div>
                              {monday.previews.map((u, i) => (
                                <div
                                  key={i}
                                  style={{
                                    fontSize: 12,
                                    lineHeight: 1.5,
                                    color: "var(--ink-1, #1f2a2d)",
                                    whiteSpace: "pre-wrap",
                                    borderTop:
                                      i === 0
                                        ? "none"
                                        : "1px dashed #cddffb",
                                    paddingTop: i === 0 ? 0 : 6,
                                  }}
                                >
                                  <div
                                    style={{
                                      fontSize: 10,
                                      color: "#5b6b8a",
                                      marginBottom: 2,
                                      fontWeight: 600,
                                    }}
                                  >
                                    {u.kind === "reply" ? "↳ " : ""}
                                    {u.creator_name ?? "—"}
                                    {u.created_at
                                      ? ` · ${describeFreshness(u.created_at, t, lang).relative}`
                                      : ""}
                                  </div>
                                  {truncate(
                                    applyCorrections(u.text_body).trim(),
                                    280,
                                  )}
                                </div>
                              ))}
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
      <OrdersChatHost lang={lang} />
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

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1).trimEnd() + "…";
}

function formatShort(iso: string | null, lang?: "en" | "es"): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return iso;
  return d.toLocaleDateString(lang === "es" ? "es" : "en-US", {
    month: "short",
    day: "numeric",
  });
}

// Fishbowl only sends English status strings ("Issued", "Fulfilled",
// …). Map to the current locale for display. Falls back to the raw
// string when unknown.
function translateStatus(
  status: string | null | undefined,
  t: TFn,
): string {
  if (!status) return "";
  const key = status.trim().toLowerCase();
  const map: Record<string, string> = {
    "estimate": t("statusEstimate"),
    "issued": t("statusIssued"),
    "in progress": t("statusInProgress"),
    "fulfilled": t("statusFulfilled"),
    "in process": t("statusInProcess"),
    "unfulfilled": t("statusUnfulfilled"),
    "partial": t("statusPartial"),
    "closed short": t("statusClosedShort"),
    "void": t("statusVoid"),
    "cancelled": t("statusCancelled"),
    "canceled": t("statusCancelled"),
  };
  return map[key] ?? status;
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
  t,
}: {
  status: string | null;
  statusId: number | null;
  t: TFn;
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
      {translateStatus(status, t)}
    </span>
  );
}

function ShipDatePill({
  date,
  classification,
  t,
  lang,
}: {
  date: string;
  classification: ShipClassification;
  t: TFn;
  lang: "en" | "es";
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
      : formatShort(date, lang);
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
