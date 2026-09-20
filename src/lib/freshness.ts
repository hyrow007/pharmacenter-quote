/**
 * Sync freshness — shared across every PharmaCenter app.
 *
 * The rule: any screen backed by the nightly Fishbowl sync shows how old
 * its data is, and shouts when the sync did not run. The threshold is 26
 * hours — the job runs ~04:30 daily, so anything past 26h means last
 * night's run was missed.
 *
 * Why this exists: on 2026-09-19 an audit found Monday board data 24 days
 * stale on a screen the team reads every week. Nobody noticed, because
 * nothing on the page said how old it was. An automated job that leaves no
 * visible evidence will eventually stop running silently.
 *
 * This module is duplicated verbatim across the two PharmaCenter repos,
 * pharmacenter-packing-list and pharmacenter-quote. The two copies must
 * stay BYTE-IDENTICAL: `diff` between them should print nothing. Keeping
 * the header symmetric (rather than each pointing at the other) is what
 * makes that check mechanical instead of a reading exercise. Change one,
 * change the other in the same session.
 *
 * The three inline copies this module was written to replace are gone as of
 * 2026-09-20. They had drifted in ways that showed on screen: two were
 * English-only regardless of the language toggle, and the third -- the one
 * behind the Orders landing page -- had no staleness concept at all, which
 * is why that page could read "hace 10h" and stay silent at ten days. It
 * also rounded where this one floors, so the same timestamp read "1h ago"
 * on Orders and "31 min ago" everywhere else.
 */

export const STALE_AFTER_HOURS = 26;

export type Freshness = {
  /** Human-readable age, e.g. "3h ago". Localized when `t` is passed. */
  relative: string;
  /** True when the sync is older than STALE_AFTER_HOURS, or never ran. */
  stale: boolean;
  /** Age in hours, or null when there is no timestamp at all. */
  ageHours: number | null;
};

/**
 * The exact keys this module needs from a dictionary.
 *
 * Typed as a union of literals rather than `string` on purpose. Under
 * `strictFunctionTypes`, parameters are checked contravariantly: a
 * `makeT(lang)` whose key parameter is the app's own `TranslationKey`
 * union is assignable here only because every literal below is a member
 * of that union. Widening this to `string` would break assignment and
 * force a cast at every call site.
 *
 * Adding a key here means adding it to both dictionaries in both apps.
 */
export type FreshnessKey =
  | "timeJustNow"
  | "timeMinAgo"
  | "timeHrAgo"
  | "timeDayAgo"
  | "syncNever";

type Translate = (
  key: FreshnessKey,
  vars?: Record<string, string | number>,
) => string;

const FALLBACK: Record<FreshnessKey, string> = {
  timeJustNow: "just now",
  timeMinAgo: "{n} min ago",
  timeHrAgo: "{n}h ago",
  timeDayAgo: "{n}d ago",
  syncNever: "never",
};

function phrase(
  t: Translate | undefined,
  key: FreshnessKey,
  n?: number,
): string {
  const vars = n === undefined ? undefined : { n: String(n) };
  if (t) return t(key, vars);
  let out: string = FALLBACK[key];
  if (vars) out = out.replace("{n}", vars.n);
  return out;
}

/**
 * Describe how long ago a sync ran.
 *
 * A null/invalid timestamp is treated as STALE, not as "unknown" — a
 * screen that cannot prove its data is fresh should say so rather than
 * stay quiet. That is the whole point of the indicator.
 */
export function describeFreshness(
  iso: string | null | undefined,
  t?: Translate,
  lang?: "en" | "es",
): Freshness {
  if (!iso) {
    return { relative: phrase(t, "syncNever"), stale: true, ageHours: null };
  }
  const ms = new Date(iso).getTime();
  if (!Number.isFinite(ms)) {
    return { relative: phrase(t, "syncNever"), stale: true, ageHours: null };
  }

  const ageMs = Date.now() - ms;
  const ageHours = ageMs / (60 * 60 * 1000);
  const stale = ageHours > STALE_AFTER_HOURS;

  let relative: string;
  if (ageMs < 60_000) relative = phrase(t, "timeJustNow");
  else if (ageMs < 60 * 60_000)
    relative = phrase(t, "timeMinAgo", Math.floor(ageMs / 60_000));
  else if (ageHours < 24) relative = phrase(t, "timeHrAgo", Math.floor(ageHours));
  else if (ageHours < 24 * 30)
    relative = phrase(t, "timeDayAgo", Math.floor(ageHours / 24));
  // Past a month "847d ago" stops being information. The Orders landing's
  // inline copy did this and it was the one thing it did better, so it is
  // kept here rather than lost in the consolidation. `lang` only picks the
  // date locale; everything above is translated through `t`.
  else relative = new Date(ms).toLocaleDateString(lang === "es" ? "es" : "en-US");

  return { relative, stale, ageHours };
}
