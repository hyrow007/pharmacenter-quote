// Sachet film geometry -- the house rules, in one place, as pure functions.
//
// A PharmaCenter sachet is a 3-side seal: one printed web, folded down the
// center, sealed on the other three edges. Everything below is in millimeters
// unless a name says otherwise. The drawings are returned as SVG strings so
// the same code can later be the downloadable dieline, not just the preview.
//
// Rules (from the user, 2026-10-16):
//   tooling (flat film width) 5.5 / 6 / 6.5 in; finished width is half
//   length = finished height, 2.5 to 4.5 in
//   seal 6 mm on top, bottom and both outer edges; the fold has none
//   bleed 1 mm
//   eye mark 6 x 6 mm, top-left, on a 6 mm high-contrast lane down the left edge
//   left panel = back, right panel = front
//   notch: none, or a slit (4 mm long, right edge, 4.5 mm below the top seal),
//     or a triangle (1.5 mm wide, bottom edge of the front, tip 2-17 mm in
//     from the right seal, standard 4.5) -- never both
//   the film always comes off the roll bottom edge first; the unwind
//     position (1-4) only turns the copy
//   hang hole (optional): the top seal grows to 20 mm and a 6 mm hole is
//     punched centered in it, through both layers. The slit keeps its rule of
//     4.5 mm below the top seal, so it moves down with it.

export const MM_PER_IN = 25.4;
export const SEAL = 6;
export const BLEED = 1;
export const EYE = 6;
export const SLIT_BELOW_SEAL = 4.5;
export const HANG_SEAL = 20;
export const HANG_HOLE_D = 6;
export const SLIT_LEN = 4;
export const TRI_W = 1.5;
export const TRI_D = (TRI_W * Math.sqrt(3)) / 2;

export const TOOLING_IN = [5.5, 6, 6.5] as const;
export const LEN_MIN_IN = 2.5;
export const LEN_MAX_IN = 4.5;
export const OFF_MIN_MM = 2;
export const OFF_MAX_MM = 17;
export const OFF_STD_MM = 4.5;
export const STANDARDS = [
  { tooling: 5.5, length: 3 },
  { tooling: 6, length: 3.5 },
  { tooling: 6.5, length: 3.5 },
] as const;

export type Notch = "none" | "slit" | "triangle";
export type Unwind = 1 | 2 | 3 | 4;

export type SachetSpec = {
  toolingIn: number;
  lengthIn: number;
  notch: Notch;
  triangleOffsetMm: number;
  unwind: Unwind;
  hangHole: boolean;
  /** Hot-stamped LOT / EXP area (stamped at PharmaCenter after printing). */
  stamp: boolean;
  stampLines: StampLines;
  /** Top-left of the stamp area on the flat film, mm; null = standard spot. */
  stampPos: { x: number; y: number } | null;
};

export const DEFAULT_SPEC: SachetSpec = {
  toolingIn: 6,
  lengthIn: 3.5,
  notch: "slit",
  triangleOffsetMm: OFF_STD_MM,
  unwind: 2,
  hangHole: false,
  stamp: false,
  stampLines: 1, // standard: one line (user, 2026-10-22)
  stampPos: null,
};

// ---- hot stamp (LOT / EXP) ----------------------------------------------------
// From the user, 2026-10-22: up to 3 lines, max 15 characters per line (spaces
// count), characters about 1.5 mm tall (~6 pt). The stamp reads upright on the
// film -- like unwind position 2 -- whatever the unwind position, and it can be
// moved anywhere on the film. Standard spot: back panel, just above the bottom
// seal, one line. Ink is black or white only (no choice in the builder; the
// guidelines say so). The width assumes a monospaced stamp font at ~1.25 mm per character.
export type StampLines = 1 | 2 | 3;
export const STAMP_CHAR_H = 1.5;
export const STAMP_LINE_GAP = 1;
export const STAMP_MARGIN = 1;
export const STAMP_MAX_CHARS = 15;
export const STAMP_CHAR_W = 1.25;
export const STAMP_W = Math.round(STAMP_MAX_CHARS * STAMP_CHAR_W + 2 * STAMP_MARGIN); // 21 mm
export const stampH = (n: StampLines) => n * STAMP_CHAR_H + (n - 1) * STAMP_LINE_GAP + 2 * STAMP_MARGIN;

