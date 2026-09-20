"use client";

import { useEffect, useState } from "react";

// ---------------------------------------------------------------
// Client-side access-control helpers.
//
// "Effective admin" is the answer to "should the UI grant admin-only
// affordances right now?". It collapses two inputs:
//   1. The server-truth `isAdmin` flag returned from /api/me
//   2. A local "view as user" override that admins toggle to see the
//      restricted view non-admins see (useful for testing).
//
// The override is persisted in an apex-domain cookie so it survives
// reloads AND follows the admin across every PharmaCenter subdomain. A
// custom DOM event keeps components in sync within a tab; a throwaway
// localStorage write keeps other tabs on this origin in sync.
// ---------------------------------------------------------------

// Stored in a COOKIE scoped to .pharmacenter.app, not localStorage.
//
// It was localStorage until 2026-09-20, and localStorage is per-origin: an
// admin who flipped "view as user" on quote.pharmacenter.app was still in
// full admin view on packing.pharmacenter.app, formula.pharmacenter.app and
// orders.pharmacenter.app. One setting, four answers -- exactly the shape of
// finding I2, where the language toggle did not follow the user either. The
// fix is the one I2 used: an apex-domain cookie.
export const VIEW_AS_USER_COOKIE = "pc-view-as-user";
/** The pre-2026-09-20 localStorage key. Read once, to migrate, then cleared. */
export const LEGACY_VIEW_AS_USER_KEY = "quote.viewAsUser";
export const VIEW_AS_USER_EVENT = "quote:view-mode-changed";

function readCookie(name: string): string | null {
  if (typeof document === "undefined") return null;
  const hit = document.cookie
    .split("; ")
    .find((c) => c.startsWith(`${name}=`));
  return hit ? decodeURIComponent(hit.slice(name.length + 1)) : null;
}

export function readViewAsUser(): boolean {
  if (typeof window === "undefined") return false;
  if (readCookie(VIEW_AS_USER_COOKIE) === "1") return true;
  // One-release migration: an admin who left the old flag set should not be
  // silently flipped back into admin view by this change.
  try {
    if (window.localStorage.getItem(LEGACY_VIEW_AS_USER_KEY) === "1") {
      setViewAsUser(true);
      return true;
    }
  } catch {
    // Private mode. Nothing to migrate.
  }
  return false;
}

export function setViewAsUser(next: boolean): void {
  if (typeof window === "undefined") return;

  const onProdDomain = window.location.hostname === "pharmacenter.app" || window.location.hostname.endsWith(".pharmacenter.app");
  const domain = onProdDomain ? "; domain=.pharmacenter.app" : "";
  // Same trap LangToggle documents: a browser will hold a host-only cookie
  // AND an apex-domain cookie under one name, and the server reads whichever
  // the request header lists first. Clear the host-only variant before
  // writing, so the new value is the only one there is.
  if (onProdDomain) {
    document.cookie = `${VIEW_AS_USER_COOKIE}=; path=/; max-age=0`;
  }
  document.cookie = next
    ? `${VIEW_AS_USER_COOKIE}=1; path=/${domain}; max-age=${60 * 60 * 24 * 30}; samesite=lax`
    : `${VIEW_AS_USER_COOKIE}=; path=/${domain}; max-age=0; samesite=lax`;

  try {
    window.localStorage.removeItem(LEGACY_VIEW_AS_USER_KEY);
    // The cookie is the source of truth; this write exists ONLY to fire the
    // `storage` event, which is still the cheapest way to tell other tabs on
    // this origin to re-read. Cookies raise no such event.
    window.localStorage.setItem(VIEW_AS_USER_COOKIE, next ? "1" : "0");
  } catch {
    // Private mode - the toggle still works, other tabs just won't follow
    // until they navigate.
  }
  window.dispatchEvent(new CustomEvent(VIEW_AS_USER_EVENT));
}

// React hook: fetches /api/me once, then subscribes to view-mode changes.
// Returns `{ loaded, isAdmin, viewAsUser, effectiveAdmin }`.
// `effectiveAdmin = isAdmin && !viewAsUser` — the value gates feature
// enablement in the UI.
export function useEffectiveAdmin(): {
  loaded: boolean;
  isAdmin: boolean;
  viewAsUser: boolean;
  effectiveAdmin: boolean;
} {
  const [loaded, setLoaded] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);
  const [viewAsUser, setViewAsUserState] = useState<boolean>(() => readViewAsUser());

  useEffect(() => {
    let cancelled = false;
    fetch("/api/me", { cache: "no-store" })
      .then((res) => res.json())
      .then((data) => {
        if (cancelled) return;
        setIsAdmin(!!data?.isAdmin);
        setLoaded(true);
      })
      .catch(() => {
        if (cancelled) return;
        setIsAdmin(false);
        setLoaded(true);
      });
    function onChange() {
      setViewAsUserState(readViewAsUser());
    }
    window.addEventListener(VIEW_AS_USER_EVENT, onChange);
    // Also react to other tabs flipping the same key.
    window.addEventListener("storage", onChange);
    return () => {
      cancelled = true;
      window.removeEventListener(VIEW_AS_USER_EVENT, onChange);
      window.removeEventListener("storage", onChange);
    };
  }, []);

  return {
    loaded,
    isAdmin,
    viewAsUser,
    effectiveAdmin: isAdmin && !viewAsUser,
  };
}
