import Link from "next/link";
import { headers } from "next/headers";
import { createClient } from "@/lib/auth/server";
import { isAdmin as checkIsAdmin } from "@/lib/workflows";
import { SignOutButton } from "../auth-buttons";
import AdminToggle from "./AdminToggle";
import NavLinks from "./NavLinks";

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

type Props = {
  user: { email: string };
};

export default async function AppHeader({ user }: Props) {
  const supabase = await createClient();
  const admin = await checkIsAdmin(supabase, user.email);

  // v48.7: the two subdomains now present themselves as separate
  // products — the quote site doesn't link to Formulas and the formula
  // site doesn't link to Workflows (middleware already 308s stray
  // /formulas hits on the quote host). Host is read server-side and
  // passed down so the client nav renders the right set on first paint.
  const host = (await headers()).get("host") ?? "";
  const onFormulaHost = host.startsWith("formula.");

  return (
    <header className="app-nav">
      <div className="app-nav__inner">
        <Link href={onFormulaHost ? "/" : "/workflows"} className="app-nav__brand">
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
          <span className="app-nav__divider" aria-hidden="true" />
          <span className="app-nav__product">
            {/* v48.8: each subdomain wears its own product name. */}
            <span className="app-nav__product-main">
              {onFormulaHost ? "Formulas" : "Quote"}
            </span>
            <span className="app-nav__product-sub">
              {onFormulaHost ? "Catalog" : "Work Flows"}
            </span>
          </span>
        </Link>

        <NavLinks onFormulaHost={onFormulaHost} />

        <div className="app-nav__user">
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
