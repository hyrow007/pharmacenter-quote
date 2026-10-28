import Link from "next/link";
import type { Lang } from "@/lib/i18n/dict";
import { makeYT, type YKey } from "../_lib/i18n";
import {
  LINES,
  addToRollup,
  emptyRollup,
  fmtDate,
  fmtInt,
  fmtMoney,
  fmtNum,
  grossPerManHour,
  lineLabelKey,
  revenuePerManHour,
  type Rollup,
  type YieldEntry,
} from "../_lib/model";
import { SNAP_KINDS, type SnapKind } from "../_lib/period";
import s from "../yields.module.css";

// The top-of-page snapshot: revenue, gross, man-hours and the per-man-hour
// figures for one day or any period, split by packaging line, and by day when
// the period covers more than one.

export default function Snapshot({
  rows,
  lang,
  kind,
  from,
  to,
  hrefFor,
  hidden,
}: {
  rows: YieldEntry[];
  lang: Lang;
  kind: SnapKind;
  from: string;
  to: string;
  hrefFor: (kind: SnapKind) => string;
  hidden: Record<string, string>; // other query params the custom form must keep
}) {
  const t = makeYT(lang);
  const total = emptyRollup();
  const byLine = new Map<string, Rollup>();
  const byDay = new Map<string, Rollup>();
  for (const r of rows) {
    addToRollup(total, r);
    byLine.set(r.line_key, addToRollup(byLine.get(r.line_key) ?? emptyRollup(), r));
    byDay.set(r.run_date, addToRollup(byDay.get(r.run_date) ?? emptyRollup(), r));
  }
  const lineRows = LINES.filter((l) => byLine.has(l)).map((l) => [l, byLine.get(l)!] as const);
  const days = [...byDay.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1));
  // Margin only over runs that have both a price and a gross, so a run still
  // waiting on its cost does not drag the percentage down.
  const margin = total.revenueWithGross > 0 ? Math.round((total.gross / total.revenueWithGross) * 100) : null;
  const periodLabel = from === to ? fmtDate(from, lang) : `${fmtDate(from, lang, false)} – ${fmtDate(to, lang, false)}`;

  return (
    <section className={`${s.card} ${s.snapshot}`}>
      <div className={s.entriesHead}>
        <div>
          <h2 className={s.cardTitle} style={{ marginBottom: 2 }}>{t("snapHeading")}</h2>
          <span className={s.hint}>
            {periodLabel} · {t("snapDays", { n: days.length })}
          </span>
        </div>
        <nav className={s.segmented} aria-label={t("snapHeading")}>
          {SNAP_KINDS.filter((k) => k !== "custom").map((k) => (
            <Link key={k} href={hrefFor(k)} scroll={false} className={k === kind ? s.segOn : undefined}>
              {t(`snap_${k}` as YKey)}
            </Link>
          ))}
          <form method="get" className={s.segForm}>
            {Object.entries(hidden).map(([k, v]) => (
              <input key={k} type="hidden" name={k} value={v} />
            ))}
            <input type="hidden" name="snap" value="custom" />
            <input type="date" name="sfrom" defaultValue={from} className={s.input} aria-label={t("fFrom")} />
            <span>–</span>
            <input type="date" name="sto" defaultValue={to} className={s.input} aria-label={t("fTo")} />
            <button type="submit" className={kind === "custom" ? `btn-chrome ${s.segOn}` : "btn-chrome"}>{t("apply")}</button>
          </form>
        </nav>
      </div>

      <div className={s.kpis}>
        <Kpi label={t("kRevenue")} value={fmtMoney(total.revenue, lang)} sub={total.revenueMissing ? t("kUnknown", { n: total.revenueMissing }) : undefined} />
        <Kpi label={t("colGross")} value={fmtMoney(total.gross, lang)} sub={margin !== null ? t("kMargin", { p: margin }) : undefined} />
        <Kpi label={t("colManHours")} value={fmtNum(total.manHours, lang, 1)} sub={t("kRuns", { n: total.entries })} />
        <Kpi label={t("kRevenueMh")} value={fmtMoney(revenuePerManHour(total), lang)} />
        <Kpi label={t("colGrossMh")} value={fmtMoney(grossPerManHour(total), lang)} />
        <Kpi label={t("kFinished")} value={fmtInt(total.finished, lang)} sub={t("kSingles", { n: fmtInt(total.singles, lang) })} />
      </div>
      {total.grossMissing > 0 ? <p className={s.warn}>{t("missingNote", { n: total.grossMissing })}</p> : null}
      {total.provisional > 0 ? <p className={s.hint}>{t("provisionalNote", { n: total.provisional })}</p> : null}
      {total.revenueMissing > 0 ? <p className={s.hint}>{t("revenueMissingNote", { n: total.revenueMissing })}</p> : null}

      {rows.length === 0 ? (
        <p className={s.empty}>{t("noEntries")}</p>
      ) : (
        <>
          <h3 className={s.subHeading}>{t("byLine")}</h3>
          <div className={s.tableWrap}>
            <table className={s.table}>
              <thead>
                <tr>
                  <th>{t("colLine")}</th>
                  <th className={s.num}>{t("kRunsCol")}</th>
                  <th className={s.num}>{t("colFinished")}</th>
                  <th className={s.num}>{t("colSingles")}</th>
                  <th className={s.num}>{t("colManHours")}</th>
                  <th className={s.num}>{t("kRevenue")}</th>
                  <th className={s.num}>{t("colGross")}</th>
                  <th className={s.num}>{t("kRevenueMh")}</th>
                  <th className={s.num}>{t("colGrossMh")}</th>
                </tr>
              </thead>
              <tbody>
                {lineRows.map(([l, r]) => (
                  <LineRow key={l} label={t(lineLabelKey(l))} r={r} lang={lang} />
                ))}
              </tbody>
              {lineRows.length > 1 ? (
                <tfoot>
                  <LineRow label={t("kTotal")} r={total} lang={lang} />
                </tfoot>
              ) : null}
            </table>
          </div>

          {days.length > 1 ? (
            <>
              <h3 className={s.subHeading}>{t("byDay")}</h3>
              <div className={s.tableWrap}>
                <table className={s.table}>
                  <thead>
                    <tr>
                      <th>{t("colDate")}</th>
                      <th className={s.num}>{t("kRunsCol")}</th>
                      <th className={s.num}>{t("colFinished")}</th>
                      <th className={s.num}>{t("colManHours")}</th>
                      <th className={s.num}>{t("kRevenue")}</th>
                      <th className={s.num}>{t("colGross")}</th>
                      <th className={s.num}>{t("kRevenueMh")}</th>
                      <th className={s.num}>{t("colGrossMh")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {days.map(([d, r]) => (
                      <tr key={d}>
                        <td style={{ whiteSpace: "nowrap" }}><Link href={`?date=${d}`}>{fmtDate(d, lang)}</Link></td>
                        <td className={s.num}>{r.entries}</td>
                        <td className={s.num}>{fmtInt(r.finished, lang)}</td>
                        <td className={s.num}>{fmtNum(r.manHours, lang, 1)}</td>
                        <td className={s.num}>
                          {fmtMoney(r.revenue, lang)}
                          {r.revenueMissing > 0 ? <span className={s.missingDot}>+{r.revenueMissing} {t("missing")}</span> : null}
                        </td>
                        <td className={s.num}>
                          {fmtMoney(r.gross, lang)}
                          {r.grossMissing > 0 ? <span className={s.missingDot}>+{r.grossMissing} {t("missing")}</span> : null}
                        </td>
                        <td className={s.num}>{fmtMoney(revenuePerManHour(r), lang)}</td>
                        <td className={s.num}>{fmtMoney(grossPerManHour(r), lang)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          ) : null}
        </>
      )}
    </section>
  );
}

function Kpi({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className={s.kpi}>
      <span className={s.kpiLabel}>{label}</span>
      <span className={s.kpiValue}>{value}</span>
      {sub ? <span className={s.kpiSub}>{sub}</span> : null}
    </div>
  );
}

function LineRow({ label, r, lang }: { label: string; r: Rollup; lang: Lang }) {
  return (
    <tr>
      <td>{label}</td>
      <td className={s.num}>{fmtInt(r.entries, lang)}</td>
      <td className={s.num}>{fmtInt(r.finished, lang)}</td>
      <td className={s.num}>{fmtInt(r.singles, lang)}</td>
      <td className={s.num}>{fmtNum(r.manHours, lang, 1)}</td>
      <td className={s.num}>{fmtMoney(r.revenue, lang)}</td>
      <td className={s.num}>{fmtMoney(r.gross, lang)}</td>
      <td className={s.num}>{fmtMoney(revenuePerManHour(r), lang)}</td>
      <td className={s.num}>{fmtMoney(grossPerManHour(r), lang)}</td>
    </tr>
  );
}
