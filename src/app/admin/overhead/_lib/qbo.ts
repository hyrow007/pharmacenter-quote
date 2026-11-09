import "server-only";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { createClient as createServiceClient, type SupabaseClient } from "@supabase/supabase-js";

// Everything that talks to Intuit for /admin/overhead. Server only.
//
// Behavior declared to Intuit in the app assessment (2026-11-08) and kept here:
//   - OAuth endpoints come from Intuit's discovery document, never hard-coded.
//   - Access tokens are refreshed only when they expire (or a call returns 401).
//   - The newest refresh token is always saved (Intuit rotates it ~daily).
//   - A refresh is retried once on a network/5xx error, never on invalid_grant;
//     invalid_grant marks the link "needs_reconnect" and the page asks to reconnect.
//   - Every failed call is logged with Intuit's intuit_tid.
//   - Read-only: the only scope requested is accounting, and nothing is written.
//   - Tokens are AES-256-GCM encrypted with QBO_TOKEN_KEY and never reach a browser.

export type QboEnv = "sandbox" | "production";
export const SCOPE = "com.intuit.quickbooks.accounting";
export const SUPPORT_EMAIL = "jairo@pharmacenter.health";

type Discovery = { authorization_endpoint: string; token_endpoint: string; revocation_endpoint: string };

export class QboError extends Error {
  constructor(
    message: string,
    public readonly kind: "config" | "auth" | "api" | "network",
    public readonly httpStatus?: number,
    public readonly intuitTid?: string | null,
  ) {
    super(message);
  }
}

// ------------------------------------------------------------------ config

export function qboConfig() {
  const env = (process.env.QBO_ENVIRONMENT ?? "").trim() as QboEnv;
  const clientId = process.env.QBO_CLIENT_ID?.trim();
  const clientSecret = process.env.QBO_CLIENT_SECRET?.trim();
  const tokenKey = process.env.QBO_TOKEN_KEY?.trim();
  const missing = [
    !clientId && "QBO_CLIENT_ID",
    !clientSecret && "QBO_CLIENT_SECRET",
    !tokenKey && "QBO_TOKEN_KEY",
    env !== "sandbox" && env !== "production" && "QBO_ENVIRONMENT",
  ].filter(Boolean) as string[];
  return { env, clientId: clientId ?? "", clientSecret: clientSecret ?? "", tokenKey: tokenKey ?? "", missing };
}

export function redirectUri(): string {
  return "https://quote.pharmacenter.app/api/overhead/quickbooks/callback";
}

function apiBase(env: QboEnv) {
  return env === "production" ? "https://quickbooks.api.intuit.com" : "https://sandbox-quickbooks.api.intuit.com";
}

let discoveryCache: { env: QboEnv; at: number; doc: Discovery } | null = null;

export async function discovery(env: QboEnv): Promise<Discovery> {
  if (discoveryCache && discoveryCache.env === env && Date.now() - discoveryCache.at < 6 * 3600_000) {
    return discoveryCache.doc;
  }
  const url =
    env === "production"
      ? "https://developer.api.intuit.com/.well-known/openid_configuration"
      : "https://developer.api.intuit.com/.well-known/openid_sandbox_configuration";
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) throw new QboError(`discovery document returned ${r.status}`, "network", r.status);
  const doc = (await r.json()) as Discovery;
  if (!doc.authorization_endpoint || !doc.token_endpoint) throw new QboError("discovery document incomplete", "network");
  discoveryCache = { env, at: Date.now(), doc };
  return doc;
}

export function serviceDb(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new QboError("server misconfigured (Supabase)", "config");
  return createServiceClient(url, key, { auth: { persistSession: false } });
}

// ------------------------------------------------------------------ crypto

function key32(): Buffer {
  const k = Buffer.from(qboConfig().tokenKey, "base64");
  if (k.length !== 32) throw new QboError("QBO_TOKEN_KEY must be 32 bytes, base64", "config");
  return k;
}

export function seal(plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key32(), iv);
  const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return "v1:" + Buffer.concat([iv, c.getAuthTag(), ct]).toString("base64");
}

export function unseal(sealed: string): string {
  if (!sealed.startsWith("v1:")) throw new QboError("unknown token format", "config");
  const raw = Buffer.from(sealed.slice(3), "base64");
  const d = createDecipheriv("aes-256-gcm", key32(), raw.subarray(0, 12));
  d.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString("utf8");
}

// ------------------------------------------------------------------ log

export async function log(
  db: SupabaseClient,
  entry: { level: "info" | "error"; action: string; httpStatus?: number; intuitTid?: string | null; message?: string; actor?: string },
) {
  const { error } = await db.from("overhead_qbo_log").insert({
    level: entry.level,
    action: entry.action,
    http_status: entry.httpStatus ?? null,
    intuit_tid: entry.intuitTid ?? null,
    message: entry.message?.slice(0, 4000) ?? null,
    actor: entry.actor ?? null,
  });
  if (error) console.error("overhead_qbo_log insert failed:", error.message);
  if (entry.level === "error") console.error(`[qbo] ${entry.action} ${entry.httpStatus ?? ""} tid=${entry.intuitTid ?? "-"} ${entry.message ?? ""}`);
}

