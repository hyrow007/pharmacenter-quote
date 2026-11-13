import { redirect } from "next/navigation";
import { headers } from "next/headers";
import AppHeader from "../../_components/AppHeader";
import { getLangFromCookie } from "@/lib/i18n/server";
import { shipGate } from "../_lib/gate";
import { makeST } from "../_lib/i18n";
import ImportClient from "./ImportClient";
import ShipmentImportClient from "./ShipmentImportClient";
import s from "../shipping.module.css";

// /shipping/import -- ship.pharmacenter.app/import. Admins only. Two imports
// from fedex.com: the shipment report (so labels made on fedex.com show in the
// Recent shipments log) and the address book export (the shared address book).

export const dynamic = "force-dynamic";
export const metadata = { title: "Shipping · Import" };

export default async function ImportPage() {
  const g = await shipGate();
  const host = (await headers()).get("host") ?? "";
  const onShipHost = host.startsWith("ship.") || host.startsWith("shipping.");
  if (!g.ok) redirect(onShipHost ? "/?showSignIn=1" : "/");
  const lang = await getLangFromCookie();
  const t = makeST(lang);
  const [{ count }, ext, latest] = await Promise.all([
    g.supabase.from("shipping_recipients").select("id", { count: "exact", head: true }).is("archived_at", null),
    g.supabase.from("shipping_external_shipments").select("id", { count: "exact", head: true }),
    g.supabase.from("shipping_external_shipments").select("ship_date").order("ship_date", { ascending: false }).limit(1),
  ]);
  const extCount = ext.count ?? 0;
  const lastShip = (latest.data?.[0]?.ship_date as string | undefined) ?? null;
  const shipStatus = extCount ? t("shipImpLast", { n: extCount, d: lastShip ?? "—" }) : t("shipImpNone");

  return (
    <div className="app-shell">
      <AppHeader user={{ email: g.email }} appContext="shipping" />
      <main className="page">
        <div className="page__inner">
          <div className={s.head}>
            <div>
              <p className="eyebrow" style={{ marginBottom: 6 }}>
                <a href={onShipHost ? "/" : "/shipping"} className={s.crumb}>{t("eyebrow")}</a>
              </p>
              <h1 className="page-header__title" style={{ marginBottom: 6 }}>{t("impTitle")}</h1>
              <p className="lede" style={{ marginTop: 4, marginBottom: 0 }}>{t("impLede")}</p>
            </div>
          </div>
          {g.admin ? (
            <>
              <ShipmentImportClient lang={lang} status={shipStatus} />
              <p className={s.muted} style={{ marginBottom: 14 }}>{t("impCount", { n: count ?? 0 })}</p>
              <ImportClient lang={lang} />
            </>
          ) : (
            <p className={s.warn}>{t("err_not_admin")}</p>
          )}
        </div>
      </main>
    </div>
  );
}
