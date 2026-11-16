import s from "../kpi.module.css";

// Plain SVG line chart, no library (same approach as Yields' TrendChart).
// A null value breaks the line. `dashed` series draw dashed (estimates).
// Hovering a point shows its numbers via <title>.

export type ChartSeries = {
  name: string;
  color: string;
  values: (number | null)[];
  dashed?: boolean;
  dots?: boolean;
};

const W = 900;
const H = 260;
const PAD = { top: 12, right: 16, bottom: 30, left: 70 };

function niceMax(v: number): number {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}

export const PALETTE = [
  "#1d6c7b", "#7fb04f", "#b4532a", "#6a4c93", "#d4a017",
  "#3a8d9c", "#c2577a", "#5f8e3a", "#8a9498", "#2f4858",
];

export default function LineChart({
  labels,
  tickLabels,
  series,
  format,
  ariaLabel,
  highlight,
}: {
  labels: string[];               // one per x position, used in tooltips
  tickLabels?: (string | null)[]; // what to print under the axis (null = nothing)
  series: ChartSeries[];
  format: (n: number) => string;  // axis + tooltip numbers
  ariaLabel: string;
  highlight?: number;             // x index to mark with a vertical line
}) {
  const n = labels.length;
  const all = series.flatMap((se) => se.values.filter((v): v is number => v !== null));
  if (n === 0 || all.length === 0) return null;
  const yMax = niceMax(Math.max(...all));
  const yMin = Math.min(0, ...all);
  const innerW = W - PAD.left - PAD.right;
  const innerH = H - PAD.top - PAD.bottom;
  const x = (i: number) => PAD.left + (n === 1 ? innerW / 2 : (i / (n - 1)) * innerW);
  const y = (v: number) => PAD.top + innerH - ((v - yMin) / (yMax - yMin || 1)) * innerH;
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => yMin + f * (yMax - yMin));
  const every = Math.max(1, Math.ceil(n / 8));
  const ticksX = tickLabels ?? labels.map((l, i) => (i % every === 0 || i === n - 1 ? l : null));

  const path = (vals: (number | null)[]) => {
    let d = "";
    let pen = false;
    vals.forEach((v, i) => {
      if (v === null) { pen = false; return; }
      d += `${pen ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)} `;
      pen = true;
    });
    return d.trim();
  };

  return (
    <div className={s.chart}>
      {series.length > 1 ? (
        <div className={s.legend}>
          {series.map((se) => (
            <span key={se.name}>
              <i style={{ background: se.color, opacity: se.dashed ? 0.6 : 1 }} />
              {se.name}
            </span>
          ))}
        </div>
      ) : null}
      <svg viewBox={`0 0 ${W} ${H}`} className={s.chartSvg} role="img" aria-label={ariaLabel}>
        {ticks.map((v) => (
          <g key={v}>
            <line x1={PAD.left} x2={W - PAD.right} y1={y(v)} y2={y(v)} stroke="var(--stone)" strokeWidth={1} />
            <text x={PAD.left - 8} y={y(v) + 4} textAnchor="end" className={s.axis}>{format(v)}</text>
          </g>
        ))}
        {ticksX.map((l, i) =>
          l ? (
            <text key={i} x={x(i)} y={H - 8} textAnchor={i === 0 ? "start" : i === n - 1 ? "end" : "middle"} className={s.axis}>{l}</text>
          ) : null,
        )}
        {highlight !== undefined && highlight >= 0 && highlight < n ? (
          <line x1={x(highlight)} x2={x(highlight)} y1={PAD.top} y2={PAD.top + innerH} stroke="var(--ink-3)" strokeWidth={1} strokeDasharray="3 3" />
        ) : null}
        {series.map((se) => (
          <path key={se.name} d={path(se.values)} fill="none" stroke={se.color} strokeWidth={2.25}
            strokeDasharray={se.dashed ? "6 4" : undefined} strokeLinejoin="round" strokeLinecap="round" />
        ))}
        {series.map((se) =>
          se.values.map((v, i) =>
            v === null || (se.dots === false) ? null : (
              <circle key={se.name + i} cx={x(i)} cy={y(v)} r={n > 40 ? 1.8 : 3.5} fill="var(--paper)" stroke={se.color} strokeWidth={2}>
                <title>{`${labels[i]}\n${se.name}: ${format(v)}`}</title>
              </circle>
            ),
          ),
        )}
      </svg>
    </div>
  );
}
