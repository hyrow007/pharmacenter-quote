"use client";

// The bottle label dieline builder. Local state only, like the sachet one:
// pick a die-cut size and (rarely) an unwind position; the label redraws to
// scale and Generate downloads the 1:1 PDF.

import { useEffect, useMemo, useState } from "react";
import type { Lang } from "@/lib/i18n/dict";
import { makeDT, type DKey } from "../_lib/i18n";
import {
  BOTTLES,
  DEFAULT_BOTTLE_CC,
  DEFAULT_LABEL,
  DIES,
  bottleOf,
  fit,
  onBottleSvg,
  LABEL_UNWIND_STD,
  dieOf,
  inText,
  labelDims,
  labelSvg,
  mmText,
  sizeIn,
  sizeMm,
  type LabelSpec,
  type LabelUnwind,
} from "../_lib/bottle";
import { downloadLabel, labelFileName } from "../_lib/bottlePdf";
import { labelGuidelines } from "../_lib/guidelines";
import s from "../dielines.module.css";

const UNWIND_HINT: Record<LabelUnwind, DKey> = { 1: "unwindHint1", 2: "unwindHint2", 3: "unwindHint3", 4: "unwindHint4" };

export default function BottleBuilder({ lang }: { lang: Lang }) {
  const t = useMemo(() => makeDT(lang), [lang]);
  const [spec, setSpec] = useState<LabelSpec>(DEFAULT_LABEL);
  const [customUnwind, setCustomUnwind] = useState(false);
  const [bottleCc, setBottleCc] = useState(DEFAULT_BOTTLE_CC);
  // Size buttons in mm or inches; remembered per browser, mm by default.
  const [unit, setUnit] = useState<"mm" | "in">("mm");
  useEffect(() => {
    try {
      if (localStorage.getItem("dl-label-unit") === "in") setUnit("in");
    } catch {
      // storage blocked -- stay in mm
    }
  }, []);
  const pickUnit = (u: "mm" | "in") => {
    setUnit(u);
    try {
      localStorage.setItem("dl-label-unit", u);
    } catch {
      // not remembered, still switched
    }
  };
  const inNum = (mm: number) => (mm / 25.4).toFixed(2);
  const [busy, setBusy] = useState(false);
  const [fileError, setFileError] = useState(false);
  const set = (patch: Partial<LabelSpec>) => setSpec((p) => ({ ...p, ...patch }));

  const d = dieOf(spec);
  const { safeH, safeL } = labelDims(d);
  const drawing = labelSvg(spec, { safe: t("bSafe"), offRoll: t("offRoll") }, t("bFlat"));
  const positionLabel = t("position", { n: spec.unwind });
  const bottle = bottleOf(bottleCc);
  const onBottle = onBottleSvg(spec, bottle, { front: t("bFront"), back: t("bBack"), above: t("bAbove"), gap: t("bGap"), overlap: t("bOverlapShort") }, t("bOnBottle"));
  const f = fit(d, bottle);
  const r0 = (n: number) => String(Math.round(n));
  // inches first, mm in brackets, like every other measurement on the page
  const both = (mm: number) => `${inText(mm)} (${Math.round(mm)} mm)`;

  const generate = async () => {
    setBusy(true);
    setFileError(false);
    try {
      await downloadLabel(spec, lang);
    } catch {
      setFileError(true);
    } finally {
      setBusy(false);
    }
  };

  const specRows: [string, string][] = [
    [t("bsSize"), `${sizeIn(d)}  (${sizeMm(d)})`],
    [t("bsDie"), `#${d.die}`],
    [t("bsVendor"), d.vendor],
    [t("bsCorners"), t("bsCornersV", { r: mmText(d.r) })],
    [t("sBleed"), "1 mm"],
    [t("bsSafe"), t("bsSafeV", { s: `${inText(safeH)} × ${inText(safeL)}` })],
    [t("sUnwind"), spec.unwind === LABEL_UNWIND_STD ? `${positionLabel} (${t("bUnwindStd")})` : positionLabel],
  ];

  const legend = [
    { cls: s.swCut, label: t("lgCut") },
    { cls: s.swClear, label: t("lgSafe") },
    { cls: s.swBleed, label: t("lgBleed") },
  ];

  return (
    <div className={s.layout}>
      <section className={s.controls} aria-label={t("bTitle")}>
        <div className={s.field}>
          <div className={s.fieldHead}>
            <span className={s.label}>{t("bSize")}</span>
            <div className={s.unitToggle} role="group" aria-label={t("bUnits")}>
              {(["mm", "in"] as const).map((u) => (
                <button key={u} type="button" aria-pressed={unit === u} onClick={() => pickUnit(u)}>{u}</button>
              ))}
            </div>
          </div>
          <div className={s.sizeGrid} role="group" aria-label={t("bSize")}>
            {DIES.map((x) => (
              <button
                key={x.die} type="button" aria-pressed={x.die === spec.die}
                onClick={() => set({ die: x.die })}
                title={`${x.vendor} #${x.die}${x.note ? ` · ${x.note}` : ""}`}
              >
                {unit === "mm" ? `${mmText(x.h)} × ${mmText(x.l)}` : `${inNum(x.h)} × ${inNum(x.l)}`}
                <small>#{x.die}</small>
              </button>
            ))}
          </div>
          <p className={s.hint}>{t(unit === "mm" ? "bSizeHint" : "bSizeHintIn")}</p>
        </div>

        <div className={s.field}>
          <span className={s.label}>{t("unwind")}</span>
          {customUnwind ? (
            <>
              <div className={s.seg} role="group" aria-label={t("unwind")}>
                {([1, 2, 3, 4] as LabelUnwind[]).map((n) => (
                  <button key={n} type="button" aria-pressed={n === spec.unwind} onClick={() => set({ unwind: n })}>
                    {n}
                  </button>
                ))}
              </div>
              <p className={s.hint}>{t(UNWIND_HINT[spec.unwind])}</p>
              <button
                type="button" className={s.chip}
                onClick={() => {
                  setCustomUnwind(false);
                  set({ unwind: LABEL_UNWIND_STD });
                }}
              >
                {t("bUnwindReset")}
              </button>
            </>
          ) : (
            <>
              <p className={s.fixedValue}>
                {positionLabel} <span className={s.hint}>{t("bUnwindStd")}</span>
              </p>
              <p className={s.hint}>{t(UNWIND_HINT[spec.unwind])}</p>
              <button type="button" className={s.chip} onClick={() => setCustomUnwind(true)}>
                {t("lengthCustomize")}
              </button>
            </>
          )}
        </div>
      </section>

      <section className={s.view}>
        <div className={s.viewHead}>
          <h2 className={s.viewTitle}>{t("bFlat")}</h2>
          <span className={s.viewMeta}>{sizeIn(d)} · {sizeMm(d)}</span>
        </div>
        <div className={s.drawing} dangerouslySetInnerHTML={{ __html: drawing }} />
        <div className={s.flatFoot}>
          <ul className={s.legend}>
            {legend.map((l) => (
              <li key={l.label}><span className={`${s.sw} ${l.cls}`} />{l.label}</li>
            ))}
          </ul>
          {/* Same roll chart as the sachet builder: the converter's label
              unwind positions, so the numbers mean the same thing. */}
          <figure className={s.roll} aria-live="polite">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={`/dielines/unwind-${spec.unwind}.png`} alt={positionLabel} width={112} height={82} />
            <figcaption>
              <b>{positionLabel}</b>
              {t(UNWIND_HINT[spec.unwind])}
            </figcaption>
          </figure>
        </div>
      </section>

      {/* Row 2: which bottle, beside how the label looks on it. */}
      <section className={`${s.controls} ${s.output}`} aria-label={t("bBottle")}>
        <div className={s.field}>
          <span className={s.label}>{t("bBottle")}</span>
          <div className={s.sizeGrid} role="group" aria-label={t("bBottle")}>
            {BOTTLES.map((b) => (
              <button
                key={b.cc} type="button" aria-pressed={b.cc === bottleCc}
                onClick={() => setBottleCc(b.cc)}
              >
                {b.cc} cc
                <small>{b.finish}-400</small>
              </button>
            ))}
          </div>
          <p className={s.hint}>{t("bBottleHint")}</p>
        </div>
      </section>

      <section className={s.view}>
        <div className={s.viewHead}>
          <h2 className={s.viewTitle}>{t("bOnBottle")}</h2>
          <span className={s.viewMeta}>{bottle.cc} cc · {bottle.finish}-400</span>
        </div>
        <div className={`${s.drawing} ${s.bottleDrawing}`} dangerouslySetInnerHTML={{ __html: onBottle }} />
        <ul className={s.fitList}>
          <li className={f.overlap > 0 ? s.fitWarn : undefined}>
            {f.overlap > 0
              ? t("bOverlap", { o: both(f.overlap) })
              : t("bWrap", { pct: r0(f.coverage * 100), l: both(d.l), c: both(f.circ) })}
          </li>
          <li className={f.tooTall ? s.fitWarn : undefined}>
            {f.tooTall ? t("bTooTall", { p: both(f.panelH) }) : t("bFitsTall", { p: both(f.panelH) })}
          </li>
        </ul>
        <p className={s.hint}>{t("bPreviewNote")}</p>
      </section>

      <section className={`${s.controls} ${s.output}`} aria-label={t("generate")}>
        <div className={s.generate}>
          <button type="button" className={s.generateBtn} onClick={generate} disabled={busy}>
            {busy ? t("generating") : t("generate")}
          </button>
          <p className={s.hint}>{t("bGenerateHint")}</p>
          <p className={s.fileName}>{labelFileName(spec)}</p>
          {fileError ? <p className={s.error} role="alert">{t("generateError")}</p> : null}
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

      <section className={s.view} aria-labelledby="bl-guidelines">
        <div className={s.viewHead}>
          <h2 className={s.viewTitle} id="bl-guidelines">{t("guidelines")}</h2>
        </div>
        <ul className={s.guides}>
          {labelGuidelines(d.r, lang).map((g) => (
            <li key={g.title}>
              <b>{g.title}</b>
              <span>{g.text}</span>
            </li>
          ))}
        </ul>
      </section>

      <p className={`${s.foot} ${s.fullRow}`}>{t("bFoot")}</p>
    </div>
  );
}
