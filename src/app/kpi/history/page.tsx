import AppHeader from "../../_components/AppHeader";
import { ESTIMATE_FROM, estimateSeries, loadHistoricOrders, openOn } from "@/app/orders/_lib/openHistory";
import LineChart from "../_components/LineChart";
import { fmtDay, fmtMonth, fmtUsd, fmtUsdCompact, kpiPage, one } from "../_lib/pageCtx";
import { plantToday } from "../_lib/run";
import s from "../kpi.module.css";

// /kpi/history -- open sales order value on any day.
// Saved snapshots (kpi_snapshots, from 2026-11-05) are the record; any day
// without one is rebuilt by Orders' openHistory.ts and labelled estimated.

export const dynamic = "force-dynamic";
export const metadata = { title: "KPIs · History" };

type Snap = { period_date: string; value: number | null; detail: Record<string, unknown> | null };
type ListRow = { so: string; customer: string; value: number | null };

export default async function HistoryPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { supabase, email, lang, t } = await kpiPage();
  const sp = await searchParams;
  const today = plantToday();
  const asked = one(sp.date);
  const day = asked && /^\d{4}-\d{2}-\d{2}$/.test(asked) ? (asked < ESTIMATE_FROM ? ESTIMATE_FROM : asked > today ? today : asked) : today;

  const [snapsRes, historic] = await Promise.all([
    supabase.from("kpi_snapshots").select("period_date, value, detail").eq("metric_id", "orders.open_value").order("period_date"),
    loadHistoricOrders(supabase),
  ]);
  const snaps = new Map(((snapsRes.data ?? []) as Snap[]).map((r) => [r.period_date, r]));
  const est = historic ? estimateSeries(historic, ESTIMATE_FROM, today) : new Map();

  // One point per day; saved wins, estimate fills the rest.
  const days: string[] = [];
  for (const d of est.keys()) days.push(d);
  for (const d of snaps.keys()) if (!est.has(d) && d >= ESTIMATE_FROM && d <= today) days.push(d);
  days.sort();
  const saved = days.map((d) => (snaps.get(d)?.value ?? null) === null ? null : Number(snaps.get(d)!.value));
  const estimated = days.map((d, i) => (saved[i] === null ? est.get(d)?.value ?? null : null));
  // Join the dashed line to the solid one where they meet.
  for (let i = 1; i < days.length; i++) {
    if (estimated[i - 1] !== null && saved[i] !== null && estimated[i] === null) estimated[i] = saved[i];
    if (saved[i - 1] !== null && estimated[i] !== null && estimated[i - 1] === null) estimated[i - 1] = saved[i - 1];
  }
  const tickLabels = days.map((d, i) => (i === 0 || d.endsWith("-01") ? fmtMonth(d.slice(0, 7), lang, i === 0 || d.slice(5, 7) === "01") : null));

  // The chosen day
  const snap = snaps.get(day);
  const isSaved = !!snap && snap.value !== null;
  const value = isSaved ? Number(snap!.value) : est.get(day)?.value ?? null;
  let list: ListRow[] | null = null;
  let count: number | null = null;
  if (isSaved) {
    const det = (snap!.detail ?? {}) as { orders?: number; order_list?: ListRow[] };
    count = typeof det.orders === "number" ? det.orders : null;
    list = Array.isArray(det.order_list) ? det.order_list : null;
  } else if (historic) {
    const open = openOn(historic, day).sort((a, b) => b.value - a.value);
    list = open.map((o) => ({ so: o.so, customer: o.customer, value: o.value }));
    count = open.length;
  }
  const byCustomer = new Map<string, number>();
  for (const r of list ?? []) byCustomer.set(r.customer, (byCustomer.get(r.customer) ?? 0) + (r.value ?? 0));
  const top = [...byCustomer.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);

  return (
    <div className="app-shell">
      <AppHeader user={{ email }} appContext="kpi" />
      <main className="page">
        <div className="page__inner">
          <h1 className="page-header__title" style={{ marginBottom: 6 }}>{t("historyTitle")}</h1>
          <p className="lede" style={{ marginTop: 4 }}>{t("historyLede")}</p>

          <form method="get" className={s.filters}>
            <label className={s.field}>
              {t("pickDay")}
              <input type="date" name="date" defaultValue={day} min={ESTIMATE_FROM} max={today} />
            </label>
            <button type="submit" className={s.btn}>{t("show")}</button>
          </form>

          <LineChart
            labels={days.map((d) => fmtDay(d, lang))}
            tickLabels={tickLabels}
            series={[
              { name: t("legendSaved"), color: "var(--teal-700)", values: saved, dots: days.length <= 60 },
              { name: t("legendEstimated"), color: "var(--teal-500)", values: estimated, dashed: true, dots: false },
            ]}
            format={(n) => fmtUsdCompact(n, lang)}
            ariaLabel={t("chartValue")}
            highlight={days.indexOf(day)}
          />

          <h2 className={s.h2}>
            {t("openAtEnd", { date: fmtDay(day, lang) })}
            <span className={`${s.tag} ${isSaved ? s.tagSaved : s.tagEst}`}>{isSaved ? t("savedTag") : t("estimatedTag")}</span>
          </h2>
          {!isSaved ? <p className={s.note}>{t("estimatedNote")}</p> : null}

          {value === null ? (
            <p className={s.note}>{t("noDay")}</p>
          ) : (
            <>
              <div className={s.stats}>
                <div className={s.stat}>
                  <p className={s.statLabel}>{t("chartValue")}</p>
                  <p className={s.statValue}>{fmtUsd(value, lang)}</p>
                </div>
                {count !== null ? (
                  <div className={s.stat}>
                    <p className={s.statLabel}>{t("ordersCount")}</p>
                    <p className={s.statValue}>{count}</p>
                  </div>
                ) : null}
              </div>

              {top.length > 0 ? (
                <>
                  <p className={s.statLabel}>{t("topCustomers")}</p>
                  <div className={s.tableWrap}>
                    <table className={s.table}>
                      <tbody>
                        {top.map(([c, v]) => (
                          <tr key={c}><td>{c}</td><td className={s.num}>{fmtUsd(v, lang)}</td></tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              ) : null}

              <p className={s.statLabel}>{t("orderList")}</p>
              {list ? (
                <div className={s.tableWrap}>
                  <table className={s.table}>
                    <thead>
                      <tr><th>{t("colSo")}</th><th>{t("colCustomer")}</th><th className={s.num}>{t("colValue")}</th></tr>
                    </thead>
                    <tbody>
                      {list.map((r) => (
                        <tr key={r.so}>
                          <td>{r.so}</td>
                          <td>{r.customer}</td>
                          <td className={s.num}>{r.value === null ? "—" : fmtUsd(r.value, lang)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className={s.note}>{t("noListSaved")}</p>
              )}
            </>
          )}
        </div>
      </main>
    </div>
  );
}
