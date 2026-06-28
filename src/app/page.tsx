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

  // Layout is a 1:1 port of the Packing List sign-in
  // (packing.pharmacenter.app). Exact computed-style values copied from
  // the live PL DOM:
  //   main:    grid 1047px / 873px (≈ 1.2fr / 1fr)
  //   section: padding 48px, align-items center, justify-items center
  //   .card:   max-width 520px
  //   aside:   overflow hidden, position relative, full height
  //   aside img: position absolute, w/h 100%, object-fit cover
  // The .signin-art class hides the right column on narrow screens via
  // a media query in globals.css.
  return (
    <main
      style={{
        minHeight: "100vh",
        display: "grid",
        gridTemplateColumns: "1.2fr 1fr",
        overflow: "hidden",
      }}
    >
      <section
        style={{
          display: "grid",
          padding: 48,
          alignItems: "center",
          justifyItems: "center",
        }}
      >
        <div className="card" style={{ maxWidth: 520, width: "100%" }}>
          {/* Wordmark first — the brand image carries "PharmaCenter" so
              we don't repeat the company name in text above it. */}
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
            <p
              style={{
                marginTop: 14,
                padding: "10px 14px",
                background: "#fff1f1",
                border: "1px solid #f5c2c2",
                borderRadius: 8,
                color: "#7a1d1d",
                fontSize: 13,
              }}
            >
              Sign-in didn&rsquo;t complete. Try again &mdash; if it keeps
              failing, check that your account is on @pharmacenterusa.com.
            </p>
          ) : null}
        </div>
      </section>

      {/* Right column: pills/capsules/gummies image. Hotlinked from the
          Packing List app so both sign-ins share the same asset. The
          aside is the positioned ancestor; the img inside is absolute
          and uses object-fit:cover, mirroring the PL DOM exactly. */}
      <aside
        className="signin-art"
        aria-hidden="true"
        style={{
          position: "relative",
          overflow: "hidden",
        }}
      >
        <img
          src="https://packing.pharmacenter.app/PILLS.png"
          alt=""
          style={{
            position: "absolute",
            inset: 0,
            width: "100%",
            height: "100%",
            objectFit: "cover",
            objectPosition: "50% 50%",
          }}
        />
      </aside>
    </main>
  );
}
