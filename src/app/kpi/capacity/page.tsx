import AppHeader from "../../_components/AppHeader";
import { CAP_LINES, loadCapacity } from "../_lib/capacity";
import { fmtDay, fmtMonth, kpiPage, one } from "../_lib/pageCtx";
import type { KKey } from "../_lib/i18n";
import { saveCapacity } from "./actions";
import s from "../kpi.module.css";

// /kpi/capacity -- utilization last month per line, and the editable table of
// what each line can run (machines x working days). Used run-days are
// Overhead's measurement from the Yields log.

export const dynamic = "force-dynamic";
export const metadata = { title: "KPIs · Capacity" };

export default async function CapacityPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { supabase, email, lang, t } = await kpiPage();
  const sp = await searchParams;
  const cap = await loadCapacity(supabase);
  const saved = one(sp.saved) === "1";
  const err = one(sp.err);
  const pct = (v: number | null) => (v === null ? "—" : `${v.toFixed(0)}%`);
  const all = cap?.config.find((c) => c.line_key === "ALL");
  const lastEdit = cap?.config
    .filter((c) => c.updated_by && c.updated_by !== "seed" && c.updated_at)
    .sort((a, b) => (a.updated_at! < b.updated_at! ? 1 : -1))[0];
  const off = cap?.pct !== null && cap?.pct !== undefined && cap.band && (cap.pct < cap.band.low || cap.pct > cap.band.high);

  return (
    <div className="app-shell">
      <AppHeader user={{ email }} appContext="kpi" />
      <main className="page">
        <div className="page__inner">
          <h1 className="page-header__title" style={{ marginBottom: 6 }}>{t("capTitle")}</h1>
          <p className="lede" style={{ marginTop: 4 }}>{t("capLede")}</p>
          {cap ? <p className={s.note}>{t("capMonth", { month: fmtMonth(cap.month, lang) })}</p> : null}
          {saved ? <p className={s.ok}>{t("savedOk")}</p> : null}
          {err ? <p className={s.err}>{t("saveFailed", { err })}</p> : null}

          {cap ? (
            <div className={s.stats}>
              <div className={s.stat}>
                <p className={s.statLabel}>{t("colPct")}</p>
                <p className={s.statValue} style={off ? { color: "#b4532a" } : undefined}>{pct(cap.pct)}</p>
                {cap.band ? <p className={s.statSub}>{t("bandTitle")}: {cap.band.low}–{cap.band.high}%</p> : null}
              </div>
              <div className={s.stat}>
                <p className={s.statLabel}>{t("colUsed")}</p>
                <p className={s.statValue}>{cap.lines.reduce((a, l) => a + l.used, 0)}</p>
              </div>
              <div className={s.stat}>
                <p className={s.statLabel}>{t("colAvailable")}</p>
                <p className={s.statValue}>{cap.available || "—"}</p>
              </div>
            </div>
          ) : null}

          <form action={saveCapacity}>
            <div className={s.tableWrap}>
              <table className={s.table}>
                <thead>
                  <tr>
                    <th>{t("colLine")}</th>
                    <th className={s.num}>{t("colMachines")}</th>
                    <th className={s.num}>{t("colDays")}</th>
                    <th className={s.num}>{t("colAvailable")}</th>
                    <th className={s.num}>{t("colUsed")}</th>
                    <th className={s.num}>{t("colPct")}</th>
                  </tr>
                </thead>
                <tbody>
                  {CAP_LINES.map((line) => {
                    const c = cap?.config.find((x) => x.line_key === line);
                    const u = cap?.lines.find((x) => x.line === line);
                    return (
                      <tr key={line}>
                        <td>{t(`line_${line}` as KKey)}</td>
                        <td className={s.num}>
                          <input type="number" name={`machines_${line}`} min={0} max={100} step={1} defaultValue={c?.machines ?? ""} aria-label={`${t(`line_${line}` as KKey)} ${t("colMachines")}`} />
                        </td>
                        <td className={s.num}>
                          <input type="number" name={`days_${line}`} min={0} max={31} step={0.5} defaultValue={c?.days_per_month ?? ""} aria-label={`${t(`line_${line}` as KKey)} ${t("colDays")}`} />
                        </td>
                        <td className={s.num}>{u?.available ?? t("notSet")}</td>
                        <td className={s.num}>{u?.used ?? 0}</td>
                        <td className={s.num}>{pct(u?.pct ?? null)}</td>
                      </tr>
                    );
                  })}
                </tbody>
                {cap ? (
                  <tfoot>
                    <tr>
                      <td>{t("total")}</td>
                      <td />
                      <td />
                      <td className={s.num}>{cap.available || "—"}</td>
                      <td className={s.num}>{cap.used}</td>
                      <td className={s.num}>{pct(cap.pct)}</td>
                    </tr>
                  </tfoot>
                ) : null}
              </table>
            </div>

            <h2 className={s.h2}>{t("bandTitle")}</h2>
            <p className={s.note}>{t("bandHelp")}</p>
            <div className={s.filters}>
              <label className={s.field}>
                {t("bandLow")}
                <input type="number" name="band_low" min={0} max={100} step={1} defaultValue={all?.band_low ?? ""} />
              </label>
              <label className={s.field}>
                {t("bandHigh")}
                <input type="number" name="band_high" min={0} max={100} step={1} defaultValue={all?.band_high ?? ""} />
              </label>
              <button type="submit" className={s.btn}>{t("save")}</button>
            </div>
          </form>
          {lastEdit ? <p className={s.note}>{t("lastEdit", { who: lastEdit.updated_by!, when: fmtDay(lastEdit.updated_at!.slice(0, 10), lang) })}</p> : null}
          <p className={s.note}>{t("capCaveat")}</p>
        </div>
      </main>
    </div>
  );
}