// ------------------------------------------------------------------ tokens

type TokenResponse = {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  x_refresh_token_expires_in?: number;
  // Newer field for the 5-year hard cap; name varies by SDK, so read either.
  refresh_token_hard_expires_in?: number;
  x_refresh_token_hard_expires_in?: number;
};

function basicAuth() {
  const { clientId, clientSecret } = qboConfig();
  return "Basic " + Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
}

async function tokenRequest(env: QboEnv, body: Record<string, string>): Promise<{ tok: TokenResponse; tid: string | null }> {
  const d = await discovery(env);
  let lastErr: QboError | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    let r: Response;
    try {
      r = await fetch(d.token_endpoint, {
        method: "POST",
        headers: { Authorization: basicAuth(), Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(body),
        cache: "no-store",
      });
    } catch (e) {
      lastErr = new QboError(`token endpoint unreachable: ${(e as Error).message}`, "network");
      continue; // one retry on network failure
    }
    const tid = r.headers.get("intuit_tid");
    if (r.ok) return { tok: (await r.json()) as TokenResponse, tid };
    const text = await r.text();
    if (r.status >= 500) {
      lastErr = new QboError(`token endpoint ${r.status}: ${text.slice(0, 300)}`, "network", r.status, tid);
      continue; // one retry on server error
    }
    // 4xx — invalid_grant (expired/revoked refresh token, reused code) etc. Not retried.
    throw new QboError(`token endpoint ${r.status}: ${text.slice(0, 300)}`, "auth", r.status, tid);
  }
  throw lastErr ?? new QboError("token request failed", "network");
}

function refreshExpiry(tok: TokenResponse): string | null {
  const s = tok.refresh_token_hard_expires_in ?? tok.x_refresh_token_hard_expires_in ?? tok.x_refresh_token_expires_in;
  return s ? new Date(Date.now() + s * 1000).toISOString() : null;
}

/** Exchange the code from the callback. Returns the tokens; caller decides whether to keep them. */
export async function exchangeCode(env: QboEnv, code: string) {
  return tokenRequest(env, { grant_type: "authorization_code", code, redirect_uri: redirectUri() });
}

export async function storeConnection(
  db: SupabaseClient,
  c: { env: QboEnv; realmId: string; companyName: string | null; tok: TokenResponse; by: string },
) {
  const { error } = await db.from("overhead_qbo_connection").upsert({
    id: 1,
    environment: c.env,
    realm_id: c.realmId,
    company_name: c.companyName,
    refresh_token_enc: seal(c.tok.refresh_token),
    refresh_expires_at: refreshExpiry(c.tok),
    access_token_enc: seal(c.tok.access_token),
    access_expires_at: new Date(Date.now() + (c.tok.expires_in - 120) * 1000).toISOString(),
    connected_by: c.by,
    connected_at: new Date().toISOString(),
    last_refreshed_at: new Date().toISOString(),
    status: "connected",
    updated_at: new Date().toISOString(),
  });
  if (error) throw new QboError(`could not save the connection: ${error.message}`, "config");
}

type ConnRow = {
  environment: QboEnv;
  realm_id: string;
  company_name: string | null;
  refresh_token_enc: string;
  access_token_enc: string | null;
  access_expires_at: string | null;
  status: string;
  last_refreshed_at: string | null;
};

async function loadConn(db: SupabaseClient): Promise<ConnRow | null> {
  const { data, error } = await db.from("overhead_qbo_connection").select("*").eq("id", 1).maybeSingle();
  if (error) throw new QboError(error.message, "config");
  return (data as ConnRow) ?? null;
}

