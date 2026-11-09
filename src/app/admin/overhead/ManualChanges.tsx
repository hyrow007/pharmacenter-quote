import type { CSSProperties, ReactNode } from "react";
import type { OT } from "./_lib/i18n";
import type { OverheadData, Resolved } from "./_lib/load";
import type { ManualData, ManualProposal } from "./_lib/loadManual";
import { manualDecide, manualProposeBand, manualProposeLead, manualProposeShare } from "./actions";

// Hand-made changes on /admin/overhead (2026-11-08): the queue, and the three
// forms (item band, lead time, share). All writes go through
// overhead_manual_propose / overhead_manual_decide. Approve and Reject are
// separate forms with hidden verdicts — never a name/value on the button.

type Fmt = { t: OT; money: (v: number) => string; day: (iso: string | null) => string; when: (iso: string) => string };

// ------------------------------------------------------------------ queue

export function ManualQueue({ m, outcome, t, money, day, when }: { m: ManualData; outcome: { man?: string; d?: string } } & Fmt) {
  const banner = (() => {
    switch (outcome.man) {
      case "proposed":
        return <Note tone="good">{t("mrProposed")}</Note>;
      case "approved":
        return <Note tone="good">{t("mrApproved")}</Note>;
      case "rejected":
        return <Note tone="good">{t("mrRejected")}</Note>;
      case "stale":
        return <Note tone="warn">{t("mrStale")}</Note>;
      case "error":
        return <Note tone="bad">{t("mrError", { detail: outcome.d ?? "" })}</Note>;
      default:
        return null;
    }
  })();
  return (
    <section id="changes" style={{ margin: "0 0 26px" }}>
      <h2 style={h2}>{t("mTitle")}</h2>
      <p style={note}>{t("mLede")}</p>
      {banner}
      {!m.migrated ? <Note tone="warn">{t("mMigrate", { detail: m.error ?? "" })}</Note> : null}
      {m.pending.length ? (
        <>
          <h3 style={h3}>{t("mWaiting")}</h3>
          {m.pending.map((p) => (
            <div key={p.id} style={card}>
              <Describe p={p} t={t} money={money} day={day} when={when} />
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", marginTop: 8 }}>
                <form action={manualDecide} style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", flex: "1 1 320px" }}>
                  <input type="hidden" name="id" value={p.id} />
                  <input type="hidden" name="verdict" value="approve" />
                  <input name="note" placeholder={t("capNote")} maxLength={2000} style={{ flex: "1 1 220px", minWidth: 0, padding: "6px 8px", fontSize: 13 }} />
                  <button type="submit" className="button-primary">{t("mApprove")}</button>
                </form>
                <form action={manualDecide}>
                  <input type="hidden" name="id" value={p.id} />
                  <input type="hidden" name="verdict" value="reject" />
                  <button type="submit" style={secondaryBtn}>{t("capReject")}</button>
                </form>
              </div>
            </div>
          ))}
        </>
      ) : m.migrated ? (
        <p style={note}>{t("mNone")}</p>
      ) : null}
      {m.recent.length ? (
        <details>
          <summary style={{ cursor: "pointer", fontSize: 13 }}>{t("mRecent", { n: m.recent.length })}</summary>
          {m.recent.map((p) => (
            <div key={p.id} style={{ ...card, opacity: 0.85 }}>
              <Describe p={p} t={t} money={money} day={day} when={when} />
              <div style={dim}>
                {t("mDecided", {
                  status: t(p.status === "approved" ? "stApproved" : p.status === "rejected" ? "stRejected" : "stSuperseded"),
                  who: p.decidedBy ?? "",
                  when: p.decidedAt ? when(p.decidedAt) : "",
                })}
                {p.decisionNote ? ` · ${p.decisionNote}` : ""}
              </div>
            </div>
          ))}
        </details>
      ) : null}
    </section>
  );
}

const FIELD_LABEL: Record<string, Parameters<OT>[0]> = {
  monthly: "fMonthly",
  cam: "fCam",
  cam_estimated: "fCamEst",
  pay_type: "fPayType",
  rate: "fRate",
  qty: "fQty",
  hours: "fHours",
  tax_pct: "fTax",
  wc_pct: "fWc",
};

