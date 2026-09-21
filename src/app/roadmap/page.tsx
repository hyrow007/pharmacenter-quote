import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { isAdmin as checkIsAdmin } from "@/lib/workflows";
import AppHeader from "../_components/AppHeader";
import { getLangFromCookie } from "@/lib/i18n/server";
import { makeT } from "@/lib/i18n/dict";
import type { RoadmapItem } from "@/lib/roadmap";
import RoadmapBoard from "./RoadmapBoard";

// /roadmap — features and tools the team wants to add. Admin-only, linked from
// the hub's nav (NavLinks, hub context). Wears the hub's header because it is
// about the whole set of tools, not any one of them.
//
// Gated three ways, each for a different reason:
//   - the nav link hides for non-admins (and for admins "viewing as user"),
//   - this page redirects a typed-in URL,
//   - RLS on public.roadmap_items returns nothing to a non-admin at all.
// The first two are courtesy. The third is the one that holds.

export const dynamic = "force-dynamic";

export default async function RoadmapPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user || !user.email?.endsWith("@pharmacenterusa.com")) redirect("/");
  if (!(await checkIsAdmin(supabase, user.email))) redirect("/");

  const lang = await getLangFromCookie();
  const t = makeT(lang);

  const { data, error } = await supabase
    .from("roadmap_items")
    .select("id, title, details, app, status, priority, created_by, created_at, shipped_at")
    .order("priority", { ascending: true })
    .order("created_at", { ascending: false });

  return (
    <div className="app-shell">
      <AppHeader user={{ email: user.email! }} appContext="hub" />
      <main className="page">
        <div className="page__inner">
          <div style={{ marginBottom: 24 }}>
            <p className="eyebrow" style={{ marginBottom: 6 }}>
              {t("rmEyebrow")}
            </p>
            <h1 className="page-header__title" style={{ marginBottom: 6 }}>
              {t("rmTitle")}
            </h1>
            <p className="lede" style={{ marginTop: 4 }}>
              {t("rmLede")}
            </p>
          </div>
          {error ? (
            <p className="roadmap-error" role="alert">
              {t("rmLoadError", { msg: error.message })}
            </p>
          ) : (
            <RoadmapBoard items={(data ?? []) as RoadmapItem[]} lang={lang} />
          )}
        </div>
      </main>
    </div>
  );
}
