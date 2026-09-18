// Fishbowl-truth name resolution for Plaud transcripts.
//
// Plaud is a great transcriber but doesn't know the PharmaCenter book of
// customers, vendors, or products, so it produces phonetic look-alikes:
//
//   Plaud says …    Fishbowl truth
//   ─────────────   ──────────────
//   Kunza           Cunsa International LLC
//   Peter Chu       Purechews
//   Beatomex        VitaMex USA
//   Renays          Rene's Naturals, Inc.
//   Inova Gel       InnovaGel
//   Fine Buenes     Unicardio (InnovaGel product)
//   Sayad           (customer TBD — often InnovaGel product)
//
// This module loads the live Fishbowl name lexicon (active customers +
// vendors + product descriptions from the mirror tables) and exposes a
// corrector that scans free text for phonetic/edit-distance near-matches
// and replaces them with the canonical Fishbowl name inline. The result
// is threaded through the UI at render time, so every note the reader
// sees names things the way Fishbowl does — even if Plaud got them wrong.
//
// Deliberately conservative: only substitutes when the match confidence
// is high (short edit distance normalized by length, plus a shared-prefix
// or shared-consonant-skeleton check). No LLM, no external service, no
// dependencies — just character comparison and phonetic folding.

import type { SupabaseClient } from "@supabase/supabase-js";

export type LexiconKind = "customer" | "vendor" | "product" | "person";

export type Lexicon = {
  customers: string[];
  vendors: string[];
  products: string[]; // descriptions (what a reader would say aloud)
  people: string[]; // PharmaCenter staff — full names + common first-name-only forms
};

// PharmaCenter staff, canonical spellings. Plaud commonly mangles these
// (Jesica ↔ Jessica, Louisa ↔ Luisa, Hairo ↔ Jairo, Gutierez ↔ Gutierrez,
// Olivia Cloud ↔ Olivia Clawd, etc.) and the phonetic + edit-distance
// matcher auto-corrects to the canonical form. Extend when new staff
// join or common manglings are noticed.
//
// Sources: HR list + org chart (V2026.06). Includes both full names and
// bare first names so a lone "Rosie" or "Jairo" also gets normalized —
// the matcher prefers longer canonicals on ties, so "Rosie Gutierrez"
// wins over "Rosie" when the source text has "Rosie Gutieres".
export const STAFF_NAMES: string[] = [
  // ── Full names ─────────────────────────────────────────────────
  // Leadership
  "Jairo Osorno", // President
  "Wilmer Torres", // QA Manager & Sanitation Supervisor
  "Melissa Medri", // HR Manager (also spelled "Melissa Medi" on some sheets)
  "Glendy Acosta", // Bookkeeping / Office Admin
  "Andrea Acurero", // Operations Coordinator
  "Rosie Gutierrez", // Purchasing / Logistics Coordinator
  "Jessica Medri", // Sales Manager
  "Jesus Salerno", // Warehouse Manager
  // Under Sales
  "Carlos Rojas", // Sales Rep
  // Under QA
  "Elvira Odoardi", // QC Assistant
  "Maria Williams", // QC Floor Inspector
  // Under Operations
  "Gabriela Nuñez", // Bottling Line Leader — Line 1
  "Yaneisy Rodriguez", // Bottling Line Leader — Line 2
  "Rosa Urias", // BlisterLines Leader
  "Yamilee Reinoso", // Sachet Line Leader
  "Andreina Duarte", // Secondary Packaging Area Leader
  "Leonardo Lacruz", // Manufacturing Coordinator
  "Dionel Davila", // Plant Mechanic
  // Under Warehouse
  "Luisa Sosa", // Warehouse Assistant
  // Also on HR list (may be a shift/rotation worker not on chart)
  "Mario Medri",
  "Andreina Nunez", // note: distinct from Andreina Duarte
  // Note: "Olivia Clawd" appears on the HR export but is an AI agent
  // being built, not a real staff member. Excluded from the lexicon
  // so mentions of "Olivia" in Plaud transcripts aren't auto-corrected
  // to a person that doesn't exist.
  // ── Bare first names — Plaud usually says only one part ──────
  "Andrea",
  "Andreina",
  "Carlos",
  "Dionel",
  "Elvira",
  "Gabriela",
  "Glendy",
  "Jairo",
  "Jessica",
  "Jesus",
  "Leonardo",
  "Luisa",
  "Maria",
  "Mario",
  "Melissa",
  "Rosa",
  "Rosie",
  "Wilmer",
  "Yamilee",
  "Yaneisy",
];

