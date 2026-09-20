import { NextResponse } from "next/server";
import { requireSyncAuth } from "@/lib/sync-auth";
import { askForJson } from "@/lib/sync/anthropic";
import {
  buildTranslationPrompt,
  buildSynthesisPrompt,
  keepKnownIds,
  keepKnownSoNumbers,
  sessionNeedsWork,
  noteNeedsWork,
  type PendingSession,
  type PendingNote,
  type SynthesisInput,
} from "@/lib/sync/llm-core";

// GET /api/cron/daily
//
// The daily server-side run: translate pending meeting content, then generate
// SO key points. Both used to be Cowork scheduled tasks.
//
// ---------------------------------------------------------------------------
// Why this exists
// ---------------------------------------------------------------------------
// A Cowork scheduled task cannot make an authenticated HTTP call. Its sandbox
// has no outbound network, its shell is Linux (so the Windows scripts written
// for it are unrunnable), its built-in web fetch cannot set headers, and the
// browser route is refused by a credential classifier. Four independent walls.
// The work therefore moved here, where ANTHROPIC_API_KEY already lives and
// nothing depends on a particular laptop being awake. See claude/automation.md.
//
// ---------------------------------------------------------------------------
// Why it calls its own endpoints over HTTP
// ---------------------------------------------------------------------------
// The read and write logic already exists, tested, in /api/sync/*. Duplicating
// those queries here to save two internal hops would mean two copies of the
// same joins drifting apart. The hops cost a few hundred ms inside a 60s
// budget. CRON_SECRET authenticates them — see CRON_SCOPES in sync-auth-core.
//
// ---------------------------------------------------------------------------
// Why one endpoint does both jobs
// ---------------------------------------------------------------------------
// Vercel Hobby allows 2 cron jobs, once daily. /api/sync/monday holds one.
// This is the other, so it has to carry both jobs.
//
// Auth: requireSyncAuth(request, "so-synthesis") — accepts CRON_SECRET (what
// Vercel sends) or SO_SYNTHESIS_SECRET for a manual catch-up run.

export const runtime = "nodejs";
export const maxDuration = 60;

// Hobby kills the function at 60s flat, with no error worth reading. Stop at
// 50 and report what got done: a partial run that says so is worth far more
// than a complete-looking one that was cut off mid-write.
const BUDGET_MS = 50_000;

// Bounded batches keep one enormous backlog from blowing the budget on the
// first model call. Whatever is left is still pending next run.
const MAX_SESSIONS = 12;
const MAX_NOTES = 25;
const MAX_SOS = 15;

type StepResult = Record<string, unknown>;

// Any of the custom domains serves every /api route: src/middleware.ts carves
// /api out of all host rewrites. quote is chosen because it is the canonical
// one; nothing depends on which.
const PUBLIC_BASE = "https://quote.pharmacenter.app";

function baseUrl(request: Request): string {
  const override = process.env.SYNC_BASE_URL;
  if (override) return override.replace(/\/+$/, "");

  const origin = new URL(request.url).origin;

  // NOT VERCEL_URL, and not a *.vercel.app origin. Those deployment URLs sit
  // behind Vercel's Deployment Protection, which answers an unauthenticated
  // request with an HTML SSO page rather than the route. The fetch then dies
  // on `Unexpected token '<'` — a JSON parse error that looks like a bug in
  // the endpoint being called, not an auth wall in front of it. The custom
  // domains are public, so use one of those.
  if (origin.endsWith(".vercel.app")) return PUBLIC_BASE;

  return origin;
}

/**
 * Read a JSON response, or explain what arrived instead.
 *
 * A bare res.json() on an HTML error page throws `Unexpected token '<'`, which
 * says nothing about which host answered or why. Naming the content-type and
 * showing the first bytes turns a whole debugging session into one log line.
 */
async function readJson(res: Response, what: string): Promise<unknown> {
  const type = res.headers.get("content-type") ?? "";
  if (!type.includes("json")) {
    const head = (await res.text().catch(() => "")).slice(0, 120);
    throw new Error(
      `${what}: expected JSON, got ${type || "no content-type"} from ${res.url} — ${head}`,
    );
  }
  return res.json();
}

// Record<string, string> rather than HeadersInit on purpose: HeadersInit is a
// union (Headers | string[][] | Record<string,string>) and spreading a union
// into an object literal does not typecheck under strict mode.
function internalHeaders(): Record<string, string> {
  // Whatever authenticated US is good enough to authenticate our own calls
  // onward: Vercel sends CRON_SECRET, a manual caller sends the dedicated
  // secret, and both are accepted by the scopes we call.
  const token = process.env.CRON_SECRET || process.env.SO_SYNTHESIS_SECRET;
  return token ? { authorization: `Bearer ${token}` } : {};
}

