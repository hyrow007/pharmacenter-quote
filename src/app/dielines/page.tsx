import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import AppHeader from "../_components/AppHeader";
import { getLangFromCookie } from "@/lib/i18n/server";
import { makeDT } from "./_lib/i18n";
import SachetBuilder from "./_components/SachetBuilder";

// /dielines -- the sachet dieline builder. Served at dieline.pharmacenter.app/
// by the host rewrite in middleware.ts, and reachable at /dielines on the
// quote host until that DNS exists.
//
// Nothing is stored yet: the page is the house rules for 3-side-seal sachet
// film, drawn to scale from four inputs (width, length, notch, unwind).

export const dynamic = "force-dynamic";
export const metadata = { title: "Dielines" };

export default async function DielinesPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user || !user.email?.endsWith("@pharmacenterusa.com")) {
    const host = (await headers()).get("host") ?? "";
    redirect(host.startsWith("dieline.") || host.startsWith("dielines.") ? "/?showSignIn=1" : "/");
  }

  const lang = await getLangFromCookie();
  const t = makeDT(lang);

  return (
    <div className="app-shell">
      <AppHeader user={{ email: user.email! }} appContext="dielines" />
      <main className="page">
        <div className="page__inner">
          <div style={{ marginBottom: 20 }}>
            <p className="eyebrow" style={{ marginBottom: 6 }}>{t("eyebrow")}</p>
            <h1 className="page-header__title" style={{ marginBottom: 6 }}>{t("title")}</h1>
            <p className="lede" style={{ marginTop: 4, marginBottom: 0 }}>{t("lede")}</p>
          </div>
          <SachetBuilder lang={lang} />
        </div>
      </main>
    </div>
  );
}
