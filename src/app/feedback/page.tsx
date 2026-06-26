import { redirect } from "next/navigation";
import { createClient } from "@/lib/auth/server";
import { isAdmin as checkIsAdmin } from "@/lib/workflows";
import AppHeader from "../_components/AppHeader";
import FeedbackBoard, { type FeedbackDisplayRow } from "./FeedbackBoard";

// /feedback — community-style page where signed-in PharmaCenter users can
// post comments, bugs, or feature requests about the Quote app. Mirrors the
// Packing List app's Feedback feature so the two products feel like a set.
//
// Reads happen here (server) for SEO-friendly initial render; writes (post +
// delete) are handled by the API route at /api/feedback. The list is then
// hydrated in <FeedbackBoard/> (client) so new posts appear without a full
// reload.

function titleCase(s: string): string {
  return s
    .split(" ")
    .filter((w) => w.length > 0)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(" ");
}

function localPart(email: string): string {
  const at = email.indexOf("@");
  return at > 0 ? email.slice(0, at) : email;
}

type FeedbackRow = {
  id: string;
  created_at: string;
  author_email: string;
  body: string;
};

export default async function FeedbackPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user || !user.email?.endsWith("@pharmacenterusa.com")) {
    redirect("/");
  }

  const admin = await checkIsAdmin(supabase, user.email);

  const { data: rawRows } = await supabase
    .from("feedback")
    .select("id, created_at, author_email, body")
    .order("created_at", { ascending: false });
  const rows = (rawRows ?? []) as FeedbackRow[];

  // Resolve display names from user_directory (Google SSO full_name view).
  // Fallback to a title-cased local-part of the email when the directory
  // doesn't have an entry yet.
  const emails = Array.from(new Set(rows.map((r) => r.author_email)));
  const displayMap: Record<string, string> = {};
  if (emails.length > 0) {
    const { data: dir } = await supabase
      .from("user_directory")
      .select("email, display_name")
      .in("email", emails);
    for (const d of (dir ?? []) as Array<{ email: string; display_name: string | null }>) {
      if (d.display_name) displayMap[d.email] = d.display_name;
    }
  }

  const display: FeedbackDisplayRow[] = rows.map((r) => ({
    id: r.id,
    createdAt: r.created_at,
    body: r.body,
    authorEmail: r.author_email,
    authorName:
      displayMap[r.author_email] || titleCase(localPart(r.author_email).replace(/[._-]+/g, " ")),
    canDelete: admin || r.author_email === user.email,
  }));

  return (
    <div className="app-shell">
      <AppHeader user={{ email: user.email! }} />
      <main className="page">
        <div className="page__inner--narrow">
          <div style={{ marginBottom: 18 }}>
            <h1 className="page-header__title" style={{ marginBottom: 6 }}>
              Feedback
            </h1>
            <p className="lede" style={{ marginTop: 4, marginBottom: 0 }}>
              Share ideas, bugs, or anything else about the app.
            </p>
          </div>

          <FeedbackBoard initialRows={display} currentUserEmail={user.email!} />
        </div>
      </main>
    </div>
  );
}
