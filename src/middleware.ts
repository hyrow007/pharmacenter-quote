import { NextResponse, type NextRequest } from "next/server";
import { updateSession } from "@/lib/supabase/middleware";

// Vanity subdomain: formula.pharmacenter.app serves the gummy formula
// catalog as a standalone. Under the hood it's still the same Next.js
// app deployed at quote.pharmacenter.app — we just rewrite the URL so
// visitors land on /formulas without seeing the "quote" host or the
// "/formulas" path in the address bar. Individual formula pages
// (formula.pharmacenter.app/<uuid>) map to /formulas/<uuid>.
//
// The rewrite is scoped: /api, /auth, and anything already under
// /formulas passes through untouched so API routes, OAuth callbacks,
// and any deep-link that already includes the path prefix keep
// working from either subdomain.

function isFormulaHost(host: string | null): boolean {
  if (!host) return false;
  // Match "formula.<anything>" so preview URLs and localhost overrides
  // (e.g. formula.localhost:3000) work the same as production.
  // v82: "formulas.<anything>" is an alias — both singular and plural
  // subdomains serve the catalog identically.
  return host.startsWith("formula.") || host.startsWith("formulas.");
}

// meeting.pharmacenter.app is the meetings hub — a sibling of the
// formula subdomain that fronts /meetings. Same substring rule so
// preview URLs (meeting-<hash>.vercel.app doesn't match, but
// meeting.localhost:3000 does) behave consistently.
// Singular and plural subdomains are aliased (mirrors formula/formulas
// in v82) so either one serves the hub identically.
function isMeetingHost(host: string | null): boolean {
  if (!host) return false;
  return host.startsWith("meeting.") || host.startsWith("meetings.");
}

// order.pharmacenter.app / orders.pharmacenter.app are the sales-order
// status tracker — the pivot from "meeting hub" to "everything about
// every open SO". Same substring pattern; both singular and plural
// serve the tracker identically. Fronts /orders.
function isOrderHost(host: string | null): boolean {
  if (!host) return false;
  return host.startsWith("order.") || host.startsWith("orders.");
}

// v48.6: formulas are only reachable on the formula subdomain. A
// /formulas page request arriving on the quote host gets a permanent
// redirect to the same path on formula.<domain>. Scoped to hosts that
// literally start with "quote." so Vercel preview URLs and localhost
// (which have no formula subdomain) keep serving /formulas directly.
function isQuoteHost(host: string | null): boolean {
  if (!host) return false;
  return host.startsWith("quote.");
}

function shouldRewriteToFormulas(pathname: string): boolean {
  if (pathname.startsWith("/api")) return false;
  if (pathname.startsWith("/auth")) return false;
  if (pathname.startsWith("/formulas")) return false;
  if (pathname.startsWith("/_next")) return false;
  return true;
}

// Same shape as the formula rewrite guard — carve out /api, /auth,
// anything already under /meetings, and Next.js internals so those
// requests pass through unchanged from either host.
function shouldRewriteToMeetings(pathname: string): boolean {
  if (pathname.startsWith("/api")) return false;
  if (pathname.startsWith("/auth")) return false;
  if (pathname.startsWith("/meetings")) return false;
  if (pathname.startsWith("/_next")) return false;
  return true;
}

function shouldRewriteToOrders(pathname: string): boolean {
  if (pathname.startsWith("/api")) return false;
  if (pathname.startsWith("/auth")) return false;
  if (pathname.startsWith("/orders")) return false;
  // Every SO card on the Orders landing links to the SO detail page, which
  // lives at /meetings/sales-orders/orders/[so]. Without this carve-out the
  // orders host rewrote that to /orders/meetings/... and every card 404'd.
  if (pathname.startsWith("/meetings")) return false;
  if (pathname.startsWith("/_next")) return false;
  return true;
}

// Cheap "user probably has a session" check without instantiating a
// full Supabase client. @supabase/ssr writes cookies named
// `sb-<projectref>-auth-token[.N]`; if any exist we assume the user is
// signed in for the purposes of routing. If they turn out not to be
// signed in the /formulas server page redirects them to "/" — this
// check just prevents that redirect from bouncing back into a rewrite
// loop for anonymous visitors on the formula subdomain.
function looksSignedIn(request: NextRequest): boolean {
  for (const cookie of request.cookies.getAll()) {
    if (cookie.name.startsWith("sb-") && cookie.name.includes("auth-token")) {
      return true;
    }
  }
  return false;
}