async function translations(
  request: Request,
  signal: AbortSignal,
): Promise<StepResult> {
  const root = baseUrl(request);

  const res = await fetch(`${root}/api/sync/meeting-translations`, {
    headers: internalHeaders(),
    signal,
  });
  if (!res.ok) {
    return { ok: false, error: `fetch_${res.status}` };
  }

  const body = (await readJson(res, "translations read")) as {
    sessions?: PendingSession[];
    notes?: PendingNote[];
  };

  const sessions = (body.sessions ?? []).filter(sessionNeedsWork).slice(0, MAX_SESSIONS);
  const notes = (body.notes ?? []).filter(noteNeedsWork).slice(0, MAX_NOTES);

  if (sessions.length === 0 && notes.length === 0) {
    // Nothing pending is a success, not a failure. Recording it as one is how
    // a healthy quiet day gets mistaken for a broken job.
    return { ok: true, translated: 0, note: "nothing pending" };
  }

  const answer = await askForJson(
    buildTranslationPrompt(sessions, notes),
    8000,
    signal,
  );
  if (!answer.ok) return { ok: false, error: answer.error, detail: answer.detail };

  const out = answer.json as { sessions?: unknown; notes?: unknown };
  const payload = {
    sessions: keepKnownIds(out.sessions, sessions.map((s) => s.id)),
    notes: keepKnownIds(out.notes, notes.map((n) => n.id)),
  };

  if (payload.sessions.length === 0 && payload.notes.length === 0) {
    return { ok: false, error: "model_returned_no_usable_rows" };
  }

  const write = await fetch(`${root}/api/sync/meeting-translations`, {
    method: "POST",
    headers: { ...internalHeaders(), "content-type": "application/json" },
    body: JSON.stringify(payload),
    signal,
  });
  if (!write.ok) {
    return { ok: false, error: `write_${write.status}` };
  }

  return {
    ok: true,
    sessions_translated: payload.sessions.length,
    notes_translated: payload.notes.length,
    sessions_remaining: Math.max(0, (body.sessions ?? []).filter(sessionNeedsWork).length - sessions.length),
  };
}

async function synthesis(
  request: Request,
  signal: AbortSignal,
): Promise<StepResult> {
  const root = baseUrl(request);

  const res = await fetch(`${root}/api/sync/so-synthesis/inputs`, {
    headers: internalHeaders(),
    signal,
  });
  if (!res.ok) return { ok: false, error: `fetch_${res.status}` };

  const body = (await readJson(res, "synthesis inputs read")) as {
    sos?: SynthesisInput[];
  };
  const all = body.sos ?? [];
  const sos = all.slice(0, MAX_SOS);

  if (sos.length === 0) return { ok: true, synthesized: 0, note: "nothing pending" };

  const answer = await askForJson(buildSynthesisPrompt(sos), 8000, signal);
  if (!answer.ok) return { ok: false, error: answer.error, detail: answer.detail };

  const out = answer.json as { items?: unknown };
  const items = keepKnownSoNumbers(
    out.items,
    sos.map((s) => String(s.so_number)),
  );
  if (items.length === 0) return { ok: false, error: "model_returned_no_usable_items" };

  const write = await fetch(`${root}/api/sync/so-synthesis`, {
    method: "POST",
    headers: { ...internalHeaders(), "content-type": "application/json" },
    body: JSON.stringify({ items }),
    signal,
  });
  if (!write.ok) return { ok: false, error: `write_${write.status}` };

  return { ok: true, synthesized: items.length, remaining: all.length - sos.length };
}

async function run(request: Request): Promise<NextResponse> {
  const denied = requireSyncAuth(request, "so-synthesis");
  if (denied) return denied;

  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), BUDGET_MS);

  const result: Record<string, unknown> = {};
  try {
    // Sequential on purpose. Both steps call the model, and running them at
    // once doubles the peak against a single 60s ceiling for no gain — the
    // cron runs once a day and has nobody waiting on it.
    result.translations = await translations(request, controller.signal).catch(
      (err: unknown) => ({ ok: false, error: describe(err) }),
    );
    result.synthesis = await synthesis(request, controller.signal).catch(
      (err: unknown) => ({ ok: false, error: describe(err) }),
    );
  } finally {
    clearTimeout(timer);
  }

  const steps = [result.translations, result.synthesis] as StepResult[];
  const ok = steps.every((s) => s?.ok === true);

  console.log(
    `cron/daily ok=${ok} elapsed_ms=${Date.now() - started} ${JSON.stringify(result)}`,
  );

  // 200 even on partial failure: a non-2xx makes Vercel's cron UI show a red
  // run with no detail, and the body is where the detail is. `ok` is the field
  // to watch, not the status code.
  return NextResponse.json({ ok, elapsed_ms: Date.now() - started, ...result });
}

function describe(err: unknown): string {
  if (err instanceof Error) {
    return err.name === "AbortError" ? "timeout" : err.message.slice(0, 200);
  }
  return String(err).slice(0, 200);
}

// Vercel Cron issues GET. POST is here for manual catch-up runs.
export async function GET(request: Request) {
  return run(request);
}

export async function POST(request: Request) {
  return run(request);
}
