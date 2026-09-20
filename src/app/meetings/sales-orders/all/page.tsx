import { redirect } from "next/navigation";
import { headers } from "next/headers";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import AppHeader from "../../../_components/AppHeader";
import OpenOrdersBoard, { type SalesOrderRow } from "./OpenOrdersBoard";
import { getLangFromCookie } from "@/lib/i18n/server";
import { makeT } from "@/lib/i18n/dict";

// /meetings/sales-orders/all
//
// The working document driven from during the weekly Sales Orders
// meeting. Server-fetches the current OPEN Fishbowl SOs, hands them to
// the client board which owns search / sort / pagination / include-
// closed toggle / print.

export const metadata = { title: "Meetings · Open Sales Orders" };

const COLS =
  "fb_so_id, so_number, status_id, status_name, is_open, customer_name, " +
  "customer_po, salesman, note, date_issued, date_created, date_first_ship, " +
  "date_last_modified, subtotal, total_price, items, synced_at";

export default async function OpenSalesOrdersPage() {
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

  // Initial payload: open orders only, newest SO first. The client
  // board can flip to "include closed & estimates" via the shared
  // /api/sales-orders?all=1 endpoint.
  const { data, error } = await supabase
    .from("fishbowl_sales_orders")
    .select(COLS)
    .eq("is_open", true)
    .order("so_number", { ascending: false })
    .limit(500);

  const rows = (error ? [] : (data ?? [])) as unknown as SalesOrderRow[];

  // Freshness stamp — newest synced_at across the fetched rows. That
  // is "how fresh is what you're looking at right now" rather than the
  // table-wide max, which would be the same in practice but is one
  // more query.
  const syncedAt = rows.reduce<string | null>(
    (m, r) =>
      typeof r.synced_at === "string" && (!m || r.synced_at > m)
        ? r.synced_at
        : m,
    null,
  );

  return (
    <div className="app-shell">
      <AppHeader user={{ email: user.email! }} appContext="meetings" />
      <main className="page">
        <div className="page__inner">
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
              {t("openOrdersTitle")}
            </h1>
            <p className="lede" style={{ marginTop: 4, marginBottom: 0 }}>
              {t("openOrdersLede")}
            </p>
          </div>

          <OpenOrdersBoard
            initialRows={rows}
            initialSyncedAt={syncedAt}
            lang={lang}
          />
        </div>
      </main>
    </div>
  );
}
