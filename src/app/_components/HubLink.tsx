import { hubHrefForHost } from "@/lib/hub-href";

// The way back to the apex hub, first entry in every app's header menu.
//
// Until 2026-10-07 nothing inside any app linked to the hub. The nav listed
// the four sister apps and the formula catalog grew its own "back to
// workflows" pill, which pointed at /workflows -- a path that does not exist
// on the formula host, because middleware rewrites "/" to /formulas there. So
// the one exit anybody had built was also broken everywhere except the host it
// was written on. One entry, in the shared chrome, in the same place in every
// app, is the fix; the formula pill is redundant once this ships.
//
// Not rendered on the hub itself -- see the appContext check at each call
// site.
//
// THIS FILE IS DUPLICATED VERBATIM in pharmacenter-packing-list. Change one,
// change the other.
export default function HubLink({ host, label }: { host: string; label: string }) {
  return (
    <a href={hubHrefForHost(host)} className="app-nav__link app-nav__link--hub">
      <svg
        width="13"
        height="13"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        style={{ marginRight: 7, verticalAlign: "-2px", flex: "none" }}
      >
        <rect x="3" y="3" width="7" height="7" rx="1.6" />
        <rect x="14" y="3" width="7" height="7" rx="1.6" />
        <rect x="3" y="14" width="7" height="7" rx="1.6" />
        <rect x="14" y="14" width="7" height="7" rx="1.6" />
      </svg>
      {label}
    </a>
  );
}
