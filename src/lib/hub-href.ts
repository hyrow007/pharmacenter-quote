// Where the "Your tools" link in the header menu points, from inside an app.
//
// The hub is served on BOTH pharmacenter.app and pharmacenter.tools, and a
// sign-in on one does not carry to the other -- the Supabase auth cookie is
// scoped per registrable domain. A hard-coded https://pharmacenter.app/ would
// therefore hand anyone working on the .tools side a sign-in page instead of
// the hub. So the link stays on whichever domain the visitor is already on.
//
// Same reasoning as the roadmap link in NavLinks, which is relative for
// exactly this reason.
//
// THIS FILE IS DUPLICATED VERBATIM in pharmacenter-packing-list/src/lib/
// hub-href.ts, like freshness.ts, app-chrome.css, SyncNowButton.tsx and
// HeaderMenu.tsx. There is no shared package -- change one, change the other.
export function hubHrefForHost(host: string): string {
  const bare = host.split(":")[0].replace(/^www\./, "").toLowerCase();
  return bare === "pharmacenter.tools" || bare.endsWith(".pharmacenter.tools")
    ? "https://pharmacenter.tools/"
    : "https://pharmacenter.app/";
}