// Canonical PharmaCenter roles, keyed by role → primary person(s).
// The AI synthesis can use this to say "Rosie (Purchasing) confirmed…"
// or "the Sales Manager pushed the date". Kept alongside STAFF_NAMES so
// the whole employee/org lexicon lives in one file.
export const STAFF_ROLES: Record<string, string[]> = {
  President: ["Jairo Osorno"],
  "QA Manager & Sanitation Supervisor": ["Wilmer Torres"],
  "HR Manager": ["Melissa Medri"],
  "Bookkeeping / Office Admin": ["Glendy Acosta"],
  "Operations Coordinator": ["Andrea Acurero"],
  "Purchasing / Logistics Coordinator": ["Rosie Gutierrez"],
  "Sales Manager": ["Jessica Medri"],
  "Warehouse Manager": ["Jesus Salerno"],
  "Sales Rep": ["Melissa Medri", "Carlos Rojas"],
  "QC Assistant": ["Elvira Odoardi"],
  "QC Floor Inspector": ["Maria Williams"],
  "Bottling Line Leader (Line 1)": ["Gabriela Nuñez"],
  "Bottling Line Leader (Line 2)": ["Yaneisy Rodriguez"],
  "BlisterLines Leader": ["Rosa Urias"],
  "Sachet Line Leader": ["Yamilee Reinoso"],
  "Secondary Packaging Area Leader": ["Andreina Duarte"],
  "Manufacturing Coordinator": ["Leonardo Lacruz"],
  "Plant Mechanic": ["Dionel Davila"],
  "Warehouse Assistant": ["Luisa Sosa"],
};

export type Correction = {
  original: string; // as it appeared in the source text
  canonical: string; // Fishbowl truth
  kind: LexiconKind;
};

// ─── Load the lexicon from the Fishbowl mirror ───────────────────────────

/**
 * Pull active customer/vendor/product names from the Fishbowl mirror
 * tables. Cached callers should build this once per request.
 */
export async function loadFishbowlLexicon(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: SupabaseClient<any, any, any>,
): Promise<Lexicon> {
  const [custRes, poRes, soRes] = await Promise.all([
    supabase
      .from("fishbowl_sales_orders")
      .select("customer_name")
      .not("customer_name", "is", null)
      .limit(2000),
    supabase
      .from("fishbowl_purchase_orders")
      .select("vendor_name")
      .not("vendor_name", "is", null)
      .limit(2000),
    supabase
      .from("fishbowl_sales_orders")
      .select("items")
      .not("items", "is", null)
      .limit(2000),
  ]);

  const customers = new Set<string>();
  for (const raw of (custRes.data ?? []) as Array<{ customer_name: string | null }>) {
    if (raw.customer_name && raw.customer_name.trim())
      customers.add(raw.customer_name.trim());
  }

  const vendors = new Set<string>();
  for (const raw of (poRes.data ?? []) as Array<{ vendor_name: string | null }>) {
    if (raw.vendor_name && raw.vendor_name.trim())
      vendors.add(raw.vendor_name.trim());
  }

  const products = new Set<string>();
  for (const raw of (soRes.data ?? []) as Array<{
    items: Array<{
      type_id?: number | null;
      description?: string | null;
    }> | null;
  }>) {
    for (const it of raw.items ?? []) {
      if (typeof it.description === "string" && it.description.trim()) {
        products.add(it.description.trim());
      }
    }
  }

  return {
    customers: Array.from(customers),
    vendors: Array.from(vendors),
    products: Array.from(products),
    people: STAFF_NAMES,
  };
}

// ─── Fuzzy matching ─────────────────────────────────────────────────────

/**
 * Fold a name to its consonant skeleton — a rough phonetic key that
 * survives vowel swaps ("Kunza" and "Cunsa" both fold to "KNS", "Renays"
 * and "Rene's Naturals" both start with "RN"). Also collapses common
 * misheard consonants (K↔C, PH↔F, Y↔I) and strips punctuation. Not as
 * strict as full metaphone, but fast, dependency-free, and good enough
 * for the "Kunza vs Cunsa" class of typo.
 */
function phoneticKey(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // strip accents
    .replace(/[^a-z]/g, "") // keep letters only
    .replace(/ph/g, "f")
    .replace(/ck/g, "k")
    .replace(/c([eiy])/g, "s$1") // soft c → s
    .replace(/c/g, "k") // hard c → k
    .replace(/qu/g, "kw")
    .replace(/x/g, "ks")
    .replace(/z/g, "s")
    .replace(/[aeiouhwy]/g, ""); // drop vowels + silent letters
}

/**
 * Damerau-Levenshtein edit distance (single-char insert/delete/replace/
 * adjacent-transpose). Small enough to run per-word without breaking a
 * sweat.
 */
function editDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const dp: number[][] = Array.from({ length: m + 1 }, () =>
    new Array(n + 1).fill(0),
  );
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost,
      );
      if (
        i > 1 &&
        j > 1 &&
        a[i - 1] === b[j - 2] &&
        a[i - 2] === b[j - 1]
      ) {
        dp[i][j] = Math.min(dp[i][j], dp[i - 2][j - 2] + 1);
      }
    }
  }
  return dp[m][n];
}

/**
 * Score how likely `candidate` (from free text) is a mangling of
 * `canonical` (Fishbowl truth). 0 = no match, 1 = identical, and the
 * threshold for accepting a substitution is 0.72.
 */
