// Bottle label geometry -- the label printer's die cuts, as pure functions.
//
// A PharmaCenter bottle label is a plain wrap-around label: one rounded
// rectangle, the length running around the bottle and the height up it.
// Sizes come from the label printer's die-cut templates (sent by the user,
// 2026-10-19), measured from the files themselves:
//   bleed 1 mm past the cut on every side
//   text safe zone 1.5 mm inside the cut on every side
//   corners rounded, 2 mm on most dies (a few are larger -- see `r`)
// Unwind position: standard is 4 (left side of the copy comes off the roll
// first), with an option to deviate.
//
// Everything is in millimeters unless a name says otherwise. The drawing is
// returned as an SVG string so the same numbers feed the PDF.

export const LABEL_BLEED = 1;
export const LABEL_SAFE = 1.5;

export type Die = {
  /** The printer's die-cut number. */
  die: number;
  /** Height (up the bottle) x length (around it), in mm. */
  h: number;
  l: number;
  /** Corner radius of the cut, mm. */
  r: number;
  note?: string;
};

// Sorted by height, then length. Two dies are drawn from the template's own
// numbers where the file name rounds: #6812 is exactly 2.25 x 6 in (57.15 mm).
export const DIES: Die[] = [
  { die: 3911, h: 38, l: 114, r: 2, note: "Small pump spray" },
  { die: 3942, h: 44, l: 126, r: 2 },
  { die: 4499, h: 44.45, l: 139.7, r: 2 },
  { die: 4002, h: 50, l: 140, r: 2 },
  { die: 6812, h: 57.15, l: 152.4, r: 4.23 },
  { die: 15500, h: 57, l: 175, r: 2 },
  { die: 3100, h: 58, l: 147, r: 3.58 },
  { die: 15720, h: 63, l: 173, r: 2 },
  { die: 4632, h: 65, l: 148, r: 2 },
  { die: 6766, h: 65, l: 170, r: 2 },
  { die: 16260, h: 66.6, l: 152.4, r: 3.17 },
  { die: 3396, h: 66.7, l: 171.5, r: 2 },
  { die: 4545, h: 67, l: 143, r: 2 },
  { die: 3521, h: 67, l: 190, r: 2 },
  { die: 3791, h: 68, l: 175, r: 2 },
  { die: 3447, h: 69.5, l: 178, r: 2.24 },
  { die: 6807, h: 70, l: 156, r: 2 },
  { die: 6400, h: 70, l: 180, r: 2 },
  { die: 6881, h: 70, l: 190, r: 2 },
  { die: 4438, h: 70, l: 195, r: 2 },
  { die: 3090, h: 70, l: 200, r: 2 },
];

export type LabelUnwind = 1 | 2 | 3 | 4;
export const LABEL_UNWIND_STD: LabelUnwind = 4;

export type LabelSpec = { die: number; unwind: LabelUnwind };
export const DEFAULT_LABEL: LabelSpec = { die: 3791, unwind: LABEL_UNWIND_STD };

export const dieOf = (spec: LabelSpec) => DIES.find((d) => d.die === spec.die) ?? DIES[0];

const MM_PER_IN = 25.4;
/** 57.15 -> "57.15", 68 -> "68", 66.6 -> "66.6" */
export const mmText = (mm: number) => String(Math.round(mm * 100) / 100);
export const inText = (mm: number) => ((mm / MM_PER_IN).toFixed(2)) + '"';
export const sizeMm = (d: Die) => `${mmText(d.h)} × ${mmText(d.l)} mm`;
export const sizeIn = (d: Die) => `${inText(d.h)} × ${inText(d.l)}`;

export function labelDims(d: Die) {
  return {
    safeH: d.h - 2 * LABEL_SAFE,
    safeL: d.l - 2 * LABEL_SAFE,
    safeR: Math.max(d.r - LABEL_SAFE, 0.3),
  };
}

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function hdim(x1: number, x2: number, y: number, label: string) {
  return (
    `<path class="s-dim" d="M${x1} ${y}H${x2}M${x1} ${y - 1.4}V${y + 1.4}M${x2} ${y - 1.4}V${y + 1.4}"/>` +
    `<text class="t" x="${(x1 + x2) / 2}" y="${y - 1.3}" text-anchor="middle">${label}</text>`
  );
}
function vdim(y1: number, y2: number, x: number, label: string) {
  const cy = (y1 + y2) / 2;
  return (
    `<path class="s-dim" d="M${x} ${y1}V${y2}M${x - 1.4} ${y1}H${x + 1.4}M${x - 1.4} ${y2}H${x + 1.4}"/>` +
    `<text class="t" x="${x + 1.6}" y="${cy}" text-anchor="middle" transform="rotate(90 ${x + 1.6} ${cy})">${label}</text>`
  );
}
const both = (mm: number) => `${inText(mm)} (${mmText(mm)} mm)`;