function Describe({ p, t, money, day, when }: { p: ManualProposal } & Fmt) {
  const show = (k: string, v: unknown): string => {
    if (v === null || v === undefined) return t("none");
    if (k === "cam_estimated") return v ? "✓" : "✗";
    if (k === "pay_type") return t(v === "salary" ? "fSalary" : "fHourly");
    if (["monthly", "cam", "rate"].includes(k)) return money(Number(v));
    return String(v);
  };
  let body: ReactNode;
  if (p.kind === "band") {
    const diff = p.monthlyBefore !== null && p.monthlyAfter !== null ? p.monthlyAfter - p.monthlyBefore : null;
    const sign = diff !== null && diff > 0 ? "+" : "";
    const pct = diff !== null && p.monthlyBefore ? ` ${sign}${((diff / p.monthlyBefore) * 100).toFixed(1)}%` : "";
    body = (
      <>
        <div>
          <strong>{p.label}</strong> · {t("mFrom", { date: day(p.effectiveFrom) })}
        </div>
        <ul style={{ margin: "4px 0", paddingLeft: 18 }}>
          {Object.keys(p.proposed).map((k) => (
            <li key={k}>
              {k === "monthly" && p.current.group_key === "rent" ? t("fMonthlyRent") : t(FIELD_LABEL[k] ?? "none")}: {show(k, p.current[k])} → <strong>{show(k, p.proposed[k])}</strong>
            </li>
          ))}
        </ul>
        {diff !== null ? (
          <div style={{ fontFamily: "var(--mono, monospace)" }}>
            {t("mPerMonth", { before: money(p.monthlyBefore!), after: money(p.monthlyAfter!), diff: `${sign}${money(diff)}${pct}` })}
          </div>
        ) : null}
        <div style={dim}>{t("mBandNote", { from: day(p.bandFrom), to: day(p.bandTo) })}</div>
      </>
    );
  } else if (p.kind === "lead_days") {
    body = (
      <div>
        <strong>{t("mLead")}</strong>: {t("mLeadVal", { before: String(p.current.days ?? "—"), after: String(p.proposed.days) })}
      </div>
    );
  } else {
    body = (
      <>
        <div>
          <strong>{p.label}</strong> · {t("mShare", { line: p.lineKey ?? "" })}: {t("mShareVal", { before: String(p.current.share_pct ?? 0), after: String(p.proposed.share_pct) })}
        </div>
        <div style={dim}>{t("mShareNote")}</div>
      </>
    );
  }
  return (
    <div style={{ fontSize: 13.5, lineHeight: 1.5 }}>
      {body}
      {p.sourceDoc ? <div style={dim}>{t("mSource", { v: p.sourceDoc })}</div> : null}
      {p.reason ? <div style={dim}>{t("mReason", { v: p.reason })}</div> : null}
      <div style={dim}>{t("mBy", { who: p.createdBy, when: when(p.createdAt) })}</div>
    </div>
  );
}

// ------------------------------------------------------------------ forms

/** "Change…" under one item row. Blank boxes keep the figure; placeholders show today's. */
export function EditItem({ r, today, t }: { r: Resolved; today: string; t: OT }) {
  const field = (name: string, label: Parameters<OT>[0], cur: number | null, step = "0.01") => (
    <label style={lbl}>
      <span>{t(label)}</span>
      <input name={name} type="number" step={step} min="0" placeholder={cur === null ? "" : String(cur)} style={inp} />
    </label>
  );
  return (
    <details style={{ marginTop: 4 }}>
      <summary style={{ cursor: "pointer", fontSize: 12, color: "var(--teal, #0f4a56)" }}>{t("mChange")}</summary>
      <form action={manualProposeBand} style={{ display: "grid", gap: 6, marginTop: 6, maxWidth: 420 }}>
        <input type="hidden" name="item" value={r.itemKey} />
        <label style={lbl}>
          <span>{t("mStarts")}</span>
          <input name="from" type="date" required defaultValue={today} style={inp} />
        </label>
        {r.group === "rent" ? (
          <>
            {field("monthly", "fMonthlyRent", r.monthly)}
            {field("cam", "fCam", r.cam)}
            <input type="hidden" name="cam_estimated_set" value="1" />
            <label style={{ ...lbl, flexDirection: "row", alignItems: "center", gap: 6 }}>
              <input name="cam_estimated" type="checkbox" defaultChecked={r.camEstimated} />
              <span>{t("fCamEst")}</span>
            </label>
          </>
        ) : r.group === "indirect" ? (
          <>
            <label style={lbl}>
              <span>{t("fPayType")}</span>
              <select name="pay_type" defaultValue="" style={inp}>
                <option value="">{t(r.payType === "salary" ? "fSalary" : "fHourly")}</option>
                <option value="hourly">{t("fHourly")}</option>
                <option value="salary">{t("fSalary")}</option>
              </select>
            </label>
            {field("rate", "fRate", r.rate)}
            {field("qty", "fQty", r.qty, "1")}
            {field("hours", "fHours", r.hours)}
            {field("tax_pct", "fTax", r.taxPct)}
            {field("wc_pct", "fWc", r.wcPct)}
          </>
        ) : (
          field("monthly", "fMonthly", r.monthly)
        )}
        <p style={{ ...dim, margin: 0 }}>{t("mBlankKeeps")}</p>
        <input name="source" placeholder={t("mSourceIn")} maxLength={300} style={inp} />
        <input name="reason" placeholder={t("mReasonIn")} maxLength={2000} style={inp} />
        <div>
          <button type="submit" style={secondaryBtn}>{t("mPropose")}</button>
        </div>
      </form>
    </details>
  );
}