/** The standard spot: centered on the back panel's clear area, 0.5 mm above the bottom seal. */
export function stampStd(spec: SachetSpec) {
  const half = (spec.toolingIn * MM_PER_IN) / 2;
  const H = spec.lengthIn * MM_PER_IN;
  return { x: (SEAL + half) / 2 - STAMP_W / 2, y: H - SEAL - stampH(spec.stampLines) - 0.5 };
}

/** Where the stamp area actually is (kept on the film), or null when off. */
export function stampBox(spec: SachetSpec) {
  if (!spec.stamp) return null;
  const W = spec.toolingIn * MM_PER_IN, H = spec.lengthIn * MM_PER_IN;
  const h = stampH(spec.stampLines);
  const p = spec.stampPos ?? stampStd(spec);
  const x = Math.min(Math.max(p.x, 0), W - STAMP_W);
  const y = Math.min(Math.max(p.y, 0), H - h);
  return { x, y, w: STAMP_W, h };
}

/** Top seal height: 6 mm, or 20 mm when the sachet has a hang hole. */
export const topSeal = (spec: SachetSpec) => (spec.hangHole ? HANG_SEAL : SEAL);
/** The slit's height from the top edge -- always 4.5 mm below the top seal. */
export const slitY = (spec: SachetSpec) => topSeal(spec) + SLIT_BELOW_SEAL;

/** Labels the drawings need, already in the viewer's language. */
export type DrawLabels = {
  back: string;
  front: string;
  fold: string;
  clear: string;
  offRoll: string;
  stamp: string;
};

// Rotation of the copy on the film for each unwind position. The bottom edge
// leads off the roll, so position 2 (bottom of the copy first) is upright.
export const COPY_ROTATION: Record<Unwind, number> = { 1: 180, 2: 0, 3: 90, 4: -90 };

export const inches = (mm: number) => (Math.round((mm / MM_PER_IN) * 100) / 100).toFixed(2) + '"';
const mm1 = (mm: number) => (Math.round(mm * 10) / 10).toFixed(1);
export const both = (mm: number) => `${inches(mm)} (${mm1(mm)} mm)`;
const esc = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] as string);

export function dims(spec: SachetSpec) {
  const filmW = spec.toolingIn * MM_PER_IN;
  const height = spec.lengthIn * MM_PER_IN;
  const panelW = filmW / 2;
  return {
    filmW,
    height,
    panelW,
    topSeal: topSeal(spec),
    clearW: panelW - SEAL,
    clearH: height - topSeal(spec) - SEAL,
  };
}

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

function copySample(spec: SachetSpec, cx: number, cy: number) {
  const r = COPY_ROTATION[spec.unwind];
  return (
    `<g transform="rotate(${r} ${cx} ${cy})"><text class="t-copy" x="${cx}" y="${cy}" text-anchor="middle" dominant-baseline="central">COPY</text>` +
    `<path class="s-copyline" d="M${cx - 8} ${cy + 4.6}H${cx + 8}"/></g>`
  );
}

// The notch as cut on the front panel. `rightEdge` is the front's outer edge;
// the triangle's tip sits `triangleOffsetMm` in from the inside of that seal.
function frontNotch(spec: SachetSpec, rightEdge: number, bottom: number) {
  if (spec.notch === "slit") {
    return `<path class="s-cut" d="M${rightEdge} ${slitY(spec)}H${rightEdge - SLIT_LEN}"/>`;
  }
  if (spec.notch === "triangle") {
    const tx = rightEdge - SEAL - spec.triangleOffsetMm;
    return `<path class="s-cutfill" d="M${tx - TRI_W / 2} ${bottom}L${tx} ${bottom - TRI_D}L${tx + TRI_W / 2} ${bottom}Z"/>`;
  }
  return "";
}

// Where the pack tears once opened -- finished view only. A slit on the side
// edge tears straight across at its own height; a triangle on the bottom edge
// tears straight up from its tip. `tipX` is the triangle tip on this panel.
function tearLine(spec: SachetSpec, w: number, H: number, tipX: number) {
  if (spec.notch === "slit") return `<path class="s-tear" d="M0 ${slitY(spec)}H${w}"/>`;
  if (spec.notch === "triangle") return `<path class="s-tear" d="M${tipX} ${H - TRI_D}V0"/>`;
  return "";
}

