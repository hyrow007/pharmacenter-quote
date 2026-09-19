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
 * Keep this identical to pharmacenter-packing-list/src/lib/freshness.ts.
 *
 * TODO: three older copies of this logic still live inline and should
 * fold into this module -- they already disagree on shape:
 *   - src/app/meetings/sales-orders/all/OpenOrdersBoard.tsx (has the 26h rule, English only)
 *   - src/app/meetings/sales-orders/orders/[so]/page.tsx    (has the 26h rule, English only)
 *   - src/app/orders/page.tsx                               (i18n-aware, NO staleness at all)
 * That last one is why the Orders landing shows an age but never warns.
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
  else relative = phrase(t, "timeDayAgo", Math.floor(ageHours / 24));

  return { relative, stale, ageHours };
}
