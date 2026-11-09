import { randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import { discovery, qboConfig, redirectUri, SCOPE } from "@/app/admin/overhead/_lib/qbo";
import { adminEmail, back, STATE_COOKIE } from "../_gate";

// GET /api/overhead/quickbooks/connect — also the Connect/Reconnect URL registered with Intuit.
// Starts Intuit sign-in with a one-time state value (CSRF protection) kept in an httpOnly cookie.
export const dynamic = "force-dynamic";

export async function GET() {
  if (!(await adminEmail())) return NextResponse.redirect(back("not_admin"));
  const cfg = qboConfig();
  if (cfg.missing.length) return NextResponse.redirect(back("not_configured", cfg.missing.join(", ")));

  let authUrl: URL;
  try {
    authUrl = new URL((await discovery(cfg.env)).authorization_endpoint);
  } catch (e) {
    return NextResponse.redirect(back("error", (e as Error).message));
  }
  const state = randomBytes(24).toString("hex");
  authUrl.search = new URLSearchParams({
    client_id: cfg.clientId,
    response_type: "code",
    scope: SCOPE,
    redirect_uri: redirectUri(),
    state,
  }).toString();

  const res = NextResponse.redirect(authUrl.toString());
  res.cookies.set(STATE_COOKIE, state, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/api/overhead/quickbooks",
    maxAge: 600,
  });
  return res;
}
