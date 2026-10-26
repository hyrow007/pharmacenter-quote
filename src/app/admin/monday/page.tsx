import { redirect } from "next/navigation";
import { headers } from "next/headers";
import type { ReactNode } from "react";
import { createClient } from "@/lib/supabase/server";
import { isAdmin as checkIsAdmin } from "@/lib/workflows";
import { HUB_HOSTS } from "@/lib/hub-hosts";
import { getLangFromCookie } from "@/lib/i18n/server";
import AppHeader from "../../_components/AppHeader";
import { loadBoards, loadMirror } from "./_lib/load";
import { reconcile, type BoardItem, type FieldDiff, type Report, type Row } from "./_lib/reconcile";
import { makeMT, type MT } from "./_lib/i18n";

// /admin/monday — the Fishbowl → Monday reconciler, read-only.
//
// Every load reads the whole mirror and both boards and recomputes the report.
// Nothing is stored and nothing is written: that is what makes it safe to run
// against the live boards while LilyPad is still pushing to them. The push
// that will act on this report is not built yet. See
// claude/monday-integration.md.

export const metadata = { title: "Fishbowl → Monday" };
export const dynamic = "force-dynamic";
// Two boards of a few hundred items plus the mirror: a few seconds normally,
// but Monday can be slow and Hobby's default is 10s.
export const maxDuration = 60;

const STALE_HOURS = 26;

export default async function MondayReconcilePage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user || !user.email?.endsWith("@pharmacenterusa.com")) redirect("/");

  const host = (await headers()).get("host") ?? "";
  const onApexHost = HUB_HOSTS.has(host.split(":")[0].replace(/^www\./, ""));
  if (!(await checkIsAdmin(supabase, user.email))) redirect(onApexHost ? "/" : "/workflows");

  const lang = await getLangFromCookie();
  const t = makeMT(lang);

  let report: Report | null = null;
  let failure: string | null = null;
  try {
    const [mirror, items] = await Promise.all([loadMirror(supabase), loadBoards()]);
    report = reconcile(mirror, items);
  } catch (err) {
    failure = err instanceof Error ? err.message : String(err);
    console.error("monday reconcile failed:", failure);
  }

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
          {report ? <Body report={report} t={t} lang={lang} /> : null}
        </div>
      </main>
    </div>
  );
}

function Body({ report, t, lang }: { report: Report; t: MT; lang: "en" | "es" }) {
  const locale = lang === "es" ? "es-US" : "en-US";
  const when = report.latestRunAt
    ? new Date(report.latestRunAt).toLocaleString(locale, {
        timeZone: "America/New_York",
        dateStyle: "medium",
        timeStyle: "short",
      })
    : "—";
  const ageH = report.latestRunAt ? (Date.now() - new Date(report.latestRunAt).getTime()) / 3.6e6 : Infinity;

  const problems =
    report.missing.length +
    report.openOnFulfilled.length +
    report.fulfilledOnOpen.length +
    report.closedOnOpen.length +
    report.unknownOnOpen.length +
    report.fieldDiffs.length +
    report.duplicates.length;

  return (
    <>
      <p style={{ fontSize: 13, color: "var(--ink-3, #8a9498)", margin: "0 0 4px" }}>{t("asOf", { when })}</p>
      <p style={{ fontSize: 13, color: "var(--ink-3, #8a9498)", margin: "0 0 14px" }}>
        {t("totals", {
          wanted: report.counts.mirrorWanted,
          open: report.counts.openItems,
          fulfilled: report.counts.fulfilledItems,
        })}
      </p>
      {ageH > STALE_HOURS ? <Banner tone="warn">{t("stale")}</Banner> : null}
      {report.fulfilledInMirror === 0 ? <Banner tone="warn">{t("noFulfilled")}</Banner> : null}
      {problems === 0 ? <Banner tone="good">{t("allClear")}</Banner> : null}

      <Section title={t("sMissing")} hint={t("hMissing")} n={report.missing.length} open>
        <SoTable rows={report.missing} t={t} />
      </Section>
      <Section title={t("sFulfilledOnOpen")} hint={t("hFulfilledOnOpen")} n={report.fulfilledOnOpen.length} open>
        <SoTable rows={report.fulfilledOnOpen} t={t} />
      </Section>
      <Section title={t("sClosedOnOpen")} hint={t("hClosedOnOpen")} n={report.closedOnOpen.length} open>
        <SoTable rows={report.closedOnOpen} t={t} />
      </Section>
      <Section title={t("sOpenOnFulfilled")} hint={t("hOpenOnFulfilled")} n={report.openOnFulfilled.length} open>
        <SoTable rows={report.openOnFulfilled} t={t} />
      </Section>
      <Section title={t("sDiffs")} hint={t("hDiffs")} n={report.fieldDiffs.length}>
        <DiffTable diffs={report.fieldDiffs} t={t} />
      </Section>
      <Section title={t("sUnknown")} hint={t("hUnknown")} n={report.unknownOnOpen.length}>
        <SoTable rows={report.unknownOnOpen} t={t} />
      </Section>
      <Section title={t("sDupes")} hint={t("hDupes")} n={report.duplicates.length}>
        <SoTable
          rows={report.duplicates.flatMap((d) => d.items.map((item) => ({ so: d.so, mirror: null, item, matchType: null })))}
          t={t}
        />
      </Section>
      <Section title={t("sPrefix")} hint={t("hPrefix")} n={report.prefixMatches.length}>
        <SoTable rows={report.prefixMatches} t={t} showMatch />
      </Section>
      <Section title={t("sFulfilledNeither")} hint={t("hFulfilledNeither")} n={report.fulfilledNeither.length}>
        <SoTable rows={report.fulfilledNeither} t={t} />
      </Section>
    </>
  );
}

