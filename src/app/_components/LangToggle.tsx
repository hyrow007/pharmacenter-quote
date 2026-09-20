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
    // Kill any stale host-only cookie from an earlier version of this
    // toggle — the browser will happily hold both a host-only cookie
    // and an apex-domain cookie for the same name, and cookies().get()
    // returns whichever the request header lists first. Deleting the
    // host-only variant before writing the new one guarantees the new
    // value wins.
    if (onProdDomain) {
      document.cookie = `${LANG_COOKIE_NAME}=; path=/; max-age=0`;
    }
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
    >
      {label}
    </button>
  );

  return (
    <div className="langtoggle" role="group" aria-label="Language">
      {btn("en", "EN")}
      {btn("es", "ES")}
    </div>
  );
}
