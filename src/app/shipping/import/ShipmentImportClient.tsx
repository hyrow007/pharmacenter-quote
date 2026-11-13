"use client";

import { useState, useTransition } from "react";
import type { Lang } from "@/lib/i18n/dict";
import { makeST } from "../_lib/i18n";
import { readXlsxRows } from "../_lib/xlsx";
import { importFedexShipments } from "./shipmentActions";
import s from "../shipping.module.css";

// Upload fedex.com's Ship Manager shipment report. No preview step: the import
// only adds or refreshes a read-only log, keyed on tracking number.

export default function ShipmentImportClient({ lang, status }: { lang: Lang; status: string }) {
  const t = makeST(lang);
  const [fileName, setFileName] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();

  async function onFile(f: File | undefined) {
    setMsg(null);
    if (!f) return;
    setFileName(f.name);
    let table: string[][];
    try {
      table = await readXlsxRows(await f.arrayBuffer());
    } catch {
      setMsg({ ok: false, text: t("shipImpErrFormat") });
      return;
    }
    start(async () => {
      const r = await importFedexShipments(table);
      if (r.ok) setMsg({ ok: true, text: t("shipImpDone", { n: r.total, a: r.added, u: r.updated }) });
      else
        setMsg({
          ok: false,
          text:
            r.error === "not_shipment_report"
              ? t("shipImpErrFormat")
              : r.error === "not_admin"
                ? t("err_not_admin")
                : t("err_generic", { e: r.error }),
        });
    });
  }

  return (
    <section className={`${s.panel} ${s.block}`}>
      <h2 className={s.h2}>{t("shipImpTitle")}</h2>
      <p className={s.muted} style={{ marginBottom: 6 }}>{t("shipImpHow")}</p>
      <p className={s.muted} style={{ marginBottom: 10 }}>{status}</p>
      <label className={s.ghost} style={{ cursor: "pointer" }}>
        {fileName ?? t("shipImpChoose")}
        <input
          type="file"
          accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          style={{ display: "none" }}
          onChange={(e) => {
            void onFile(e.target.files?.[0]);
            e.target.value = "";
          }}
          disabled={pending}
        />
      </label>
      {pending ? <p className={s.muted} style={{ marginTop: 10 }}>{t("shipImpReading")}</p> : null}
      {msg ? <p className={msg.ok ? s.success : s.warn} style={{ marginTop: 10, marginBottom: 0 }}>{msg.text}</p> : null}
    </section>
  );
}
