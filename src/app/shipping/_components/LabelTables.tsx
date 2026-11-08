"use client";

import { useState, useTransition } from "react";
import type { Lang } from "@/lib/i18n/dict";
import { makeST, type SKey } from "../_lib/i18n";
import { approveShipment, rejectShipment, voidShipment, type ActionResult } from "../actions";
import s from "../shipping.module.css";

// Waiting for approval (admins act; everyone sees) and the recent label log,
// with reprint and void. Every button calls a server action that re-checks
// who is asking and whether the row is still in the state it shows.

export type LabelListRow = {
  id: string;
  environment: "sandbox" | "live";
  status: string;
  purpose: string;
  so_number: string | null;
  recipient_snapshot: { company?: string | null; contactName?: string | null; city?: string; stateProvince?: string | null; countryCode?: string };
  contents: string;
  service_type: string;
  rated_cost: number | null;
  rated_currency: string | null;
  requested_by: string;
  requested_at: string;
  approval_required: boolean;
  approved_by: string | null;
  decision_note: string | null;
  tracking_number: string | null;
  label_path: string | null;
  invoice_path: string | null;
  fedex_error: { error?: string; detail?: string | null; invoice?: string } | null;
};

const money = (n: number | null, cur: string | null) =>
  n == null ? "—" : n.toLocaleString("en-US", { style: "currency", currency: cur || "USD" });
