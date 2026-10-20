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

// ---- the bottle the label goes on -------------------------------------------
//
// Round HDPE "packer" bottles, 50-750 cc, the standard pill/vitamin bottle.
// Overall height (to the top of the neck, cap off) and body diameter are the
// stock dimensions from Alpha Packaging's HDPE catalog (Pharma Line where it
// has the size); a supplier's own bottle may differ by a millimeter or two.
// Catalogs don't publish label panel height, so the panel here is an estimate:
// the straight wall between the heel and the start of the shoulder.

export type Bottle = { cc: number; finish: number; hIn: number; dIn: number; part: string };

export const BOTTLES: Bottle[] = [
  { cc: 50, finish: 33, hIn: 2.694, dIn: 1.52, part: "50PH33" },
  { cc: 60, finish: 33, hIn: 3.046, dIn: 1.515, part: "60QL33" },
  { cc: 75, finish: 33, hIn: 2.978, dIn: 1.705, part: "75PH33" },
  { cc: 100, finish: 38, hIn: 3.225, dIn: 1.837, part: "100PH38" },
  { cc: 120, finish: 38, hIn: 3.4, dIn: 2.015, part: "120PH38" },
  { cc: 150, finish: 38, hIn: 3.725, dIn: 2.093, part: "150PH38" },
  { cc: 175, finish: 38, hIn: 3.85, dIn: 2.192, part: "175PH38" },
  { cc: 200, finish: 38, hIn: 4.281, dIn: 2.313, part: "200S38" },
  { cc: 225, finish: 45, hIn: 4.239, dIn: 2.38, part: "225PH45" },
  { cc: 250, finish: 45, hIn: 4.688, dIn: 2.516, part: "250S45" },
  { cc: 275, finish: 45, hIn: 4.477, dIn: 2.507, part: "275PH45" },
  { cc: 300, finish: 45, hIn: 4.94, dIn: 2.584, part: "300PH45" },
  { cc: 400, finish: 45, hIn: 5.22, dIn: 2.895, part: "400PH45" },
  { cc: 500, finish: 53, hIn: 5.56, dIn: 3.1, part: "500PH53" },
  { cc: 625, finish: 53, hIn: 6.169, dIn: 3.197, part: "625PH53" },
  { cc: 750, finish: 53, hIn: 6.54, dIn: 3.474, part: "750PH53" },
];
export const DEFAULT_BOTTLE_CC = 300;
export const bottleOf = (cc: number) => BOTTLES.find((b) => b.cc === cc) ?? BOTTLES[0];

/** Body proportions, in mm, drawn and measured the same way. */
export function bottleDims(b: Bottle) {
  const h = b.hIn * MM_PER_IN;
  const d = b.dIn * MM_PER_IN;
  const neckH = b.finish * 0.3; // a 38-400 neck is about 11-12 mm tall
  const neckW = b.finish;
  const shoulder = d * 0.22; // shoulder rise from wall to neck
  const heel = 3; // rounded base
  const wallTop = h - neckH - shoulder; // height where the straight wall ends
  const panelBottom = heel + 1.5;
  const panelTop = wallTop - 1.5;
  return {
    h, d, r: d / 2, neckH, neckW, shoulder, heel, wallTop,
    panelBottom, panelTop, panelH: panelTop - panelBottom,
    circ: Math.PI * d,
    capH: b.finish * 0.42, capW: b.finish + 3,
  };
}

/** How a label of this die sits on this bottle. */
export function fit(d: Die, b: Bottle) {
  const bd = bottleDims(b);
  const coverage = d.l / bd.circ;
  return {
    circ: bd.circ,
    coverage, // 1 = all the way round
    overlap: Math.max(d.l - bd.circ, 0),
    panelH: bd.panelH,
    tooTall: d.h > bd.panelH,
  };
}

export type OnBottleLabels = { front: string; back: string; above: string; gap: string; overlap: string };

