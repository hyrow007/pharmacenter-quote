"use client";

// The sachet dieline builder. Everything here is local state -- nothing is
// saved yet. The drawings come from ../_lib/sachet.ts as SVG strings (our own
// numbers and our own escaped labels, never user text), so the same functions
// can produce the downloadable file later.

import { useMemo, useState } from "react";
import type { Lang } from "@/lib/i18n/dict";
import { makeDT, type DKey } from "../_lib/i18n";
import {
  DEFAULT_SPEC,
  LEN_MAX_IN,
  LEN_MIN_IN,
  OFF_MAX_MM,
  OFF_MIN_MM,
  STANDARDS,
  TOOLING_IN,
  dims,
  finishedSvg,
  flatSvg,
  inches,
  type Notch,
  type SachetSpec,
  type Unwind,
} from "../_lib/sachet";
import s from "../dielines.module.css";

const NOTCH_LABEL: Record<Notch, DKey> = { none: "notchNone", slit: "notchSlit", triangle: "notchTriangle" };
const NOTCH_HINT: Record<Notch, DKey> = { none: "notchHintNone", slit: "notchHintSlit", triangle: "notchHintTriangle" };
const UNWIND_HINT: Record<Unwind, DKey> = { 1: "unwindHint1", 2: "unwindHint2", 3: "unwindHint3", 4: "unwindHint4" };

const half = (toolingIn: number) => (toolingIn / 2).toFixed(2);

