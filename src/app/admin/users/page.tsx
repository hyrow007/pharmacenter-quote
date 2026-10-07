import Link from "next/link";
import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { isAdmin as checkIsAdmin } from "@/lib/workflows";
import { HUB_HOSTS } from "@/lib/hub-hosts";
import AppHeader from "../../_components/AppHeader";
import AdminPanel, { type AdminPanelUser } from "../AdminPanel";

// /admin/users — one users screen for the whole ecosystem.
//
// There were two. This app's /admin had the admins table and promote/demote;
// packing's /admin/users had the same people with their activity (lists
// prepared, last seen) and no way to change anything. Two screens, one
// question, and whichever one you opened answered half of it.
//
// Data comes from the admin_list_users RPC, which packing used -- a database
// function in the one shared Supabase project, so the host it is called from
// does not matter. If it is unavailable for any reason the page falls back to
// user_directory plus the admins table: the same people, minus the activity
// columns. A directory without activity beats a page that renders nothing
// because an RPC moved.

export const metadata = { title: "Admin · Users" };
export const dynamic = "force-dynamic";

type RpcRow = {
  email: string;
  display_name: string | null;
  is_admin: boolean;
  last_seen_at: string | null;
  lists_prepared: number | null;
};

type DirectoryRow = { email: string; display_name: string | null };
type AdminRow = { email: string };

export default async function AdminUsersPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user || !user.email?.endsWith("@pharmacenterusa.com")) redirect("/");

  const host = (await headers()).get("host") ?? "";
  const onApexHost = HUB_HOSTS.has(host.split(":")[0].replace(/^www\./, ""));

  if (!(await checkIsAdmin(supabase, user.email))) {
    redirect(onApexHost ? "/" : "/workflows");
  }

  let users: AdminPanelUser[] = [];
  let degraded = false;

  const { data: rpcData, error: rpcError } = await supabase.rpc("admin_list_users");
  if (!rpcError && Array.isArray(rpcData)) {
    users = (rpcData as RpcRow[]).map((r) => ({
      email: r.email,
      displayName: r.display_name,
      isAdmin: !!r.is_admin,
      lastSeenAt: r.last_seen_at,
      listsPrepared: typeof r.lists_prepared === "number" ? r.lists_prepared : null,
    }));
  } else {
    degraded = true;
    if (rpcError) console.error("[admin/users] admin_list_users failed", rpcError);
    const [adminsRes, directoryRes] = await Promise.all([
      supabase.from("admins").select("email").order("email"),
      supabase.from("user_directory").select("email, display_name").order("email"),
    ]);
    const adminSet = new Set(
      ((adminsRes.data ?? []) as AdminRow[]).map((r) => r.email.toLowerCase()),
    );
    users = ((directoryRes.data ?? []) as DirectoryRow[]).map((r) => ({
      email: r.email,
      displayName: r.display_name,
      isAdmin: adminSet.has(r.email.toLowerCase()),
    }));
  }

  // Admins first, then everyone else by email.
  users.sort((a, b) => {
    if (a.isAdmin !== b.isAdmin) return a.isAdmin ? -1 : 1;
    return a.email.localeCompare(b.email);
  });

  return (
    <div className="app-shell">
      <AppHeader user={{ email: user.email! }} />
      <main className="page">
        <div className="page__inner--narrow">
          <div style={{ marginBottom: 18 }}>
            <p className="eyebrow" style={{ marginBottom: 6 }}>
              <Link href="/admin" style={{ color: "inherit", textDecoration: "none" }}>
                &larr; Admin
              </Link>
            </p>
            <h1 className="page-header__title" style={{ marginBottom: 6 }}>
              Users &amp; admins
            </h1>
            <p className="lede" style={{ marginTop: 4, marginBottom: 0 }}>
              Everyone who has signed in to any PharmaCenter app. Promoting
              someone takes effect the next time they reload.
            </p>
          </div>

          {degraded ? (
            <div
              style={{
                background: "#fffaf0",
                border: "1px solid #f0dfb8",
                borderRadius: 8,
                color: "#7a5a1d",
                fontSize: 13,
                padding: "10px 14px",
                marginBottom: 16,
                lineHeight: 1.5,
              }}
            >
              Showing the directory without activity &mdash; the
              <code style={{ margin: "0 4px" }}>admin_list_users</code>
              function did not answer. Promote and remove still work.
            </div>
          ) : null}

          <AdminPanel currentUserEmail={user.email!} initialUsers={users} />
        </div>
      </main>
    </div>
  );
}
