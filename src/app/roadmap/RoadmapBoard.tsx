"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { makeT, type Lang } from "@/lib/i18n/dict";
import {
  APP_LABEL,
  PRIORITY_LABEL,
  ROADMAP_APPS,
  STATUS_LABEL,
  type RoadmapApp,
  type RoadmapItem,
  type RoadmapPriority,
  type RoadmapStatus,
} from "@/lib/roadmap";
import {
  addRoadmapItem,
  deleteRoadmapItem,
  updateRoadmapItem,
  type RoadmapActionResult,
} from "./actions";

// The four working columns. "Dropped" is kept out of the board and folded
// away underneath: a dropped idea is worth remembering (so nobody proposes it
// again blind) but not worth a quarter of the screen.
const COLUMNS: RoadmapStatus[] = ["idea", "planned", "in_progress", "shipped"];
const ALL_STATUSES: RoadmapStatus[] = [...COLUMNS, "dropped"];

export default function RoadmapBoard({
  items,
  lang,
}: {
  items: RoadmapItem[];
  lang: Lang;
}) {
  const t = makeT(lang);
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [showDropped, setShowDropped] = useState(false);

  // Add-form state.
  const [title, setTitle] = useState("");
  const [details, setDetails] = useState("");
  const [app, setApp] = useState<RoadmapApp>("hub");
  const [priority, setPriority] = useState<RoadmapPriority>(2);

  function run(action: () => Promise<RoadmapActionResult>, after?: () => void) {
    setError(null);
    startTransition(async () => {
      const res = await action();
      if (!res.ok) {
        setError(t("rmSaveError", { msg: res.error }));
        return;
      }
      after?.();
      router.refresh();
    });
  }

  function onAdd(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim()) return;
    run(
      () => addRoadmapItem({ title, details, app, priority }),
      () => {
        setTitle("");
        setDetails("");
      },
    );
  }

  const dropped = items.filter((i) => i.status === "dropped");
  const dateFmt = new Intl.DateTimeFormat(lang === "es" ? "es-US" : "en-US", {
    month: "short",
    day: "numeric",
  });

  return (
    <div className="roadmap" aria-busy={pending}>
      <form className="roadmap-add" onSubmit={onAdd}>
        <p className="roadmap-add__heading">{t("rmAddHeading")}</p>
        <input
          className="roadmap-input"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder={t("rmFieldTitle")}
          aria-label={t("rmFieldTitle")}
          maxLength={200}
          required
        />
        <textarea
          className="roadmap-input roadmap-input--area"
          value={details}
          onChange={(e) => setDetails(e.target.value)}
          placeholder={t("rmFieldDetails")}
          aria-label={t("rmFieldDetails")}
          maxLength={4000}
          rows={2}
        />
        <div className="roadmap-add__row">
          <label className="roadmap-field">
            <span>{t("rmFieldApp")}</span>
            <select
              className="roadmap-select"
              value={app}
              onChange={(e) => setApp(e.target.value as RoadmapApp)}
            >
              {ROADMAP_APPS.map((a) => (
                <option key={a} value={a}>
                  {t(APP_LABEL[a])}
                </option>
              ))}
            </select>
          </label>
          <label className="roadmap-field">
            <span>{t("rmFieldPriority")}</span>
            <select
              className="roadmap-select"
              value={priority}
              onChange={(e) => setPriority(Number(e.target.value) as RoadmapPriority)}
            >
              {([1, 2, 3] as RoadmapPriority[]).map((p) => (
                <option key={p} value={p}>
                  {t(PRIORITY_LABEL[p])}
                </option>
              ))}
            </select>
          </label>
          <button type="submit" className="btn-chrome" disabled={pending || !title.trim()}>
            {t("rmAdd")}
          </button>
        </div>
      </form>

      {error ? (
        <p className="roadmap-error" role="alert">
          {error}
        </p>
      ) : null}

      <div className="roadmap-board">
        {COLUMNS.map((status) => {
          const col = items.filter((i) => i.status === status);
          return (
            <section key={status} className={`roadmap-col roadmap-col--${status}`}>
              <h2 className="roadmap-col__title">
                {t(STATUS_LABEL[status])}
                <span className="roadmap-col__count">{col.length}</span>
              </h2>
              {col.length === 0 ? (
                <p className="roadmap-empty">{t("rmEmpty")}</p>
              ) : (
                <ul className="roadmap-list">
                  {col.map((item) => (
                    <Card
                      key={item.id}
                      item={item}
                      t={t}
                      dateFmt={dateFmt}
                      disabled={pending}
                      onStatus={(s) => run(() => updateRoadmapItem(item.id, { status: s }))}
                      onPriority={(p) => run(() => updateRoadmapItem(item.id, { priority: p }))}
                      onDelete={() => run(() => deleteRoadmapItem(item.id))}
                    />
                  ))}
                </ul>
              )}
            </section>
          );
        })}
      </div>

      {dropped.length > 0 ? (
        <div className="roadmap-dropped">
          <button
            type="button"
            className="roadmap-link"
            onClick={() => setShowDropped((v) => !v)}
            aria-expanded={showDropped}
          >
            {showDropped
              ? t("rmHideDropped")
              : t("rmShowDropped", { n: dropped.length })}
          </button>
          {showDropped ? (
            <ul className="roadmap-list roadmap-list--dropped">
              {dropped.map((item) => (
                <Card
                  key={item.id}
                  item={item}
                  t={t}
                  dateFmt={dateFmt}
                  disabled={pending}
                  onStatus={(s) => run(() => updateRoadmapItem(item.id, { status: s }))}
                  onPriority={(p) => run(() => updateRoadmapItem(item.id, { priority: p }))}
                  onDelete={() => run(() => deleteRoadmapItem(item.id))}
                />
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function Card({
  item,
  t,
  dateFmt,
  disabled,
  onStatus,
  onPriority,
  onDelete,
}: {
  item: RoadmapItem;
  t: ReturnType<typeof makeT>;
  dateFmt: Intl.DateTimeFormat;
  disabled: boolean;
  onStatus: (s: RoadmapStatus) => void;
  onPriority: (p: RoadmapPriority) => void;
  onDelete: () => void;
}) {
  // Two-step delete instead of window.confirm(): the first click arms it, the
  // second deletes. No blocking dialog, and a stray click costs nothing.
  const [armed, setArmed] = useState(false);
  const shipped = item.status === "shipped" && item.shipped_at;

  return (
    <li className={`roadmap-card roadmap-card--p${item.priority}`}>
      <div className="roadmap-card__top">
        <span className="roadmap-pill">{t(APP_LABEL[item.app])}</span>
        <span className={`roadmap-prio roadmap-prio--${item.priority}`}>
          {t(PRIORITY_LABEL[item.priority])}
        </span>
      </div>
      <p className="roadmap-card__title">{item.title}</p>
      {item.details ? <p className="roadmap-card__details">{item.details}</p> : null}
      <p className="roadmap-card__meta">
        {shipped
          ? t("rmShippedOn", { date: dateFmt.format(new Date(item.shipped_at!)) })
          : t("rmAddedOn", { date: dateFmt.format(new Date(item.created_at)) })}
      </p>
      <div className="roadmap-card__controls">
        <select
          className="roadmap-select roadmap-select--sm"
          value={item.status}
          disabled={disabled}
          aria-label={t("rmFieldStatus")}
          onChange={(e) => onStatus(e.target.value as RoadmapStatus)}
        >
          {ALL_STATUSES.map((s) => (
            <option key={s} value={s}>
              {t(STATUS_LABEL[s])}
            </option>
          ))}
        </select>
        <select
          className="roadmap-select roadmap-select--sm"
          value={item.priority}
          disabled={disabled}
          aria-label={t("rmFieldPriority")}
          onChange={(e) => onPriority(Number(e.target.value) as RoadmapPriority)}
        >
          {([1, 2, 3] as RoadmapPriority[]).map((p) => (
            <option key={p} value={p}>
              {t(PRIORITY_LABEL[p])}
            </option>
          ))}
        </select>
        <button
          type="button"
          className={`roadmap-link roadmap-link--danger${armed ? " is-armed" : ""}`}
          disabled={disabled}
          onClick={() => (armed ? onDelete() : setArmed(true))}
          onBlur={() => setArmed(false)}
        >
          {armed ? t("rmDeleteConfirm") : t("rmDelete")}
        </button>
      </div>
    </li>
  );
}
