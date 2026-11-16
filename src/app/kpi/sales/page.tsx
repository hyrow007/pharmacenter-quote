import AppHeader from "../../_components/AppHeader";
import { addMonths, firstDay, loadFulfilled, monthEnd, newCustomers, salesByCustomer } from "@/app/orders/_lib/revenue";
import LineChart, { PALETTE } from "../_components/LineChart";
import { fmtDay, fmtMonth, fmtPct, fmtUsd, fmtUsdCompact, kpiPage, one } from "../_lib/pageCtx";
import { plantToday } from "../_lib/run";
import s from "../kpi.module.css";

// /kpi/sales -- sales by customer over a chosen range, and new customers.
// Every number comes from Orders' revenue.ts (fulfilled Fishbowl orders,
// dated by completion; gross = total_price - Fishbowl line cost).

export const dynamic = "force-dynamic";
export const metadata = { title: "KPIs · Sales" };

const LOOKBACKS = [3, 6, 12];

export default async function SalesPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { supabase, email, lang, t } = await kpiPage();
  const sp = await searchParams;
  const today = plantToday();
  const thisMonth = today.slice(0, 7);
  const ym = (v: string | undefined) => (v && /^\d{4}-\d{2}$/.test(v) ? v : undefined);
  let toM = ym(one(sp.to)) ?? thisMonth;
  let fromM = ym(one(sp.from)) ?? addMonths(`${thisMonth}-01`, -11).slice(0, 7);
  if (toM > thisMonth) toM = thisMonth;
  if (fromM > toM) [fromM, toM] = [toM, fromM];
  const top = Math.min(10, Math.max(1, Number(one(sp.top)) || 6));
  const lookback = LOOKBACKS.includes(Number(one(sp.lookback))) ? Number(one(sp.lookback)) : 6;
  const includeHouse = one(sp.house) === "1";

  const from = `${fromM}-01`;
  const to = toM === thisMonth ? today : monthEnd(toM);

  const rows = await loadFulfilled(supabase);
  const first = rows ? firstDay(rows) : null;
  const last = rows && rows.length ? rows[rows.length - 1].day : null;
  const sales = rows ? salesByCustomer(rows, from, to, { includeHouse }) : null;
  const nc = rows ? newCustomers(rows, from, to, lookback, { includeHouse }) : null;

  // Chart: top N customers + everyone else, one line per month.
  const months = sales?.months ?? [];
  const shown = (sales?.customers ?? []).slice(0, top);
  const rest = (sales?.customers ?? []).slice(top);
  const series = shown.map((c, i) => ({
    name: c.name,
    color: PALETTE[i % PALETTE.length],
    values: months.map((m) => c.byMonth.get(m) ?? 0),
  }));
  if (rest.length > 0) {
    series.push({
      name: t("everyoneElse"),
      color: PALETTE[8],
      values: months.map((m) => rest.reduce((a, c) => a + (c.byMonth.get(m) ?? 0), 0)),
    });
  }
  const monthOptions: string[] = [];
  if (first) for (let m = first.slice(0, 7); m <= thisMonth; m = addMonths(`${m}-01`, 1).slice(0, 7)) monthOptions.push(m);
  const clipped = first && from < first;
  const ncLimited = nc?.fullHistoryFrom && from < nc.fullHistoryFrom;

  return (
    <div className="app-shell">
      <AppHeader user={{ email }} appContext="kpi" />
      <main className="page">
        <div className="page__inner">
          <h1 className="page-header__title" style={{ marginBottom: 6 }}>{t("salesTitle")}</h1>
          <p className="lede" style={{ marginTop: 4 }}>{t("salesLede")}</p>
          {first && last ? <p className={s.note}>{t("dataRange", { from: fmtDay(first, lang), to: fmtDay(last, lang) })}</p> : null}

          <form method="get" className={s.filters}>
            <label className={s.field}>
              {t("fromMonth")}
              <select name="from" defaultValue={fromM}>
                {monthOptions.map((m) => <option key={m} value={m}>{fmtMonth(m, lang)}</option>)}
              </select>
            </label>
            <label className={s.field}>
              {t("toMonth")}
              <select name="to" defaultValue={toM}>
                {monthOptions.map((m) => <option key={m} value={m}>{fmtMonth(m, lang)}</option>)}
              </select>
            </label>
            <label className={s.field}>
              {t("topN")}
              <select name="top" defaultValue={String(top)}>
                {[3, 5, 6, 8, 10].map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
            </label>
            <label className={s.field}>
              {t("lookback")}
              <select name="lookback" defaultValue={String(lookback)}>
                {LOOKBACKS.map((n) => <option key={n} value={n}>{t("monthsN", { n })}</option>)}
              </select>
            </label>
            <label className={s.check}>
              <input type="checkbox" name="house" value="1" defaultChecked={includeHouse} />
              {t("includeHouse")}
            </label>
            <button type="submit" className={s.btn}>{t("apply")}</button>
          </form>

          {!sales || sales.total === 0 ? (
            <p className={s.note}>{t("noSales")}</p>
          ) : (
            <>
              {clipped ? <p className={s.note}>{t("rangeClipped", { from: fmtDay(first!, lang) })}</p> : null}
              <div className={s.stats}>
                <div className={s.stat}><p className={s.statLabel}>{t("totalRevenue")}</p><p className={s.statValue}>{fmtUsd(sales.total, lang)}</p></div>
                <div className={s.stat}><p className={s.statLabel}>{t("customersCount")}</p><p className={s.statValue}>{sales.customers.length}</p></div>
                <div className={s.stat}><p className={s.statLabel}>{t("ordersCount")}</p><p className={s.statValue}>{sales.customers.reduce((a, c) => a + c.orders, 0)}</p></div>
              </div>

              <h2 className={s.h2}>{t("monthlyChart")}</h2>
              <LineChart
                labels={months.map((m) => fmtMonth(m, lang))}
                tickLabels={months.map((m, i) => fmtMonth(m, lang, i === 0 || m.endsWith("-01")))}
                series={series}
                format={(n) => fmtUsdCompact(n, lang)}
                ariaLabel={t("monthlyChart")}
              />

              <div className={s.tableWrap}>
                <table className={s.table}>
                  <thead>
                    <tr>
                      <th className={s.num}>{t("colRank")}</th>
                      <th>{t("colCustomer")}</th>
                      <th className={s.num}>{t("colRevenue")}</th>
                      <th className={s.num}>{t("colShare")}</th>
                      <th className={s.num}>{t("colOrders")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sales.customers.map((c, i) => (
                      <tr key={c.key}>
                        <td className={s.num}>{i + 1}</td>
                        <td>
                          {i < top ? <span className={s.swatch} style={{ background: PALETTE[i % PALETTE.length] }} /> : null}
                          {c.name}
                        </td>
                        <td className={s.num}>{fmtUsd(c.revenue, lang)}</td>
                        <td className={s.num}>{fmtPct(c.share, lang)}</td>
                        <td className={s.num}>{c.orders}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr>
                      <td />
                      <td>{t("total")}</td>
                      <td className={s.num}>{fmtUsd(sales.total, lang)}</td>
                      <td className={s.num}>{fmtPct(1, lang, 0)}</td>
                      <td className={s.num}>{sales.customers.reduce((a, c) => a + c.orders, 0)}</td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            </>
          )}

          <h2 id="new" className={s.h2}>{t("newTitle")}</h2>
          <p className={s.note}>{t("newLede", { n: lookback })}</p>
          {ncLimited ? (
            <p className={s.note}>{t("historyLimit", { first: fmtDay(first!, lang), full: fmtDay(nc!.fullHistoryFrom!, lang), n: lookback })}</p>
          ) : null}
          {!nc || nc.count === 0 ? (
            <p className={s.note}>{t("noneNew")}</p>
          ) : (
            <>
              <div className={s.stats}>
                <div className={s.stat}>
                  <p className={s.statLabel}>{t("newCount")}</p>
                  <p className={s.statValue}>{nc.count}</p>
                </div>
                <div className={s.stat}>
                  <p className={s.statLabel}>{t("newRevenue")}</p>
                  <p className={s.statValue}>{fmtUsd(nc.revenue, lang)}</p>
                  {nc.periodRevenue > 0 ? <p className={s.statSub}>{t("newShare", { pct: fmtPct(nc.revenue / nc.periodRevenue, lang) })}</p> : null}
                </div>
                <div className={s.stat}>
                  <p className={s.statLabel}>{t("grossProfit")}</p>
                  <p className={s.statValue}>{fmtUsd(nc.gross, lang)}</p>
                  {nc.costKnownRevenue > 0 ? <p className={s.statSub}>{t("grossMargin", { pct: fmtPct(nc.gross / nc.costKnownRevenue, lang) })}</p> : null}
                </div>
              </div>
              {nc.ordersKnown < nc.ordersTotal ? (
                <p className={s.note}>{t("costCoverage", { known: nc.ordersKnown, total: nc.ordersTotal })}</p>
              ) : null}
              <div className={s.tableWrap}>
                <table className={s.table}>
                  <thead>
                    <tr>
                      <th>{t("colCustomer")}</th>
                      <th>{t("colFirst")}</th>
                      <th className={s.num}>{t("colOrders")}</th>
                      <th className={s.num}>{t("colRevenue")}</th>
                      <th className={s.num}>{t("colGross")}</th>
                      <th className={s.num}>{t("colMargin")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {nc.customers.map((c) => (
                      <tr key={c.key}>
                        <td>{c.name}</td>
                        <td>{fmtDay(c.firstDay, lang)}</td>
                        <td className={s.num}>{c.orders}</td>
                        <td className={s.num}>{fmtUsd(c.revenue, lang)}</td>
                        <td className={s.num}>{c.costKnown > 0 ? fmtUsd(c.gross, lang) : "—"}</td>
                        <td className={s.num}>{c.costKnownRevenue > 0 ? fmtPct(c.gross / c.costKnownRevenue, lang) : "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr>
                      <td>{t("total")}</td>
                      <td />
                      <td className={s.num}>{nc.ordersTotal}</td>
                      <td className={s.num}>{fmtUsd(nc.revenue, lang)}</td>
                      <td className={s.num}>{fmtUsd(nc.gross, lang)}</td>
                      <td className={s.num}>{nc.costKnownRevenue > 0 ? fmtPct(nc.gross / nc.costKnownRevenue, lang) : "—"}</td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            </>
          )}
        </div>
      </main>
    </div>
  );
}