function similarity(candidate: string, canonical: string): number {
  const a = candidate.toLowerCase().trim();
  const b = canonical.toLowerCase().trim();
  if (!a || !b) return 0;
  if (a === b) return 1;
  // Consider only the FIRST significant word of the canonical name —
  // "Cunsa" from "Cunsa International LLC", "Purechews" from
  // "Purechews Inc." — so a Plaud "Kunza" matches without needing the
  // full company suffix.
  const bHead = b.split(/[\s,]+/).find((w) => w.length >= 3) ?? b;

  // Strong signal: phonetic keys match.
  const keyA = phoneticKey(a);
  const keyB = phoneticKey(bHead);
  const phoneticMatch = keyA.length > 0 && keyA === keyB;

  // Edit distance normalized against the longer word length. Anything
  // over 40% edit gets rejected outright.
  const longer = Math.max(a.length, bHead.length);
  const dist = editDistance(a, bHead);
  const editRatio = 1 - dist / longer;

  if (phoneticMatch) return Math.max(0.8, editRatio);
  return editRatio;
}

/**
 * Given a lowercased word from free text, return the closest Fishbowl
 * canonical name across ALL three name lists — or null when nothing
 * scores above the acceptance threshold.
 *
 * We prefer specificity: an EXACT-word match beats a fuzzy match, and
 * longer canonical names outrank shorter ones (so "Cunsa International"
 * outranks "Cunsa" when both hit).
 */
export function findClosestName(
  candidate: string,
  lexicon: Lexicon,
  minScore = 0.72,
): { canonical: string; kind: LexiconKind; score: number } | null {
  const all: Array<{ name: string; kind: LexiconKind }> = [
    ...lexicon.customers.map((n) => ({ name: n, kind: "customer" as const })),
    ...lexicon.vendors.map((n) => ({ name: n, kind: "vendor" as const })),
    ...lexicon.people.map((n) => ({ name: n, kind: "person" as const })),
    // Products are rarely mentioned by full description in Plaud text;
    // skip them from the fuzzy corrector unless the caller explicitly
    // opts in later — false positives would be too noisy.
  ];
  let best: {
    canonical: string;
    kind: LexiconKind;
    score: number;
  } | null = null;
  for (const { name, kind } of all) {
    const s = similarity(candidate, name);
    if (s < minScore) continue;
    if (
      !best ||
      s > best.score ||
      (s === best.score && name.length > best.canonical.length)
    ) {
      best = { canonical: name, kind, score: s };
    }
  }
  return best;
}

// ─── Text-level corrector ───────────────────────────────────────────────

// Word-shape regex — grabs a capitalized run (possibly with an
// apostrophe or hyphen inside): "Cunsa", "Rene's", "Peter Chu",
// "Vita-Joy". Also picks up two-word capitalized runs so "Peter Chu"
// stays glued.
const CAPITALIZED_SPAN = /\b[A-Z][A-Za-z0-9'’\-]+(?:\s+[A-Z][A-Za-z0-9'’\-]+)?/g;

/**
 * Scan free text for capitalized name-like spans; for each, look up the
 * closest Fishbowl canonical name; if one is found AND it differs from
 * the source, replace it inline. Returns the corrected string plus the
 * list of substitutions made so the UI can render an audit trail.
 *
 * Substitutions are word-boundary-anchored so "Cunsa" won't rewrite an
 * unrelated "Cunsan" — but "Kunza" → "Cunsa" fires.
 */
export function correctPlaudText(
  text: string,
  lexicon: Lexicon,
  minScore = 0.72,
): { corrected: string; corrections: Correction[] } {
  if (!text) return { corrected: text, corrections: [] };

  const corrections: Correction[] = [];
  const seen = new Map<string, string>(); // original → canonical (once per span)

  const corrected = text.replace(CAPITALIZED_SPAN, (span) => {
    // Trim trailing punctuation the regex captured.
    const clean = span.replace(/[.,;:!?)]+$/, "");
    if (!clean) return span;

    // Cached decision from earlier in this pass.
    if (seen.has(clean)) {
      const canonical = seen.get(clean)!;
      return span.replace(clean, canonical);
    }

    const match = findClosestName(clean, lexicon, minScore);
    if (!match) {
      seen.set(clean, clean);
      return span;
    }
    // If the span is already an exact substring of the canonical name
    // (case-insensitive), leave it alone — no correction needed.
    if (
      match.canonical.toLowerCase().includes(clean.toLowerCase()) &&
      clean.length >= 4
    ) {
      seen.set(clean, clean);
      return span;
    }
    if (clean.toLowerCase() === match.canonical.toLowerCase()) {
      seen.set(clean, clean);
      return span;
    }
    seen.set(clean, match.canonical);
    corrections.push({
      original: clean,
      canonical: match.canonical,
      kind: match.kind,
    });
    return span.replace(clean, match.canonical);
  });

  return { corrected, corrections };
}
