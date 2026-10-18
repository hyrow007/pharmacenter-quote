import { redirect } from "next/navigation";
import { headers } from "next/headers";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import AppHeader from "../../_components/AppHeader";
import { getLangFromCookie } from "@/lib/i18n/server";
import { makeYT } from "../_lib/i18n";
import { loadEntries } from "../_lib/load";
import { fillMissingGross } from "../_lib/backfill";
import {
  LINES,
  addDays,
  addToRollup,
  emptyRollup,
  fmtDate,
  fmtInt,
  fmtMoney,
  fmtNum,
  fmtUnitMoney,
  grossPerManHour,
  grossPerManHourOf,
  isIsoDate,
  isLine,
  lineLabelKey,
  todayInPlant,
  type Rollup,
} from "../_lib/model";
import s from "../yields.module.css";

// /yields/history -- any date range, optionally one line or one product.
// Totals, a by-line split, and one row per day. Defaults to the last 90 days.

export const dynamic = "force-dynamic";
export const metadata = { title: "Yields · History" };

export default async function YieldsHistoryPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string; line?: string; product?: string }>;
}) {
  const sp = await searchParams;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user || !user.email?.endsWith("@pharmacenterusa.com")) {
    const host = (await headers()).get("host") ?? "";
    redirect(host.startsWith("yield.") || host.startsWith("yields.") ? "/?showSignIn=1" : "/");
  }

  const lang = await getLangFromCookie();
  const t = makeYT(lang);
  const to = isIsoDate(sp.to) ? sp.to : todayInPlant();
  const from = isIsoDate(sp.from) ? sp.from : addDays(to, -90);
  const line = isLine(sp.line) ? sp.line : null;
  const product = (sp.product ?? "").trim() || null;

  const { rows, error } = await loadEntries(supabase, { from, to, line, product });
  // Entries whose sales order has shipped since they were logged get their
  // gross from Fishbowl now (see _lib/backfill.ts).
  await fillMissingGross(supabase, rows);

  const total = emptyRollup();
  const byLine = new Map<string, Rollup>();
  const byDay = new Map<string, Rollup>();
  for (const r of rows) {
    addToRollup(total, r);
    byLine.set(r.line_key, addToRollup(byLine.get(r.line_key) ?? emptyRollup(), r));
    byDay.set(r.run_date, addToRollup(byDay.get(r.run_date) ?? emptyRollup(), r));
  }
  const days = [...byDay.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1));
  // Every entry, newest first (same day: by line, then product).
  const ENTRY_CAP = 1000;
  const entryRows = [...rows]
    .sort((a, b) =>
      a.run_date !== b.run_date
        ? a.run_date < b.run_date ? 1 : -1
        : a.line_key.localeCompare(b.line_key) || a.product_num.localeCompare(b.product_num),
    )
    .slice(0, ENTRY_CAP);
  const lineRows = LINES.filter((l) => byLine.has(l)).map((l) => [l, byLine.get(l)!] as const);

  return (
    <div className="app-shell">
      <AppHeader user={{ email: user.email! }} appContext="yields" />
      <main className="page">
        <div className="page__inner">
          <div style={{ marginBottom: 20 }}>
            <p className="eyebrow" style={{ marginBottom: 6 }}>{t("eyebrow")}</p>
            <h1 className="page-header__title" style={{ marginBottom: 6 }}>{t("histHeading")}</h1>
            <p className="lede" style={{ marginTop: 4, marginBottom: 0 }}>{t("histLede")}</p>
          </div>

          <form method="get" className={s.filters}>
            <label className={s.field}>
              <span>{t("fFrom")}</span>
              <input type="date" name="from" defaultValue={from} className={s.input} />
            </label>
            <label className={s.field}>
              <span>{t("fTo")}</span>
              <input type="date" name="to" defaultValue={to} className={s.input} />
            </label>
            <label className={s.field}>
              <span>{t("fLine")}</span>
              <select name="line" defaultValue={line ?? ""} className={s.input}>
                <option value="">{t("fAllLines")}</option>
                {LINES.map((l) => (
                  <option key={l} value={l}>{t(lineLabelKey(l))}</option>
                ))}
              </select>
            </label>
            <label className={s.field}>
              <span>{t("fProductFilter")}</span>
              <input name="product" defaultValue={product ?? ""} className={s.input} placeholder="1928" />
            </label>
            <button type="submit" className={s.primary}>{t("apply")}</button>
          </form>

          {error ? <p className={s.error} role="alert">{error}</p> : null}

          <div className={s.kpis}>
            <div className={s.kpi}>
              <span className={s.kpiLabel}>{t("colGross")}</span>
              <span className={s.kpiValue}>{fmtMoney(total.gross, lang)}</span>
            </div>
            <div className={s.kpi}>
              <span className={s.kpiLabel}>{t("perDay")}</span>
              <span className={s.kpiValue}>{fmtMoney(days.length ? total.gross / days.length : null, lang)}</span>
              <span className={s.kpiSub}>{days.length} {t("days")}</span>
            </div>
            <div className={s.kpi}>
              <span className={s.kpiLabel}>{t("colManHours")}</span>
              <span className={s.kpiValue}>{fmtInt(total.manHours, lang)}</span>
            </div>
            <div className={s.kpi}>
              <span className={s.kpiLabel}>{t("colGrossMh")}</span>
              <span className={s.kpiValue}>{fmtMoney(grossPerManHour(total), lang)}</span>
            </div>
          </div>
          {total.grossMissing > 0 ? <p className={s.warn}>{t("missingNote", { n: total.grossMissing })}</p> : null}
          {total.house > 0 ? <p className={s.hint}>{t("houseNote", { n: total.house })}</p> : null}

          <section className={s.card}>
            <h2 className={s.cardTitle}>{t("byLine")}</h2>
            <div className={s.tableWrap}>
              <table className={s.table}>
                <thead>
                  <tr>
                    <th>{t("colLine")}</th>
                    <th className={s.num}>{t("colEntries")}</th>
                    <th className={s.num}>{t("colFinished")}</th>
                    <th className={s.num}>{t("colManHours")}</th>
                    <th className={s.num}>{t("colGross")}</th>
                    <th className={s.num}>{t("colGrossMh")}</th>
                  </tr>
                </thead>
                <tbody>
                  {lineRows.map(([l, r]) => (
                    <tr key={l}>
                      <td>{t(lineLabelKey(l))}</td>
                      <td className={s.num}>{fmtInt(r.entries, lang)}</td>
                      <td className={s.num}>{fmtInt(r.finished, lang)}</td>
                      <td className={s.num}>{fmtNum(r.manHours, lang, 1)}</td>
                      <td className={s.num}>{fmtMoney(r.gross, lang)}</td>
                      <td className={s.num}>{fmtMoney(grossPerManHour(r), lang)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className={s.card}>
            <h2 className={s.cardTitle}>{t("byDay")}</h2>
            <div className={s.tableWrap}>
              <table className={s.table}>
                <thead>
                  <tr>
                    <th>{t("colDate")}</th>
                    <th className={s.num}>{t("colEntries")}</th>
                    <th className={s.num}>{t("colFinished")}</th>
                    <th className={s.num}>{t("colManHours")}</th>
                    <th className={s.num}>{t("colGross")}</th>
                    <th className={s.num}>{t("colGrossMh")}</th>
                  </tr>
                </thead>
                <tbody>
                  {days.map(([d, r]) => (
                    <tr key={d}>
                      <td><Link href={`/yields?date=${d}`}>{fmtDate(d, lang)}</Link></td>
                      <td className={s.num}>{r.entries}</td>
                      <td className={s.num}>{fmtInt(r.finished, lang)}</td>
                      <td className={s.num}>{fmtNum(r.manHours, lang, 1)}</td>
                      <td className={s.num}>
                        {fmtMoney(r.gross, lang)}
                        {r.grossMissing > 0 ? <span className={s.missingDot}>+{r.grossMissing} {t("missing")}</span> : null}
                      </td>
                      <td className={s.num}>{fmtMoney(grossPerManHour(r), lang)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className={s.card}>
            <h2 className={s.cardTitle}>{t("allEntries")} ({fmtInt(rows.length, lang)})</h2>
            {rows.length > entryRows.length ? (
              <p className={s.hint}>{t("entriesCapped", { shown: entryRows.length, n: rows.length })}</p>
            ) : null}
            <div className={s.tableWrap}>
              <table className={s.table}>
                <thead>
                  <tr>
                    <th>{t("colDate")}</th>
                    <th>{t("colLine")}</th>
                    <th>{t("colProduct")}</th>
                    <th>{t("colSo")}</th>
                    <th className={s.num}>{t("colFinished")}</th>
                    <th className={s.num}>{t("colManHours")}</th>
                    <th className={s.num}>{t("colGrossUnit")}</th>
                    <th className={s.num}>{t("colGross")}</th>
                    <th className={s.num}>{t("colGrossMh")}</th>
                  </tr>
                </thead>
                <tbody>
                  {entryRows.map((r) => (
                    <tr key={r.id}>
                      <td style={{ whiteSpace: "nowrap" }}><Link href={`/yields?date=${r.run_date}`}>{fmtDate(r.run_date, lang)}</Link></td>
                      <td>{t(lineLabelKey(r.line_key))}</td>
                      <td>
                        <span className={s.code}>{r.product_num}</span>
                        <span className={s.sub}>{r.product_name}</span>
                        {r.note ? <span className={s.note}>{r.note}</span> : null}
                      </td>
                      <td className={s.code}>{r.so_numbers.join(", ") || "—"}</td>
                      <td className={s.num}>
                        {fmtInt(r.finished_units, lang)}
                        {r.is_multipack && r.single_units !== null ? (
                          <span className={s.sub}>{fmtInt(r.single_units, lang)} {t("colSingles").toLowerCase()}</span>
                        ) : null}
                      </td>
                      <td className={s.num}>
                        {fmtNum(r.man_hours, lang)}
                        {r.people !== null && r.hours !== null ? (
                          <span className={s.sub}>{fmtNum(r.people, lang)} × {fmtNum(r.hours, lang)}</span>
                        ) : null}
                      </td>
                      <td className={s.num} title={r.gross_source ? t(`source_${r.gross_source}`) : undefined}>
                        {r.gross_source === "house" ? (
                          <span className={s.sub}>{t("houseStock")}</span>
                        ) : r.gross_per_unit === null && r.finished_units > 0 ? (
                          <span className={s.missing}>{t("missing")}</span>
                        ) : (
                          fmtUnitMoney(r.gross_per_unit, lang)
                        )}
                      </td>
                      <td className={s.num}>{fmtMoney(r.gross_total, lang)}</td>
                      <td className={s.num}>{fmtMoney(grossPerManHourOf(r), lang)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </div>
      </main>
    </div>
  );
}
