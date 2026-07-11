"use client";

// v50.1: carries the language preference through client component trees
// (the formula editor and its subcomponents) without threading a prop
// through every level. Server pages read the cookie and wrap their
// client islands in <I18nProvider lang={lang}>.

import { createContext, useContext } from "react";
import type { Lang } from "./dict";

const LangContext = createContext<Lang>("en");

export function I18nProvider({
  lang,
  children,
}: {
  lang: Lang;
  children: React.ReactNode;
}) {
  return <LangContext.Provider value={lang}>{children}</LangContext.Provider>;
}

export function useLang(): Lang {
  return useContext(LangContext);
}
