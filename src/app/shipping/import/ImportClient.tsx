"use client";

import { useState, useTransition } from "react";
import type { Lang } from "@/lib/i18n/dict";
import { makeST, type SKey } from "../_lib/i18n";
import { RECIPIENT_KINDS, type RecipientKind } from "../_lib/draft";
import type { ImportRow } from "../_lib/fedexCsv";
import { previewImport, commitImport } from "./actions";
import s from "../shipping.module.css";

export default function ImportClient({ lang }: { lang: Lang }) {
  const t = makeST(lang);
  const [csv, setCsv] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [rows, setRows] = useState<ImportRow[] | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();

  const err = (e: string) =>
    t(
      e === "not_fedex_export" ? "impErrFormat" : e === "not_admin" ? "err_not_admin" : "err_generic",
      { e },
    );

  async function onFile(f: File | undefined) {
    setMsg(null);
    setRows(null);
    if (!f) return;
    const text = await f.text();
    setCsv(text);
    setFileName(f.name);
    start(async () => {
      const r = await previewImport(text);
      if (r.ok) setRows(r.rows);
      else setMsg({ ok: false, text: err(r.error) });
    });
  }

  function update(key: string, patch: Partial<Pick<ImportRow, "include" | "kind">>) {
    setRows((cur) => (cur ? cur.map((r) => (r.key === key ? { ...r, ...patch } : r)) : cur));
  }

  function commit() {
    if (!csv || !rows) return;
    start(async () => {
      const r = await commitImport(
        csv,
        rows.map((x) => ({ key: x.key, include: x.include, kind: x.kind })),
      );
      if (r.ok) {
        setMsg({ ok: true, text: t("impDone", { n: r.inserted, s: r.skipped }) });
        setRows(null);
        setCsv(null);
      } else setMsg({ ok: false, text: err(r.error) });
    });
  }

  const chosen = rows?.filter((r) => r.include).length ?? 0;
  const dupes = rows?.filter((r) => r.duplicateOf).length ?? 0;

  return (
    <>
      <section className={`${s.panel} ${s.block}`}>
        <h2 className={s.h2}>{t("impStep1")}</h2>
        <p className={s.muted} style={{ marginBottom: 10 }}>{t("impHow")}</p>
        <label className={s.ghost} style={{ cursor: "pointer" }}>
          {fileName ?? t("impChoose")}
          <input
            type="file"
            accept=".csv,text/csv"
            style={{ display: "none" }}
            onChange={(e) => void onFile(e.target.files?.[0])}
            disabled={pending}
          />
        </label>
        {pending && !rows ? <p className={s.muted} style={{ marginTop: 10 }}>{t("confirming")}</p> : null}
      </section>

      {msg ? <p className={msg.ok ? s.success : s.warn} style={{ marginBottom: 16 }}>{msg.text}</p> : null}

      {rows ? (
        <section className={`${s.panel} ${s.block}`}>
          <h2 className={s.h2}>{t("impStep2")}</h2>
          <p className={s.muted} style={{ marginBottom: 12 }}>
            {t("impSummary", { n: rows.length, c: chosen, d: dupes })}
          </p>
          <div className={s.tableWrap}>
            <table className={s.table}>
              <thead>
                <tr>
                  <th />
                  <th>{t("colTo")}</th>
                  <th>{t("impAddress")}</th>
                  <th>{t("impKind")}</th>
                  <th>{t("impNotes")}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.key} className={r.include ? undefined : s.dim}>
                    <td>
                      <input
                        type="checkbox"
                        checked={r.include}
                        disabled={!!r.duplicateOf || r.problems.length > 0}
                        onChange={(e) => update(r.key, { include: e.target.checked })}
                        aria-label={t("impInclude")}
                      />
                    </td>
                    <td>
                      <b>{r.company ?? r.contactName}</b>
                      {r.company && r.contactName ? <div>{r.contactName}</div> : null}
                      <div className={s.muted}>
                        {r.phone}
                        {r.phoneNote === "placeholder" ? ` · ${t("impPhonePlaceholder")}` : ""}
                        {r.phoneNote === "pharmacenter" ? ` · ${t("impPhoneOwn")}` : ""}
                      </div>
                    </td>
                    <td>
                      {r.streetLines.map((l, i) => <div key={i}>{l}</div>)}
                      <div>{[r.city, r.stateProvince, r.postalCode].filter(Boolean).join(", ")} {r.countryCode}</div>
                    </td>
                    <td>
                      <select
                        value={r.kind}
                        onChange={(e) => update(r.key, { kind: e.target.value as RecipientKind })}
                        disabled={!r.include}
                      >
                        {RECIPIENT_KINDS.map((k) => (
                          <option key={k} value={k}>{t(`k_${k}` as SKey)}</option>
                        ))}
                      </select>
                      <div className={s.muted}>{r.kindReason}</div>
                    </td>
                    <td className={s.muted}>
                      {r.duplicateOf ? <div><b>{t("impDup")}</b></div> : null}
                      {r.problems.length ? <div><b>{t("missing")}: {r.problems.join(", ")}</b></div> : null}
                      {r.billToAccount ? <div>{t("impBillsRecipient", { last4: r.billToAccount.slice(-4) })}</div> : null}
                      {r.residential === true ? <div>{t("residential")}</div> : null}
                      {r.notes ? <div>{r.notes}</div> : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className={s.confirm} style={{ marginTop: 14 }}>
            <button type="button" className={s.primary} onClick={commit} disabled={pending || chosen === 0}>
              {pending ? t("confirming") : t("impGo", { n: chosen })}
            </button>
          </div>
        </section>
      ) : null}
    </>
  );
}