/** A valid access token, refreshing only if the stored one has expired (or force). */
async function accessToken(db: SupabaseClient, force = false): Promise<{ token: string; conn: ConnRow }> {
  const conn = await loadConn(db);
  if (!conn) throw new QboError("QuickBooks is not connected", "auth");
  if (conn.status !== "connected") throw new QboError("QuickBooks needs to be reconnected", "auth");
  if (!force && conn.access_token_enc && conn.access_expires_at && new Date(conn.access_expires_at).getTime() > Date.now()) {
    return { token: unseal(conn.access_token_enc), conn };
  }
  try {
    const { tok, tid } = await tokenRequest(conn.environment, {
      grant_type: "refresh_token",
      refresh_token: unseal(conn.refresh_token_enc),
    });
    // Only overwrite if nobody else refreshed in the meantime (rotation safety).
    let q = db
      .from("overhead_qbo_connection")
      .update({
        refresh_token_enc: seal(tok.refresh_token),
        refresh_expires_at: refreshExpiry(tok),
        access_token_enc: seal(tok.access_token),
        access_expires_at: new Date(Date.now() + (tok.expires_in - 120) * 1000).toISOString(),
        last_refreshed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", 1);
    q = conn.last_refreshed_at ? q.eq("last_refreshed_at", conn.last_refreshed_at) : q;
    const { error } = await q;
    if (error) throw new QboError(`could not save refreshed tokens: ${error.message}`, "config");
    await log(db, { level: "info", action: "refresh", intuitTid: tid });
    return { token: tok.access_token, conn };
  } catch (e) {
    const err = e instanceof QboError ? e : new QboError(String(e), "network");
    await log(db, { level: "error", action: "refresh", httpStatus: err.httpStatus, intuitTid: err.intuitTid, message: err.message });
    if (err.kind === "auth") {
      await db.from("overhead_qbo_connection").update({ status: "needs_reconnect", updated_at: new Date().toISOString() }).eq("id", 1);
    }
    throw err;
  }
}

/** GET a QuickBooks API path (after /v3/company/{realm}). One retry after a 401 with a forced refresh. */
export async function qboGet<T>(db: SupabaseClient, path: string, params: Record<string, string> = {}): Promise<T> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const { token, conn } = await accessToken(db, attempt > 0);
    const url = new URL(`${apiBase(conn.environment)}/v3/company/${conn.realm_id}/${path}`);
    for (const [k, v] of Object.entries({ minorversion: "75", ...params })) url.searchParams.set(k, v);
    let r: Response;
    try {
      r = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" }, cache: "no-store" });
    } catch (e) {
      const err = new QboError(`QuickBooks unreachable: ${(e as Error).message}`, "network");
      await log(db, { level: "error", action: "api", message: `${path}: ${err.message}` });
      throw err;
    }
    const tid = r.headers.get("intuit_tid");
    if (r.status === 401 && attempt === 0) continue; // expired early: refresh once and retry
    if (!r.ok) {
      const text = await r.text();
      const err = new QboError(`QuickBooks ${r.status} on ${path}: ${text.slice(0, 500)}`, r.status === 401 ? "auth" : "api", r.status, tid);
      await log(db, { level: "error", action: "api", httpStatus: r.status, intuitTid: tid, message: err.message });
      if (r.status === 401) {
        await db.from("overhead_qbo_connection").update({ status: "needs_reconnect", updated_at: new Date().toISOString() }).eq("id", 1);
      }
      throw err;
    }
    const body = (await r.json()) as T & { Fault?: { Error?: { Message?: string; Detail?: string }[] } };
    if (body && (body as { Fault?: unknown }).Fault) {
      const f = body.Fault?.Error?.[0];
      const err = new QboError(`QuickBooks fault on ${path}: ${f?.Message ?? ""} ${f?.Detail ?? ""}`.trim(), "api", r.status, tid);
      await log(db, { level: "error", action: "api", httpStatus: r.status, intuitTid: tid, message: err.message });
      throw err;
    }
    return body;
  }
  throw new QboError("QuickBooks call failed after refresh", "auth");
}

/** Revoke at Intuit (best effort) and forget the connection. */
export async function disconnect(db: SupabaseClient, actor: string) {
  const conn = await loadConn(db);
  if (conn) {
    try {
      const d = await discovery(conn.environment);
      const r = await fetch(d.revocation_endpoint, {
        method: "POST",
        headers: { Authorization: basicAuth(), Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({ token: unseal(conn.refresh_token_enc) }),
        cache: "no-store",
      });
      if (!r.ok) {
        await log(db, { level: "error", action: "disconnect", httpStatus: r.status, intuitTid: r.headers.get("intuit_tid"), message: (await r.text()).slice(0, 500), actor });
      }
    } catch (e) {
      await log(db, { level: "error", action: "disconnect", message: (e as Error).message, actor });
    }
  }
  await db.from("overhead_qbo_connection").delete().eq("id", 1);
  await log(db, { level: "info", action: "disconnect", actor });
}

/** CompanyInfo name, used to confirm the right company before keeping a connection. */
export async function companyNameWith(env: QboEnv, realmId: string, accessTokenPlain: string): Promise<{ name: string | null; tid: string | null }> {
  const r = await fetch(`${apiBase(env)}/v3/company/${realmId}/companyinfo/${realmId}?minorversion=75`, {
    headers: { Authorization: `Bearer ${accessTokenPlain}`, Accept: "application/json" },
    cache: "no-store",
  });
  const tid = r.headers.get("intuit_tid");
  if (!r.ok) throw new QboError(`CompanyInfo ${r.status}: ${(await r.text()).slice(0, 300)}`, "api", r.status, tid);
  const j = (await r.json()) as { CompanyInfo?: { CompanyName?: string; LegalName?: string } };
  return { name: j.CompanyInfo?.CompanyName ?? j.CompanyInfo?.LegalName ?? null, tid };
}

/** In production, only PharmaCenter's company may be kept. */
export function companyAllowed(env: QboEnv, name: string | null): boolean {
  if (env !== "production") return true;
  const expected = process.env.QBO_EXPECTED_COMPANY?.trim();
  if (expected) return (name ?? "").toLowerCase().includes(expected.toLowerCase());
  return /pharma\s*center/i.test(name ?? "");
}
