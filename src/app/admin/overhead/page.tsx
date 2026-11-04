import { redirect } from "next/navigation";
import { headers } from "next/headers";
import type { CSSProperties, ReactNode } from "react";
import { createClient } from "@/lib/supabase/server";
import { isAdmin as checkIsAdmin } from "@/lib/workflows";
import { HUB_HOSTS } from "@/lib/hub-hosts";
import { getLangFromCookie } from "@/lib/i18n/server";
import { overheadRowMonthly, type OverheadGroupMode } from "@/lib/bottleCosting";
import AppHeader from "../../_components/AppHeader";
import { loadCapacity, loadOverhead, type Band, type CapacityData, type Group, type OverheadData, type Proposal, type Resolved } from "./_lib/load";
import { decide, measureNow } from "./actions";
import { makeOT, type OT } from "./_lib/i18n";

// /admin/overhead — the plant's overhead figures, read-only.
//
// Shows what every quote is costed against, on two dates side by side —
// today, and the quote date (today + quote_lead_days), which is what the
// boards actually use. The one thing it writes is the Contract Packaging
// run-day divisor, measured from Yields and applied only on approval
// (see migration 20261103200000 and claude/overhead.md).
//
// Money comes from overheadRowMonthly() in lib/bottleCosting.ts, the same
// function the boards use, so this page and a quote cannot disagree.

export const metadata = { title: "Overhead" };
export const dynamic = "force-dynamic";

const GROUPS: { key: Group; title: "gRent" | "gIndirect" | "gOther"; mode: OverheadGroupMode }[] = [
  { key: "rent", title: "gRent", mode: "lease" },
  { key: "indirect", title: "gIndirect", mode: "labor" },
  { key: "other", title: "gOther", mode: undefined },
];

const modeFor = (g: Group): OverheadGroupMode => GROUPS.find((x) => x.key === g)?.mode;

function monthlyOf(b: Band): number {
  return overheadRowMonthly(
    {
      label: b.label,
      monthly: b.monthly,
      cam: b.cam,
      rate: b.rate,
      taxPct: b.taxPct,
      wcPct: b.wcPct,
      hours: b.hours,
      qty: b.qty,
      payType: b.payType,
      qbAccount: b.qbAccount,
      sharePct: 0,
    },
    modeFor(b.group),
  );
}

export default async function OverheadAdminPage({
  searchParams,
}: {
  searchParams?: Promise<{ cap?: string; d?: string }>;
}) {
  const sp = (await searchParams) ?? {};
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user || !user.email?.endsWith("@pharmacenterusa.com")) redirect("/");

  const host = (await headers()).get("host") ?? "";
  const onApexHost = HUB_HOSTS.has(host.split(":")[0].replace(/^www\./, ""));
  if (!(await checkIsAdmin(supabase, user.email))) redirect(onApexHost ? "/" : "/workflows");

  const lang = await getLangFromCookie();
  const t = makeOT(lang);
  const locale = lang === "es" ? "es-US" : "en-US";

  let data: OverheadData | null = null;
  let cap: CapacityData | null = null;
  let failure: string | null = null;
  try {
    [data, cap] = await Promise.all([loadOverhead(supabase), loadCapacity(supabase)]);
  } catch (err) {
    failure = err instanceof Error ? err.message : String(err);
    console.error("overhead admin load failed:", failure);
  }

  const money = (v: number) =>
    v.toLocaleString(locale, { style: "currency", currency: "USD", maximumFractionDigits: 2 });
  const day = (iso: string | null) =>
    iso
      ? new Date(`${iso}T12:00:00Z`).toLocaleDateString(locale, { timeZone: "UTC", dateStyle: "medium" })
      : t("open");

  return (
    <div className="app-shell">
      <AppHeader user={{ email: user.email! }} />
      <main className="page">
        <div className="page__inner">
          <p style={{ margin: "0 0 10px" }}>
            <a href="/admin" style={{ fontSize: 13 }}>{t("backToAdmin")}</a>
          </p>
          <p className="eyebrow" style={{ marginBottom: 6 }}>{t("eyebrow")}</p>
          <h1 className="page-header__title" style={{ marginBottom: 6 }}>{t("title")}</h1>
          <p className="lede" style={{ marginTop: 4 }}>{t("lede")}</p>

          {failure ? <Banner tone="bad">{t("loadFailed", { detail: failure })}</Banner> : null}
          {data ? <Body data={data} cap={cap} outcome={sp} t={t} money={money} day={day} /> : null}
        </div>
      </main>
    </div>
  );
}

