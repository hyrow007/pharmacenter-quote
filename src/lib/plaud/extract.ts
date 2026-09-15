// SO extraction + Fishbowl cross-reference for Plaud recordings.
//
// Plaud's AI summary is a bilingual free-text markdown blob whose speakers
// pronounce SO numbers a dozen ways ("Sales Order 14693", "SO 14733",
// "M-14221", "M14381-4", "14730/1473?"). This module turns that into a
// clean list of {so_number, note_md, action_items, status_flag,
// fishbowl_snapshot} rows keyed on Fishbowl-verified so_number strings.
//
// The critical piece is cross-referencing every extracted SO against
// public.fishbowl_sales_orders. Fishbowl is the source of truth for
// customer_name / product / status / ship dates — if the Plaud speaker
// says "Peter Chu 14767" but Fishbowl says 14767 = Purechews, the
// extractor trusts Fishbowl and appends a warning line to the note. This
// catches transcription errors (b/v swaps, homophones, dropped M-
// prefixes) automatically without a curator having to notice.

// The supabase client is passed in — accept any variant (service-role or
// ssr-wrapped). Typing as `any` sidesteps supabase-js's aggressively
// generic client type, which cascades into "Type instantiation is
// excessively deep" at every call site otherwise.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnySupabase = any;

// ---- Types ---------------------------------------------------------------

export type OtherBusinessItem = {
  /** Short title — e.g. "Shandong load status" or "Line 2 sequence". */
  title: string;
  /** Full body text carved from the Plaud bullet. */
  note_md: string;
  /** Structured follow-ups; may be empty. */
  action_items: Array<{
    text: string;
    owner?: string;
    due_date?: string;
    done?: boolean;
  }>;
};

export type SoMention = {
  /** Canonical so_number as it exists in Fishbowl (e.g. "14693", "M-14221"). */
  so_number: string;
  /** Markdown note body — the speaker's words about this SO from the summary. */
  note_md: string;
  /** Structured follow-ups. */
  action_items: Array<{
    text: string;
    owner?: string;
    due_date?: string;
    done?: boolean;
  }>;
  /** Optional urgency tag. */
  status_flag?: "on_track" | "at_risk" | "blocked" | null;
  /** Snapshot of the Fishbowl row at ingest time, minus noisy fields. */
  fishbowl_snapshot: Record<string, unknown> | null;
  /**
   * True when the Plaud text mentions a customer name that doesn't fuzzy-match
   * the Fishbowl customer_name for this SO. When true, the note_md carries an
   * inline warning ("⚠ Plaud said X, Fishbowl says Y") and status_flag is
   * bumped to at_risk if not already set.
   */
  customer_mismatch: boolean;
};

// Fishbowl fields we care about for snapshotting. Mirrors the read side of
// /api/sales-orders minus items/sync bookkeeping.
type FishbowlSnapshotShape = {
  so_number: string;
  status_id: number | null;
  status_name: string | null;
  is_open: boolean;
  customer_name: string | null;
  customer_po: string | null;
  salesman: string | null;
  date_first_ship: string | null;
  subtotal: number | null;
  total_price: number | null;
};

// ---- SO number regex ----------------------------------------------------

// Matches the shapes we've seen in Plaud transcripts:
//   "SO 14693", "SO14693", "SO#14693", "SO-14693"
//   "SO M-14221", "SOM14381", "SO M14381-4"
//   "Sales Order 14693", "Sales Order M-14221"
//   Bare "14693" / "M-14221" when adjacent to sale-order context words
// Groups:
//   [1] optional "M" or "M-" prefix
//   [2] digit body (4-6 digits)
//   [3] optional dash suffix like "-1", "-2"
const SO_RE =
  /\b(?:SO|S\.O\.|Sales?\s+Order)\s*[#\-:]?\s*(M-?)?(\d{4,6})(-\d+)?\b/gi;

/**
 * Extract every SO reference from a block of Plaud markdown. Returns
 * canonical "so_number" strings (as they'd appear in fishbowl_sales_orders)
 * paired with the character span they were found at, so a later step can
 * carve out the paragraph around each mention as the note body.
 */
export function findSoMentions(
  text: string,
): Array<{ so_number: string; index: number; matched: string }> {
  const out: Array<{ so_number: string; index: number; matched: string }> = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(SO_RE)) {
    const mPrefix = m[1] ? m[1].replace("-", "").toUpperCase() : "";
    const digits = m[2];
    const dashSuffix = m[3] ?? "";
    // Canonicalize to Fishbowl format. Master-order prefix is "M-" (with dash)
    // per Rene's / Sensory Scout examples; the "M14381" (no dash) shape is
    // normalized to "M14381" — we try BOTH when looking up so no exact-form
    // guess is required at extraction time.
    const canonical = mPrefix
      ? `${mPrefix}${mPrefix === "M" && digits.startsWith("-") ? "" : "-"}${digits}${dashSuffix}`
      : `${digits}${dashSuffix}`;
    const canonicalKey = `${canonical}@${m.index}`;
    if (seen.has(canonicalKey)) continue;
    seen.add(canonicalKey);
    out.push({ so_number: canonical, index: m.index ?? 0, matched: m[0] });
  }
  return out;
}