// The hang hole, centered across a panel of width `w` starting at `x0`, and
// centered in the top seal.
function hangHole(spec: SachetSpec, x0: number, w: number) {
  if (!spec.hangHole) return "";
  return `<circle class="s-hole" cx="${x0 + w / 2}" cy="${HANG_SEAL / 2}" r="${HANG_HOLE_D / 2}"/>`;
}

/** Baseline for a panel's "Clear area" caption: lifted above the stamp area
 *  when the stamp would sit on top of it. `cx` is the caption's center in
 *  film coordinates. */
export function clearCaptionY(spec: SachetSpec, cx: number, y: number) {
  const b = stampBox(spec);
  if (!b) return y;
  const overlapsX = Math.abs(b.x + b.w / 2 - cx) < b.w / 2 + 26;
  const overlapsY = b.y < y + 1 && b.y + b.h > y - 3;
  return overlapsX && overlapsY ? b.y - 1.5 : y;
}

/** One baseline for both panels' "Clear area" captions, so they always line
 *  up: if the stamp lifts one, both move. */
export function captionsY(spec: SachetSpec, y: number) {
  const half = (spec.toolingIn * MM_PER_IN) / 2;
  return Math.min(clearCaptionY(spec, half / 2 + SEAL / 2, y), clearCaptionY(spec, half * 1.5 - SEAL / 2, y));
}

/** The hot stamp area, clipped to [x0, x1) of the film and shifted by dx. */
function stampArea(spec: SachetSpec, label: string, x0 = -Infinity, x1 = Infinity, dx = 0) {
  const b = stampBox(spec);
  if (!b) return "";
  const l = Math.max(b.x, x0), r = Math.min(b.x + b.w, x1);
  if (r - l <= 0.05) return "";
  let s = `<rect class="s-stamp" x="${l + dx}" y="${b.y}" width="${r - l}" height="${b.h}"/>`;
  if (r - l >= 12) {
    s += `<text class="t-stamp" x="${(l + r) / 2 + dx}" y="${b.y + b.h / 2}" text-anchor="middle" dominant-baseline="central">${esc(label)}</text>`;
  }
  return s;
}

// A faint diamond crosshatch on the sealed edges -- the mark the heat-seal
// jaws leave. Each drawing gets its own pattern id (two drawings share a page).
// Inline style beats the .s-seal class fill.
function waffle(g: string, id: string) {
  const grid = `<path class="s-waffle" d="M0 0H1.4M0 0V1.4"/>`;
  const defs =
    `<defs><pattern id="${id}" width="1.4" height="1.4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">` +
    `<rect class="s-waffle-bg" width="1.4" height="1.4"/>${grid}</pattern>` +
    // Lines only, laid over the eye-mark lane: it is the back panel's side
    // seal, so it gets the waffle while keeping its own lane color.
    `<pattern id="${id}-lane" width="1.4" height="1.4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">${grid}</pattern></defs>`;
  return (
    defs +
    g
      .split('class="s-seal"').join(`class="s-seal" style="fill:url(#${id})"`)
      .split('class="s-lanewaffle"').join(`class="s-lanewaffle" style="fill:url(#${id}-lane)"`)
  );
}

