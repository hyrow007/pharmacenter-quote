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
import { fillMissingGross, fillMissingPrice } from "./_lib/backfill";
import { isSnapKind, snapRange, type SnapKind } from "./_lib/period";
import Snapshot from "./_components/Snapshot";
import {
  DAY_OPTIONS,
  DEFAULT_DAYS,
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
import EntriesFilter from "./_components/EntriesFilter";
import { soBalances } from "./_lib/balance";
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
  searchParams: Promise<{ date?: string; edit?: string; days?: string; product?: string; snap?: string; sfrom?: string; sto?: string }>;
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
  const dayTotal = byDay.get(date) ?? emptyRollup();

  // Snapshot: one day (default) or a period, relative to the selected date.
  const snapKind: SnapKind = isSnapKind(sp.snap) ? sp.snap : "day";
  let snap = snapRange(snapKind, date, sp.sfrom, sp.sto);
  if (snapKind === "7d") {
    const { data: dateRows } = await supabase
      .from("yield_entries")
      .select("run_date")
      .lte("run_date", date)
      .order("run_date", { ascending: false })
      .limit(300);
    const distinct = Array.from(new Set((dateRows ?? []).map((d) => d.run_date as string)));
    snap = { from: distinct[Math.min(7, distinct.length) - 1] ?? date, to: date };
  }
  const inLoaded = snap.from >= addDays(date, -20) && snap.to <= date;
  const snapRows = inLoaded
    ? rows.filter((r) => r.run_date >= snap.from && r.run_date <= snap.to)
    : (await loadEntries(supabase, { from: snap.from, to: snap.to })).rows;
  if (!inLoaded) await fillMissingGross(supabase, snapRows);
  await fillMissingPrice(supabase, snapRows);
  const keep: Record<string, string> = {};
  for (const k of ["date", "days", "product"] as const) if (sp[k]) keep[k] = sp[k]!;
  const snapHref = (k: SnapKind) => {
    const q = new URLSearchParams(keep);
    if (k !== "day") q.set("snap", k);
    const qs = q.toString();
    return qs ? `?${qs}` : "?";
  };
  // "Every entry": the last N working days (days with entries) up to the
  // selected date -- 10 by default, or all -- optionally one product only.
  const days = (DAY_OPTIONS as readonly string[]).includes(sp.days ?? "") ? sp.days! : DEFAULT_DAYS;
  const product = (sp.product ?? "").trim() || null;
  let listFrom = "2000-01-01";
  if (days !== "all") {
    const n = Number(days);
    const { data: dateRows } = await supabase
      .from("yield_entries")
      .select("run_date")
      .lte("run_date", date)
      .order("run_date", { ascending: false })
      .limit(Math.min(n * 40, 5000));
    const distinct = Array.from(new Set((dateRows ?? []).map((d) => d.run_date as string)));
    listFrom = distinct[Math.min(n, distinct.length) - 1] ?? date;
  }
  const LIST_CAP = 1000;
  const listRes = await loadEntries(supabase, { from: listFrom, to: date, product });
  const known = new Set(rows.map((r) => r.id));
  await fillMissingGross(supabase, listRes.rows.filter((r) => !known.has(r.id)));
  // Rows already on screen above carry any gross just filled in.
  const byId = new Map(rows.map((r) => [r.id, r]));
  const listAll = sortEntries(listRes.rows.map((r) => byId.get(r.id) ?? r));
  const recentRows = listAll.slice(0, LIST_CAP);
  const balances = await soBalances(supabase, recentRows);
  const productName = product ? (listAll[0]?.product_name ?? null) : null;

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

          <Snapshot
            rows={snapRows}
            lang={lang}
            kind={snapKind}
            from={snap.from}
            to={snap.to}
            hrefFor={snapHref}
            hidden={keep}
          />

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
                                `${r.gross_source === "last" ? "≈ " : ""}${fmtUnitMoney(r.gross_per_unit, lang)}`
                              )}
                            </td>
                            <td className={s.num}>{r.gross_source === "last" && r.gross_total !== null ? "≈ " : ""}{fmtMoney(r.gross_total, lang)}</td>
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
                {dayTotal.provisional > 0 ? <p className={s.hint}>{t("provisionalNote", { n: dayTotal.provisional })}</p> : null}
                {dayTotal.house > 0 ? <p className={s.hint}>{t("houseNote", { n: dayTotal.house })}</p> : null}
              </section>

            </div>
          </div>

          <section className={s.card} style={{ marginTop: 20 }}>
            <div className={s.entriesHead} id="entries">
              <h2 className={s.cardTitle}>{t("recentEntries")} ({fmtInt(listAll.length, lang)})</h2>
              <EntriesFilter lang={lang} days={days} product={product} productName={productName} />
            </div>
            {listAll.length > recentRows.length ? (
              <p className={s.hint}>{t("entriesCapped", { shown: recentRows.length, n: listAll.length })}</p>
            ) : null}
            {recentRows.length === 0 ? (
              <p className={s.empty}>{t("noEntries")}</p>
            ) : (
              <EntriesTable rows={recentRows} lang={lang} canChange={canChange} balances={balances} />
            )}
          </section>
        </div>
      </main>
    </div>
  );
}
