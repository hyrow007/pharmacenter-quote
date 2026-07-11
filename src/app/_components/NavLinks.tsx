"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffectiveAdmin } from "@/lib/access";
import { makeT, type Lang } from "@/lib/i18n/dict";

// Client-side child of <AppHeader/>. Pulls the current pathname so we can
// underline the active nav link. Kept tiny on purpose — the rest of the
// header stays a server component so user data doesn't have to hop the
// client boundary.
//
// The Admin link is gated on effectiveAdmin so:
//   - Non-admin users never see it (they wouldn't be allowed past the
//     /admin page guard anyway).
//   - Admins in "viewing as user" mode also lose it, which is what we
//     want — the toggle is a way for the admin to verify what a normal
//     user sees, so the Admin link should disappear with everything else.
// The AdminToggle pill itself stays visible in the user-row of AppHeader,
// so an admin can always flip back to admin view.

// v48.7: `onFormulaHost` comes from AppHeader (server-side host read).
// The formula site hides the Workflows link, the quote site hides the
// Formulas link — each subdomain presents as its own product.
export default function NavLinks({
  onFormulaHost,
  appContext,
  lang,
}: {
  onFormulaHost: boolean;
  appContext: "quote" | "formulas" | "packing-list";
  lang: Lang;
}) {
  const pathname = usePathname() || "";
  const { effectiveAdmin } = useEffectiveAdmin();
  const t = makeT(lang);

  const isWorkflows =
    pathname === "/workflows" || pathname.startsWith("/workflow/") || pathname === "/start";
  const isFormulas = pathname.startsWith("/formulas");
  const isFeedback = pathname.startsWith("/feedback");
  const isAdmin = pathname.startsWith("/admin");

  return (
    <nav className="app-nav__links" aria-label="Primary">
      {/* v49.2: the primary link matches the app the visitor is in or
          arrived from — quote gets Workflows, formulas gets Formulas,
          packing list gets Lists. */}
      {appContext === "quote" ? (
        <Link
          href="/workflows"
          className={`app-nav__link${isWorkflows ? " app-nav__link--active" : ""}`}
        >
          {t("navWorkflows")}
        </Link>
      ) : null}
      {appContext === "formulas" ? (
        <Link
          href={onFormulaHost ? "/formulas" : "https://formula.pharmacenter.app/formulas"}
          className={`app-nav__link${isFormulas ? " app-nav__link--active" : ""}`}
        >
          {t("navFormulas")}
        </Link>
      ) : null}
      {appContext === "packing-list" ? (
        <a href="https://packing.pharmacenter.app/lists" className="app-nav__link">
          {t("navLists")}
        </a>
      ) : null}
      {/* v49: Feedback and Admin are canonical on the quote host and
          shared by all PharmaCenter apps (packing list links here too).
          From the formula subdomain they're absolute URLs — a relative
          /feedback there would get rewritten into /formulas/feedback. */}
      <Link
        href={
          onFormulaHost
            ? "https://quote.pharmacenter.app/feedback?from=formulas"
            : appContext === "quote"
              ? "/feedback"
              : `/feedback?from=${appContext}`
        }
        className={`app-nav__link${isFeedback ? " app-nav__link--active" : ""}`}
      >
        {t("navFeedback")}
      </Link>
      {effectiveAdmin ? (
        <Link
          href={onFormulaHost ? "https://quote.pharmacenter.app/admin" : "/admin"}
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
          {t("navAdmin")}
        </Link>
      ) : null}
    </nav>
  );
}
