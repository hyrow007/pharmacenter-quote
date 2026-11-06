import { redirect } from "next/navigation";
import { headers } from "next/headers";
import AppHeader from "../../_components/AppHeader";
import { getLangFromCookie } from "@/lib/i18n/server";
import { shipGate } from "../_lib/gate";
import { makeST } from "../_lib/i18n";
import ImportClient from "./ImportClient";
import s from "../shipping.module.css";

// /shipping/import -- ship.pharmacenter.app/import. Bring a fedex.com address
// book export into the shared address book. Admins only.

export const dynamic = "force-dynamic";
export const metadata = { title: "Shipping · Import" };

export default async function ImportPage() {
  const g = await shipGate();
  const host = (await headers()).get("host") ?? "";
  const onShipHost = host.startsWith("ship.") || host.startsWith("shipping.");
  if (!g.ok) redirect(onShipHost ? "/?showSignIn=1" : "/");
  const lang = await getLangFromCookie();
  const t = makeST(lang);
  const { count } = await g.supabase
    .from("shipping_recipients")
    .select("id", { count: "exact", head: true })
    .is("archived_at", null);

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
          <p className={s.muted} style={{ marginBottom: 14 }}>{t("impCount", { n: count ?? 0 })}</p>
          {g.admin ? <ImportClient lang={lang} /> : <p className={s.warn}>{t("err_not_admin")}</p>}
        </div>
      </main>
    </div>
  );
}