/**
 * Given an SO number extracted from Plaud, resolve it against Fishbowl.
 * Tries the canonical form first, then a couple of common alternatives
 * (with/without "M-" prefix, with/without dash suffix). Returns the first
 * matching Fishbowl row or null.
 */
export async function resolveSoAgainstFishbowl(
  supabase: AnySupabase,
  raw: string,
): Promise<FishbowlSnapshotShape | null> {
  const candidates = new Set<string>([raw]);
  // Master-order variants.
  if (raw.startsWith("M-")) candidates.add(raw.replace("M-", "M"));
  if (raw.startsWith("M") && !raw.startsWith("M-"))
    candidates.add(raw.replace(/^M/, "M-"));
  // Strip -N suffix and try the base master.
  if (/-\d+$/.test(raw)) candidates.add(raw.replace(/-\d+$/, ""));
  // Strip leading M entirely — sometimes the master lands under bare number.
  if (raw.startsWith("M")) candidates.add(raw.replace(/^M-?/, ""));

  const list = Array.from(candidates);
  const { data, error } = await supabase
    .from("fishbowl_sales_orders")
    .select(
      "so_number, status_id, status_name, is_open, customer_name, customer_po, salesman, date_first_ship, subtotal, total_price",
    )
    .in("so_number", list)
    .limit(list.length);

  const rows = (data ?? []) as unknown as FishbowlSnapshotShape[];
  if (error || rows.length === 0) return null;

  // Prefer an exact match over a fallback.
  const exact = rows.find((r) => r.so_number === raw);
  return exact ?? rows[0];
}

// ---- Customer cross-reference -------------------------------------------

// Common Plaud-mangling patterns we've caught by hand. When a Plaud-said
// customer name doesn't match Fishbowl, the mismatch flag flips regardless;
// this table lets us surface a helpful "did you mean" hint in the warning.
const KNOWN_PLAUD_MISMATCHES: Array<{
  plaud: RegExp;
  fishbowl_hint: string;
}> = [
  { plaud: /\bpeter\s+chu\b/i, fishbowl_hint: "Purechews" },
  { plaud: /\bbeatomex\b/i, fishbowl_hint: "VitaMex" },
  { plaud: /\brenays?\b/i, fishbowl_hint: "Rene's Naturals" },
  { plaud: /\binova\s*gel\b/i, fishbowl_hint: "InnovaGel" },
  { plaud: /\bfine\s*buenes\b/i, fishbowl_hint: "InnovaGel Unicardio" },
  { plaud: /\bagency\s+commercial\b/i, fishbowl_hint: "Agencia Comercial Wan Tung" },
];

/**
 * Fuzzy customer-match between what Plaud transcribed and what Fishbowl
 * has. Returns true when they clearly disagree — i.e. Fishbowl has a
 * customer, the Plaud text near the SO mention has a customer-shaped span,
 * and their tokens don't overlap.
 *
 * Deliberately permissive: partial substring match either way counts as
 * "matches" so we don't flag "Kunza" vs "Kunza International" as a
 * mismatch. The goal is catching the Peter-Chu-vs-Purechews class of error,
 * not language variations.
 */
