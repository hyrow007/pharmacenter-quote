import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import AppHeader from "../_components/AppHeader";
import { getLangFromCookie } from "@/lib/i18n/server";
import { makeT, type DictKey } from "@/lib/i18n/dict";

// The apex landing: pharmacenter.app.
//
// Replaces a Wix page that had been the front door since 2023 and listed
// Google Drive folders by department. That page now lives at
// old.pharmacenter.app; this one lists the apps instead (Meetings is hidden
// until it is built out -- see the `hidden` flag below).
//
// Signed-in only, like every other surface. There is no redirect loop to worry
// about: an unauthenticated visitor never reaches this page, because the apex
// "/" is src/app/page.tsx, which renders the sign-in card and only sends a
// signed-in user here. That is also why this needs no middleware rewrite --
// the apex simply isn't a vanity host and falls through to the app.
//
// Tile titles have their own dictionary keys, not the nav ones. A nav label is
// read underneath a wordmark that already names the product -- "Lists" is fine
// there. Standing alone in a list of five tools it is not, which is exactly
// what went wrong the first time this page was written.

export const dynamic = "force-dynamic";

type Tool = {
  key: string;
  href: string;
  titleKey: DictKey;
  descKey: DictKey;
  icon: React.ReactNode;
  // Built, named and translated, but not ready to be handed to anyone yet.
  // Kept in the array rather than deleted so restoring it is one word, and so
  // the tile, its icon and its two dictionary keys never drift apart while it
  // waits. Filtered out at render -- see VISIBLE_TOOLS.
  hidden?: boolean;
};

// Stroke icons rather than glyphs or emoji: they take currentColor, so each
// one picks up the tile's ink in light and dark, and they hold their weight at
// the 26px they render at. Same visual family as the star in NavLinks.
const ICON = {
  strokeWidth: 1.6,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  fill: "none",
  stroke: "currentColor",
  width: 26,
  height: 26,
  viewBox: "0 0 24 24",
  "aria-hidden": true,
};

const TOOLS: Tool[] = [
  {
    key: "quote",
    href: "https://quote.pharmacenter.app/workflows",
    titleKey: "hubQuoteName",
    descKey: "hubQuoteDesc",
    // A branching flow: one node splitting into two.
    icon: (
      <svg {...ICON}>
        <circle cx="5" cy="12" r="2.2" />
        <circle cx="19" cy="6" r="2.2" />
        <circle cx="19" cy="18" r="2.2" />
        <path d="M7.2 11 17 6.8M7.2 13 17 17.2" />
      </svg>
    ),
  },
  {
    key: "lists",
    href: "https://packing.pharmacenter.app/lists",
    titleKey: "hubListsName",
    descKey: "hubListsDesc",
    // A shipping carton, seam down the middle.
    icon: (
      <svg {...ICON}>
        <path d="M3 8.2 12 4l9 4.2v7.6L12 20l-9-4.2V8.2Z" />
        <path d="M3 8.2 12 12.4l9-4.2M12 12.4V20" />
      </svg>
    ),
  },
  {
    key: "formulas",
    href: "https://formula.pharmacenter.app/formulas",
    titleKey: "hubFormulasName",
    descKey: "hubFormulasDesc",
    // A lab flask with a fill line.
    icon: (
      <svg {...ICON}>
        <path d="M10 3h4M10.8 3v6.1L5.4 17.6A2 2 0 0 0 7.1 20.7h9.8a2 2 0 0 0 1.7-3.1L13.2 9.1V3" />
        <path d="M7.9 14.5h8.2" />
      </svg>
    ),
  },
  {
    key: "orders",
    href: "https://orders.pharmacenter.app/",
    titleKey: "hubOrdersName",
    descKey: "hubOrdersDesc",
    // A clipboard with a checked line — order tracking, not a generic doc.
    icon: (
      <svg {...ICON}>
        <path d="M9 4.5H7.6A1.6 1.6 0 0 0 6 6.1v13.3A1.6 1.6 0 0 0 7.6 21h8.8a1.6 1.6 0 0 0 1.6-1.6V6.1A1.6 1.6 0 0 0 16.4 4.5H15" />
        <rect x="9" y="3" width="6" height="3" rx="1" />
        <path d="M9.2 12.4l1.7 1.7 3.9-3.9" />
      </svg>
    ),
  },
  {
    key: "meetings",
    href: "https://meeting.pharmacenter.app/meetings",
    titleKey: "hubMeetingsName",
    descKey: "hubMeetingsDesc",
    // Hidden 2026-09-20: Meetings is not built out. Set this to false (or
    // delete the line) to put the tile back.
    hidden: true,
    // Two overlapping speech bubbles — a recurring conversation, not a date.
    icon: (
      <svg {...ICON}>
        <path d="M14.5 13.2a1.8 1.8 0 0 1-1.8 1.8H7.4L4.3 17.7V6.3a1.8 1.8 0 0 1 1.8-1.8h6.6a1.8 1.8 0 0 1 1.8 1.8Z" />
        <path d="M17.2 8.6h.7a1.8 1.8 0 0 1 1.8 1.8v9.3l-2.8-2.4h-4.3" />
      </svg>
    ),
  },
];

const VISIBLE_TOOLS = TOOLS.filter((tool) => !tool.hidden);

export default async function HubPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/");

  const lang = await getLangFromCookie();
  const t = makeT(lang);

  return (
    <div className="app-shell">
      <AppHeader user={{ email: user.email! }} appContext="hub" />
      <main className="page">
        <div className="page__inner">
          <div style={{ marginBottom: 28 }}>
            <p className="eyebrow" style={{ marginBottom: 6 }}>
              {t("hubEyebrow")}
            </p>
            <h1 className="page-header__title" style={{ marginBottom: 6 }}>
              {t("hubTitle")}
            </h1>
            <p className="lede" style={{ marginTop: 4 }}>
              {t("hubLede")}
            </p>
          </div>

          <ul className="hub-grid">
            {VISIBLE_TOOLS.map((tool) => (
              <li key={tool.key}>
                {/* The whole tile is the link, so the target is the card
                    rather than a word inside it. */}
                <a className="hub-tile" href={tool.href}>
                  <span className="hub-tile__icon">{tool.icon}</span>
                  <span className="hub-tile__body">
                    <span className="hub-tile__name">{t(tool.titleKey)}</span>
                    <span className="hub-tile__desc">{t(tool.descKey)}</span>
                  </span>
                  <span className="hub-tile__go" aria-hidden="true">
                    {t("hubOpen")} &rarr;
                  </span>
                </a>
              </li>
            ))}
          </ul>
        </div>
      </main>
    </div>
  );
}