type Fmt = { t: OT; money: (v: number) => string; day: (iso: string | null) => string };

function Body({
  data,
  cap,
  outcome,
  t,
  money,
  day,
}: { data: OverheadData; cap: CapacityData | null; outcome: { cap?: string; d?: string } } & Fmt) {
  return (
    <>
      <Dates data={data} t={t} day={day} />
      <Attention data={data} t={t} money={money} day={day} />
      {cap ? <Capacity data={data} cap={cap} outcome={outcome} t={t} money={money} day={day} /> : null}
      {GROUPS.map((g) => {
        const rows = data.quote.filter((r) => r.group === g.key);
        if (!rows.length) return null;
        const total = rows.reduce((s, r) => s + monthlyOf(r), 0);
        return (
          <section key={g.key} style={{ margin: "0 0 26px" }}>
            <h2 style={h2}>
              {t(g.title)} <span style={{ fontFamily: "var(--mono, monospace)", fontWeight: 400 }}>· {money(total)}/mo</span>
            </h2>
            <div style={{ overflowX: "auto" }}>
              <table style={table}>
                <thead>
                  <tr>
                    <th style={head}>{t("colItem")}</th>
                    <th style={{ ...head, textAlign: "right" }}>{t("colMonthly")}</th>
                    <th style={head}>{t("colDetail")}</th>
                    <th style={head}>{t("colBand")}</th>
                    <th style={head}>{t("colSource")}</th>
                    <th style={head}>{t("colVerified")}</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <ItemRow key={r.itemKey} r={r} today={data.current.get(r.itemKey)} bands={data.bands.get(r.itemKey) ?? []} t={t} money={money} day={day} />
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        );
      })}
      <Shares data={data} t={t} />
    </>
  );
}

function Dates({ data, t, day }: { data: OverheadData; t: OT; day: Fmt["day"] }) {
  const box: CSSProperties = {
    border: "1px solid var(--stone, #e3dcc9)",
    borderRadius: 10,
    padding: "10px 14px",
    background: "var(--paper, #fffdf8)",
    minWidth: 0,
  };
  const label: CSSProperties = { fontSize: 11.5, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--ink-3, #8a9498)" };
  const value: CSSProperties = { fontFamily: "var(--serif)", fontSize: 24, color: "var(--teal, #0f4a56)" };
  return (
    <div style={{ margin: "0 0 18px" }}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 10, marginBottom: 8 }}>
        <div style={box}>
          <div style={label}>{t("today")}</div>
          <div style={value}>{day(data.today)}</div>
        </div>
        <div style={{ ...box, borderColor: "var(--teal-2, #1d6c7b)" }}>
          <div style={label}>{t("quotesAsOf")}</div>
          <div style={value}>{day(data.quoteDate)}</div>
        </div>
      </div>
      <p style={note}>{data.leadDays ? t("leadNote", { days: data.leadDays }) : t("leadMissing")}</p>
    </div>
  );
}