/** The printed web, flat, viewed from the printed side. */
export function flatSvg(spec: SachetSpec, L: DrawLabels, ariaLabel: string): string {
  const { filmW: W, height: H, panelW: half, topSeal: top, clearW, clearH } = dims(spec);
  const pl = 16, pr = 24, pt = 24, pb = 14;
  const bcx = half / 2 + SEAL / 2;
  const fcx = half * 1.5 - SEAL / 2;
  const clearLabel = `${esc(L.clear)} ${inches(clearW)} × ${inches(clearH)}`;
  let g = "";
  g += `<rect class="s-bleed" x="${-BLEED}" y="${-BLEED}" width="${W + 2 * BLEED}" height="${H + 2 * BLEED}"/>`;
  g += `<rect class="s-film" x="0" y="0" width="${W}" height="${H}"/>`;
  g += `<rect class="s-seal" x="0" y="0" width="${W}" height="${top}"/>`;
  g += `<rect class="s-seal" x="0" y="${H - SEAL}" width="${W}" height="${SEAL}"/>`;
  g += `<rect class="s-seal" x="${W - SEAL}" y="0" width="${SEAL}" height="${H}"/>`;
  g += `<rect class="s-lane" x="0" y="0" width="${EYE}" height="${H}"/>`;
  g += `<rect class="s-lanewaffle" x="0" y="0" width="${EYE}" height="${H}"/>`;
  g += `<rect class="s-mark" x="0" y="0" width="${EYE}" height="${EYE}"/>`;
  g += `<rect class="s-clear" x="${SEAL}" y="${top}" width="${clearW}" height="${clearH}"/>`;
  g += `<rect class="s-clear" x="${half}" y="${top}" width="${clearW}" height="${clearH}"/>`;
  g += `<rect class="s-outline" x="0" y="0" width="${W}" height="${H}"/>`;
  g += `<line class="s-fold" x1="${half}" y1="-4" x2="${half}" y2="${H + 4}"/>`;
  g += `<text class="t-sub t-fold" x="${half}" y="-5.2" text-anchor="middle">${esc(L.fold)}</text>`;
  g += `<text class="t-panel" x="${bcx}" y="${top + 6}" text-anchor="middle">${esc(L.back)}</text>`;
  g += `<text class="t-panel" x="${fcx}" y="${top + 6}" text-anchor="middle">${esc(L.front)}</text>`;
  g += copySample(spec, bcx, (top + H - SEAL) / 2 + 1) + copySample(spec, fcx, (top + H - SEAL) / 2 + 1);
  g += `<text class="t-sub" x="${bcx}" y="${captionsY(spec, H - SEAL - 2.5)}" text-anchor="middle">${clearLabel}</text>`;
  g += `<text class="t-sub" x="${fcx}" y="${captionsY(spec, H - SEAL - 2.5)}" text-anchor="middle">${clearLabel}</text>`;
  g += stampArea(spec, L.stamp);
  g += frontNotch(spec, W, H);
  // Punched through both layers, so it shows on both panels.
  g += hangHole(spec, 0, half) + hangHole(spec, half, half);
  // Direction off the roll is fixed: bottom edge first.
  const ax = W * 0.76;
  // A short, stubby arrow: wide shaft, broad head, pointing down off the roll.
  g +=
    `<path class="s-lead" d="M${ax - 1.3} ${H + 3.5}H${ax + 1.3}V${H + 6.3}H${ax + 3}` +
    `L${ax} ${H + 9.6}L${ax - 3} ${H + 6.3}H${ax - 1.3}Z"/>`;
  g += `<text class="t-lead" x="${ax + 4}" y="${H + 7.6}">${esc(L.offRoll)}</text>`;
  g += hdim(0, half, -10, inches(half)) + hdim(half, W, -10, inches(half));
  g += hdim(0, W, -18, both(W));
  g += vdim(0, H, W + 7, both(H));
  return `<svg viewBox="${-pl} ${-pt} ${W + pl + pr} ${H + pt + pb}" role="img" aria-label="${esc(ariaLabel)}">${waffle(g, "dl-waffle-flat")}</svg>`;
}

