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
    // Match the Packing List sign-in layout exactly: card sits on the
    // LEFT, decorative pills image fills the RIGHT half of the viewport.
    // On narrow screens the image hides and the card centers itself. We
    // override the default centered .hero behavior with an inline grid.
    <main
      style={{
        minHeight: "100vh",
        display: "grid",
        // Card column gets a fixed size so the card itself stays at the
        // same comfortable width regardless of viewport. The image column
        // takes whatever is left. Generous left padding pushes the whole
        // composition rightward to match the Packing List sign-in.
        gridTemplateColumns: "minmax(480px, 540px) 1fr",
        alignItems: "center",
        padding: "32px 0 32px clamp(80px, 14vw, 240px)",
        gap: "clamp(32px, 5vw, 80px)",
        overflow: "hidden",
      }}
    >
      <div
        className="card"
        style={{
          // Match the .card defaults from globals.css exactly so the
          // sign-in card sits at the same size the PL sign-in uses.
          maxWidth: 540,
          padding: "56px 64px",
          justifySelf: "start",
          width: "100%",
        }}
      >
        {/* Wordmark first — the brand image carries "PharmaCenter" so we
            don't repeat the company name in text above it. */}
        <img
          src="/logo.png"
          alt="PharmaCenter"
          style={{
            display: "block",
            width: 180,
            height: "auto",
            marginBottom: 14,
          }}
        />
        <h1 style={{ marginBottom: 0 }}>Quote</h1>
        <p
          style={{
            fontFamily: "var(--font-serif, Georgia, serif)",
            fontStyle: "italic",
            fontSize: 24,
            color: "var(--ink-3, #8a9498)",
            margin: "0 0 18px",
            fontWeight: 400,
          }}
        >
          Work Flows
        </p>
        <p className="lede" style={{ marginBottom: 18 }}>
          Internal tool for managing quoting work flows and generating
          customer-facing quote documents. Sign in with your PharmaCenter
          Google account to continue.
        </p>
        <SignInButton />
        <p className="meta" style={{ marginTop: 22 }}>
          Restricted to <strong>@pharmacenterusa.com</strong> accounts.
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

      {/* Decorative pills/capsules/gummies image on the right.
          Hotlinked from the Packing List app's /public folder so both
          sign-ins share the same asset. Hidden on narrow screens via
          a media query in globals.css (.signin-art class). */}
      <div
        className="signin-art"
        aria-hidden="true"
        style={{
          height: "100%",
          minHeight: 640,
          // cover + left-anchored so the foreground pills cluster sits
          // near the card and the rest of the image bleeds off-screen on
          // the right (mirrors the PL composition).
          backgroundImage: "url('https://packing.pharmacenter.app/PILLS.png')",
          backgroundSize: "cover",
          backgroundRepeat: "no-repeat",
          backgroundPosition: "left center",
        }}
      />
    </main>
  );
}