// A number box that lets you type freely and only commits values in range;
// on blur it snaps back to the committed value.
function NumberField({
  id, value, min, max, step, unit, fixed, label, onCommit,
}: {
  id: string; value: number; min: number; max: number; step: number; unit: string;
  fixed: number; label: string; onCommit: (v: number) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const clamp = (n: number) => Math.min(max, Math.max(min, n));
  return (
    <div className={s.num}>
      <input
        type="range" min={min} max={max} step={step} value={value} aria-label={label}
        onChange={(e) => onCommit(clamp(parseFloat(e.target.value)))}
      />
      <input
        id={id} type="number" min={min} max={max} step={step}
        value={draft ?? value.toFixed(fixed)}
        onChange={(e) => {
          setDraft(e.target.value);
          const n = parseFloat(e.target.value);
          if (!Number.isNaN(n) && n >= min && n <= max) onCommit(Math.round(n * 100) / 100);
        }}
        onBlur={() => setDraft(null)}
      />
      <span className={s.unit}>{unit}</span>
    </div>
  );
}

function Segmented<T extends string | number>({
  label, options, value, onPick,
}: {
  label: string;
  options: { v: T; main: string; small?: string }[];
  value: T;
  onPick: (v: T) => void;
}) {
  return (
    <div className={s.seg} role="group" aria-label={label}>
      {options.map((o) => (
        <button
          key={String(o.v)} type="button" aria-pressed={o.v === value}
          onClick={() => onPick(o.v)}
        >
          {o.main}
          {o.small ? <small>{o.small}</small> : null}
        </button>
      ))}
    </div>
  );
}

export default function SachetBuilder({ lang }: { lang: Lang }) {
  const t = useMemo(() => makeDT(lang), [lang]);
  const [spec, setSpec] = useState<SachetSpec>(DEFAULT_SPEC);
  const set = (patch: Partial<SachetSpec>) => setSpec((p) => ({ ...p, ...patch }));

  const d = dims(spec);
  const labels = { back: t("back"), front: t("front"), fold: t("fold"), clear: t("clear"), offRoll: t("offRoll") };
  const flat = flatSvg(spec, labels, t("flat"));
  const finished = finishedSvg(spec, labels, t("finished"));
  const positionLabel = t("position", { n: spec.unwind });

  const notchValue =
    spec.notch === "triangle"
      ? t("sNotchTriangle", { o: spec.triangleOffsetMm })
      : spec.notch === "slit"
        ? t("sNotchSlit")
        : t("sNotchNone");

  const specRows: [string, string][] = [
    [t("sFinished"), `${inches(d.panelW)} × ${inches(d.height)}`],
    [t("sFilm"), `${inches(d.filmW)} × ${inches(d.height)}`],
    [t("sClear"), `${inches(d.clearW)} × ${inches(d.clearH)}`],
    [t("sSeals"), t("sSealsV")],
    [t("sBleed"), "1 mm"],
    [t("sEye"), t("sEyeV")],
    [t("sNotch"), notchValue],
    [t("sUnwind"), positionLabel],
  ];

  const legend: { cls: string; label: string }[] = [
    { cls: s.swCut, label: t("lgCut") },
    ...(spec.notch !== "none" ? [{ cls: s.swNotch, label: t("lgNotch") }] : []),
    { cls: s.swFold, label: t("lgFold") },
    { cls: s.swSeal, label: t("lgSeal") },
    { cls: s.swMark, label: t("lgMark") },
    { cls: s.swClear, label: t("lgClear") },
    { cls: s.swBleed, label: t("lgBleed") },
    { cls: s.swLead, label: t("lgLead") },
  ];

  return (
    <div className={s.layout}>
      <section className={s.controls} aria-label={t("title")}>
        <div className={s.field}>
          <span className={s.label}>{t("width")}</span>
          <Segmented<number>
            label={t("width")}
            options={TOOLING_IN.map((w) => ({ v: w, main: `${half(w)}"`, small: `${t("widthTooling")} ${w}"` }))}
            value={spec.toolingIn}
            onPick={(v) => set({ toolingIn: v })}
          />
          <p className={s.hint}>{t("widthHint")}</p>
        </div>

        <div className={s.field}>
          <label className={s.label} htmlFor="dl-length">{t("length")}</label>
          <NumberField
            id="dl-length" value={spec.lengthIn} min={LEN_MIN_IN} max={LEN_MAX_IN} step={0.05}
            unit="in" fixed={2} label={t("length")} onCommit={(v) => set({ lengthIn: v })}
          />
          <p className={s.hint}>{t("lengthHint")}</p>
          <div className={s.presets}>
            <span className={s.hint}>{t("standards")}:</span>
            {STANDARDS.map((p) => (
              <button
                key={p.tooling} type="button" className={s.chip}
                onClick={() => set({ toolingIn: p.tooling, lengthIn: p.length })}
              >
                {half(p.tooling)} × {p.length}
              </button>
            ))}
          </div>
        </div>

        <div className={s.field}>
          <span className={s.label}>{t("notch")}</span>
          <Segmented<Notch>
            label={t("notch")}
            options={(["none", "slit", "triangle"] as Notch[]).map((n) => ({ v: n, main: t(NOTCH_LABEL[n]) }))}
            value={spec.notch}
            onPick={(v) => set({ notch: v })}
          />
          <p className={s.hint}>{t(NOTCH_HINT[spec.notch])}</p>
        </div>

        {spec.notch === "triangle" ? (
          <div className={s.field}>
            <label className={s.label} htmlFor="dl-offset">{t("offset")}</label>
            <NumberField
              id="dl-offset" value={spec.triangleOffsetMm} min={OFF_MIN_MM} max={OFF_MAX_MM} step={0.5}
              unit="mm" fixed={1} label={t("offset")} onCommit={(v) => set({ triangleOffsetMm: v })}
            />
            <p className={s.hint}>{t("offsetHint")}</p>
          </div>
        ) : null}

        <div className={s.field}>
          <span className={s.label}>{t("unwind")}</span>
          <Segmented<Unwind>
            label={t("unwind")}
            options={([1, 2, 3, 4] as Unwind[]).map((n) => ({ v: n, main: String(n) }))}
            value={spec.unwind}
            onPick={(v) => set({ unwind: v })}
          />
          <p className={s.hint}>{t(UNWIND_HINT[spec.unwind])}</p>
          <p className={s.hint}>{t("unwindNote")}</p>
        </div>

        <dl className={s.spec}>
          {specRows.map(([k, v]) => (
            <div key={k} className={s.specRow}>
              <dt>{k}</dt>
              <dd>{v}</dd>
            </div>
          ))}
        </dl>
      </section>

      <div className={s.views}>
        <section className={s.view}>
          <div className={s.viewHead}>
            <h2 className={s.viewTitle}>{t("flat")}</h2>
            <span className={s.viewMeta}>{inches(d.filmW)} × {inches(d.height)}</span>
          </div>
          <div className={s.drawing} dangerouslySetInnerHTML={{ __html: flat }} />
          <ul className={s.legend}>
            {legend.map((l) => (
              <li key={l.label}><span className={`${s.sw} ${l.cls}`} />{l.label}</li>
            ))}
          </ul>
        </section>

        <section className={s.view}>
          <div className={s.viewHead}>
            <h2 className={s.viewTitle}>{t("finished")}</h2>
            <span className={s.viewMeta}>{inches(d.panelW)} × {inches(d.height)}</span>
          </div>
          <div className={s.drawing} dangerouslySetInnerHTML={{ __html: finished }} />
        </section>

        <div className={s.bottom}>
          <p className={s.foot}>{t("foot")}</p>
          <figure className={s.roll} aria-live="polite">
            {/* The roll pictures are the converter's own chart, cropped. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={`/dielines/unwind-${spec.unwind}.png`} alt={positionLabel} width={112} height={73} />
            <figcaption>
              <b>{positionLabel}</b>
              {t(UNWIND_HINT[spec.unwind])}
            </figcaption>
          </figure>
        </div>
      </div>
    </div>
  );
}
