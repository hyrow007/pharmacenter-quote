"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { makeT, type Lang } from "@/lib/i18n/dict";

// "Sync now" — admin-only, rendered beside a freshness line.
//
// What it does NOT do is start a sync. Vercel cannot reach the office LAN, so
// this queues a request; a task on the office server picks it up within about
// two minutes, runs the full sync, and reports back. The copy says minutes
// rather than implying instant, because a button that looks instant and takes
// three minutes gets clicked four times.
//
// One button, not one per app: a sync is global. It re-reads Fishbowl and
// pushes customers, products, raw materials, packaging, sales orders,
// purchase orders and product costs in one pass, whichever page asked.

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

  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
      <button
        type="button"
        className="btn-chrome"
        onClick={onClick}
        disabled={busy || !!inFlight}
        style={{ fontSize: 12, padding: "4px 10px" }}
      >
        {inFlight ? t("syncNowRunning") : t("syncNow")}
      </button>
      {inFlight ? (
        <span style={{ fontSize: 12, color: "var(--ink-3, #8a9498)" }}>
          {t("syncNowQueued", { who: localPart(request.requested_by) })}
        </span>
      ) : null}
      {!inFlight && request?.status === "done" ? (
        <span style={{ fontSize: 12, color: "var(--sage-700, #5f8e3a)" }}>
          {t("syncNowDone")}
        </span>
      ) : null}
      {!inFlight && request?.status === "failed" ? (
        <span style={{ fontSize: 12, color: "#8b2f2f", fontWeight: 600 }} title={request.detail ?? undefined}>
          {t("syncNowFailed")}
        </span>
      ) : null}
      {!inFlight && request?.status === "abandoned" ? (
        <span style={{ fontSize: 12, color: "#8b2f2f", fontWeight: 600 }}>
          {t("syncNowAbandoned")}
        </span>
      ) : null}
      {error ? (
        <span role="alert" style={{ fontSize: 12, color: "#8b2f2f" }}>
          {error}
        </span>
      ) : null}
    </span>
  );
}