/** Front and back views of the bottle with the label on it, plus a top view. */
export function onBottleSvg(spec: LabelSpec, b: Bottle, L: OnBottleLabels, ariaLabel: string): string {
  const d = dieOf(spec);
  const bd = bottleDims(b);
  const { h, r, neckW, shoulder, heel, wallTop, capH, capW } = bd;
  // Every bottle is drawn in the same frame, sized for the largest, so
  // switching bottles shows their real difference in size.
  const big = bottleDims(BOTTLES[BOTTLES.length - 1]);
  const Y = (z: number) => -z; // base at y = 0, bottle rises into negative y
  const lz = (bd.panelBottom + bd.panelTop) / 2; // label centered on the panel
  const top = Y(lz + d.h / 2), lh = d.h;
  const lr = Math.min(d.r, 2);
  const half = d.l / 2 / r; // half the wrap angle, radians, centered on the front
  const circ = 2 * Math.PI * r;

  let g = `<defs><linearGradient id="bt-shade" x1="0" x2="1" y1="0" y2="0">` +
    `<stop offset="0" stop-color="#000" stop-opacity="0.12"/><stop offset="0.35" stop-color="#000" stop-opacity="0"/>` +
    `<stop offset="0.7" stop-color="#000" stop-opacity="0.03"/><stop offset="1" stop-color="#000" stop-opacity="0.16"/></linearGradient></defs>`;

  const bottleAt = (cx: number) => {
    const nx = neckW / 2;
    const body =
      `M${cx - r + heel} ${Y(0)}H${cx + r - heel}Q${cx + r} ${Y(0)} ${cx + r} ${Y(heel)}V${Y(wallTop)}` +
      `Q${cx + r} ${Y(wallTop + shoulder)} ${cx + nx} ${Y(wallTop + shoulder)}V${Y(h)}H${cx - nx}V${Y(wallTop + shoulder)}` +
      `Q${cx - r} ${Y(wallTop + shoulder)} ${cx - r} ${Y(wallTop)}V${Y(heel)}Q${cx - r} ${Y(0)} ${cx - r + heel} ${Y(0)}Z`;
    let s = `<path class="s-bottle" d="${body}"/><path d="${body}" fill="url(#bt-shade)"/>`;
    const cy = Y(h - 1);
    s += `<rect class="s-cap" x="${cx - capW / 2}" y="${cy - capH}" width="${capW}" height="${capH}" rx="1.5"/>`;
    for (let x = -capW / 2 + 2.5; x < capW / 2 - 1.5; x += 2.2) {
      s += `<path class="s-capline" d="M${cx + x} ${cy - capH + 1.5}V${cy - 1.5}"/>`;
    }
    return s;
  };
  const labelRect = (x1: number, x2: number) =>
    x2 - x1 < 0.05 ? "" :
    `<rect class="s-blabel" x="${x1}" y="${top}" width="${x2 - x1}" height="${lh}" rx="${lr}"/>` +
    `<rect x="${x1}" y="${top}" width="${x2 - x1}" height="${lh}" fill="url(#bt-shade)" opacity="0.6"/>`;
  const caption = (cx: number, text: string) =>
    `<text class="t-sub" x="${cx}" y="${Y(h) - capH - 4}" text-anchor="middle">${esc(text)}</text>`;

  // ---- front: the middle of the label faces us
  const fx = 0;
  g += bottleAt(fx);
  const vis = half >= Math.PI / 2 ? r : r * Math.sin(half);
  g += labelRect(fx - vis, fx + vis);
  const fs = Math.min(7, lh * 0.22, vis * 0.38);
  g += `<text class="t-copy" x="${fx}" y="${top + lh / 2}" text-anchor="middle" dominant-baseline="central" style="font-size:${fs}px">COPY</text>`;
  g += caption(fx, L.front);

  // ---- back: where the two ends of the label meet, or don't
  const bx = 2 * big.r + 18;
  g += bottleAt(bx);
  const gapLen = circ - d.l; // > 0: bare film at the back; < 0: the ends overlap
  if (gapLen >= circ / 2) {
    // the label never reaches round to the back
  } else if (gapLen > 0) {
    const gHalf = gapLen / 2 / r; // half the gap angle, centered on the back
    const gw = r * Math.sin(gHalf);
    g += labelRect(bx - r, bx - gw) + labelRect(bx + gw, bx + r);
    // dimension across the gap
    const yy = top + lh + 4;
    g += `<path class="s-dim" d="M${bx - gw} ${top - 1}V${yy + 1.4}M${bx + gw} ${top - 1}V${yy + 1.4}M${bx - gw} ${yy}H${bx + gw}"/>`;
  } else {
    g += labelRect(bx - r, bx + r);
    g += `<path class="s-seam" d="M${bx} ${top}V${top + lh}"/>`;
  }
  // under the back bottle, on the same line as the diameter under the front
  const gapText = gapLen >= 0 ? `${L.gap} ${Math.round(gapLen)} mm` : `${L.overlap} ${Math.round(-gapLen)} mm`;
  g += `<text class="t" x="${bx}" y="12" text-anchor="middle">${esc(gapText)}</text>`;
  g += caption(bx, L.back);

  // ---- dimensions on the front bottle: height on the left, diameter below
  const lx = fx - r - 7;
  g += `<path class="s-dim" d="M${lx} ${Y(0)}V${Y(h)}M${lx - 1.4} ${Y(0)}H${lx + 1.4}M${lx - 1.4} ${Y(h)}H${lx + 1.4}"/>`;
  g += `<text class="t" x="${lx - 1.6}" y="${Y(h / 2)}" text-anchor="middle" transform="rotate(-90 ${lx - 1.6} ${Y(h / 2)})">${inText(h)} (${mmText(Math.round(h))} mm)</text>`;
  g += `<path class="s-dim" d="M${fx - r} 6H${fx + r}M${fx - r} 4.6V7.4M${fx + r} 4.6V7.4"/>`;
  g += `<text class="t" x="${fx}" y="12" text-anchor="middle">Ø ${inText(2 * r)} (${mmText(Math.round(2 * r))} mm)</text>`;

  // ---- top view: the bottle as a circle, the label as an arc round the front
  const tvR = Math.min(r, 26);
  const tcx = bx + big.r + 20 + 26, tcy = Y(h / 2);
  g += `<circle class="s-bottle" cx="${tcx}" cy="${tcy}" r="${tvR}"/>`;
  g += `<circle class="s-cap" cx="${tcx}" cy="${tcy}" r="${tvR * (capW / (2 * r))}"/>`;
  const wrap = Math.min(d.l / circ, 1);
  const R = tvR + 1.6;
  if (wrap >= 1) {
    g += `<circle class="s-arc" cx="${tcx}" cy="${tcy}" r="${R}"/>`;
  } else {
    const a = wrap * Math.PI; // half-angle, centered on the front (bottom of the circle)
    const x1 = tcx - R * Math.sin(a), y1 = tcy + R * Math.cos(a);
    const x2 = tcx + R * Math.sin(a), y2 = tcy + R * Math.cos(a);
    g += `<path class="s-arc" d="M${x1} ${y1}A${R} ${R} 0 ${wrap > 0.5 ? 1 : 0} 0 ${x2} ${y2}"/>`;
  }
  g += `<text class="t-sub" x="${tcx}" y="${tcy - tvR - 5}" text-anchor="middle">${esc(L.above)}</text>`;
  g += `<text class="t" x="${tcx}" y="${tcy + tvR + 8}" text-anchor="middle">${Math.round(wrap * 100)}%</text>`;

  const x0 = -big.r - 18, x1v = tcx + 26 + 6;
  const y0 = -big.h - big.capH - 10, y1v = 16;
  return `<svg viewBox="${x0} ${y0} ${x1v - x0} ${y1v - y0}" role="img" aria-label="${esc(ariaLabel)}">${g}</svg>`;
}
