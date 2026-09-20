import { redirect } from "next/navigation";
import { createClient } from "@/lib/auth/server";
import AppHeader from "../_components/AppHeader";

// Server layout for /start (and all its child routes). Renders the shared
// app top-nav above the existing client form. Keeping this here (instead of
// patching every /start/* page) means the bulk-product/quantity legacy
// sub-routes inherit the header for free.

export default async function StartLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user || !user.email?.endsWith("@pharmacenterusa.com")) {
    redirect("/");
  }

  return (
    <div className="app-shell">
      <AppHeader user={{ email: user.email! }} />
      {children}
    </div>
  );
}
