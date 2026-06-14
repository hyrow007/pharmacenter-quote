import Link from "next/link";
import { SignOutButton } from "../auth-buttons";
import NavLinks from "./NavLinks";

// Top navigation bar — sits flush on every signed-in page. Mirrors the look
// of the sister Packing List app: small circular brand mark, two-line title,
// horizontal links, signed-in email + sign-out on the right.
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
          <span className="app-nav__mark" aria-hidden="true">
            <svg width="32" height="32" viewBox="0 0 32 32">
              <circle cx="13" cy="13" r="11" fill="var(--teal-900)" />
              <circle
                cx="20"
                cy="20"
                r="8"
                fill="var(--green)"
                fillOpacity="0.55"
              />
            </svg>
          </span>
          <span className="app-nav__brand-text">
            <span className="app-nav__brand-top">PHARMACENTER</span>
            <span className="app-nav__brand-bottom">Quote Generator</span>
          </span>
        </Link>

        <span className="app-nav__divider" aria-hidden="true" />

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
