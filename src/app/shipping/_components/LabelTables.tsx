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

// A shipment made on fedex.com and imported from Ship Manager's report:
// read-only, no PDF or void here (those live on fedex.com).
export type ExternalListRow = {
  id: string;
  master_tracking_number: string;
  piece_tracking_numbers: string[];
  ship_date: string | null;
  service_type: string | null;
  reference: string | null;
  po_number: string | null;
  payment_type: string | null;
  recipient_contact: string | null;
  recipient_company: string | null;
  recipient_city: string | null;
  recipient_state: string | null;
  recipient_country: string | null;
  packages: number | null;
  estimated_cost: number | null;
};

type LogItem = { at: string; app: LabelListRow; ext?: undefined } | { at: string; ext: ExternalListRow; app?: undefined };

const trackUrl = (n: string) => `https://www.fedex.com/fedextrack/?trknbr=${encodeURIComponent(n)}`;

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
  external = [],
}: {
  lang: Lang;
  me: string;
  admin: boolean;
  pending: LabelListRow[];
  recent: LabelListRow[];
  external?: ExternalListRow[];
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

  // One log, newest first: the app's labels and fedex.com shipments together.
  // A tracking number the app already has is not shown twice.
  const appTracking = new Set(recent.map((r) => r.tracking_number).filter(Boolean));
  const log: LogItem[] = [
    ...recent.map((r) => ({ at: r.requested_at, app: r })),
    ...external
      .filter((e) => !appTracking.has(e.master_tracking_number))
      // ship_date is a calendar day; noon Eastern keeps it on the right date.
      .map((e) => ({ at: e.ship_date ? `${e.ship_date}T12:00:00-05:00` : "1970-01-01T00:00:00Z", ext: e })),
  ]
    .sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime())
    .slice(0, 50);
  const day = (d: string | null) =>
    d
      ? new Date(`${d}T12:00:00-05:00`).toLocaleDateString(lang === "es" ? "es-US" : "en-US", {
          timeZone: "America/New_York",
          month: "short",
          day: "numeric",
        })
      : "—";
  const extRow = (e: ExternalListRow) => (
    <tr key={`x-${e.id}`}>
      <td>
        {day(e.ship_date)} <span className={s.srcTag} title={t("srcFedexHint")}>{t("srcFedex")}</span>
      </td>
      <td>
        <b>{e.recipient_company || e.recipient_contact || "—"}</b>
        {e.recipient_company && e.recipient_contact && e.recipient_contact !== e.recipient_company ? (
          <div>{e.recipient_contact}</div>
        ) : null}
        <div className={s.muted}>
          {[e.recipient_city, e.recipient_state, e.recipient_country].filter(Boolean).join(", ")}
        </div>
      </td>
      <td>
        {e.reference || e.po_number ? (
          <>
            {e.reference ? <div>{e.reference}</div> : null}
            {e.po_number ? <div className={s.muted}>PO {e.po_number}</div> : null}
          </>
        ) : (
          <span className={s.muted}>—</span>
        )}
      </td>
      <td>
        {e.service_type ? service(e.service_type) : "—"}
        {e.packages && e.packages > 1 ? <div className={s.muted}>{t("packagesN", { n: e.packages })}</div> : null}
      </td>
      <td className={s.num}>
        {money(e.estimated_cost, "USD")}
        {e.payment_type && e.payment_type !== "SENDER" ? <div className={s.muted}>{t("billedRecipientShort")}</div> : null}
      </td>
      <td className={s.muted}>{t("srcFedex")}</td>
      <td>{t("shippedOn")}</td>
      <td className={s.mono}>{e.master_tracking_number}</td>
      <td className={s.actions}>
        <a className={s.ghostSm} href={trackUrl(e.master_tracking_number)} target="_blank" rel="noreferrer">
          {t("track")}
        </a>
      </td>
    </tr>
  );

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
        <h2 className={s.h2}>{t("recentShipTitle")}</h2>
        {log.length === 0 ? (
          <p className={s.muted}>{t("recentShipNone")}</p>
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
                {log.map((item) => {
                  if (item.ext) return extRow(item.ext);
                  const r = item.app;
                  return (
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
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
