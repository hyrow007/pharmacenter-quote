"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { makeT, type Lang } from "@/lib/i18n/dict";

// "Sync now" — in the header band, on every app, for anyone signed in.
//
// What it does NOT do is start a sync. Vercel cannot reach the office LAN, so
// this queues a request; a task on the office server picks it up within about
// two minutes, runs the full sync, and reports back. The copy says minutes
// rather than implying instant, because a button that looks instant and takes
// three minutes gets clicked four times.
//
// One button, not one per app: a sync is global. It re-reads Fishbowl and
// pushes customers, products, raw materials, packaging, sales orders,
// purchase orders and product costs in one pass, whichever app asked.
//
// Open to every signed-in PharmaCenter account, not just admins: the people
// who notice stale data are the ones using it, and making them find an admin
// is how you get a workaround instead of a fix. Abuse is bounded by the API
// -- one request at a time, and a cooldown after a completed run.
//
// In the band it is compact: an icon and a word. The detail (who asked, how
// it went) lives in the title attribute rather than taking horizontal space
// from a header that already carries a wordmark, nav, language and email.

type RequestRow = {
  id: string;
  requested_by: string;
  requested_at: string;
  status: "pending" | "running" | "done" | "failed" | "abandoned";
  started_at: string | null;
  finished_at: string | null;
  detail: string | null;
};

const POLL_MS = 5000;
// Long enough to cover a full sync (the live dump is under a second, the
// parse and POSTs take a couple of minutes), short enough that a dead poller
// does not leave a spinner going all afternoon.
const GIVE_UP_MS = 12 * 60 * 1000;

function localPart(email: string): string {
  const at = email.indexOf("@");
  return at > 0 ? email.slice(0, at) : email;
}

export default function SyncNowButton({ lang }: { lang: Lang }) {
  const t = makeT(lang);
  const router = useRouter();
  const [request, setRequest] = useState<RequestRow | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Whether THIS tab is waiting on a run, so a long-finished request from
  // yesterday does not make the page refresh itself on load.
  const watching = useRef(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/sync/request", { cache: "no-store" });
      const json = await res.json();
      if (json?.ok) setRequest(json.request ?? null);
      return json?.request as RequestRow | null;
    } catch {
      return null;
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Poll only while something is in flight.
  useEffect(() => {
    const active =
      request && (request.status === "pending" || request.status === "running");
    if (!active) return;
    const startedWatching = Date.now();
    const timer = setInterval(async () => {
      const next = await load();
      if (Date.now() - startedWatching > GIVE_UP_MS) {
        clearInterval(timer);
        return;
      }
      if (next && (next.status === "done" || next.status === "failed")) {
        clearInterval(timer);
        // The page was server-rendered from data this run just replaced.
        if (watching.current && next.status === "done") router.refresh();
        watching.current = false;
      }
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [request, load, router]);

  async function onClick() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/sync/request", { method: "POST" });
      const json = await res.json();
      if (!json?.ok) {
        setError(t("syncNowError", { msg: json?.error ?? "failed" }));
        return;
      }
      watching.current = true;
      setRequest(json.request as RequestRow);
    } catch (e) {
      setError(t("syncNowError", { msg: e instanceof Error ? e.message : "failed" }));
    } finally {
      setBusy(false);
    }
  }

  const inFlight =
    request && (request.status === "pending" || request.status === "running");

  // Everything the wide version said in prose, folded into one hover string.
  let title = t("syncNowHint");
  if (error) title = error;
  else if (inFlight) title = t("syncNowQueued", { who: localPart(request.requested_by) });
  else if (request?.status === "done") title = t("syncNowDone");
  else if (request?.status === "failed") title = `${t("syncNowFailed")} ${request.detail ?? ""}`.trim();
  else if (request?.status === "abandoned") title = t("syncNowAbandoned");

  return (
    <button
      type="button"
      className={`app-nav__sync${inFlight ? " is-running" : ""}`}
      onClick={onClick}
      disabled={busy || !!inFlight}
      title={title}
      aria-live="polite"
    >
      <svg
        width="13"
        height="13"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
        aria-hidden="true"
        className={inFlight ? "app-nav__sync-spin" : undefined}
      >
        <path d="M20 11a8 8 0 1 0-.6 4.1" />
        <path d="M20 4.5V11h-6.2" />
      </svg>
      <span>{inFlight ? t("syncNowRunning") : t("syncNow")}</span>
    </button>
  );
}
