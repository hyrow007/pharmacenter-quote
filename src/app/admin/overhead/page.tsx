import { redirect } from "next/navigation";
import { headers } from "next/headers";
import type { CSSProperties, ReactNode } from "react";
import { createClient } from "@/lib/supabase/server";
import { isAdmin as checkIsAdmin } from "@/lib/workflows";
import { HUB_HOSTS } from "@/lib/hub-hosts";
import { getLangFromCookie } from "@/lib/i18n/server";
import { overheadRowMonthly, type OverheadGroupMode } from "@/lib/bottleCosting";
import AppHeader from "../../_components/AppHeader";
import { loadOverhead, type Band, type Group, type OverheadData, type Resolved } from "./_lib/load";
import { makeOT, type OT } from "./_lib/i18n";

// /admin/overhead — the plant's overhead figures, read-only.
//
// Version 1 of the Overhead app: shows what every quote is costed against,
// on two dates side by side — today, and the quote date (today +
// quote_lead_days), which is what the boards actually use. Nothing is written.
// The propose → diff → approve flow comes next and needs its own migration.
// See claude/overhead.md.
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

export default async function OverheadAdminPage() {
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
  let failure: string | null = null;
  try {
    data = await loadOverhead(supabase);
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
          {data ? <Body data={data} t={t} money={money} day={day} /> : null}
        </div>
      </main>
    </div>
  );
}

type Fmt = { t: OT; money: (v: number) => string; day: (iso: string | null) => string };

function Body({ data, t, money, day }: { data: OverheadData } & Fmt) {
  return (
    <>
      <Dates data={data} t={t} day={day} />
      <Attention data={data} t={t} money={money} day={day} />
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
              <th style={{ ...head, textAlign: "right" }}>{t("colTotal")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const vals = data.lines.map((l) => pct.get(`${r.itemKey}|${l}`) ?? 0);
              const sum = vals.reduce((a, b) => a + b, 0);
              return (
                <tr key={r.itemKey}>
                  <td style={cell}>{r.label}</td>
                  {vals.map((v, i) => (
                    <td key={data.lines[i]} style={{ ...cell, textAlign: "right", fontFamily: "var(--mono, monospace)", color: v ? undefined : "var(--ink-3, #8a9498)" }}>
                      {v ? `${v}%` : "—"}
                    </td>
                  ))}
                  <td style={{ ...cell, textAlign: "right", fontFamily: "var(--mono, monospace)", fontWeight: 600, color: Math.abs(sum - 100) > 0.01 && sum > 0 ? "#8a5a00" : undefined }}>
                    {sum ? `${Math.round(sum * 100) / 100}%` : "—"}
                  </td>
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
const h2: CSSProperties = { margin: "0 0 8px", fontSize: 15, fontWeight: 700 };
