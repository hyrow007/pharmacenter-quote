"use client";

import { useState, type CSSProperties } from "react";
import { createClient } from "@/lib/supabase/client";

// The sign-out button's style moved to .btn-chrome in app-chrome.css, shared
// byte-for-byte with the packing list so the band matches across both apps.
// primaryStyle stays inline: it is the sign-IN button on the unauthenticated
// landing page, which is not part of the signed-in chrome.
const primaryStyle: CSSProperties = {
  display: "inline-flex", alignItems: "center", gap: 8,
  padding: "12px 22px", background: "var(--teal-900)",
  color: "#fff", border: "none", borderRadius: 10,
  fontSize: 15, fontWeight: 700, cursor: "pointer",
  fontFamily: "inherit", letterSpacing: "0.01em",
};

export function SignInButton() {
  const [loading, setLoading] = useState(false);
  const supabase = createClient();

  async function signIn() {
    setLoading(true);
    const { error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo: `${window.location.origin}/auth/callback`,
        queryParams: {
          // Hint Google to scope to the PharmaCenter Workspace.
          hd: "pharmacenterusa.com",
          access_type: "offline",
          prompt: "consent",
        },
      },
    });
    if (error) {
      console.error("Sign-in error:", error.message);
      setLoading(false);
    }
    // Otherwise the browser is being redirected to Google.
  }

  return (
    <button onClick={signIn} disabled={loading} style={primaryStyle}>
      {loading ? "Redirecting…" : "Sign in with Google →"}
    </button>
  );
}

export function SignOutButton({ label = "Sign out" }: { label?: string }) {
  const [loading, setLoading] = useState(false);
  const supabase = createClient();

  async function signOut() {
    setLoading(true);
    await supabase.auth.signOut();
    window.location.assign("/");
  }

  return (
    <button onClick={signOut} disabled={loading} className="btn-chrome">
      {loading ? "…" : label}
    </button>
  );
}
