import { redirect } from "next/navigation";
import { headers } from "next/headers";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { isAdmin } from "@/lib/workflows";
import AppHeader from "../_components/AppHeader";
import { getLangFromCookie } from "@/lib/i18n/server";
import { I18nProvider } from "@/lib/i18n/context";
import { makeYT } from "./_lib/i18n";
import { loadEntries } from "./_lib/load";
import { fillMissingGross } from "./_lib/backfill";
import {
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
  lineLabelKey,
  todayInPlant,
  type Rollup,
} from "./_lib/model";
import EntryForm from "./_components/EntryForm";
import RowActions from "./_components/RowActions";
import EntriesTable, { sortEntries } from "./_components/EntriesTable";
import s from "./yields.module.css";

// /yields -- the daily log. Served at yield.pharmacenter.app/ by the host
// rewrite in middleware.ts.
//
// One day at a time (?date=YYYY-MM-DD, default today in Davie): the entry
// form, that day's entries with a day total, and the last seven working days
// for context. ?edit=<id> loads an entry into the form.

export const dynamic = "force-dynamic";
export const metadata = { title: "Yields" };

export default async function YieldsPage({
  searchParams,
}: {
  searchParams: Promise<{ date?: string; edit?: string }>;
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
  const today = todayInPlant();
  const date = isIsoDate(sp.date) ? sp.date : today;
  const admin = await isAdmin(supabase, user.email);

  // The selected day plus the fortnight before it, in one read.
  const { rows, error } = await loadEntries(supabase, { from: addDays(date, -20), to: date });
  // Entries whose sales order has shipped since they were logged get their
  // gross from Fishbowl now (see _lib/backfill.ts).
  await fillMissingGross(supabase, rows);
  const dayRows = rows.filter((r) => r.run_date === date);
  const editing = sp.edit ? (rows.find((r) => r.id === sp.edit) ?? null) : null;

  const byDay = new Map<string, Rollup>();
  for (const r of rows) byDay.set(r.run_date, addToRollup(byDay.get(r.run_date) ?? emptyRollup(), r));
  const week = [...byDay.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1)).slice(0, 7);
  const dayTotal = byDay.get(date) ?? emptyRollup();
  // Every individual entry on those working days, newest first.
  const weekDays = new Set(week.map(([d]) => d));
  const recentRows = sortEntries(rows.filter((r) => weekDays.has(r.run_date)));

  const canChange = (r: (typeof rows)[number]) =>
    admin || (r.source === "app" && r.created_by === user.email);

  return (
    <div className="app-shell">
      <AppHeader user={{ email: user.email! }} appContext="yields" />
      <main className="page">
        <div className="page__inner">
          <div style={{ marginBottom: 20 }}>
            <p className="eyebrow" style={{ marginBottom: 6 }}>{t("eyebrow")}</p>
            <h1 className="page-header__title" style={{ marginBottom: 6 }}>{t("title")}</h1>
            <p className="lede" style={{ marginTop: 4, marginBottom: 0 }}>{t("lede")}</p>
          </div>

          <nav className={s.dayNav} aria-label={t("day")}>
            <Link href={`?date=${addDays(date, -1)}`} className={s.dayNavLink}>{t("prevDay")}</Link>
            <form method="get" className={s.dayPick}>
              <input type="date" name="date" defaultValue={date} className={s.input} aria-label={t("day")} />
              <button type="submit" className="btn-chrome">{t("apply")}</button>
            </form>
            <span className={s.dayTitle}>{fmtDate(date, lang)}</span>
            {date !== today ? <Link href="?" className={s.dayNavLink}>{t("today")}</Link> : null}
            <Link href={`?date=${addDays(date, 1)}`} className={s.dayNavLink}>{t("nextDay")}</Link>
          </nav>

          {error ? <p className={s.error} role="alert">{error}</p> : null}

          <div className={s.layout}>
            <section className={s.card}>
              <h2 className={s.cardTitle}>{editing ? t("editHeading") : t("formHeading")}</h2>
              <I18nProvider lang={lang}>
                <EntryForm key={editing?.id ?? date} lang={lang} date={date} editing={editing} />
              </I18nProvider>
            </section>

            <div className={s.stack}>
              <section className={s.card}>
                <h2 className={s.cardTitle}>{fmtDate(date, lang)}</h2>
                {dayRows.length === 0 ? (
                  <p className={s.empty}>{t("noEntries")}</p>
                ) : (
                  <div className={s.tableWrap}>
                    <table className={s.table}>
                      <thead>
                        <tr>
                          <th>{t("colLine")}</th>
                          <th>{t("colProduct")}</th>
                          <th>{t("colSo")}</th>
                          <th className={s.num}>{t("colFinished")}</th>
                          <th className={s.num}>{t("colManHours")}</th>
                          <th className={s.num}>{t("colGrossUnit")}</th>
                          <th className={s.num}>{t("colGross")}</th>
                          <th className={s.num}>{t("colGrossMh")}</th>
                          <th />
                        </tr>
                      </thead>
                      <tbody>
                        {dayRows.map((r) => (
                          <tr key={r.id}>
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
                            <td className={s.actions}>
                              {canChange(r) ? <RowActions id={r.id} date={date} lang={lang} /> : null}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                      <tfoot>
                        <tr>
                          <td colSpan={3}>{t("dayTotal")}</td>
                          <td className={s.num}>{fmtInt(dayTotal.finished, lang)}</td>
                          <td className={s.num}>{fmtNum(dayTotal.manHours, lang)}</td>
                          <td />
                          <td className={s.num}>{fmtMoney(dayTotal.gross, lang)}</td>
                          <td className={s.num}>{fmtMoney(grossPerManHour(dayTotal), lang)}</td>
                          <td />
                        </tr>
                      </tfoot>
                    </table>
                  </div>
                )}
                {dayTotal.grossMissing > 0 ? (
                  <p className={s.warn}>{t("missingNote", { n: dayTotal.grossMissing })}</p>
                ) : null}
                {dayTotal.house > 0 ? <p className={s.hint}>{t("houseNote", { n: dayTotal.house })}</p> : null}
              </section>

              <section className={s.card}>
                <h2 className={s.cardTitle}>{t("weekHeading")}</h2>
                <div className={s.tableWrap}>
                  <table className={s.table}>
                    <thead>
                      <tr>
                        <th>{t("colDate")}</th>
                        <th className={s.num}>{t("colEntries")}</th>
                        <th className={s.num}>{t("colManHours")}</th>
                        <th className={s.num}>{t("colGross")}</th>
                        <th className={s.num}>{t("colGrossMh")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {week.map(([d, r]) => (
                        <tr key={d} className={d === date ? s.current : undefined}>
                          <td><Link href={`?date=${d}`}>{fmtDate(d, lang)}</Link></td>
                          <td className={s.num}>{r.entries}</td>
                          <td className={s.num}>{fmtNum(r.manHours, lang)}</td>
                          <td className={s.num}>
                            {fmtMoney(r.gross, lang)}
                            {r.grossMissing > 0 ? <span className={s.missingDot} title={t("missingNote", { n: r.grossMissing })}>+{r.grossMissing} {t("missing")}</span> : null}
                          </td>
                          <td className={s.num}>{fmtMoney(grossPerManHour(r), lang)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            </div>
          </div>

          <section className={s.card} style={{ marginTop: 20 }}>
            <h2 className={s.cardTitle}>{t("recentEntries")} ({recentRows.length})</h2>
            {recentRows.length === 0 ? (
              <p className={s.empty}>{t("noEntries")}</p>
            ) : (
              <EntriesTable rows={recentRows} lang={lang} canChange={canChange} />
            )}
          </section>
        </div>
      </main>
    </div>
  );
}
