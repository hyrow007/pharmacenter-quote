import Link from "next/link";
import type { Lang } from "@/lib/i18n/dict";
import { makeYT } from "../_lib/i18n";
import {
  fmtDate,
  fmtInt,
  fmtMoney,
  fmtNum,
  fmtUnitMoney,
  grossPerManHourOf,
  lineLabelKey,
  type YieldEntry,
} from "../_lib/model";
import RowActions from "./RowActions";
import type { SoBalance } from "../_lib/balance";
import s from "../yields.module.css";

// One row per entry, newest first -- the same view as the sheet's Data tab.
// Used on the daily log (recent entries, with edit/delete) and on History
// (any range, read-only; the date links to that day's log for editing).

export function sortEntries(rows: YieldEntry[]): YieldEntry[] {
  return [...rows].sort((a, b) =>
    a.run_date !== b.run_date
      ? a.run_date < b.run_date ? 1 : -1
      : a.line_key.localeCompare(b.line_key) || a.product_num.localeCompare(b.product_num),
  );
}

export default function EntriesTable({
  rows,
  lang,
  canChange,
  balances,
}: {
  rows: YieldEntry[];
  lang: Lang;
  // SO balance per entry id (see _lib/balance.ts); the column shows when given.
  balances?: Map<string, SoBalance>;
  // When given, rows it allows get Edit / Delete.
  canChange?: (r: YieldEntry) => boolean;
}) {
  const t = makeYT(lang);
  return (
    <div className={s.tableWrap}>
      <table className={s.table}>
        <thead>
          <tr>
            <th>{t("colDate")}</th>
            <th>{t("colLine")}</th>
            <th>{t("colProduct")}</th>
            <th>{t("colSo")}</th>
            <th className={s.num}>{t("colFinished")}</th>
            {balances ? <th className={s.num}>{t("colDoneToDate")}</th> : null}
            {balances ? <th className={s.num}>{t("colSoBalance")}</th> : null}
            {balances ? <th className={s.num}>{t("colEcd")}</th> : null}
            <th className={s.num}>{t("colPeople")}</th>
            <th className={s.num}>{t("colManHours")}</th>
            <th className={s.num}>{t("colGrossUnit")}</th>
            <th className={s.num}>{t("colGross")}</th>
            <th className={s.num}>{t("colGrossMh")}</th>
            {canChange ? <th /> : null}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td style={{ whiteSpace: "nowrap" }}>
                <Link href={`/yields?date=${r.run_date}`}>{fmtDate(r.run_date, lang)}</Link>
              </td>
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
              {balances ? <DoneCell b={balances.get(r.id)} lang={lang} /> : null}
              {balances ? <BalanceCell b={balances.get(r.id)} lang={lang} /> : null}
              {balances ? <EcdCell b={balances.get(r.id)} lang={lang} /> : null}
              <td className={s.num}>{fmtNum(r.people, lang)}</td>
              <td className={s.num}>
                {fmtNum(r.man_hours, lang)}
                {r.hours !== null ? <span className={s.sub}>{t("hoursEach", { h: fmtNum(r.hours, lang) })}</span> : null}
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
              {canChange ? (
                <td className={s.actions}>
                  {canChange(r) ? <RowActions id={r.id} date={r.run_date} lang={lang} /> : null}
                </td>
              ) : null}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function BalanceCell({ b, lang }: { b: SoBalance | undefined; lang: Lang }) {
  const t = makeYT(lang);
  if (!b) return <td className={s.num}>—</td>;
  const title = t("balanceTitle", { o: fmtInt(b.ordered, lang), p: fmtInt(b.produced, lang) });
  return (
    <td className={s.num} title={title}>
      {b.balance > 0 ? (
        <>
          {fmtInt(b.balance, lang)}
          <span className={s.sub}>{t("balanceOf", { n: fmtInt(b.ordered, lang) })}</span>
        </>
      ) : b.balance === 0 ? (
        <span className={s.balanceDone}>{t("balanceDone")}</span>
      ) : (
        <>
          <span className={s.balanceOver}>{t("balanceOver", { n: fmtInt(-b.balance, lang) })}</span>
          <span className={s.sub}>{t("balanceOf", { n: fmtInt(b.ordered, lang) })}</span>
        </>
      )}
    </td>
  );
}

// Finished units made so far on this product's sales order(s), through this
// run -- the running yield against the order.
function DoneCell({ b, lang }: { b: SoBalance | undefined; lang: Lang }) {
  const t = makeYT(lang);
  if (!b) return <td className={s.num}>—</td>;
  const pct = b.ordered > 0 ? Math.round((b.produced / b.ordered) * 100) : null;
  return (
    <td className={s.num} title={t("balanceTitle", { o: fmtInt(b.ordered, lang), p: fmtInt(b.produced, lang) })}>
      {fmtInt(b.produced, lang)}
      {pct !== null ? <span className={s.sub}>{t("pctOfOrder", { p: pct })}</span> : null}
    </td>
  );
}

// Estimated completion date at the average of the last two run rates.
function EcdCell({ b, lang }: { b: SoBalance | undefined; lang: Lang }) {
  const t = makeYT(lang);
  if (!b) return <td className={s.num}>—</td>;
  if (b.balance <= 0) return <td className={s.num}><span className={s.balanceDone}>{t("balanceDone")}</span></td>;
  if (!b.ecd) return <td className={s.num}>—</td>;
  return (
    <td className={s.num} style={{ whiteSpace: "nowrap" }} title={t("ecdTitle", { r: fmtInt(b.rate, lang) })}>
      {fmtDate(b.ecd, lang)}
      <span className={s.sub}>{t("ecdDays", { n: b.daysLeft ?? 0 })}</span>
    </td>
  );
}
