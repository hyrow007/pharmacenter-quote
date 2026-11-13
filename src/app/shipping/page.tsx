import { redirect } from "next/navigation";
import { headers } from "next/headers";
import AppHeader from "../_components/AppHeader";
import { getLangFromCookie } from "@/lib/i18n/server";
import { shipGate } from "./_lib/gate";
import { makeST } from "./_lib/i18n";
import { fedexConfigured, LIVE, ENVIRONMENT } from "./_lib/fedex";
import ShipDesk from "./_components/ShipDesk";
import LabelTables, { type LabelListRow, type ExternalListRow } from "./_components/LabelTables";
import s from "./shipping.module.css";

// /shipping -- served at ship.pharmacenter.app/ by the host rewrite.
// The assistant on the left fills in the label on the right; the person
// confirms. Below: what is waiting for an admin, and the recent label log.

export const dynamic = "force-dynamic";
export const metadata = { title: "Shipping" };

const EXT_COLS =
  "id, master_tracking_number, piece_tracking_numbers, ship_date, service_type, reference, po_number, payment_type, recipient_contact, recipient_company, recipient_city, recipient_state, recipient_country, packages, estimated_cost";

const LIST_COLS =
  "id, environment, status, purpose, so_number, recipient_snapshot, contents, service_type, rated_cost, rated_currency, requested_by, requested_at, approval_required, approved_by, decision_note, tracking_number, label_path, invoice_path, created_label_at, voided_at, fedex_error";

export default async function ShippingPage() {
  const g = await shipGate();
  const host = (await headers()).get("host") ?? "";
  const onShipHost = host.startsWith("ship.") || host.startsWith("shipping.");
  if (!g.ok) redirect(onShipHost ? "/?showSignIn=1" : "/");

  const lang = await getLangFromCookie();
  const t = makeST(lang);
  const cfg = fedexConfigured();

  // Only labels from the environment the app is running in: once live, the
  // sandbox test labels (FedEx validation samples etc.) drop out of the log.
  const [pending, recent, external] = await Promise.all([
    g.supabase.from("shipping_labels").select(LIST_COLS).eq("environment", ENVIRONMENT).eq("status", "pending_approval").order("requested_at").limit(50),
    g.supabase.from("shipping_labels").select(LIST_COLS).eq("environment", ENVIRONMENT).neq("status", "pending_approval").order("requested_at", { ascending: false }).limit(30),
    // Shipments made on fedex.com (imported from Ship Manager's report). Only
    // real ones exist, so they show only once the app itself is live.
    LIVE
      ? g.supabase.from("shipping_external_shipments").select(EXT_COLS).order("ship_date", { ascending: false }).limit(40)
      : Promise.resolve({ data: [] as unknown[], error: null }),
  ]);

  return (
    <div className="app-shell">
      <AppHeader user={{ email: g.email }} appContext="shipping" />
      <main className="page">
        <div className="page__inner">
          <div className={s.head}>
            <div>
              <p className="eyebrow" style={{ marginBottom: 6 }}>{t("eyebrow")}</p>
              <h1 className="page-header__title" style={{ marginBottom: 6 }}>{t("title")}</h1>
              <p className="lede" style={{ marginTop: 4, marginBottom: 0 }}>{t("lede")}</p>
            </div>
            <div className={s.headSide}>
              {g.admin ? (
                <a className={s.ghostSm} href={onShipHost ? "/import" : "/shipping/import"}>{t("impLink")}</a>
              ) : null}
              {LIVE ? null : (
                <span className={s.sandbox} title={t("sandboxHint")}>{t("sandbox")}</span>
              )}
            </div>
          </div>
          {cfg.ok ? null : <p className={s.warn}>{t("notConfigured", { list: cfg.missing.join(", ") })}</p>}
          {pending.error || recent.error ? (
            <p className={s.warn}>{t("err_generic", { e: (pending.error ?? recent.error)!.message })}</p>
          ) : null}

          <ShipDesk lang={lang} />

          <LabelTables
            lang={lang}
            me={g.email}
            admin={g.admin}
            pending={(pending.data ?? []) as unknown as LabelListRow[]}
            recent={(recent.data ?? []) as unknown as LabelListRow[]}
            external={(external.data ?? []) as unknown as ExternalListRow[]}
          />
          <p className={s.foot}>{t("foot")}</p>
        </div>
      </main>
    </div>
  );
}
