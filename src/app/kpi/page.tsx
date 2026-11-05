import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import AppHeader from "../_components/AppHeader";
import { getLangFromCookie } from "@/lib/i18n/server";
import { makeT, type Lang } from "@/lib/i18n/dict";
import { describeFreshness } from "@/lib/freshness";
import type { Metric } from "./_lib/contract";
import { SECTIONS } from "./_lib/sections";
import { addDays, collectMetrics, judge, loadComparisons, plantToday, writeSnapshots, type Comparison, type Verdict } from "./_lib/run";
import { serviceClient } from "./_lib/service";
import { makeKT, type KT } from "./_lib/i18n";
import s from "./kpi.module.css";

// /kpi -- served at kpi.pharmacenter.app/ by the host rewrite in middleware.ts.
//
// Exceptions first: the top answers "is anything wrong", the sections hold the
// detail. Every value comes from the owning app's kpi.ts (see _lib/sections.ts).
// Today's snapshot is written by the daily cron; if a visit arrives before it
// has run, the page writes it, so a day with a visitor is never a day missing.

export const dynamic = "force-dynamic";
export const metadata = { title: "KPIs" };

function fmtValue(m: Metric, lang: Lang): string {
  if (m.value === null) return "—";
  const loc = lang === "es" ? "es-US" : "en-US";
  switch (m.unit) {
    case "usd":
      return new Intl.NumberFormat(loc, { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(m.value);
    case "usd_per_hour":
      return `${new Intl.NumberFormat(loc, { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format(m.value)}/h`;
    case "pct":
      return `${new Intl.NumberFormat(loc, { maximumFractionDigits: 1 }).format(m.value)}%`;
    default:
      return new Intl.NumberFormat(loc, { maximumFractionDigits: 0 }).format(m.value);
  }
}

function fmtUsd(n: number, lang: Lang): string {
  return new Intl.NumberFormat(lang === "es" ? "es-US" : "en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(n);
}

function fmtDay(iso: string, lang: Lang): string {
  return new Intl.DateTimeFormat(lang === "es" ? "es-US" : "en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }).format(new Date(`${iso}T12:00:00Z`));
}

function fmtPct(p: number): string {
  return `${p > 0 ? "+" : ""}${p.toFixed(1)}%`;
}

function reasonText(m: Metric, v: Verdict, t: KT, lang: Lang): string {
  if (!v.off) return "";
  if (v.reason === "unknown") return t("unknownNote");
  if (v.reason === "below") return t("belowTarget", { target: fmtValue({ ...m, value: m.target!.value }, lang) });
  if (v.reason === "above") return t("aboveTarget", { target: fmtValue({ ...m, value: m.target!.value }, lang) });
  const n = m.alarm?.vsDays ?? 30;
  const pct = `${Math.abs(v.changePct ?? 0).toFixed(1)}%`;
  return (v.changePct ?? 0) >= 0 ? t("movedUp", { pct, n }) : t("movedDown", { pct, n });
}

export default async function KpiPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user || !user.email?.endsWith("@pharmacenterusa.com")) {
    const host = (await headers()).get("host") ?? "";
    redirect(host.startsWith("kpi.") || host.startsWith("kpis.") ? "/?showSignIn=1" : "/");
  }

  const lang = await getLangFromCookie();
  const t = makeKT(lang);
  const today = plantToday();

  const metrics = await collectMetrics(supabase);
  const shown = SECTIONS.flatMap((sec) => sec.metrics).map((id) => metrics.get(id)).filter((m): m is Metric => !!m);

  // Day-one guarantee: if the cron has not written today yet, write it now.
  const { count } = await supabase
    .from("kpi_snapshots")
    .select("metric_id", { count: "exact", head: true })
    .eq("period_date", today);
  if ((count ?? 0) < metrics.size) {
    const db = serviceClient();
    if (db) await writeSnapshots(db, metrics.values(), today);
  }

  const comparisons = await loadComparisons(supabase, shown, today);
  const verdicts = new Map(shown.map((m) => [m.id, judge(m, comparisons.get(m.id))]));
  const off = shown.filter((m) => verdicts.get(m.id)?.off);

  const asOf = shown.map((m) => m.dataAsOf).filter((x): x is string => !!x).sort().pop() ?? null;
  const freshness = describeFreshness(asOf, makeT(lang), lang);

  return (
    <div className="app-shell">
      <AppHeader user={{ email: user.email! }} appContext="kpi" />
      <main className="page">
        <div className="page__inner">
          <div style={{ marginBottom: 20 }}>
            <p className="eyebrow" style={{ marginBottom: 6 }}>{t("eyebrow")}</p>
            <h1 className="page-header__title" style={{ marginBottom: 6 }}>{t("title")}</h1>
            <p className="lede" style={{ marginTop: 4, marginBottom: 0 }}>{t("lede")}</p>
            {asOf ? <p className={s.meta} style={{ marginTop: 8 }}>{t("dataAsOf", { when: freshness.relative })}</p> : null}
          </div>

          {freshness.stale ? <p className={s.stale} role="alert">{t("stale")}</p> : null}

          <section className={`${s.attention} ${off.length === 0 ? s.attentionClear : ""}`} aria-labelledby="kpi-attention">
            <h2 id="kpi-attention" className={s.attentionTitle}>{t("attention")}</h2>
            {off.length === 0 ? (
              <p className={s.muted} style={{ margin: 0 }}>{t("allClear")}</p>
            ) : (
              <ul className={s.attentionList}>
                {off.map((m) => (
                  <li key={m.id} className={s.attentionItem}>
                    <a href={`#${m.id}`}>{m.label[lang]}</a> — {fmtValue(m, lang)}.{" "}
                    {reasonText(m, verdicts.get(m.id)!, t, lang)}
                  </li>
                ))}
              </ul>
            )}
          </section>

          {SECTIONS.map((sec) => {
            const ms = sec.metrics.map((id) => metrics.get(id)).filter((m): m is Metric => !!m);
            if (ms.length === 0) return null;
            return (
              <section key={sec.id} className={s.section} aria-labelledby={`sec-${sec.id}`}>
                <h2 id={`sec-${sec.id}`} className={s.sectionTitle}>{sec.title[lang]}</h2>
                <div className={s.grid}>
                  {ms.map((m) => (
                    <MetricCard key={m.id} m={m} c={comparisons.get(m.id)} v={verdicts.get(m.id)!} t={t} lang={lang} />
                  ))}
                </div>
              </section>
            );
          })}
        </div>
      </main>
    </div>
  );
}

function MetricCard({ m, c, v, t, lang }: { m: Metric; c?: Comparison; v: Verdict; t: KT; lang: Lang }) {
  const d = (m.detail ?? {}) as { orders?: number; unpriced?: number; top_customers?: { customer: string; value: number }[] };
  const vsDays = m.alarm?.vsDays ?? 30;
  let changeLine: React.ReactNode;
  if (c?.priorDate && c.changePct !== null) {
    const good = c.changePct === 0 ? null : (c.changePct > 0) === (m.direction === "up");
    changeLine =
      c.changePct === 0 ? (
        <p className={s.change}>{t("noChange", { date: fmtDay(c.priorDate, lang) })}</p>
      ) : (
        <p className={`${s.change} ${good ? s.up : s.down}`}>{t("changeVs", { pct: fmtPct(c.changePct), date: fmtDay(c.priorDate, lang) })}</p>
      );
  } else if (c?.firstDate) {
    changeLine = <p className={`${s.change} ${s.muted}`}>{t("trendStarts", { date: fmtDay(c.firstDate, lang), n: vsDays, from: fmtDay(addDays(c.firstDate, vsDays), lang) })}</p>;
  } else {
    changeLine = <p className={`${s.change} ${s.muted}`}>{t("noHistory")}</p>;
  }

  return (
    <article id={m.id} className={`${s.card} ${v.off ? s.cardOff : ""}`}>
      <p className={s.label}>{m.label[lang]}</p>
      <p className={s.value}>{m.value === null ? t("unknown") : fmtValue(m, lang)}</p>
      {changeLine}
      {typeof d.orders === "number" ? <p className={s.meta}>{t("orders", { n: d.orders })}</p> : null}
      {d.unpriced ? <p className={s.meta}>{t("unpriced", { n: d.unpriced })}</p> : null}
      {m.alarm ? <p className={s.meta}>{t("alarmRule", { pct: m.alarm.changePct, n: m.alarm.vsDays })}</p> : null}
      {d.top_customers && d.top_customers.length > 0 ? (
        <>
          <p className={s.meta} style={{ marginTop: 10, fontWeight: 700 }}>{t("topCustomers")}</p>
          <ul className={s.top}>
            {d.top_customers.map((r) => (
              <li key={r.customer} className={s.topRow}>
                <span className={s.topName}>{r.customer}</span>
                <span className={s.topVal}>{fmtUsd(r.value, lang)}</span>
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {m.href ? <a className={s.link} href={m.href}>{t("openIn", { app: lang === "es" ? "Órdenes" : "Sales Orders" })}</a> : null}
    </article>
  );
}
