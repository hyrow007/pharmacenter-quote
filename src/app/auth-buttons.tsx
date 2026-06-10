"use client";

import { useState, type CSSProperties } from "react";
import { createClient } from "@/lib/auth/client";

const primaryStyle: CSSProperties = {
  display: "inline-flex", alignItems: "center", gap: 8,
  padding: "12px 22px", background: "var(--teal-900)",
  color: "#fff", border: "none", borderRadius: 10,
  fontSize: 15, fontWeight: 700, cursor: "pointer",
  fontFamily: "inherit", letterSpacing: "0.01em",
};

const secondaryStyle: CSSProperties = {
  padding: "6px 12px", background: "transparent",
  color: "var(--teal-700)", border: "1px solid #e3dcc9",
  borderRadius: 6, fontSize: 12, fontWeight: 700,
  cursor: "pointer", fontFamily: "inherit",
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
    <button onClick={signOut} disabled={loading} style={secondaryStyle}>
      {loading ? "…" : label}
    </button>
  );
}

