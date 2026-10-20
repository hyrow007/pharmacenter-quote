import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import AppHeader from "../_components/AppHeader";
import { getLangFromCookie } from "@/lib/i18n/server";
import { makeDT } from "./_lib/i18n";
import s from "./dielines.module.css";

// /dielines -- the chooser: which kind of dieline. Served at
// dieline.pharmacenter.app/ by the host rewrite in middleware.ts. Sachet is
// built (/dielines/sachet); bottle is next; blister comes after.

export const dynamic = "force-dynamic";
export const metadata = { title: "Dielines" };

const ICON = { fill: "none", stroke: "currentColor", strokeWidth: 2.4, strokeLinejoin: "round", strokeLinecap: "round" } as const;

function SachetIcon() {
  return (
    <svg viewBox="0 0 64 64" aria-hidden="true">
      <rect x="15" y="8" width="34" height="48" rx="2" {...ICON} />
      <path d="M15 16H49M15 48H49" {...ICON} strokeWidth={1.4} strokeDasharray="2 2" />
      <path d="M49 21l-4 0" {...ICON} />
      <path d="M24 30h16M24 36h10" {...ICON} strokeWidth={1.8} />
    </svg>
  );
}
function BottleIcon() {
  return (
    <svg viewBox="0 0 64 64" aria-hidden="true">
      <rect x="24" y="5" width="16" height="8" rx="1.5" {...ICON} />
      <path d="M27 13v5M37 13v5" {...ICON} />
      <path d="M19 27c0-6 4-9 8-9h10c4 0 8 3 8 9v26c0 3-2 5-5 5H24c-3 0-5-2-5-5z" {...ICON} />
      <rect x="19" y="32" width="26" height="15" {...ICON} strokeWidth={1.6} />
    </svg>
  );
}
function BlisterIcon() {
  return (
    <svg viewBox="0 0 64 64" aria-hidden="true">
      <rect x="8" y="12" width="48" height="40" rx="3" {...ICON} />
      {[19, 32, 45].flatMap((x) => [24, 40].map((y) => <circle key={`${x}-${y}`} cx={x} cy={y} r="4.6" {...ICON} strokeWidth={1.8} />))}
    </svg>
  );
}

export default async function DielinesPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const host = (await headers()).get("host") ?? "";
  const onDielineHost = host.startsWith("dieline.") || host.startsWith("dielines.");
  if (!user || !user.email?.endsWith("@pharmacenterusa.com")) {
    redirect(onDielineHost ? "/?showSignIn=1" : "/");
  }

  const lang = await getLangFromCookie();
  const t = makeDT(lang);
  const base = onDielineHost ? "" : "/dielines";

  const types = [
    { key: "sachet", icon: <SachetIcon />, title: t("typeSachet"), sub: t("typeSachetSub"), href: `${base}/sachet`, badge: null },
    { key: "bottle", icon: <BottleIcon />, title: t("typeBottle"), sub: t("typeBottleSub"), href: null, badge: t("badgeNext") },
    { key: "blister", icon: <BlisterIcon />, title: t("typeBlister"), sub: t("typeBlisterSub"), href: null, badge: t("badgeSoon") },
  ];

  return (
    <div className="app-shell">
      <AppHeader user={{ email: user.email! }} appContext="dielines" />
      <main className="page">
        <div className="page__inner">
          <div style={{ marginBottom: 24 }}>
            <p className="eyebrow" style={{ marginBottom: 6 }}>{t("eyebrow")}</p>
            <h1 className="page-header__title" style={{ marginBottom: 6 }}>{t("chooseTitle")}</h1>
            <p className="lede" style={{ marginTop: 4, marginBottom: 0 }}>{t("chooseLede")}</p>
          </div>
          <div className={s.chooser}>
            {types.map((ty) => {
              const body = (
                <>
                  <span className={s.typeIcon}>{ty.icon}</span>
                  <span className={s.typeTitle}>{ty.title}</span>
                  <span className={s.typeSub}>{ty.sub}</span>
                  {ty.badge ? <span className={s.typeBadge}>{ty.badge}</span> : <span className={s.typeGo}>{t("open")} →</span>}
                </>
              );
              return ty.href ? (
                <a key={ty.key} href={ty.href} className={s.typeCard}>{body}</a>
              ) : (
                <div key={ty.key} className={`${s.typeCard} ${s.typeCardOff}`} aria-disabled="true">{body}</div>
              );
            })}
          </div>
        </div>
      </main>
    </div>
  );
}
