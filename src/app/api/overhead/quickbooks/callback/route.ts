import { timingSafeEqual } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import {
  companyAllowed,
  companyNameWith,
  discovery,
  exchangeCode,
  log,
  qboConfig,
  QboError,
  serviceDb,
  storeConnection,
} from "@/app/admin/overhead/_lib/qbo";
import { adminEmail, back, STATE_COOKIE } from "../_gate";

// GET /api/overhead/quickbooks/callback — Intuit sends the admin back here after sign-in.
// Checks the state (CSRF), exchanges the code, confirms the company, then stores the
// encrypted tokens. Nothing from this exchange is ever sent to the browser.
export const dynamic = "force-dynamic";

function sameState(a: string | undefined, b: string | null): boolean {
  if (!a || !b || a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

export async function GET(req: NextRequest) {
  const db = serviceDb();
  const p = req.nextUrl.searchParams;
  const finish = (outcome: string, detail?: string) => {
    const res = NextResponse.redirect(back(outcome, detail));
    res.cookies.set(STATE_COOKIE, "", { path: "/api/overhead/quickbooks", maxAge: 0 });
    return res;
  };

  const email = await adminEmail();
  if (!email) return finish("not_admin");

  if (!sameState(req.cookies.get(STATE_COOKIE)?.value, p.get("state"))) {
    await log(db, { level: "error", action: "callback", message: "state mismatch (possible CSRF or expired sign-in)", actor: email });
    return finish("csrf");
  }
  if (p.get("error")) {
    await log(db, { level: "info", action: "callback", message: `Intuit returned ${p.get("error")}`, actor: email });
    return finish("denied", p.get("error") ?? undefined);
  }
  const code = p.get("code");
  const realmId = p.get("realmId");
  if (!code || !realmId) return finish("error", "Intuit did not return a code and company id");

  const { env } = qboConfig();
  try {
    const { tok, tid } = await exchangeCode(env, code);
    const { name } = await companyNameWith(env, realmId, tok.access_token);
    if (!companyAllowed(env, name)) {
      // Wrong company: revoke what we were just given and keep nothing.
      try {
        const d = await discovery(env);
        await fetch(d.revocation_endpoint, {
          method: "POST",
          headers: {
            Authorization: "Basic " + Buffer.from(`${qboConfig().clientId}:${qboConfig().clientSecret}`).toString("base64"),
            Accept: "application/json",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ token: tok.refresh_token }),
          cache: "no-store",
        });
      } catch {
        /* best effort */
      }
      await log(db, { level: "error", action: "callback", intuitTid: tid, message: `refused company "${name ?? "?"}" (realm ${realmId})`, actor: email });
      return finish("wrong_company", name ?? realmId);
    }
    await storeConnection(db, { env, realmId, companyName: name, tok, by: email });
    await log(db, { level: "info", action: "connect", intuitTid: tid, message: `${env}: ${name ?? "?"} (realm ${realmId})`, actor: email });
    return finish("connected", name ?? undefined);
  } catch (e) {
    const err = e instanceof QboError ? e : new QboError(String(e), "network");
    await log(db, { level: "error", action: "callback", httpStatus: err.httpStatus, intuitTid: err.intuitTid, message: err.message, actor: email });
    return finish("error", err.message);
  }
}
