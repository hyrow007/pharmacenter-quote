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
          {/* Logo: 189x48 — exact PL dimensions. */}
          <img
            src="/logo.png"
            alt="PharmaCenter"
            style={{
              display: "block",
              width: 189,
              height: 48,
              margin: "0 0 18px",
            }}
          />
          {/* H1 + subtitle structured as a single heading block, matching
              PL's <h1>Packing List <span>Generator</span></h1> exactly so
              the two pages share identical typographic rhythm. */}
          <h1
            style={{
              fontSize: 56,
              lineHeight: "56px",
              fontWeight: 500,
              margin: "0 0 20px",
            }}
          >
            Quote
            <span
              style={{
                display: "block",
                fontSize: 25.76,
                fontStyle: "italic",
                fontWeight: 400,
                lineHeight: "28.336px",
                margin: "6px 0 0 2px",
                color: "rgb(110, 124, 128)",
              }}
            >
              Work Flows
            </span>
          </h1>
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