const when = (iso: string, lang: Lang) =>
  new Date(iso).toLocaleString(lang === "es" ? "es-US" : "en-US", {
    timeZone: "America/New_York",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
const who = (email: string) => email.replace(/@pharmacenterusa\.com$/, "");
const service = (code: string) =>
  code
    .replace(/^FEDEX_/, "")
    .split("_")
    .map((w) => w.charAt(0) + w.slice(1).toLowerCase())
    .join(" ");

export default function LabelTables({
  lang,
  me,
  admin,
  pending,
  recent,
}: {
  lang: Lang;
  me: string;
  admin: boolean;
  pending: LabelListRow[];
  recent: LabelListRow[];
}) {
  const t = makeST(lang);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [, start] = useTransition();

  const run = (id: string, fn: () => Promise<ActionResult>) => {
    setBusyId(id);
    setMsg(null);
    start(async () => {
      const r = await fn();
      setBusyId(null);
      if (!r.ok)
        setMsg(
          r.error === "not_admin"
            ? t("err_not_admin")
            : r.error === "changed"
              ? t("err_changed")
              : t("err_generic", { e: `${r.error}${r.detail ? ` — ${r.detail}` : ""}` }),
        );
      else if (r.status === "created") window.open(`/api/shipping/labels/${r.id}/pdf`, "_blank");
    });
  };

  const to = (r: LabelListRow) => {
    const x = r.recipient_snapshot ?? {};
    return (
      <>
        <b>{x.company ?? x.contactName ?? "—"}</b>
        <div className={s.muted}>{[x.city, x.stateProvince, x.countryCode].filter(Boolean).join(", ")}</div>
      </>
    );
  };
  const purpose = (r: LabelListRow) => (
    <>
      {t(`p_${r.purpose}` as SKey)}
      {r.so_number ? <div className={s.muted}>SO {r.so_number}</div> : null}
    </>
  );
  const test = (r: LabelListRow) => (r.environment === "sandbox" ? <span className={s.testTag}>{t("test")}</span> : null);

  return (
    <>
      {msg ? <p className={s.warn}>{msg}</p> : null}

      <section className={`${s.panel} ${s.block}`}>
        <h2 className={s.h2}>{t("pendingTitle")}</h2>
        {pending.length === 0 ? (
          <p className={s.muted}>{t("pendingNone")}</p>
        ) : (
          <div className={s.tableWrap}>
            <table className={s.table}>
              <thead>
                <tr>
                  <th>{t("colWhen")}</th>
                  <th>{t("colTo")}</th>
                  <th>{t("colPurpose")}</th>
                  <th>{t("colService")}</th>
                  <th className={s.num}>{t("colCost")}</th>
                  <th>{t("colBy")}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {pending.map((r) => (
                  <tr key={r.id}>
                    <td>{when(r.requested_at, lang)} {test(r)}</td>
                    <td>{to(r)}</td>
                    <td>{purpose(r)}<div className={s.muted}>{r.contents}</div></td>
                    <td>{service(r.service_type)}</td>
                    <td className={s.num}>{money(r.rated_cost, r.rated_currency)}</td>
                    <td>{who(r.requested_by)}</td>
                    <td className={s.actions}>
                      {admin ? (
                        <>
                          <button
                            type="button"
                            className={s.primarySm}
                            disabled={busyId === r.id}
                            onClick={() => run(r.id, () => approveShipment(r.id))}
                          >
                            {t("approve")}
                          </button>
                          <button
                            type="button"
                            className={s.ghostSm}
                            disabled={busyId === r.id}
                            onClick={() => {
                              const note = window.prompt(t("rejectNote")) ?? null;
                              run(r.id, () => rejectShipment(r.id, note));
                            }}
                          >
                            {t("reject")}
                          </button>
                        </>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className={`${s.panel} ${s.block}`}>
        <h2 className={s.h2}>{t("recentTitle")}</h2>
        {recent.length === 0 ? (
          <p className={s.muted}>{t("recentNone")}</p>
        ) : (
          <div className={s.tableWrap}>
            <table className={s.table}>
              <thead>
                <tr>
                  <th>{t("colWhen")}</th>
                  <th>{t("colTo")}</th>
                  <th>{t("colPurpose")}</th>
                  <th>{t("colService")}</th>
                  <th className={s.num}>{t("colCost")}</th>
                  <th>{t("colBy")}</th>
                  <th>{t("colStatus")}</th>
                  <th>{t("colTracking")}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {recent.map((r) => (
                  <tr key={r.id} className={r.status === "voided" || r.status === "rejected" ? s.dim : undefined}>
                    <td>{when(r.requested_at, lang)} {test(r)}</td>
                    <td>{to(r)}</td>
                    <td>{purpose(r)}</td>
                    <td>{service(r.service_type)}</td>
                    <td className={s.num}>{money(r.rated_cost, r.rated_currency)}</td>
                    <td>
                      {who(r.requested_by)}
                      {r.approval_required && r.approved_by ? <div className={s.muted}>✓ {who(r.approved_by)}</div> : null}
                    </td>
                    <td>
                      {t(`st_${r.status}` as SKey)}
                      {r.status === "failed" && r.fedex_error?.error ? <div className={s.muted}>{r.fedex_error.error}</div> : null}
                      {r.status === "created" && r.fedex_error?.invoice ? (
                        <div className={s.missing}>{t("invoiceMissing")}</div>
                      ) : null}
                      {r.status === "rejected" && r.decision_note ? <div className={s.muted}>{r.decision_note}</div> : null}
                    </td>
                    <td className={s.mono}>{r.tracking_number ?? "—"}</td>
                    <td className={s.actions}>
                      {r.label_path && r.status === "created" ? (
                        <a className={s.ghostSm} href={`/api/shipping/labels/${r.id}/pdf`} target="_blank" rel="noreferrer">
                          {t("reprint")}
                        </a>
                      ) : null}
                      {r.invoice_path && r.status === "created" ? (
                        <a className={s.ghostSm} href={`/api/shipping/labels/${r.id}/pdf?doc=invoice`} target="_blank" rel="noreferrer">
                          {t("invoice")}
                        </a>
                      ) : null}
                      {r.status === "created" && (admin || r.requested_by === me) ? (
                        <button
                          type="button"
                          className={s.ghostSm}
                          disabled={busyId === r.id}
                          onClick={() => {
                            if (window.confirm(t("voidConfirm"))) run(r.id, () => voidShipment(r.id));
                          }}
                        >
                          {t("void")}
                        </button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
