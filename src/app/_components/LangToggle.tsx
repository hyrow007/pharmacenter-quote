"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { LANG_COOKIE_NAME, type Lang } from "@/lib/i18n/dict";

// EN/ES pill in the header user row — same placement and behaviour as
// the packing list's LangToggle. Writes the preference cookie, then
// router.refresh() so server components re-render in the new language.
//
// The cookie is scoped to .pharmacenter.app so one toggle follows the
// user across quote / formulas / packing list. On localhost and Vercel
// preview hosts the domain attribute would be rejected, so we fall back
// to a host-only cookie there.

export default function LangToggle({ lang }: { lang: Lang }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const setLang = (next: Lang) => {
    if (next === lang) return;
    const onProdDomain = window.location.hostname.endsWith(".pharmacenter.app");
    const domain = onProdDomain ? "; domain=.pharmacenter.app" : "";
    document.cookie = `${LANG_COOKIE_NAME}=${next}; path=/${domain}; max-age=${
      60 * 60 * 24 * 365
    }; samesite=lax`;
    startTransition(() => router.refresh());
  };

  const btn = (code: Lang, label: string) => (
    <button
      type="button"
      onClick={() => setLang(code)}
      disabled={pending}
      aria-pressed={lang === code}
      style={{
        border: "none",
        background: lang === code ? "var(--teal-700, #1d6c7b)" : "transparent",
        color: lang === code ? "#fff" : "var(--teal-900, #0f4a56)",
        fontSize: 11,
        fontWeight: 700,
        letterSpacing: "0.04em",
        padding: "3px 8px",
        borderRadius: 999,
        cursor: lang === code ? "default" : "pointer",
        opacity: pending ? 0.6 : 1,
      }}
    >
      {label}
    </button>
  );

  return (
    <div
      role="group"
      aria-label="Language"
      style={{
        display: "inline-flex",
        gap: 2,
        padding: 2,
        border: "1px solid var(--line, #e3dcc9)",
        borderRadius: 999,
        background: "var(--paper, #fffdf8)",
      }}
    >
      {btn("en", "EN")}
      {btn("es", "ES")}
    </div>
  );
}