/** Back (left) and front (right), as they look once folded and sealed. */
export function finishedSvg(spec: SachetSpec, L: DrawLabels, ariaLabel: string): string {
  const { panelW: w, height: H, topSeal: top, clearW, clearH } = dims(spec);
  const gap = 20;
  const pl = 10, pr = 14, pt = 12, pb = 22;
  const fx = w + gap; // front panel's left edge
  const clearLine = `${inches(clearW)} × ${inches(clearH)}`;
  let g = "";

  // BACK -- fold on its right; its outer edge carries the eye-mark lane.
  g += `<rect class="s-film" x="0" y="0" width="${w}" height="${H}"/>`;
  g += `<rect class="s-seal" x="0" y="0" width="${w}" height="${top}"/>`;
  g += `<rect class="s-seal" x="0" y="${H - SEAL}" width="${w}" height="${SEAL}"/>`;
  g += `<rect class="s-lane" x="0" y="0" width="${EYE}" height="${H}"/>`;
  g += `<rect class="s-lanewaffle" x="0" y="0" width="${EYE}" height="${H}"/>`;
  g += `<rect class="s-mark" x="0" y="0" width="${EYE}" height="${EYE}"/>`;
  g += `<rect class="s-clear" x="${SEAL}" y="${top}" width="${clearW}" height="${clearH}"/>`;
  g += `<rect class="s-outline" x="0" y="0" width="${w}" height="${H}"/>`;
  g += `<line class="s-foldedge" x1="${w}" y1="0" x2="${w}" y2="${H}"/>`;
  // The notch cuts both layers; seen from behind it is mirrored onto the
  // back's outer (left) edge.
  if (spec.notch === "slit") g += `<path class="s-cut" d="M0 ${slitY(spec)}H${SLIT_LEN}"/>`;
  if (spec.notch === "triangle") {
    const tx = SEAL + spec.triangleOffsetMm;
    g += `<path class="s-cutfill" d="M${tx - TRI_W / 2} ${H}L${tx} ${H - TRI_D}L${tx + TRI_W / 2} ${H}Z"/>`;
  }
  g += tearLine(spec, w, H, SEAL + spec.triangleOffsetMm);
  g += hangHole(spec, 0, w);
  g += `<text class="t-panel" x="${w / 2}" y="-4" text-anchor="middle">${esc(L.back)}</text>`;
  g += copySample(spec, (w + SEAL) / 2, (top + H - SEAL) / 2);
  g += `<text class="t-sub" x="${(w + SEAL) / 2}" y="${captionsY(spec, H - SEAL - 2.5)}" text-anchor="middle">${esc(L.clear)} ${clearLine}</text>`;
  // The stamp stays where it is on the film: back = film x 0..w.
  g += stampArea(spec, L.stamp, 0, w, 0);

  // FRONT -- fold on its left.
  g += `<g transform="translate(${fx} 0)">`;
  g += `<rect class="s-film" x="0" y="0" width="${w}" height="${H}"/>`;
  g += `<rect class="s-seal" x="0" y="0" width="${w}" height="${top}"/>`;
  g += `<rect class="s-seal" x="0" y="${H - SEAL}" width="${w}" height="${SEAL}"/>`;
  g += `<rect class="s-seal" x="${w - SEAL}" y="0" width="${SEAL}" height="${H}"/>`;
  g += `<rect class="s-clear" x="0" y="${top}" width="${clearW}" height="${clearH}"/>`;
  g += `<rect class="s-outline" x="0" y="0" width="${w}" height="${H}"/>`;
  g += `<line class="s-foldedge" x1="0" y1="0" x2="0" y2="${H}"/>`;
  g += frontNotch(spec, w, H);
  g += tearLine(spec, w, H, w - SEAL - spec.triangleOffsetMm);
  g += hangHole(spec, 0, w);
  g += `<text class="t-panel" x="${w / 2}" y="-4" text-anchor="middle">${esc(L.front)}</text>`;
  g += copySample(spec, clearW / 2, (top + H - SEAL) / 2);
  g += `<text class="t-sub" x="${clearW / 2}" y="${captionsY(spec, H - SEAL - 2.5)}" text-anchor="middle">${esc(L.clear)} ${clearLine}</text>`;
  // front = film x w..2w, drawn from this panel's left edge
  g += stampArea(spec, L.stamp, w, 2 * w, -w);
  g += `</g>`;

  g += `<text class="t-sub t-fold" x="${w}" y="${H + 4.5}" text-anchor="middle">${esc(L.fold)}</text>`;
  g += `<text class="t-sub t-fold" x="${fx}" y="${H + 4.5}" text-anchor="middle">${esc(L.fold)}</text>`;
  g += hdim(0, w, H + 13, both(w)) + hdim(fx, fx + w, H + 13, both(w));
  g += vdim(0, H, fx + w + 7, both(H));
  return `<svg viewBox="${-pl} ${-pt} ${2 * w + gap + pl + pr} ${H + pt + pb}" role="img" aria-label="${esc(ariaLabel)}">${waffle(g, "dl-waffle-fin")}</svg>`;
}
