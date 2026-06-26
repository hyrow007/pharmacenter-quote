"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

// Client-side child of <AppHeader/>. Pulls the current pathname so we can
// underline the active nav link. Kept tiny on purpose — the rest of the
// header stays a server component so user data doesn't have to hop the
// client boundary.

export default function NavLinks() {
  const pathname = usePathname() || "";

  const isWorkflows =
    pathname === "/workflows" || pathname.startsWith("/workflow/") || pathname === "/start";
  const isFeedback = pathname.startsWith("/feedback");
  const isAdmin = pathname.startsWith("/admin");

  return (
    <nav className="app-nav__links" aria-label="Primary">
      <Link
        href="/workflows"
        className={`app-nav__link${isWorkflows ? " app-nav__link--active" : ""}`}
      >
        Workflows
      </Link>
      <Link
        href="/feedback"
        className={`app-nav__link${isFeedback ? " app-nav__link--active" : ""}`}
      >
        Feedback
      </Link>
      <Link
        href="/admin"
        className={`app-nav__link${isAdmin ? " app-nav__link--active" : ""}`}
      >
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="currentColor"
          aria-hidden="true"
          style={{ marginRight: 4, verticalAlign: "-1px" }}
        >
          <path d="M12 2l2.9 6.9L22 10l-5.5 4.8L18.2 22 12 18.3 5.8 22l1.7-7.2L2 10l7.1-1.1L12 2z" />
        </svg>
        Admin
      </Link>
    </nav>
  );
}
