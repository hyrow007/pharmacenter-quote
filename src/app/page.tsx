import { HUB_HOSTS } from "@/lib/hub-hosts";
import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { SignInButton } from "./auth-buttons";
import LangToggle from "./_components/LangToggle";
import { getLangFromCookie } from "@/lib/i18n/server";
import { makeT } from "@/lib/i18n/dict";

// The root layout's title is "Quotes" -- right for the quote host, wrong on
// every other identity's sign-in screen. The sign-in page names the product
// the visitor actually came to.
export async function generateMetadata() {
  const host = (await headers()).get("host") ?? "";
  if (host.startsWith("yield.") || host.startsWith("yields.")) return { title: "Yields" };
  if (host.startsWith("dieline.") || host.startsWith("dielines.")) return { title: "Dielines" };
  if (host.startsWith("ship.") || host.startsWith("shipping.")) return { title: "Shipping" };
  if (host.startsWith("order.") || host.startsWith("orders.")) return { title: "Sales Orders" };
  if (host.startsWith("formula.") || host.startsWith("formulas.")) return { title: "Formulas" };
  return {};
}

export default async function Home({
  searchParams,
}: {
  searchParams?: Promise<{ auth_error?: string }>;
}) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // Detect the vanity subdomain so we can swap copy + post-sign-in
  // landing. formula.pharmacenter.app is a standalone entry point for
  // the gummy formula catalog; meeting.pharmacenter.app fronts the
  // meetings hub; quote.pharmacenter.app (and everything else) still
  // lands on the quoting workflow inbox.
  const hostHeader = (await headers()).get("host") ?? "";
  const isFormulaHost =
    hostHeader.startsWith("formula.") || hostHeader.startsWith("formulas.");
  const isMeetingHost =
    hostHeader.startsWith("meeting.") || hostHeader.startsWith("meetings.");
  const isOrderHost =
    hostHeader.startsWith("order.") || hostHeader.startsWith("orders.");
  const isYieldHost =
    hostHeader.startsWith("yield.") || hostHeader.startsWith("yields.");
  const isDielineHost =
    hostHeader.startsWith("dieline.") || hostHeader.startsWith("dielines.");
  const isShipHost =
    hostHeader.startsWith("ship.") || hostHeader.startsWith("shipping.");
  // The hub hosts: pharmacenter.app and pharmacenter.tools (www. of either).
  // An exact match after stripping the port and a www. prefix, because every
  // other host ENDS with the apex too.
  const isApexHost = HUB_HOSTS.has(
    hostHeader.split(":")[0].replace(/^www\./, ""),
  );

  if (user) {
    if (isFormulaHost) redirect("/formulas");
    if (isOrderHost) redirect("/orders");
    if (isYieldHost) redirect("/yields");
    if (isDielineHost) redirect("/dielines");
    if (isShipHost) redirect("/shipping");
    if (isMeetingHost) redirect("/meetings");
    if (isApexHost) redirect("/hub");
    redirect("/workflows");
  }

  const params = await searchParams;
  const showError = params?.auth_error === "1";

  // The language cookie is readable without a session, so the toggle works
  // here too. It used to appear only after sign-in, which meant a
  // Spanish-speaking operator had to read an English page to reach it.
  const lang = await getLangFromCookie();
  const t = makeT(lang);
  const DOMAIN = "@pharmacenterusa.com";
  // The domain is bold inside the sentence, and Spanish puts it in a
  // different position, so the string carries a placeholder and we split on
  // it rather than gluing two half-sentences together.
  const [restrictedBefore, restrictedAfter] = t("signInRestricted", {
    domain: "\u0000",
  }).split("\u0000");

  // Sign-in copy — swapped per subdomain so operators landing on
  // formula.pharmacenter.app see "Formula / Catalog", those on
  // orders.pharmacenter.app see "Sales Order / Tracker", etc.
  const copy = isApexHost
    ? {
        titleTop: "PharmaCenter",
        titleSub: "Tools",
        lede: t("signInLedeHub"),
      }
    : isFormulaHost
    ? {
        titleTop: "Formula",
        titleSub: "Catalog",
        lede: t("signInLedeFormula"),
      }
    : isOrderHost
    ? {
        titleTop: "Sales Order",
        titleSub: "Tracker",
        lede: t("signInLedeOrder"),
      }
    : isYieldHost
    ? {
        titleTop: "Production",
        titleSub: "Yields",
        lede: t("signInLedeYield"),
      }
    : isDielineHost
    ? {
        titleTop: "Dieline",
        titleSub: "Builder",
        lede: t("signInLedeDieline"),
      }
    : isShipHost
    ? {
        titleTop: "Shipping",
        titleSub: "Labels",
        lede: t("signInLedeShip"),
      }
    : isMeetingHost
    ? {
        titleTop: "Meeting",
        titleSub: "Hub",
        lede: t("signInLedeMeeting"),
      }
    : {
        titleTop: "Quote",
        titleSub: "Work Flows",
        lede: t("signInLedeQuote"),
      };

  // Layout is a 1:1 port of the Packing List sign-in
  // (packing.pharmacenter.app). Exact computed-style values copied from
  // the live PL DOM:
  //   main:    grid 1047px / 873px (≈ 1.2fr / 1fr)
  //   section: padding 48px, align-items center, justify-items center
  //   .card:   max-width 520px
  //   aside:   overflow hidden, position relative, full height
  //   aside img: position absolute, w/h 100%, object-fit cover
  // The .signin-art class hides the right column on narrow screens via
  // a media query in globals.css.
  return (
    <main
      style={{
        minHeight: "100vh",
        display: "grid",
        gridTemplateColumns: "1.2fr 1fr",
        overflow: "hidden",
      }}
    >
      <section
        style={{
          position: "relative",
          display: "grid",
          padding: 48,
          alignItems: "center",
          justifyItems: "center",
        }}
      >
        {/* Same control, same corner, as the signed-in band. */}
        <div style={{ position: "absolute", top: 24, right: 24 }}>
          <LangToggle lang={lang} />
        </div>
        <div className="card" style={{ maxWidth: 520, width: "100%" }}>
          {/* Logo: 189x48 — exact PL dimensions. */}
          <img
            src="/logo.png"
            alt="PharmaCenter"
            style={{
              display: "block",
              width: 189,
              height: 48,
              margin: "0 0 18px",
            }}
          />
          {/* H1 + subtitle structured as a single heading block, matching
              PL's <h1>Packing List <span>Generator</span></h1> exactly so
              the two pages share identical typographic rhythm. */}
          <h1
            style={{
              fontSize: 56,
              lineHeight: "56px",
              fontWeight: 500,
              margin: "0 0 20px",
            }}
          >
            {copy.titleTop}
            <span
              style={{
                display: "block",
                fontSize: 25.76,
                fontStyle: "italic",
                fontWeight: 400,
                lineHeight: "28.336px",
                margin: "6px 0 0 2px",
                color: "rgb(110, 124, 128)",
              }}
            >
              {copy.titleSub}
            </span>
          </h1>
          <p className="lede" style={{ marginBottom: 18 }}>
            {copy.lede}
          </p>
          <SignInButton
            label={t("signInGoogle")}
            loadingLabel={t("signInRedirecting")}
          />
          <p className="meta" style={{ marginTop: 22 }}>
            {restrictedBefore}
            <strong>{DOMAIN}</strong>
            {restrictedAfter}
          </p>
          {showError ? (
            <p
              style={{
                marginTop: 14,
                padding: "10px 14px",
                background: "#fff1f1",
                border: "1px solid #f5c2c2",
                borderRadius: 8,
                color: "#7a1d1d",
                fontSize: 13,
              }}
            >
              {t("signInError")}
            </p>
          ) : null}
        </div>
      </section>

      {/* Right column: pills/capsules/gummies image. Hotlinked from the
          Packing List app so both sign-ins share the same asset. The
          aside is the positioned ancestor; the img inside is absolute
          and uses object-fit:cover, mirroring the PL DOM exactly. */}
      <aside
        className="signin-art"
        aria-hidden="true"
        style={{
          position: "relative",
          overflow: "hidden",
        }}
      >
        <img
          src="https://packing.pharmacenter.app/PILLS.png"
          alt=""
          style={{
            position: "absolute",
            inset: 0,
            width: "100%",
            height: "100%",
            objectFit: "cover",
            objectPosition: "50% 50%",
          }}
        />
      </aside>
    </main>
  );
}