const cell = { padding: "6px 10px", borderBottom: "1px solid var(--stone, #e3dcc9)", textAlign: "left" as const, verticalAlign: "top" as const };
const head = { ...cell, fontSize: 11.5, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase" as const, color: "var(--ink-3, #8a9498)" };

function Banner({ tone, children }: { tone: "bad" | "warn" | "good"; children: ReactNode }) {
  const color = tone === "bad" ? "#9b2c2c" : tone === "warn" ? "#8a5a00" : "#3f6b1f";
  return (
    <div role="status" style={{ border: `1px solid ${color}`, color, borderRadius: 8, padding: "10px 12px", margin: "0 0 14px", fontSize: 13.5, lineHeight: 1.5 }}>
      {children}
    </div>
  );
}

function Section({ title, hint, n, open, children }: { title: string; hint: string; n: number; open?: boolean; children: ReactNode }) {
  return (
    <details open={open && n > 0} style={{ margin: "0 0 14px", opacity: n === 0 ? 0.6 : 1 }}>
      <summary style={{ cursor: n ? "pointer" : "default", fontWeight: 700, fontSize: 15 }}>
        {title} <span style={{ fontFamily: "var(--mono, monospace)", fontWeight: 400 }}>({n})</span>
      </summary>
      {hint ? <p style={{ margin: "4px 0 8px", fontSize: 12.5, color: "var(--ink-3, #8a9498)" }}>{hint}</p> : null}
      {n > 0 ? <div style={{ overflowX: "auto" }}>{children}</div> : null}
    </details>
  );
}

function ItemLink({ item, t }: { item: BoardItem | null; t: MT }) {
  if (!item) return <span>—</span>;
  return (
    <a href={item.url} target="_blank" rel="noreferrer">
      {item.name} · {item.board === "open" ? t("boardOpen") : t("boardFulfilled")}
    </a>
  );
}

function SoTable({ rows, t, showMatch }: { rows: Row[]; t: MT; showMatch?: boolean }) {
  return (
    <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 13 }}>
      <thead>
        <tr>
          <th style={head}>{t("colSo")}</th>
          <th style={head}>{t("colCustomer")}</th>
          <th style={head}>{t("colStatus")}</th>
          <th style={head}>{t("colItem")}</th>
          {showMatch ? <th style={head}>{t("colMatch")}</th> : null}
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={`${r.so}-${r.item?.id ?? i}`}>
            <td style={{ ...cell, fontFamily: "var(--mono, monospace)" }}>{r.so}</td>
            <td style={cell}>{r.mirror?.customer_name ?? r.item?.cols["customer"] ?? "—"}</td>
            <td style={cell}>{r.mirror?.status_name ?? "—"}</td>
            <td style={cell}><ItemLink item={r.item} t={t} /></td>
            {showMatch ? (
              <td style={cell}>{r.matchType === "prefix" ? t("matchPrefix") : t("matchFormat")}</td>
            ) : null}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function fieldLabel(f: FieldDiff["field"], t: MT) {
  return f === "customer" ? t("fieldCustomer") : f === "customer_po" ? t("fieldCustomerPo") : t("fieldOwner");
}

function DiffTable({ diffs, t }: { diffs: FieldDiff[]; t: MT }) {
  return (
    <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 13 }}>
      <thead>
        <tr>
          <th style={head}>{t("colSo")}</th>
          <th style={head}>{t("colField")}</th>
          <th style={head}>{t("colFishbowl")}</th>
          <th style={head}>{t("colMonday")}</th>
          <th style={head}>{t("colItem")}</th>
        </tr>
      </thead>
      <tbody>
        {diffs.map((d) => (
          <tr key={`${d.item.id}-${d.field}`}>
            <td style={{ ...cell, fontFamily: "var(--mono, monospace)" }}>{d.so}</td>
            <td style={cell}>{fieldLabel(d.field, t)}</td>
            <td style={cell}>{d.fishbowl || t("empty")}</td>
            <td style={cell}>{d.board || t("empty")}</td>
            <td style={cell}><ItemLink item={d.item} t={t} /></td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
