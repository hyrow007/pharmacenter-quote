// Shared by every KPI page: sign-in gate, language, and links that work on
// both kpi.pharmacenter.app (where "/sales" is rewritten to /kpi/sales) and
// the quote host (where the page lives at /kpi/sales).

import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { getLangFromCookie } from "@/lib/i18n/server";
import type { Lang } from "@/lib/i18n/dict";
import { makeKT, type KT } from "./i18n";

export type KpiPageCtx = {
  supabase: Awaited<ReturnType<typeof createClient>>;
  email: string;
  lang: Lang;
  t: KT;
  onKpiHost: boolean;
  /** A KPI-relative path ("/sales") → the right href on this host. Absolute URLs pass through. */
  href: (path: string) => string;
};

export async function kpiPage(): Promise<KpiPageCtx> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const host = (await headers()).get("host") ?? "";
  const onKpiHost = host.startsWith("kpi.") || host.startsWith("kpis.");
  if (!user || !user.email?.endsWith("@pharmacenterusa.com")) {
    redirect(onKpiHost ? "/?showSignIn=1" : "/");
  }
  const lang = await getLangFromCookie();
  return {
    supabase,
    email: user.email!,
    lang,
    t: makeKT(lang),
    onKpiHost,
    href: (path: string) => (/^https?:/.test(path) ? path : onKpiHost ? path : `/kpi${path === "/" ? "" : path}`),
  };
}

export function fmtUsd(n: number, lang: Lang, digits = 0): string {
  return new Intl.NumberFormat(lang === "es" ? "es-US" : "en-US", { style: "currency", currency: "USD", maximumFractionDigits: digits }).format(n);
}

export function fmtUsdCompact(n: number, lang: Lang): string {
  return new Intl.NumberFormat(lang === "es" ? "es-US" : "en-US", { style: "currency", currency: "USD", notation: "compact", maximumFractionDigits: 1 }).format(n);
}

export function fmtPct(fraction01: number, lang: Lang, digits = 1): string {
  return new Intl.NumberFormat(lang === "es" ? "es-US" : "en-US", { style: "percent", maximumFractionDigits: digits }).format(fraction01);
}

export function fmtDay(iso: string, lang: Lang, withYear = true): string {
  return new Intl.DateTimeFormat(lang === "es" ? "es-US" : "en-US", {
    month: "short", day: "numeric", ...(withYear ? { year: "numeric" } : {}), timeZone: "UTC",
  }).format(new Date(`${iso}T12:00:00Z`));
}

export function fmtMonth(ym: string, lang: Lang, withYear = true): string {
  return new Intl.DateTimeFormat(lang === "es" ? "es-US" : "en-US", {
    month: "short", ...(withYear ? { year: "numeric" } : {}), timeZone: "UTC",
  }).format(new Date(`${ym}-15T12:00:00Z`));
}

export function one(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}