export function LeadForm({ leadDays, t }: { leadDays: number | null; t: OT }) {
  return (
    <details style={{ margin: "4px 0 0" }}>
      <summary style={{ cursor: "pointer", fontSize: 12.5, color: "var(--teal, #0f4a56)" }}>{t("mLeadTitle")}</summary>
      <form action={manualProposeLead} style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "end", marginTop: 6 }}>
        <label style={lbl}>
          <span>{t("mLeadDays")}</span>
          <input name="days" type="number" min="0" max="365" step="1" required placeholder={leadDays === null ? "" : String(leadDays)} style={{ ...inp, width: 90 }} />
        </label>
        <input name="reason" placeholder={t("mReasonIn")} maxLength={2000} style={{ ...inp, flex: "1 1 200px" }} />
        <button type="submit" style={secondaryBtn}>{t("mPropose")}</button>
      </form>
    </details>
  );
}

export function ShareForm({ data, t }: { data: OverheadData; t: OT }) {
  return (
    <details style={{ margin: "8px 0 0" }}>
      <summary style={{ cursor: "pointer", fontSize: 13, color: "var(--teal, #0f4a56)" }}>{t("mShareTitle")}</summary>
      <p style={{ ...dim, margin: "4px 0" }}>{t("mShareNote")}</p>
      <form action={manualProposeShare} style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "end" }}>
        <label style={lbl}>
          <span>{t("mLine")}</span>
          <select name="line" required style={inp}>
            {data.lines.map((l) => (
              <option key={l} value={l}>{l}</option>
            ))}
          </select>
        </label>
        <label style={lbl}>
          <span>{t("mItem")}</span>
          <select name="item" required style={inp}>
            {data.quote.map((r) => (
              <option key={r.itemKey} value={r.itemKey}>{r.label}</option>
            ))}
          </select>
        </label>
        <label style={lbl}>
          <span>{t("mPct")}</span>
          <input name="share" type="number" min="0" max="100" step="0.01" required style={{ ...inp, width: 90 }} />
        </label>
        <input name="reason" placeholder={t("mReasonIn")} maxLength={2000} style={{ ...inp, flex: "1 1 200px" }} />
        <button type="submit" style={secondaryBtn}>{t("mPropose")}</button>
      </form>
    </details>
  );
}

// ------------------------------------------------------------------ styles

function Note({ tone, children }: { tone: "bad" | "warn" | "good"; children: ReactNode }) {
  const color = tone === "bad" ? "#9b2c2c" : tone === "warn" ? "#8a5a00" : "#3f6b1f";
  return (
    <div role="status" style={{ border: `1px solid ${color}`, color, borderRadius: 8, padding: "10px 12px", margin: "0 0 14px", fontSize: 13.5, lineHeight: 1.5 }}>
      {children}
    </div>
  );
}

const h2: CSSProperties = { margin: "0 0 8px", fontSize: 15, fontWeight: 700 };
const h3: CSSProperties = { margin: "10px 0 6px", fontSize: 13.5, fontWeight: 700 };
const note: CSSProperties = { margin: "0 0 10px", fontSize: 12.5, color: "var(--ink-3, #8a9498)", lineHeight: 1.5 };
const dim: CSSProperties = { fontSize: 12, color: "var(--ink-3, #8a9498)" };
const card: CSSProperties = { border: "1px solid var(--stone, #e3dcc9)", borderRadius: 8, padding: "10px 12px", margin: "0 0 10px", background: "var(--paper, #fffdf8)" };
const lbl: CSSProperties = { display: "flex", flexDirection: "column", gap: 2, fontSize: 12, color: "var(--ink-2, #4a5559)" };
const inp: CSSProperties = { padding: "5px 8px", fontSize: 13, minWidth: 0 };
const secondaryBtn: CSSProperties = { padding: "7px 14px", fontSize: 13, fontWeight: 600, borderRadius: 8, border: "1px solid var(--stone, #e3dcc9)", background: "transparent", color: "var(--teal, #0f4a56)", cursor: "pointer" };