export function detectCustomerMismatch(
  noteText: string,
  fishbowlCustomer: string | null,
): { mismatch: boolean; hint: string | null } {
  if (!fishbowlCustomer) return { mismatch: false, hint: null };
  const noteL = noteText.toLowerCase();
  const custL = fishbowlCustomer.toLowerCase();
  // Direct substring hit — Plaud text contains the Fishbowl customer name.
  if (noteL.includes(custL)) return { mismatch: false, hint: null };
  // First significant word of Fishbowl customer appears in the note.
  const firstWord = custL.split(/\s+/).find((w) => w.length >= 4);
  if (firstWord && noteL.includes(firstWord))
    return { mismatch: false, hint: null };
  // Check known mangling patterns — if one hits, the Plaud text IS wrong
  // by definition (that's what "known mangling" means). Always flag as a
  // mismatch and surface a hint: prefer the pattern's hint when it agrees
  // with Fishbowl (so the "did you mean" is trustworthy), otherwise show
  // the actual Fishbowl customer name.
  for (const { plaud, fishbowl_hint } of KNOWN_PLAUD_MISMATCHES) {
    if (plaud.test(noteText)) {
      const hintL = fishbowl_hint.toLowerCase();
      const hintAgreesWithFishbowl =
        custL.includes(hintL.split(/\s+/)[0]) ||
        hintL.includes(custL.split(/\s+/)[0]);
      return {
        mismatch: true,
        hint: hintAgreesWithFishbowl ? fishbowl_hint : fishbowlCustomer,
      };
    }
  }
  // No overlap and no known-mangling hit → likely a mismatch, but we don't
  // have a good hint to offer.
  return { mismatch: true, hint: null };
}

// ---- Paragraph carving ---------------------------------------------------

/**
 * Given the full markdown and a mention index, return the paragraph (or
 * bullet + its indented sub-bullets) that surrounds that mention. This is
 * what becomes note_md.
 *
 * The Plaud summary is organized as top-level bullets like:
 *   - Sales Order 14693 (Agency Commercial, Vitamin E)
 *     - Missing components (labels, boxes, inserts) were shipped …
 *     - Conclusion: Waiting on tracking …
 * We want the whole block, not just the header line, so we scan forward
 * until we hit a line that starts a NEW top-level bullet at the same
 * indentation level as the header.
 */
export function carveNote(text: string, mentionIndex: number): string {
  // Walk back to the start of the containing line/paragraph.
  const before = text.lastIndexOf("\n", mentionIndex);
  const startOfLine = before === -1 ? 0 : before + 1;
  const headerLine = text.slice(startOfLine).split("\n", 1)[0];
  const indentMatch = /^(\s*)([-*]\s+)?/.exec(headerLine);
  const headerIndent = indentMatch ? indentMatch[1].length : 0;

  const lines = text.slice(startOfLine).split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (i === 0) {
      out.push(line);
      continue;
    }
    // Blank line inside a bullet block — keep it.
    if (line.trim() === "") {
      out.push(line);
      continue;
    }
    // A line at or shallower than the header indent that starts with a
    // bullet marker (or a new markdown heading) ends the block.
    const lm = /^(\s*)([-*]|\d+\.)\s/.exec(line);
    if (lm && lm[1].length <= headerIndent) break;
    if (/^\s{0,3}#{1,6}\s/.test(line)) break;
    out.push(line);
  }
  // Trim trailing blank lines.
  while (out.length > 0 && out[out.length - 1].trim() === "") out.pop();
  return out.join("\n").trim();
}

// ---- Full pipeline ------------------------------------------------------

/**
 * The full extractor. Given the Plaud summary markdown + an authenticated
 * Supabase client with read access to fishbowl_sales_orders, returns the
 * SoMention rows ready to upsert into meeting_so_notes.
 *
 * Every extracted SO is resolved against Fishbowl. If the resolver comes
 * back with a customer that clearly disagrees with what Plaud said in the
 * paragraph, note_md gets a "⚠ Plaud said X, Fishbowl says Y" line and
 * status_flag is bumped to at_risk (if not already stronger).
 */
export async function extractMentionsFromSummary(
  supabase: AnySupabase,
  summary_md: string,
): Promise<SoMention[]> {
  const raw = findSoMentions(summary_md);
  // Collapse repeats — keep the first occurrence's index for paragraph
  // carving, discard duplicates.
  const seen = new Set<string>();
  const uniq = raw.filter((m) => {
    if (seen.has(m.so_number)) return false;
    seen.add(m.so_number);
    return true;
  });

  const out: SoMention[] = [];
  for (const mention of uniq) {
    const fishbowl = await resolveSoAgainstFishbowl(
      supabase,
      mention.so_number,
    );
    const carved = carveNote(summary_md, mention.index);
    const { mismatch, hint } = detectCustomerMismatch(
      carved,
      fishbowl?.customer_name ?? null,
    );

    let note_md = carved;
    let status_flag: SoMention["status_flag"] = null;
    if (mismatch) {
      const line = hint
        ? `\n\n⚠ Plaud text and Fishbowl customer disagree — likely "${hint}" per Fishbowl. Verify before acting.`
        : `\n\n⚠ Plaud text mentions a customer that doesn't match Fishbowl (${fishbowl?.customer_name ?? "no Fishbowl row"}). Verify.`;
      note_md += line;
      status_flag = "at_risk";
    }

    out.push({
      so_number: fishbowl?.so_number ?? mention.so_number,
      note_md,
      action_items: [],
      status_flag,
      fishbowl_snapshot: fishbowl
        ? (fishbowl as unknown as Record<string, unknown>)
        : null,
      customer_mismatch: mismatch,
    });
  }
  return out;
}