function Attention({ data, t, money, day }: { data: OverheadData } & Fmt) {
  const items: string[] = [];
  const date = day(data.quoteDate);
  for (const r of data.quote) {
    if (r.status === "expired") items.push(t("aExpired", { label: r.label, date, to: day(r.effectiveTo) }));
    else if (r.status === "not_yet") items.push(t("aNotYet", { label: r.label, date, from: day(r.effectiveFrom) }));
    else if (r.daysLeft !== null && r.daysLeft <= 90)
      items.push(t("aEnding", { label: r.label, to: day(r.effectiveTo), days: r.daysLeft }));
    if (r.camEstimated) items.push(t("aCam", { label: r.label }));
    const now = data.current.get(r.itemKey);
    if (now && now.effectiveFrom !== r.effectiveFrom)
      items.push(t("aStepped", { label: r.label, from: day(r.effectiveFrom), quote: money(monthlyOf(r)), today: money(monthlyOf(now)) }));
  }
  return (
    <section style={{ margin: "0 0 22px" }}>
      <h2 style={h2}>{t("attention")}</h2>
      {items.length ? (
        <Banner tone="warn">
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {items.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ul>
        </Banner>
      ) : (
        <Banner tone="good">{t("attentionNone")}</Banner>
      )}
    </section>
  );
}

function ItemRow({ r, today, bands, t, money, day }: { r: Resolved; today?: Resolved; bands: Band[] } & Fmt) {
  const pct = (v: number | null) => (v === null ? "0" : String(v));
  let detail: ReactNode;
  if (r.group === "rent") {
    detail = (
      <>
        {t("base", { v: money(r.monthly) })}
        {r.cam !== null ? <> · {r.camEstimated ? t("camEst", { v: money(r.cam) }) : t("cam", { v: money(r.cam) })}</> : null}
      </>
    );
  } else if (r.group === "indirect") {
    detail = (
      <>
        {r.payType === "salary"
          ? t("salary", { qty: r.qty ?? 1, rate: money(r.rate ?? 0) })
          : t("hourly", { qty: r.qty ?? 1, rate: money(r.rate ?? 0), hours: r.hours ?? 173.33 })}
        <br />
        <span style={dim}>{t("burden", { tax: pct(r.taxPct), wc: pct(r.wcPct) })}</span>
      </>
    );
  } else {
    detail = r.qbAccount ? t("qb", { acct: r.qbAccount }) : t("none");
  }

  const stepped = today && today.effectiveFrom !== r.effectiveFrom;

  return (
    <tr>
      <td style={cell}>
        <div style={{ fontWeight: 600 }}>{r.label}</div>
        {bands.length > 1 ? (
          <details style={{ marginTop: 4 }}>
            <summary style={{ cursor: "pointer", fontSize: 12, color: "var(--ink-3, #8a9498)" }}>{t("history", { n: bands.length })}</summary>
            <table style={{ ...table, marginTop: 4, fontSize: 12 }}>
              <tbody>
                {bands.map((b) => (
                  <tr key={b.effectiveFrom} style={b.effectiveFrom === r.effectiveFrom ? { fontWeight: 700 } : undefined}>
                    <td style={mini}>{day(b.effectiveFrom)} – {day(b.effectiveTo)}</td>
                    <td style={{ ...mini, textAlign: "right", fontFamily: "var(--mono, monospace)" }}>{money(monthlyOf(b))}</td>
                    <td style={mini}>{b.sourceDoc ?? ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
        ) : null}
      </td>
      <td style={{ ...cell, textAlign: "right", fontFamily: "var(--mono, monospace)", whiteSpace: "nowrap" }}>
        {money(monthlyOf(r))}
        {stepped && today ? <div style={{ ...dim, color: "#8a5a00" }}>{t("differsToday", { v: money(monthlyOf(today)) })}</div> : null}
      </td>
      <td style={cell}>{detail}</td>
      <td style={{ ...cell, whiteSpace: "nowrap" }}>
        {day(r.effectiveFrom)} – {day(r.effectiveTo)}
        <div style={dim}>
          <StatusPill status={r.status} t={t} />
          {r.daysLeft !== null ? ` · ${r.daysLeft} d` : ""}
        </div>
      </td>
      <td style={cell}>{r.sourceDoc ?? t("none")}</td>
      <td style={{ ...cell, whiteSpace: "nowrap" }}>{r.verifiedOn ? day(r.verifiedOn) : t("none")}</td>
    </tr>
  );
}

function Capacity({
  data,
  cap,
  outcome,
  t,
  money,
  day,
}: { data: OverheadData; cap: CapacityData; outcome: { cap?: string; d?: string } } & Fmt) {
  const pending = cap.proposals.find((p) => p.status === "pending") ?? null;
  const earlier = cap.proposals.filter((p) => p !== pending);
  const gummy = cap.gummyCapacity ?? 0;
  const supportMonthly = data.quote.filter((r) => cap.supportItems.has(r.itemKey)).reduce((s, r) => s + monthlyOf(r), 0);
  const fmt1 = (v: number | null) => (v === null ? t("none") : v.toFixed(1));
  const rate = (monthly: number | null, div: number | null) => (monthly !== null && div && div > 0 ? monthly / div : null);
  const m = (v: number | null) => (v === null ? t("none") : money(v));

  const banner = (() => {
    switch (outcome.cap) {
      case "measured":
        return <Banner tone="good">{t("rMeasured")}</Banner>;
      case "approved":
        return <Banner tone="good">{t("rApproved")}</Banner>;
      case "rejected":
        return <Banner tone="good">{t("rRejected")}</Banner>;
      case "stale":
        return <Banner tone="warn">{t("rStale")}</Banner>;
      case "error":
        return <Banner tone="bad">{t("rError", { detail: outcome.d ?? "" })}</Banner>;
      default:
        return null;
    }
  })();

  return (
    <section id="capacity" style={{ margin: "0 0 26px" }}>
      <h2 style={h2}>{t("capTitle")}</h2>
      <p style={note}>{t("capLede")}</p>
      {banner}
      {!cap.migrated ? <Banner tone="warn">{t("capMigrate")}</Banner> : null}
      {cap.scheduleError ? <Banner tone="warn">{t("capSchedErr", { detail: cap.scheduleError })}</Banner> : null}

      {pending ? (
        <ProposalCard
          p={pending}
          cpNow={cap.cpCapacity}
          gummy={gummy}
          cpMonthly={cap.cpMonthly}
          supportMonthly={supportMonthly}
          rate={rate}
          fmt1={fmt1}
          m={m}
          t={t}
          day={day}
        />
      ) : cap.migrated ? (
        <p style={{ ...note, margin: "0 0 10px" }}>
          {t("capInUse")}: <strong>{t("capPerMonth", { v: fmt1(cap.cpCapacity) })}</strong>. {t("capNoPending")}
        </p>
      ) : null}

      {cap.migrated ? (
        <form action={measureNow} style={{ margin: "0 0 12px" }}>
          <button type="submit" style={secondaryBtn}>{t("capMeasureNow")}</button>
        </form>
      ) : null}
      <p style={note}>{t("capGummyNote", { v: fmt1(cap.gummyCapacity) })}</p>

      {earlier.length ? (
        <details>
          <summary style={{ cursor: "pointer", fontSize: 13, fontWeight: 600 }}>{t("capHistory")} ({earlier.length})</summary>
          <table style={{ ...table, marginTop: 6 }}>
            <tbody>
              {earlier.map((p) => (
                <tr key={p.id}>
                  <td style={cell}>{t(p.status === "approved" ? "stApproved" : p.status === "rejected" ? "stRejected" : p.status === "superseded" ? "stSuperseded" : "stPending")}</td>
                  <td style={{ ...cell, fontFamily: "var(--mono, monospace)", whiteSpace: "nowrap" }}>
                    {fmt1(p.currentValue)} → {fmt1(p.proposedValue)}
                  </td>
                  <td style={cell}>{t("capWindow", { from: day(p.windowFrom), to: day(p.windowTo), months: p.windowMonths })}</td>
                  <td style={cell}>
                    {t("capBy", { trigger: t(p.trigger === "schedule" ? "trSchedule" : "trButton"), who: p.decidedBy ?? p.createdBy, when: day((p.decidedAt ?? p.createdAt).slice(0, 10)) })}
                    {p.decisionNote ? <div style={dim}>{p.decisionNote}</div> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      ) : null}
    </section>
  );
}

function ProposalCard({
  p,
  cpNow,
  gummy,
  cpMonthly,
  supportMonthly,
  rate,
  fmt1,
  m,
  t,
  day,
}: {
  p: Proposal;
  cpNow: number | null;
  gummy: number;
  cpMonthly: number | null;
  supportMonthly: number;
  rate: (monthly: number | null, div: number | null) => number | null;
  fmt1: (v: number | null) => string;
  m: (v: number | null) => string;
  t: OT;
  day: Fmt["day"];
}) {
  const before = cpNow;
  const after = p.proposedValue;
  const pct = before ? `${(((after - before) / before) * 100).toFixed(1)}%` : t("none");
  const lines = p.measured.filter((r) => r.line_key !== "ALL").sort((a, b) => b.run_days - a.run_days);
  const all = p.measured.find((r) => r.line_key === "ALL");
  const card: CSSProperties = { border: "1px solid var(--stone, #e3dcc9)", borderRadius: 10, padding: "10px 14px", background: "var(--paper, #fffdf8)", minWidth: 0 };
  const lab: CSSProperties = { fontSize: 11.5, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--ink-3, #8a9498)" };
  const big: CSSProperties = { fontFamily: "var(--serif)", fontSize: 22, color: "var(--teal, #0f4a56)" };
  return (
    <div style={{ border: "1px solid #8a5a00", borderRadius: 10, padding: 14, margin: "0 0 12px" }}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: 10, marginBottom: 10 }}>
        <div style={card}>
          <div style={lab}>{t("capInUse")}</div>
          <div style={big}>{t("capPerMonth", { v: fmt1(before) })}</div>
        </div>
        <div style={{ ...card, borderColor: "var(--teal-2, #1d6c7b)" }}>
          <div style={lab}>{t("capMeasured")}</div>
          <div style={big}>{t("capPerMonth", { v: fmt1(after) })}</div>
          <div style={dim}>{t("capChange", { pct })} · {t("capWindow", { from: day(p.windowFrom), to: day(p.windowTo), months: p.windowMonths })}</div>
        </div>
      </div>

      <table style={{ ...table, marginBottom: 10 }}>
        <tbody>
          <tr>
            <td style={cell}>{t("capRateCp")}</td>
            <td style={{ ...cell, textAlign: "right", fontFamily: "var(--mono, monospace)", whiteSpace: "nowrap" }}>
              {m(rate(cpMonthly, before))} → <strong>{m(rate(cpMonthly, after))}</strong>
            </td>
          </tr>
          <tr>
            <td style={cell}>
              {t("capRateSupport")}
              <div style={dim}>{t("capSupportDiv", { v: fmt1(after + gummy), g: fmt1(gummy) })}</div>
            </td>
            <td style={{ ...cell, textAlign: "right", fontFamily: "var(--mono, monospace)", whiteSpace: "nowrap" }}>
              {m(rate(supportMonthly, before === null ? null : before + gummy))} → <strong>{m(rate(supportMonthly, after + gummy))}</strong>
            </td>
          </tr>
        </tbody>
      </table>

      <details style={{ marginBottom: 10 }}>
        <summary style={{ cursor: "pointer", fontSize: 13, fontWeight: 600 }}>{t("capByLine")}</summary>
        <table style={{ ...table, marginTop: 6 }}>
          <thead>
            <tr>
              <th style={head}>{t("colLine")}</th>
              <th style={{ ...head, textAlign: "right" }}>{t("colRunDays")}</th>
              <th style={{ ...head, textAlign: "right" }}>{t("colPerMonth")}</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((r) => (
              <tr key={r.line_key}>
                <td style={cell}>{r.line_key}</td>
                <td style={{ ...cell, textAlign: "right", fontFamily: "var(--mono, monospace)" }}>{r.run_days}</td>
                <td style={{ ...cell, textAlign: "right", fontFamily: "var(--mono, monospace)" }}>{fmt1(Number(r.per_month))}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {all && all.distinct_days ? (
          <p style={{ ...dim, margin: "6px 0 0" }}>{t("capParallel", { v: (all.run_days / all.distinct_days).toFixed(2) })}</p>
        ) : null}
      </details>

      <form action={decide} style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
        <input type="hidden" name="id" value={p.id} />
        <input name="note" placeholder={t("capNote")} maxLength={2000} style={{ flex: "1 1 220px", minWidth: 0, padding: "6px 8px", fontSize: 13 }} />
        <button type="submit" name="verdict" value="approve" className="button-primary">{t("capApprove", { v: fmt1(after) })}</button>
        <button type="submit" name="verdict" value="reject" style={secondaryBtn}>{t("capReject")}</button>
      </form>
    </div>
  );
}

function StatusPill({ status, t }: { status: Resolved["status"]; t: OT }) {
  const color = status === "current" ? "#3f6b1f" : status === "expired" ? "#9b2c2c" : "#8a5a00";
  const key = status === "current" ? "sCurrent" : status === "expired" ? "sExpired" : "sNotYet";
  return <span style={{ color, fontWeight: 600 }}>{t(key)}</span>;
}

function Shares({ data, t }: { data: OverheadData; t: OT }) {
  if (!data.lines.length) return null;
  const pct = new Map(data.shares.map((s) => [`${s.itemKey}|${s.lineKey}`, s.sharePct]));
  const rows = data.quote;
  return (
    <section style={{ margin: "0 0 26px" }}>
      <h2 style={h2}>{t("sharesTitle")}</h2>
      <p style={note}>{t("sharesNote")}</p>
      <div style={{ overflowX: "auto" }}>
        <table style={table}>
          <thead>
            <tr>
              <th style={head}>{t("colItem")}</th>
              {data.lines.map((l) => (
                <th key={l} style={{ ...head, textAlign: "right" }}>{l}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const vals = data.lines.map((l) => pct.get(`${r.itemKey}|${l}`) ?? 0);
              return (
                <tr key={r.itemKey}>
                  <td style={cell}>{r.label}</td>
                  {vals.map((v, i) => (
                    <td key={data.lines[i]} style={{ ...cell, textAlign: "right", fontFamily: "var(--mono, monospace)", color: v ? undefined : "var(--ink-3, #8a9498)" }}>
                      {v ? `${v}%` : "—"}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function Banner({ tone, children }: { tone: "bad" | "warn" | "good"; children: ReactNode }) {
  const color = tone === "bad" ? "#9b2c2c" : tone === "warn" ? "#8a5a00" : "#3f6b1f";
  return (
    <div role="status" style={{ border: `1px solid ${color}`, color, borderRadius: 8, padding: "10px 12px", margin: "0 0 14px", fontSize: 13.5, lineHeight: 1.5 }}>
      {children}
    </div>
  );
}

const table: CSSProperties = { borderCollapse: "collapse", width: "100%", fontSize: 13 };
const cell: CSSProperties = { padding: "6px 10px", borderBottom: "1px solid var(--stone, #e3dcc9)", textAlign: "left", verticalAlign: "top" };
const head: CSSProperties = { ...cell, fontSize: 11.5, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--ink-3, #8a9498)" };
const mini: CSSProperties = { padding: "2px 8px 2px 0", verticalAlign: "top" };
const dim: CSSProperties = { fontSize: 12, color: "var(--ink-3, #8a9498)" };
const note: CSSProperties = { margin: "0 0 10px", fontSize: 12.5, color: "var(--ink-3, #8a9498)", lineHeight: 1.5 };
const secondaryBtn: CSSProperties = { padding: "7px 14px", fontSize: 13, fontWeight: 600, borderRadius: 8, border: "1px solid var(--stone, #e3dcc9)", background: "transparent", color: "var(--teal, #0f4a56)", cursor: "pointer" };
const h2: CSSProperties = { margin: "0 0 8px", fontSize: 15, fontWeight: 700 };
