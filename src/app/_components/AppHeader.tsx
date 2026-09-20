import Link from "next/link";
import { headers } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { isAdmin as checkIsAdmin } from "@/lib/workflows";
import { SignOutButton } from "../auth-buttons";
import AdminToggle from "./AdminToggle";
import NavLinks from "./NavLinks";
import LangToggle from "./LangToggle";
import { getLangFromCookie } from "@/lib/i18n/server";

// Top navigation bar — sits flush on every signed-in page. Mirrors the look
// of the sister Packing List app: real PharmaCenter wordmark on the left,
// product name beside it, horizontal nav, signed-in email + sign-out on the
// right.
//
// Server component so the user's email comes straight from the RSC tree
// without bouncing through the client boundary. The active-link highlight
// is delegated to <NavLinks/> (client) because it needs usePathname.
//
// We also resolve `isAdmin` here so the AdminToggle can be rendered for
// admins on every page without each page having to pass the flag in.

export type AppContext =
  | "quote"
  | "formulas"
  | "packing-list"
  | "meetings"
  | "orders"
  // The apex, pharmacenter.app. Not a product -- the hub IS PharmaCenter, so
  // it wears the wordmark alone with no product name beside it.
  | "hub";

type Props = {
  user: { email: string };
  /** v49.2: shared pages (feedback, and eventually the admin hub) can
   *  pass the app the visitor arrived from (?from=) so the header keeps
   *  that app's identity instead of defaulting to quote chrome. */
  appContext?: AppContext;
};

export default async function AppHeader({ user, appContext }: Props) {
  const supabase = await createClient();
  const admin = await checkIsAdmin(supabase, user.email);

  // v48.7: the two subdomains now present themselves as separate
  // products — the quote site doesn't link to Formulas and the formula
  // site doesn't link to Workflows (middleware already 308s stray
  // /formulas hits on the quote host). Host is read server-side and
  // passed down so the client nav renders the right set on first paint.
  const host = (await headers()).get("host") ?? "";
  const onFormulaHost = host.startsWith("formula.") || host.startsWith("formulas.");
  const onMeetingHost = host.startsWith("meeting.") || host.startsWith("meetings.");
  const onOrderHost = host.startsWith("order.") || host.startsWith("orders.");
  // Apex only: pharmacenter.app and www.pharmacenter.app. Deliberately NOT a
  // prefix test -- "quote.pharmacenter.app" ends with the apex too.
  const bare = host.split(":")[0].replace(/^www\./, "");
  const onApexHost = bare === "pharmacenter.app";
  const lang = await getLangFromCookie();

  // Effective identity: explicit context from the page wins, otherwise
  // derived from the host. Orders host wins over meetings when both a
  // page passes appContext="meetings" and the visitor is on order.*
  // — that shows up on the shared SO detail page, which lives under
  // /meetings/... but should wear the orders identity when visited via
  // the orders subdomain.
  const ctx: AppContext = onOrderHost
    ? "orders"
    : (appContext ??
      (onFormulaHost
        ? "formulas"
        : onMeetingHost
          ? "meetings"
          : onApexHost
            ? "hub"
            : "quote"));
  const brandHref =
    ctx === "hub"
      ? "/"
      : ctx === "formulas"
      ? onFormulaHost
        ? "/"
        : "https://formula.pharmacenter.app/"
      : ctx === "meetings"
        ? onMeetingHost
          ? "/"
          : "https://meeting.pharmacenter.app/"
        : ctx === "orders"
          ? onOrderHost
            ? "/"
            : "https://orders.pharmacenter.app/"
          : ctx === "packing-list"
            ? "https://packing.pharmacenter.app/lists"
            : "/workflows";
  const productMain =
    ctx === "formulas"
      ? "Formulas"
      : ctx === "meetings"
        ? "Meeting"
        : ctx === "orders"
          ? "Sales Order"
          : ctx === "packing-list"
            ? "Packing List"
            : "Quote";
  const productSub =
    ctx === "formulas"
      ? "Catalog"
      : ctx === "meetings"
        ? "Hub"
        : ctx === "orders"
          ? "Tracker"
          : ctx === "packing-list"
            ? "Generator"
            : "Work Flows";

  return (
    <header className="app-nav">
      <div className="app-nav__inner">
        <Link href={brandHref} className="app-nav__brand">
          {/* The wordmark itself carries "PharmaCenter" + tagline, so we don't
              repeat "PharmaCenter" in text next to it. The product name
              ("Quote / Generator") sits beside the mark with a divider. */}
          <img
            src="/logo.png"
            alt="PharmaCenter"
            className="app-nav__logo"
            width={140}
            height={40}
          />
          {/* The wordmark already says PharmaCenter. On the apex that is the
              whole identity, so the divider and product name are omitted
              rather than filled with something redundant. */}
          {ctx === "hub" ? null : (
            <>
          <span className="app-nav__divider" aria-hidden="true" />
          <span className="app-nav__product">
            {/* v48.8/v49.2: the header wears the identity of the app the
                visitor is in (or arrived from, on shared pages). */}
            <span className="app-nav__product-main">{productMain}</span>
            <span className="app-nav__product-sub">{productSub}</span>
          </span>
            </>
          )}
        </Link>

        <NavLinks
          onFormulaHost={onFormulaHost}
          onMeetingHost={onMeetingHost}
          onOrderHost={onOrderHost}
          appContext={ctx}
          lang={lang}
        />

        <div className="app-nav__user">
          {/* v50: EN/ES pill — same placement as the packing list. */}
          <LangToggle lang={lang} />
          {admin ? <AdminToggle /> : null}
          <span className="app-nav__email" title={user.email}>
            {user.email}
          </span>
          <SignOutButton />
        </div>
      </div>
    </header>
  );
}
