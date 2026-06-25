"use client";

import { useEffect, useState } from "react";
import { readViewAsUser, setViewAsUser, VIEW_AS_USER_EVENT } from "@/lib/access";

// Small pill rendered in the AppHeader for admins only. Lets an admin
// flip into "view as user" mode so they see the restricted UI a
// non-admin would. Persists across reloads (localStorage) and broadcasts
// to other open tabs via the storage event.

export default function AdminToggle() {
  const [viewAsUser, setLocal] = useState<boolean>(false);

  useEffect(() => {
    setLocal(readViewAsUser());
    function onChange() {
      setLocal(readViewAsUser());
    }
    window.addEventListener(VIEW_AS_USER_EVENT, onChange);
    window.addEventListener("storage", onChange);
    return () => {
      window.removeEventListener(VIEW_AS_USER_EVENT, onChange);
      window.removeEventListener("storage", onChange);
    };
  }, []);

  function onClick() {
    const next = !viewAsUser;
    setViewAsUser(next);
    setLocal(next);
  }

  // Two visual states share the same control:
  //   - Admin mode (default): teal pill, "Admin view".
  //   - View-as-user mode: amber pill, "Viewing as user · Click to exit".
  // The amber colour is meant to nag the admin that what they see is
  // intentionally restricted, so they don't waste time on a "bug".
  return (
    <button
      type="button"
      onClick={onClick}
      title={
        viewAsUser
          ? "Currently viewing the restricted user view. Click to switch back to admin."
          : "Click to preview the restricted user view."
      }
      style={{
        background: viewAsUser ? "#fef3c7" : "#ecfeff",
        color: viewAsUser ? "#92400e" : "#0f4a56",
        border: `1px solid ${viewAsUser ? "#fcd34d" : "#a7e3df"}`,
        padding: "6px 12px",
        borderRadius: 999,
        fontSize: 12,
        fontWeight: 700,
        letterSpacing: "0.04em",
        textTransform: "uppercase",
        cursor: "pointer",
        whiteSpace: "nowrap",
        marginRight: 10,
        fontFamily: "inherit",
      }}
    >
      {viewAsUser ? "Viewing as User" : "Admin View"}
    </button>
  );
}