// ---- Other business extraction ------------------------------------------

/**
 * Cross-cutting topics that don't tie to a single SO — the "Other
 * business" section in the 8/25 curated PDF (Shandong load status,
 * Line 2 sequence, film/cash question, Cunsa packaging campaign notes
 * about extra packers, etc.).
 *
 * Walks top-level bullets (single `-` at start of line) in the Plaud AI
 * summary. Any bullet whose header + body contain NO SO reference is
 * kept as an OtherBusinessItem. Bullets with SO refs are left to
 * extractMentionsFromSummary. Skips the boilerplate "Meeting
 * Information", "Meeting Notes", "Next Arrangements", and "AI
 * Suggestions" section headers.
 */
export function extractOtherBusinessFromSummary(
  summary_md: string,
): OtherBusinessItem[] {
  const out: OtherBusinessItem[] = [];
  // Match each top-level bullet: line starts with "- ", followed by
  // possibly-indented continuation lines until the next top-level bullet
  // or a heading. Using multiline exec loop rather than a giant regex.
  const lines = summary_md.split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    // Skip section headings and blank lines.
    if (/^\s{0,3}#{1,6}\s/.test(line) || line.trim() === "") {
      i++;
      continue;
    }
    // Top-level bullet: line starts with "- " (no leading indent).
    if (!/^-\s+/.test(line)) {
      i++;
      continue;
    }
    // Carve the whole bullet block.
    const start = i;
    let j = i + 1;
    while (j < lines.length) {
      const nxt = lines[j];
      if (/^-\s+/.test(nxt)) break; // next top-level bullet
      if (/^\s{0,3}#{1,6}\s/.test(nxt)) break; // new heading
      j++;
    }
    const block = lines.slice(start, j).join("\n").trim();
    i = j;

    // Skip if the block references any SO — that goes to SO notes.
    SO_RE.lastIndex = 0;
    if (SO_RE.test(block)) continue;
    // Skip lightweight AI-summary meta lines like "> Date: …",
    // "> Participants: …" which sometimes float outside the main
    // structure.
    if (/^-\s+>\s/.test(lines[start])) continue;

    // Extract a title from the first line. Plaud usually formats as:
    //   - Topic Title: Bulk Availability …
    //   - <mark …>Topic Title: HARDWARE Highlights
    //   - Kunza September Needs and Bulk Planning
    // Strip leading "- ", strip a "Topic Title:" prefix, strip HTML
    // <mark> tags, and trim.
    let header = lines[start]
      .replace(/^-\s+/, "")
      .replace(/<\/?[^>]+>/g, "")
      .trim();
    const topicMatch = /^Topic\s+Title:\s*(.+)$/i.exec(header);
    if (topicMatch) header = topicMatch[1].trim();
    // If the header still ends with a colon (from "Topic Title: ..."
    // being on its own line and the actual title on the next), grab the
    // next non-blank line.
    if (header.endsWith(":") && start + 1 < lines.length) {
      header = lines[start + 1].replace(/^\s*-\s+/, "").trim() || header;
    }
    if (!header) continue;

    // Body = the block minus the header line, cleaned up. Strip leading
    // "- " markers on continuation lines so the rendered markdown reads
    // as flowing prose rather than a nested list.
    const bodyLines = lines
      .slice(start + 1, j)
      .map((l) => l.replace(/^\s*-\s+/, ""))
      .map((l) => l.replace(/<\/?[^>]+>/g, ""));
    // Drop trailing blanks.
    while (bodyLines.length && bodyLines[bodyLines.length - 1].trim() === "")
      bodyLines.pop();
    const body = bodyLines.join("\n").trim();

    out.push({
      title: header,
      note_md: body,
      action_items: [],
    });
  }
  return out;
}
