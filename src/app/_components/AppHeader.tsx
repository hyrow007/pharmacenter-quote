import Link from "next/link";
import { SignOutButton } from "../auth-buttons";
import NavLinks from "./NavLinks";

// Top navigation bar — sits flush on every signed-in page. Mirrors the look
// of the sister Packing List app: real PharmaCenter wordmark on the left,
// product name beside it, horizontal nav, signed-in email + sign-out on the
// right.
//
// Server component so the user's email comes straight from the RSC tree
// without bouncing through the client boundary. The active-link highlight
// is delegated to <NavLinks/> (client) because it needs usePathname.

type Props = {
  user: { email: string };
};

export default function AppHeader({ user }: Props) {
  return (
    <header className="app-nav">
      <div className="app-nav__inner">
        <Link href="/workflows" className="app-nav__brand">
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
            <span className="app-nav__product-main">Quote</span>
            <span className="app-nav__product-sub">Work Flows</span>
          </span>
        </Link>

        <NavLinks />

        <div className="app-nav__user">
          <span className="app-nav__email" title={user.email}>
            {user.email}
          </span>
          <SignOutButton />
        </div>
      </div>
    </header>
  );
}
