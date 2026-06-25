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
// The override is persisted in localStorage so it survives reloads on
// the same browser. A custom DOM event keeps multiple components in
// sync without prop drilling.
// ---------------------------------------------------------------

export const VIEW_AS_USER_KEY = "quote.viewAsUser";
export const VIEW_AS_USER_EVENT = "quote:view-mode-changed";

export function readViewAsUser(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(VIEW_AS_USER_KEY) === "1";
  } catch {
    return false;
  }
}

export function setViewAsUser(next: boolean): void {
  if (typeof window === "undefined") return;
  try {
    if (next) {
      window.localStorage.setItem(VIEW_AS_USER_KEY, "1");
    } else {
      window.localStorage.removeItem(VIEW_AS_USER_KEY);
    }
  } catch {
    // Ignore — private mode or quota issues. The toggle just won't persist.
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
