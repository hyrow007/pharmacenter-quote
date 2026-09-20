// Prompt construction and response parsing for the server-side translation and
// synthesis jobs. Deliberately free of any framework import — no next/server,
// no fetch, no Supabase — so llm-core.test.mjs runs under plain
// `node --experimental-strip-types` with no node_modules checked out.
//
// Same reasoning as sync-auth-core.ts: the part with real branching is the
// part worth testing, and a test nobody can run is a test nobody runs.
//
// ---------------------------------------------------------------------------
// Why this exists
// ---------------------------------------------------------------------------
// These two jobs used to be Cowork scheduled tasks: fetch inputs, have Claude
// translate or summarize, post the result back. That cannot work. A task's
// sandbox has no outbound network, its shell is Linux so Windows scripts are
// unrunnable, its web fetch cannot set headers, and the browser route is
// refused by a credential classifier. The LLM step therefore moved into the
// app, where ANTHROPIC_API_KEY already lives.

// ---- shapes returned by the read endpoints ------------------------------

export type TranslationNeeds = { summary?: boolean; other_business?: boolean };
export type NoteNeeds = { note?: boolean; action_items?: boolean };

export type PendingSession = {
  id: string | number;
  session_date?: string | null;
  summary_md?: string | null;
  other_business?: unknown;
  needs?: TranslationNeeds | null;
};

export type PendingNote = {
  id: string | number;
  session_id?: string | number;
  so_number?: string | null;
  note_md?: string | null;
  action_items?: unknown;
  needs?: NoteNeeds | null;
};

// ---- shared prompt language ---------------------------------------------

// Identifiers must survive translation untouched. Transcripts already mangle
// customer names (Peter Chu / Purechews); a model "tidying" them on the way
// past would destroy the one signal the mismatch detector runs on.
const IDENTIFIER_RULE = [
  "Never translate or alter: SO numbers, product codes, company names,",
  "people's names, or Fishbowl/Monday status strings. They are identifiers.",
  '"Sales Order 14693" becomes "Orden de Venta 14693"; "Purechews" stays',
  '"Purechews", even if it looks like a misspelling.',
].join(" ");

const SPANISH_RULE = [
  "Use natural Latin-American business Spanish as spoken in a Florida",
  "contract-manufacturing plant. Not Castilian, not word-for-word.",
].join(" ");

const JSON_RULE = [
  "Reply with a single JSON object and nothing else. No prose before or",
  "after, no markdown fence.",
].join(" ");

// ---- translation ---------------------------------------------------------

/** True when this row has at least one field actually awaiting translation. */
export function sessionNeedsWork(s: PendingSession): boolean {
  return Boolean(s.needs?.summary || s.needs?.other_business);
}

export function noteNeedsWork(n: PendingNote): boolean {
  return Boolean(n.needs?.note || n.needs?.action_items);
}

export function buildTranslationPrompt(
  sessions: PendingSession[],
  notes: PendingNote[],
): string {
  // Send only the fields whose `needs` flag is set. Shipping the whole row
  // invites the model to translate fields that already have a translation and
  // overwrite good Spanish with new Spanish for no reason.
  const payload = {
    sessions: sessions.filter(sessionNeedsWork).map((s) => ({
      id: s.id,
      ...(s.needs?.summary ? { summary_md: s.summary_md } : {}),
      ...(s.needs?.other_business ? { other_business: s.other_business } : {}),
    })),
    notes: notes.filter(noteNeedsWork).map((n) => ({
      id: n.id,
      ...(n.needs?.note ? { note_md: n.note_md } : {}),
      ...(n.needs?.action_items ? { action_items: n.action_items } : {}),
    })),
  };

  return [
    "Translate PharmaCenter meeting content into Spanish.",
    "",
    SPANISH_RULE,
    IDENTIFIER_RULE,
    "Keep the markdown structure identical: same bullets, headings and order.",
    "action_items is an array of objects with a `text` field and an optional",
    "`owner`. Translate `text`. Leave `owner` exactly as written — those are",
    "people. Omit any field whose source is empty or null rather than sending",
    'an empty string.',
    "",
    JSON_RULE,
    "Shape, echoing each id exactly as given:",
    '{"sessions":[{"id":…,"summary_md_es":"…","other_business_es":…}],',
    ' "notes":[{"id":…,"note_md_es":"…","action_items_es":[…]}]}',
    "",
    "Input:",
    JSON.stringify(payload),
  ].join("\n");
}

// ---- synthesis -----------------------------------------------------------

export type SynthesisInput = {
  so_number: string;
  fishbowl?: unknown;
  monday?: unknown;
  meetings?: unknown;
  existing_synthesis?: { generated_at?: string | null } | null;
};

