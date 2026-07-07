import { NextResponse, type NextRequest } from "next/server";
import { updateSession } from "@/lib/auth/middleware";

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
  return host.startsWith("formula.");
}

function shouldRewriteToFormulas(pathname: string): boolean {
  if (pathname.startsWith("/api")) return false;
  if (pathname.startsWith("/auth")) return false;
  if (pathname.startsWith("/formulas")) return false;
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
  if (isFormulaHost(host)) {
    const { pathname, search } = request.nextUrl;
    // Anonymous visitor hitting the formula subdomain: skip the
    // rewrite so they land on the sign-in page at "/" instead of
    // bouncing between "/" → "/formulas" → redirect("/") forever. Once
    // they authenticate, the sb-*-auth-token cookie shows up and the
    // rewrite kicks in on the next navigation.
    if (shouldRewriteToFormulas(pathname) && looksSignedIn(request)) {
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
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
