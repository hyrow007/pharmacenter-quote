import { timingSafeEqual } from "node:crypto";

// The decision half of the machine-to-machine bearer auth. Deliberately free
// of any framework import: no next/server, no Request, no DOM. That is what
// makes sync-auth.test.mjs runnable with plain
// `node --experimental-strip-types` — this repo has no node_modules checked
// out, and a test nobody can run is a test nobody runs.
//
// The HTTP half lives in sync-auth.ts, which turns these results into
// NextResponse and logs them.
//
// ---------------------------------------------------------------------------
// Why this exists (finding H4)
// ---------------------------------------------------------------------------
// A single token, PLAUD_SYNC_SECRET, authenticated FIVE endpoints: the Plaud
// webhook, the Monday board sync, meeting-translations (read and write), and
// both sides of so-synthesis. Four of the five are writes. One leak exposed
// all of them, and Vercel stored it as readable Config rather than a Secret,
// which is why it was flagged "Needs Attention".
//
// Splitting in one move would mean rotating every caller at once, including
// ones configured outside this repo — Plaud's own webhook settings, a Zapier
// hop. That is how migrations get abandoned half-done. So each scope accepts,
// in order:
//
//   1. its own dedicated secret, if set        <- where we are going
//   2. Vercel's CRON_SECRET, for cron scopes   <- Vercel sends only this
//   3. the shared PLAUD_SYNC_SECRET            <- where we are coming from
//
// Set one dedicated secret, move that caller, confirm from the logs that it
// is using the new one, repeat. When no scope reports `shared` any more,
// delete PLAUD_SYNC_SECRET from both Vercel projects and drop step 3.

export type SyncScope =
  | "plaud-webhook"
  | "monday"
  | "meeting-translations"
  | "so-synthesis"
  | "so-synthesis-inputs";

// Dedicated env var per scope. None need to exist yet — an unset one simply
// falls through to the shared secret.
export const DEDICATED: Record<SyncScope, string> = {
  "plaud-webhook": "PLAUD_WEBHOOK_SECRET",
  monday: "MONDAY_SYNC_SECRET",
  "meeting-translations": "MEETING_TRANSLATIONS_SECRET",
  // Read and write sides of synthesis share one secret on purpose: the same
  // task does both, and splitting them would buy nothing.
  "so-synthesis": "SO_SYNTHESIS_SECRET",
  "so-synthesis-inputs": "SO_SYNTHESIS_SECRET",
};

// Scopes Vercel Cron invokes itself. Vercel sends CRON_SECRET and nothing
// else, so these must accept it or the scheduled run 401s.
//
// translations and synthesis were added 2026-09-20 when the work moved
// server-side. /api/cron/daily calls these three endpoints over HTTP with
// CRON_SECRET rather than duplicating their query logic, so each must accept
// that secret. The dedicated secrets still work for manual and laptop callers.
//
// Why they moved: a Cowork scheduled task cannot make an authenticated HTTP
// call at all. Its sandbox has no outbound network, its shell is Linux (so
// Windows scripts are unrunnable), its web fetch cannot set headers, and the
// browser route is refused by a credential classifier. Four walls, no gaps.
// See claude/automation.md.
const CRON_SCOPES: ReadonlySet<SyncScope> = new Set<SyncScope>([
  "monday",
  "meeting-translations",
  "so-synthesis",
  "so-synthesis-inputs",
]);

export const SHARED = "PLAUD_SYNC_SECRET";

export type SyncAuthResult =
  | { ok: true; matched: string; legacy: boolean }
  | { ok: false; status: 401 | 500; error: string; detail: string };

// Constant-time compare. The five inline checks this replaced all used `!==`,
// which returns as soon as two bytes differ and in principle leaks the token
// a character at a time. Over HTTPS with network jitter that is not a
// practical attack, but the fix costs nothing and removes the question.
function secretMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expected, "utf8");
  // timingSafeEqual throws on a length mismatch, which is itself a length
  // oracle — but token length is not the secret, so compare lengths first.
  // The constant-time path covers every equal-length candidate.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function bearerFrom(authorization: string | null | undefined): string {
  const authz = authorization || "";
  return authz.startsWith("Bearer ") ? authz.slice("Bearer ".length).trim() : "";
}

/** Names of every secret this scope would accept, in preference order. */
export function candidateNames(scope: SyncScope): string[] {
  const names = [DEDICATED[scope]];
  if (CRON_SCOPES.has(scope)) names.push("CRON_SECRET");
  names.push(SHARED);
  return names;
}

export function evaluateSyncAuth(
  authorization: string | null | undefined,
  scope: SyncScope,
  env: Record<string, string | undefined> = process.env,
): SyncAuthResult {
  const names = candidateNames(scope);
  const configured = names
    .map((name) => [name, env[name]] as const)
    .filter((e): e is readonly [string, string] =>
      typeof e[1] === "string" && e[1].length > 0,
    );

  if (configured.length === 0) {
    // Misconfiguration, not a bad caller. 500, and name the vars that would
    // fix it — those names are not secret, and the alternative is a silent
    // 401 that sends everyone hunting for a wrong token.
    return {
      ok: false,
      status: 500,
      error: "server_misconfigured",
      detail: `no secret configured; set one of ${names.join(", ")}`,
    };
  }

  const provided = bearerFrom(authorization);
  if (!provided) {
    return { ok: false, status: 401, error: "unauthorized", detail: "no bearer token" };
  }

  for (const [name, value] of configured) {
    if (secretMatches(provided, value)) {
      return { ok: true, matched: name, legacy: name === SHARED };
    }
  }

  return {
    ok: false,
    status: 401,
    error: "unauthorized",
    detail: `bearer matched none of ${configured.map(([n]) => n).join(", ")}`,
  };
}