export function buildSynthesisPrompt(sos: SynthesisInput[]): string {
  return [
    "Summarize each PharmaCenter sales order into key points for the orders",
    "hub. One headline and 3-5 points per SO.",
    "",
    "The headline names the situation, not the SO. Prefer",
    '"Components shipped but no tracking number; order blocked" over',
    '"Update on SO 14693". Lead with whatever is blocking or time-sensitive;',
    "a point nobody would act on does not earn a slot.",
    "",
    'Tag each point with its source where it has one: "monday" or "plaud".',
    "Fishbowl facts need no tag. Prefix meeting-derived points with the date,",
    'as in "Meeting 9/8: …".',
    "",
    "Produce BOTH English and Spanish. " + SPANISH_RULE,
    IDENTIFIER_RULE,
    "The orders page prefers the Spanish fields and silently falls back to",
    "English, so a missing _es shows up as an English card rather than an",
    "error — which is how this went unnoticed before. Always send both.",
    "",
    JSON_RULE,
    "Shape, echoing each so_number exactly as given:",
    '{"items":[{"so_number":"…","headline":"…",',
    ' "points":[{"text":"…","source":"monday"}],',
    ' "headline_es":"…","points_es":[{"text":"…","source":"monday"}]}]}',
    "",
    "Input:",
    JSON.stringify({ sos }),
  ].join("\n");
}

// ---- response parsing ----------------------------------------------------

/**
 * Pull the first balanced JSON object out of a model reply.
 *
 * Models wrap JSON in prose or a markdown fence often enough that a bare
 * JSON.parse fails on otherwise-good output. Scanning for the first balanced
 * object recovers those without accepting garbage — and quote/escape aware,
 * because a brace inside a translated string is common in this data.
 */
export function extractJsonObject(text: string): unknown {
  const start = text.indexOf("{");
  if (start === -1) throw new Error("no JSON object in model reply");

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];

    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }

    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return JSON.parse(text.slice(start, i + 1));
    }
  }

  throw new Error("unbalanced JSON object in model reply");
}

/**
 * Keep only rows whose id was in the request.
 *
 * A model that invents an id would otherwise write a translation onto an
 * unrelated row, or fail the upsert in a way that looks like a database
 * problem. Ids are compared as strings because they cross JSON as both.
 */
export function keepKnownIds<T extends { id?: unknown }>(
  rows: unknown,
  knownIds: Array<string | number>,
): T[] {
  if (!Array.isArray(rows)) return [];
  const known = new Set(knownIds.map((k) => String(k)));
  return rows.filter(
    (r): r is T =>
      typeof r === "object" &&
      r !== null &&
      "id" in r &&
      known.has(String((r as { id: unknown }).id)),
  );
}

export function keepKnownSoNumbers<T extends { so_number?: unknown }>(
  items: unknown,
  knownSoNumbers: string[],
): T[] {
  if (!Array.isArray(items)) return [];
  const known = new Set(knownSoNumbers.map(String));
  return items.filter(
    (i): i is T =>
      typeof i === "object" &&
      i !== null &&
      "so_number" in i &&
      known.has(String((i as { so_number: unknown }).so_number)),
  );
}

// ---- input trimming ------------------------------------------------------

/**
 * Cut a synthesis input down to what a summary actually needs.
 *
 * The inputs endpoint returns everything: every sale_item line, every Monday
 * update, every meeting note ever recorded against the SO. Sending all of it
 * costs input tokens, slows the call, and buries the recent signal — which is
 * the only part a "what is happening now" summary uses.
 *
 * Caps are deliberately small. A bullet justified by the 12th-most-recent
 * Monday update is not a bullet anyone needed.
 */
export function trimSynthesisInput(so: SynthesisInput): SynthesisInput {
  const fb = so.fishbowl as Record<string, unknown> | null | undefined;
  const md = so.monday as Record<string, unknown> | null | undefined;
  const meetings = Array.isArray(so.meetings) ? so.meetings : [];

  return {
    so_number: so.so_number,
    fishbowl: fb
      ? {
          status_name: fb.status_name,
          is_open: fb.is_open,
          customer_name: fb.customer_name,
          customer_po: fb.customer_po,
          salesman: fb.salesman,
          note: fb.note,
          date_first_ship: fb.date_first_ship,
          date_issued: fb.date_issued,
          synced_at: fb.synced_at,
          // Line-item detail rarely changes the headline, and a long order
          // can carry dozens of lines. Keep a count and the first few.
          line_count: Array.isArray(fb.sale_items) ? fb.sale_items.length : 0,
          sale_items: Array.isArray(fb.sale_items)
            ? fb.sale_items.slice(0, 4)
            : [],
        }
      : null,
    monday: md
      ? {
          status: md.status,
          item_updated_at: md.item_updated_at,
          updates: Array.isArray(md.updates) ? md.updates.slice(0, 5) : [],
        }
      : null,
    meetings: meetings.slice(0, 3),
    existing_synthesis: so.existing_synthesis ?? null,
  };
}

/** Split into fixed-size chunks; a partial final chunk is kept. */
export function chunk<T>(items: T[], size: number): T[][] {
  if (size < 1) throw new Error("chunk size must be >= 1");
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
