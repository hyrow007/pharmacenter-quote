import { NextResponse } from "next/server";
import { evaluateSyncAuth, type SyncScope } from "@/lib/sync-auth-core";

export type { SyncScope } from "@/lib/sync-auth-core";

// HTTP half of the sync bearer auth. The decision logic lives in
// sync-auth-core.ts, which imports nothing from a framework so it can be
// tested with plain node. See that file for why this exists (finding H4).
//
// ---------------------------------------------------------------------------
// How to tell where a caller actually is
// ---------------------------------------------------------------------------
// Every accepted request logs which secret matched, BY NAME, never by value:
//
//   sync-auth: scope=monday matched=CRON_SECRET
//   sync-auth: scope=plaud-webhook matched=PLAUD_WEBHOOK_SECRET
//
// You cannot finish a migration you cannot observe. A caller still on the
// shared token says so on every request, in Vercel's function logs, instead
// of working silently until the day the shared token is deleted.

/**
 * Returns a NextResponse to send back when the request should be rejected,
 * or null when it is authorized. Call it first in the handler:
 *
 *     const denied = requireSyncAuth(request, "plaud-webhook");
 *     if (denied) return denied;
 */
export function requireSyncAuth(
  request: Request,
  scope: SyncScope,
): NextResponse | null {
  const result = evaluateSyncAuth(request.headers.get("authorization"), scope);

  if (result.ok) {
    console.log(`sync-auth: scope=${scope} matched=${result.matched}`);
    return null;
  }

  const log = result.status === 500 ? console.error : console.warn;
  log(`sync-auth: scope=${scope} ${result.detail}`);
  return NextResponse.json(
    { ok: false, error: result.error },
    { status: result.status },
  );
}
