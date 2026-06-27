import { redirect } from "next/navigation";
import { createClient } from "@/lib/auth/server";
import { isAdmin as checkIsAdmin } from "@/lib/workflows";
import AppHeader from "../_components/AppHeader";
import AdminPanel, { type AdminPanelUser } from "./AdminPanel";

// /admin — back-office page only admins should reach. We hide the nav
// link client-side for non-admins, but also enforce it here so a typed-in
// URL doesn't bypass the gate.
//
// Server-renders:
//   - The current `admins` table content (emails + when they were added).
//   - A directory of every signed-in PharmaCenter user (from
//     public.user_directory) so the admin can promote/demote quickly.
//   - A small row of "feels-good" counts: workflows, customers, vendors,
//     feedback posts.
//
// All mutations live in <AdminPanel/> (client) which posts to the
// /api/admin/admins routes.

type AdminRow = {
  email: string;
  added_at?: string | null;
};

type DirectoryRow = {
  email: string;
  display_name: string | null;
};

async function safeCount(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: any,
  table: string,
): Promise<number> {
  try {
    const { count } = await supabase
      .from(table)
      .select("*", { count: "exact", head: true });
    return typeof count === "number" ? count : 0;
  } catch {
    return 0;
  }
}

export default async function AdminPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user || !user.email?.endsWith("@pharmacenterusa.com")) {
    redirect("/");
  }
  const admin = await checkIsAdmin(supabase, user.email);
  if (!admin) {
    // Non-admins don't get to see the page even if they typed the URL.
    redirect("/workflows");
  }

  const [adminsRes, directoryRes, workflowsN, customersN, vendorsN, feedbackN] =
    await Promise.all([
      supabase.from("admins").select("email").order("email"),
      supabase
        .from("user_directory")
        .select("email, display_name")
        .order("email"),
      safeCount(supabase, "workflows"),
      safeCount(supabase, "customers"),
      safeCount(supabase, "vendors"),
      safeCount(supabase, "feedback"),
    ]);

  const adminEmails = ((adminsRes.data ?? []) as AdminRow[]).map((r) =>
    r.email.toLowerCase(),
  );
  const adminSet = new Set(adminEmails);

  const users: AdminPanelUser[] = ((directoryRes.data ?? []) as DirectoryRow[]).map(
    (r) => ({
      email: r.email,
      displayName: r.display_name,
      isAdmin: adminSet.has(r.email.toLowerCase()),
    }),
  );
  // Sort: admins first, then everyone else by email.
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
            <h1 className="page-header__title" style={{ marginBottom: 6 }}>
              Admin
            </h1>
            <p className="lede" style={{ marginTop: 4, marginBottom: 0 }}>
              Manage who has elevated access, peek at the user directory,
              and keep an eye on the moving parts.
            </p>
          </div>

          <AdminPanel
            currentUserEmail={user.email!}
            initialUsers={users}
            stats={{
              workflows: workflowsN,
              customers: customersN,
              vendors: vendorsN,
              feedback: feedbackN,
            }}
          />
        </div>
      </main>
    </div>
  );
}