export async function middleware(request: NextRequest) {
  // Always refresh the Supabase auth session cookie first. The
  // response it returns carries any Set-Cookie headers we need to
  // forward to the browser regardless of whether we rewrite below.
  const authResponse = await updateSession(request);

  const host = request.headers.get("host");

  // Formulas must not be served from the quote site. Page routes only —
  // /api/formulas stays reachable from either host on purpose, because
  // the quote workflow will consume formula material costs same-origin
  // once #164/#165 land.
  if (isQuoteHost(host) && request.nextUrl.pathname.startsWith("/formulas")) {
    const redirectUrl = request.nextUrl.clone();
    redirectUrl.host = (host as string).replace(/^quote\./, "formula.");
    const redirectResponse = NextResponse.redirect(redirectUrl, 308);
    // Forward refreshed auth cookies so sign-in state survives the hop.
    authResponse.cookies.getAll().forEach((cookie) => {
      redirectResponse.cookies.set(cookie);
    });
    return redirectResponse;
  }

  // Meetings mirror the same pattern — page routes only live on the
  // meeting subdomain. A stray /meetings on the quote host 308s over
  // so bookmarks and pasted links land on the right identity.
  if (isQuoteHost(host) && request.nextUrl.pathname.startsWith("/meetings")) {
    const redirectUrl = request.nextUrl.clone();
    redirectUrl.host = (host as string).replace(/^quote\./, "meeting.");
    const redirectResponse = NextResponse.redirect(redirectUrl, 308);
    authResponse.cookies.getAll().forEach((cookie) => {
      redirectResponse.cookies.set(cookie);
    });
    return redirectResponse;
  }

  if (isFormulaHost(host)) {
    const { pathname, search, searchParams } = request.nextUrl;
    // Loop-guard: when /formulas discovers there's no valid Supabase
    // session it redirects to "/?showSignIn=1". Middleware treats that
    // query flag as "the page below already tried to route you, do
    // NOT rewrite — let the sign-in card render." This is the safety
    // valve for the case where sb-*-auth-token cookies exist but are
    // stale/invalid, which the cookie heuristic below can't detect.
    const skipDueToSignInFlag = searchParams.get("showSignIn") === "1";
    // Anonymous visitor hitting the formula subdomain: skip the
    // rewrite so they land on the sign-in page at "/" instead of
    // bouncing between "/" → "/formulas" → redirect("/") forever. Once
    // they authenticate, the sb-*-auth-token cookie shows up and the
    // rewrite kicks in on the next navigation.
    if (
      shouldRewriteToFormulas(pathname) &&
      looksSignedIn(request) &&
      !skipDueToSignInFlag
    ) {
      const rewriteUrl = request.nextUrl.clone();
      rewriteUrl.pathname =
        pathname === "/" ? "/formulas" : `/formulas${pathname}`;
      rewriteUrl.search = search;
      const rewriteResponse = NextResponse.rewrite(rewriteUrl, { request });
      // Forward the auth session cookies onto the rewrite response so
      // sign-in state survives the URL swap.
      authResponse.cookies.getAll().forEach((cookie) => {
        rewriteResponse.cookies.set(cookie);
      });
      return rewriteResponse;
    }
  }

  // Same shape as the formula rewrite. meeting.pharmacenter.app fronts
  // /meetings — a visitor at meeting.<domain>/ gets rewritten to
  // /meetings, and any sub-path is prefixed the same way. Loop guard,
  // signed-in heuristic, and cookie forwarding all mirror above.
  if (isMeetingHost(host)) {
    const { pathname, search, searchParams } = request.nextUrl;
    const skipDueToSignInFlag = searchParams.get("showSignIn") === "1";
    if (
      shouldRewriteToMeetings(pathname) &&
      looksSignedIn(request) &&
      !skipDueToSignInFlag
    ) {
      const rewriteUrl = request.nextUrl.clone();
      rewriteUrl.pathname =
        pathname === "/" ? "/meetings" : `/meetings${pathname}`;
      rewriteUrl.search = search;
      const rewriteResponse = NextResponse.rewrite(rewriteUrl, { request });
      authResponse.cookies.getAll().forEach((cookie) => {
        rewriteResponse.cookies.set(cookie);
      });
      return rewriteResponse;
    }
  }

  // orders host — same rewrite pattern; fronts /orders (the sales-order
  // status tracker landing).
  if (isOrderHost(host)) {
    const { pathname, search, searchParams } = request.nextUrl;
    const skipDueToSignInFlag = searchParams.get("showSignIn") === "1";
    if (
      shouldRewriteToOrders(pathname) &&
      looksSignedIn(request) &&
      !skipDueToSignInFlag
    ) {
      const rewriteUrl = request.nextUrl.clone();
      rewriteUrl.pathname =
        pathname === "/" ? "/orders" : `/orders${pathname}`;
      rewriteUrl.search = search;
      const rewriteResponse = NextResponse.rewrite(rewriteUrl, { request });
      authResponse.cookies.getAll().forEach((cookie) => {
        rewriteResponse.cookies.set(cookie);
      });
      return rewriteResponse;
    }
  }

  return authResponse;
}

export const config = {
  matcher: [
    /*
     * Match all request paths except:
     * - _next/static (static files)
     * - _next/image (image optimization files)
     * - favicon.ico
     * - public assets (.svg, .png, .jpg, .jpeg, .gif, .webp)
     */
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|mjs)$).*)",
  ],
};
