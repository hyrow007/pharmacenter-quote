import { redirect } from "next/navigation";
import { createClient } from "@/lib/auth/server";
import { SignInButton } from "./auth-buttons";

export default async function Home({
  searchParams,
}: {
  searchParams?: Promise<{ auth_error?: string }>;
}) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // Signed-in users land on the workflows inbox so they see every
  // existing quote first. From there, "+ New workflow" → /start?fresh=1
  // is the explicit blank-slate path; clicking a row resumes/edits.
  if (user) redirect("/workflows");

  const params = await searchParams;
  const showError = params?.auth_error === "1";

  return (
    <main className="hero">
      <div className="card">
        <p className="eyebrow">PharmaCenter</p>
        <h1>Quote</h1>
        <p className="lede">
          Tool to internally manage quoting work flows and generate customer
          facing quote documents.
        </p>
        <SignInButton />
        <p className="meta" style={{ marginTop: 18 }}>
          Restricted to <strong>@pharmacenterusa.com</strong> accounts. Use the
          same Google login as the Packing List tool.
        </p>
        {showError ? (
          <p style={{
            marginTop: 14, padding: "10px 14px",
            background: "#fff1f1", border: "1px solid #f5c2c2",
            borderRadius: 8, color: "#7a1d1d", fontSize: 13,
          }}>
            Sign-in didn&rsquo;t complete. Try again &mdash; if it keeps failing,
            check that your account is on @pharmacenterusa.com.
          </p>
        ) : null}
      </div>
    </main>
  );
}
