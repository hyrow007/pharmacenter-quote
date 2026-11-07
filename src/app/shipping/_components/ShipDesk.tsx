"use client";

import { useRef, useState, useTransition } from "react";
import type { Lang } from "@/lib/i18n/dict";
import { makeST, type SKey } from "../_lib/i18n";
import { APPROVAL_THRESHOLD_USD, type Draft } from "../_lib/draft";
import { CUSTOMS_ITEMS } from "../_lib/customs";
import { submitShipment, type ActionResult } from "../actions";
import s from "../shipping.module.css";

// The assistant and the label it fills in. The conversation lives in this tab
// for one shipment; "Start over" clears it. Confirm is the only way a label is
// made, and it runs a server action that re-checks everything.

type Msg = { role: "user" | "assistant"; text: string };

// Errors with their own sentence in both languages; anything else shows its code.
const KNOWN_ERRORS = new Set([
  "address_not_resolved",
  "fedex_not_configured",
  "duplicate_just_submitted",
  "service_not_offered",
  "international_not_yet",
]);

const money = (n: number | null | undefined, cur = "USD") =>
  n == null ? "—" : n.toLocaleString("en-US", { style: "currency", currency: cur || "USD" });

export default function ShipDesk({ lang }: { lang: Lang }) {
  const t = makeST(lang);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [problems, setProblems] = useState<string[]>([]);
  const [result, setResult] = useState<ActionResult | null>(null);
  const [pending, startTransition] = useTransition();
  const logRef = useRef<HTMLDivElement>(null);

  const scroll = () => requestAnimationFrame(() => logRef.current?.scrollTo({ top: 1e9 }));

  async function send() {
    const text = input.trim();
    if (!text || busy) return;
    const next: Msg[] = [...msgs, { role: "user", text }, { role: "assistant", text: "" }];
    setMsgs(next);
    setInput("");
    setBusy(true);
    setResult(null);
    setStatus(t("thinking"));
    scroll();
    const append = (d: string) =>
      setMsgs((cur) => {
        const c = cur.slice();
        c[c.length - 1] = { role: "assistant", text: c[c.length - 1].text + d };
        return c;
      });
    try {
      const res = await fetch("/api/shipping/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messages: next.slice(0, -1), draft, lang }),
      });
      if (!res.ok || !res.body) throw new Error(`http_${res.status}`);
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          const ev = JSON.parse(line) as { t: string; d?: string; label?: string; draft?: Draft; problems?: string[]; error?: string };
          if (ev.t === "text" && ev.d) {
            append(ev.d);
            setStatus(null);
            scroll();
          } else if (ev.t === "status" && ev.label) setStatus(ev.label);
          else if (ev.t === "draft" && ev.draft) {
            setDraft(ev.draft);
            setProblems(ev.problems ?? []);
          } else if (ev.t === "error") append(`\n\n(${t("chatError")} ${ev.error ?? ""})`);
        }
      }
    } catch {
      append(t("chatError"));
    } finally {
      setBusy(false);
      setStatus(null);
      scroll();
    }
  }

  function reset() {
    setMsgs([]);
    setDraft(null);
    setProblems([]);
    setResult(null);
  }

  function confirm() {
    if (!draft) return;
    startTransition(async () => {
      const r = await submitShipment(draft);
      setResult(r);
      if (r.ok && r.status === "created") window.open(`/api/shipping/labels/${r.id}/pdf`, "_blank");
    });
  }

  // The server validates the address itself on confirm, so that one item
  // does not block the button; everything else does.
  const blocking = problems.filter((p) => p !== "address_not_validated");
  const overLimit =
    draft?.payer !== "recipient" &&
    (((draft?.quotedCurrency ?? "USD").toUpperCase() !== "USD") || (draft?.quotedCost ?? 0) > APPROVAL_THRESHOLD_USD);
  const done = result?.ok && (result.status === "created" || result.status === "pending_approval");
  const r = draft?.recipient;

  return (
    <section className={s.desk}>
      <div className={`${s.panel} ${s.chat}`}>
        <div className={s.log} ref={logRef} aria-live="polite">
          {msgs.map((m, i) => (
            <div key={i} className={m.role === "user" ? s.me : s.bot}>
              {m.text || (busy && i === msgs.length - 1 ? "…" : "")}
            </div>
          ))}
          {status ? <div className={s.status}>{status}</div> : null}
        </div>
        <form
          className={s.compose}
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
        >
          <textarea
            value={input}
            rows={2}
            placeholder={t("chatPlaceholder")}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
            disabled={busy}
          />
          <div className={s.composeBtns}>
            {msgs.length ? (
              <button type="button" className={s.ghost} onClick={reset} disabled={busy}>
                {t("newShipment")}
              </button>
            ) : null}
            <button type="submit" className={s.primary} disabled={busy || !input.trim()}>
              {t("send")}
            </button>
          </div>
        </form>
      </div>

      <div className={`${s.panel} ${s.draft}`}>
        <h2 className={s.h2}>{t("draftTitle")}</h2>
        {!draft ? (
          <p className={s.muted}>{t("draftEmpty")}</p>
        ) : (
          <dl className={s.fields}>
            <dt>{t("to")}</dt>
            <dd>
              <b>{r?.company ?? r?.contactName ?? "—"}</b>
              {r?.company && r.contactName ? <div>{r.contactName}</div> : null}
              {r?.streetLines.map((l, i) => <div key={i}>{l}</div>)}
              <div>
                {[r?.city, r?.stateProvince, r?.postalCode].filter(Boolean).join(", ")} {r?.countryCode}
              </div>
              {r?.phone ? <div className={s.muted}>{r.phone}</div> : null}
              <div className={r?.validated ? s.ok : s.muted}>
                {r?.validated ? t("validated") : t("notValidated")}
                {r?.residential == null ? "" : ` · ${r.residential ? t("residential") : t("business")}`}
              </div>
            </dd>
            <dt>{t("purpose")}</dt>
            <dd>
              {t(`p_${draft.purpose}` as SKey)}
              {draft.purposeNote ? ` — ${draft.purposeNote}` : ""}
              {draft.soNumber ? ` · SO ${draft.soNumber}` : ""}
            </dd>
            <dt>{t("contents")}</dt>
            <dd>{draft.contents || "—"}</dd>
            <dt>{t("packages")}</dt>
            <dd>
              {draft.packages.length
                ? draft.packages.map((p, i) => (
                    <div key={i}>
                      {p.weightLb} lb
                      {p.lengthIn && p.widthIn && p.heightIn ? ` · ${p.lengthIn}×${p.widthIn}×${p.heightIn} in` : ""}
                    </div>
                  ))
                : "—"}
            </dd>
            <dt>{t("service")}</dt>
            <dd>{draft.serviceName ?? draft.serviceType ?? "—"}</dd>
            <dt>{t("billedTo")}</dt>
            <dd>
              {draft.payer === "recipient"
                ? t("billedRecipient", { last4: (draft.payerAccount ?? "").slice(-4) || "?" })
                : t("billedPharma")}
            </dd>
            {draft.signatureRequired || draft.saturdayDelivery ? (
              <>
                <dt>{t("options")}</dt>
                <dd>{[draft.signatureRequired && t("signature"), draft.saturdayDelivery && t("saturday")].filter(Boolean).join(" · ")}</dd>
              </>
            ) : null}
            {draft.customs ? (
              <>
                <dt>{t("customs")}</dt>
                <dd>
                  {draft.customs.documentsOnly ? (
                    <div>{t("customsDocs")}</div>
                  ) : (
                    draft.customs.lines.map((l, i) => (
                      <div key={i}>
                        {l.quantity} × {CUSTOMS_ITEMS[l.item][lang === "es" ? "es" : "en"]}
                        <span className={s.muted}> · HS {CUSTOMS_ITEMS[l.item].hs}</span>
                      </div>
                    ))
                  )}
                  <div className={s.muted}>{t("customsValue", { v: money(draft.customs.declaredValue) })}</div>
                  <div className={s.muted}>{t("customsDuties")}</div>
                  {draft.customs.recipientTaxId ? (
                    <div className={s.muted}>{t("customsTaxId", { id: draft.customs.recipientTaxId })}</div>
                  ) : null}
                </dd>
              </>
            ) : null}
            <dt>{t("quoted")}</dt>
            <dd>
              <span className={s.cost}>{money(draft.quotedCost, draft.quotedCurrency ?? "USD")}</span>
              <div className={s.muted}>{t("quotedNote")}</div>
            </dd>
          </dl>
        )}

        {draft && blocking.length ? (
          <p className={s.missing}>
            {t("missing")}: {blocking.map((p) => t(`m_${p}` as SKey)).join(", ")}
          </p>
        ) : null}

        {draft && !done ? (
          <div className={s.confirm}>
            <button type="button" className={s.primary} onClick={confirm} disabled={pending || busy || blocking.length > 0}>
              {pending ? t("confirming") : overLimit ? t("confirmApproval") : t("confirm")}
            </button>
            <p className={s.muted}>
              {overLimit ? t("confirmHintApproval", { limit: APPROVAL_THRESHOLD_USD }) : t("confirmHint")}
            </p>
          </div>
        ) : null}

        {result ? (
          result.ok ? (
            result.status === "created" ? (
              <p className={s.success}>
                {t("created", { tracking: result.trackingNumber })}{" "}
                <a href={`/api/shipping/labels/${result.id}/pdf`} target="_blank" rel="noreferrer">
                  {t("openPdf")}
                </a>
                {draft?.customs ? (
                  <>
                    {" · "}
                    <a href={`/api/shipping/labels/${result.id}/pdf?doc=invoice`} target="_blank" rel="noreferrer">
                      {t("openInvoice")}
                    </a>
                    <br />
                    {t("customsPrint")}
                  </>
                ) : null}
              </p>
            ) : result.status === "pending_approval" ? (
              <p className={s.success}>{t("pendingMade", { cost: money(result.cost) })}</p>
            ) : null
          ) : (
            <p className={s.warn}>
              {result.error === "incomplete"
                ? `${t("err_problems")} ${(result.problems ?? []).map((p) => t(`m_${p}` as SKey)).join(", ")}`
                : KNOWN_ERRORS.has(result.error)
                  ? t(`err_${result.error}` as SKey)
                  : t("err_generic", { e: `${result.error}${result.detail ? ` — ${result.detail}` : ""}` })}
            </p>
          )
        ) : null}
      </div>
    </section>
  );
}
