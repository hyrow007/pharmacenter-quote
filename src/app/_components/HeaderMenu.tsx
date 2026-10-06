"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { usePathname } from "next/navigation";

// The ☰ menu on the right of the header band.
//
// The band used to carry everything at once: nav links, the Fishbowl sync
// button, the admin-view pill, the signed-in email and sign-out. On the
// packing list that was eight controls in a row and it read as clutter. Now
// the band keeps the identity (wordmark + product) and the language toggle,
// and everything else lives one click away in here.
//
// Deliberately a disclosure, not an ARIA menu: the panel holds links, toggle
// buttons and plain text, and `role="menu"` would promise arrow-key semantics
// that none of those children implement. aria-expanded on the trigger plus
// aria-controls on the panel is the honest description of what this is.
//
// THIS FILE IS DUPLICATED VERBATIM IN pharmacenter-packing-list, like
// SyncNowButton.tsx, freshness.ts and app-chrome.css. There is no shared
// package between the repos -- change one, change the other.
export default function HeaderMenu({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const pathname = usePathname();

  // Navigating away closes it. Without this the panel survives a client-side
  // route change and sits open over the page the user just asked for.
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: MouseEvent | TouchEvent) {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      setOpen(false);
      // Send focus back to the trigger rather than leaving it on a node that
      // is about to unmount -- otherwise the next Tab starts from the top of
      // the document.
      btnRef.current?.focus();
    }
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("touchstart", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("touchstart", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div className="app-nav__menu" ref={wrapRef}>
      <button
        ref={btnRef}
        type="button"
        className={`app-nav__menu-btn${open ? " is-open" : ""}`}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls="app-nav-menu-panel"
        aria-label={label}
        title={label}
      >
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          aria-hidden="true"
        >
          <path d="M4 7h16" />
          <path d="M4 12h16" />
          <path d="M4 17h16" />
        </svg>
      </button>
      {open ? (
        <div
          id="app-nav-menu-panel"
          className="app-nav__menu-panel"
          // Any link closes the panel; buttons do not. Sync in particular has
          // to stay visible after the click -- it is the only place its
          // running state and its result tooltip are shown.
          onClick={(e) => {
            if ((e.target as HTMLElement).closest("a")) setOpen(false);
          }}
        >
          {children}
        </div>
      ) : null}
    </div>
  );
}