/** Which edge leaves the roll first, and where the arrow sits. */
export function leadEdge(u: LabelUnwind, d: Die) {
  // angle rotates a down-pointing arrow: 0 = down, 180 = up, -90 = right, 90 = left
  if (u === 1) return { x: d.l * 0.5, y: 0, angle: 180 };
  if (u === 2) return { x: d.l * 0.5, y: d.h, angle: 0 };
  if (u === 3) return { x: d.l, y: d.h / 2, angle: -90 };
  return { x: 0, y: d.h / 2, angle: 90 };
}
/** The stubby arrow, pointing down from (0,0), 3.5 to 9.6 mm out. */
export const ARROW: [number, number][] = [
  [-1.3, 3.5], [1.3, 3.5], [1.3, 6.3], [3, 6.3], [0, 9.6], [-3, 6.3], [-1.3, 6.3],
];

export type LabelDrawLabels = { safe: string; offRoll: string };

/** The label laid flat, viewed from the printed side, copy upright. */
export function labelSvg(spec: LabelSpec, L: LabelDrawLabels, ariaLabel: string): string {
  const d = dieOf(spec);
  const { safeH, safeL, safeR } = labelDims(d);
  const H = d.h, W = d.l;
  const topArrow = spec.unwind === 1;
  const pl = 28, pr = 28, pt = topArrow ? 24 : 14, pb = 14;
  const dimY = topArrow ? -14 : -6;
  let g = "";
  g += `<rect class="s-bleed" x="${-LABEL_BLEED}" y="${-LABEL_BLEED}" width="${W + 2 * LABEL_BLEED}" height="${H + 2 * LABEL_BLEED}" rx="${d.r + LABEL_BLEED}"/>`;
  g += `<rect class="s-film" x="0" y="0" width="${W}" height="${H}" rx="${d.r}"/>`;
  g += `<rect class="s-clear" x="${LABEL_SAFE}" y="${LABEL_SAFE}" width="${safeL}" height="${safeH}" rx="${safeR}"/>`;
  g += `<rect class="s-outline" x="0" y="0" width="${W}" height="${H}" rx="${d.r}"/>`;
  const cx = W / 2, cy = H / 2;
  g += `<text class="t-copy" x="${cx}" y="${cy}" text-anchor="middle" dominant-baseline="central">COPY</text>`;
  g += `<path class="s-copyline" d="M${cx - 8} ${cy + 4.6}H${cx + 8}"/>`;
  g += `<text class="t-sub" x="${cx}" y="${H - LABEL_SAFE - 2.2}" text-anchor="middle">${esc(L.safe)} ${inText(safeH)} × ${inText(safeL)}</text>`;
  g += hdim(0, W, dimY, both(W));
  g += vdim(0, H, W + (spec.unwind === 3 ? 16 : 6), both(H));
  const e = leadEdge(spec.unwind, d);
  const pts = ARROW.map(([x, y]) => `${x} ${y}`).join(" L");
  g += `<path class="s-lead" transform="translate(${e.x} ${e.y}) rotate(${e.angle})" d="M${pts}Z"/>`;
  // label beside the arrow
  if (spec.unwind === 1 || spec.unwind === 2) {
    const ty = spec.unwind === 1 ? -6.4 : H + 7.6;
    g += `<text class="t-lead" x="${e.x + 4}" y="${ty}">${esc(L.offRoll)}</text>`;
  } else {
    // Under the arrow, running outward so it never sits on the bleed.
    const right = spec.unwind === 3;
    g += `<text class="t-lead" x="${right ? W + 2.5 : -2.5}" y="${H / 2 + 8.5}" text-anchor="${right ? "start" : "end"}">${esc(L.offRoll)}</text>`;
  }
  return `<svg viewBox="${-pl} ${-pt} ${W + pl + pr} ${H + pt + pb}" role="img" aria-label="${esc(ariaLabel)}">${g}</svg>`;
}
