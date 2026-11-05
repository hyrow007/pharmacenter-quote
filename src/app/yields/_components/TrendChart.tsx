import type { Lang } from "@/lib/i18n/dict";
import { makeYT } from "../_lib/i18n";
import { fmtDate, fmtMoney, type Rollup } from "../_lib/model";
import s from "../yields.module.css";

// Revenue and gross over the snapshot period, one point per run day (per week
// once the period has more than MAX_DAILY run days). Plain SVG, no library;
// hovering a point shows its numbers via <title>.

const MAX_DAILY = 62;
const W = 900;
const H = 240;
const PAD = { top: 12, right: 16, bottom: 28, left: 64 };

type Point = { key: string; label: string; revenue: number; gross: number };

function mondayOf(iso: string): string {
  const d = new Date(iso + "T12:00:00Z");
  const back = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - back);
  return d.toISOString().slice(0, 10);
}

function niceMax(v: number): number {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}

function compactMoney(n: number, lang: Lang): string {
  return n.toLocaleString(lang === "es" ? "es-US" : "en-US", {
    style: "currency",
    currency: "USD",
    notation: "compact",
    maximumFractionDigits: 1,
  });
}

export default function TrendChart({ byDay, lang }: { byDay: Map<string, Rollup>; lang: Lang }) {
  const t = makeYT(lang);
  const days = [...byDay.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  if (days.length < 2) return <p className={s.hint}>{t("trendOneDay")}</p>;

  const weekly = days.length > MAX_DAILY;
  let points: Point[];
  if (!weekly) {
    points = days.map(([d, r]) => ({ key: d, label: fmtDate(d, lang, false), revenue: r.revenue, gross: r.gross }));
  } else {
    const wk = new Map<string, Point>();
    for (const [d, r] of days) {
      const k = mondayOf(d);
      const p = wk.get(k) ?? { key: k, label: t("trendWeekOf", { d: fmtDate(k, lang, false) }), revenue: 0, gross: 0 };
      p.revenue += r.revenue;
      p.gross += r.gross;
      wk.set(k, p);
    }
    points = [...wk.values()];
  }

  const yMax = niceMax(Math.max(...points.map((p) => Math.max(p.revenue, p.gross))));
  const yMin = Math.min(0, ...points.map((p) => p.gross)); // gross can be negative
  const innerW = W - PAD.left - PAD.right;
  const innerH = H - PAD.top - PAD.bottom;
  const x = (i: number) => PAD.left + (points.length === 1 ? innerW / 2 : (i / (points.length - 1)) * innerW);
  const y = (v: number) => PAD.top + innerH - ((v - yMin) / (yMax - yMin)) * innerH;
  const path = (f: (p: Point) => number) => points.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(f(p)).toFixed(1)}`).join(" ");
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => yMin + f * (yMax - yMin));
  const labelEvery = Math.max(1, Math.ceil(points.length / 8));
  const dotR = points.length > 40 ? 2 : 3.5;

  const series = [
    { name: t("kRevenue"), color: "var(--teal-700)", f: (p: Point) => p.revenue },
    { name: t("colGross"), color: "var(--sage-700)", f: (p: Point) => p.gross },
  ];

  return (
    <div className={s.trend}>
      <div className={s.trendHead}>
        <h3 className={s.subHeading} style={{ margin: 0 }}>
          {t("trendHeading")}
          {weekly ? <span className={s.hint}> · {t("trendWeekly")}</span> : null}
        </h3>
        <div className={s.trendLegend}>
          {series.map((se) => (
            <span key={se.name}>
              <i style={{ background: se.color }} />
              {se.name}
            </span>
          ))}
        </div>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className={s.trendSvg} role="img" aria-label={t("trendHeading")}>
        {ticks.map((v) => (
          <g key={v}>
            <line x1={PAD.left} x2={W - PAD.right} y1={y(v)} y2={y(v)} stroke="var(--stone)" strokeWidth={1} />
            <text x={PAD.left - 8} y={y(v) + 4} textAnchor="end" className={s.trendAxis}>
              {compactMoney(v, lang)}
            </text>
          </g>
        ))}
        {points.map((p, i) =>
          i % labelEvery === 0 || i === points.length - 1 ? (
            <text key={p.key} x={x(i)} y={H - 8} textAnchor={i === 0 ? "start" : i === points.length - 1 ? "end" : "middle"} className={s.trendAxis}>
              {fmtDate(p.key, lang, false).replace(/,? \d{4}$/, "")}
            </text>
          ) : null,
        )}
        {series.map((se) => (
          <path key={se.name} d={path(se.f)} fill="none" stroke={se.color} strokeWidth={2.25} strokeLinejoin="round" strokeLinecap="round" />
        ))}
        {series.map((se) =>
          points.map((p, i) => (
            <circle key={se.name + p.key} cx={x(i)} cy={y(se.f(p))} r={dotR} fill="var(--paper)" stroke={se.color} strokeWidth={2}>
              <title>{`${p.label}\n${t("kRevenue")}: ${fmtMoney(p.revenue, lang)}\n${t("colGross")}: ${fmtMoney(p.gross, lang)}`}</title>
            </circle>
          )),
        )}
      </svg>
    </div>
  );
}
