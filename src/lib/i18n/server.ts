// Server-only helper for reading the language cookie during SSR —
// mirrors the packing list's src/lib/i18n/server.ts. Client code
// reads/writes the same cookie via document.cookie (see LangToggle).

import "server-only";
import { cookies } from "next/headers";
import { LANG_COOKIE_NAME, type Lang } from "./dict";

export async function getLangFromCookie(): Promise<Lang> {
  const store = await cookies();
  const raw = store.get(LANG_COOKIE_NAME)?.value;
  return raw === "es" ? "es" : "en";
}
