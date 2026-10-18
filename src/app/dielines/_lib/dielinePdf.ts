// The downloadable sachet dieline: a three-page PDF.
//
//   Page 1 -- the dieline itself, 1:1, clean technical lines on layers, every
//             line in the non-printing spot color "Dieline" (overprint), plus
//             a real black eye mark on its own layer the customer keeps, and a
//             notes block below the art.
//   Page 2 -- the film laid flat, as drawn in the builder (reference picture).
//   Page 3 -- the finished sachet, as drawn in the builder (reference picture).
//
// Page 1 is drawn from the same geometry as the preview (sachet.ts), so the two
// cannot disagree. Pages 2-3 are the builder's own SVGs, rasterised.

import {
  BLEED,
  EYE,
  HANG_HOLE_D,
  HANG_SEAL,
  SEAL,
  SLIT_LEN,
  TRI_D,
  TRI_W,
  dims,
  inches,
  slitY,
  type SachetSpec,
} from "./sachet";
import { BLACK, DIELINE, PageCanvas, buildPdf, gray, hex, textWidth } from "./pdf";
import { artworkGuidelines } from "./guidelines";

// House brand, as on every PharmaCenter app (globals.css).
const TEAL = hex("#0f4a56");
const TEAL_2 = hex("#1d6c7b");
const SAGE = hex("#7fb04f");
const LOGO_RATIO = 991 / 252; // public/logo.png, width / height

const L = {
  notes: "Notes",
  cut: "Cut line",
  bleed: "Bleed",
  fold: "Fold",
  seals: "Seals",
  clear: "Clear area",
  lane: "Eye mark lane",
  notch: "Notch & hang hole",
  labels: "Labels & dimensions",
  eye: "Eye mark (keep)",
  ref: "Reference",
};
const LAYERS = [L.eye, L.cut, L.bleed, L.fold, L.seals, L.clear, L.lane, L.notch, L.labels, L.notes, L.ref];

const NOTCH_CODE = { none: "NoNotch", slit: "HSlit", triangle: "VTri" } as const;
const UNWIND_TEXT = {
  1: "Top of the art comes off the roll first",
  2: "Bottom of the art comes off the roll first",
  3: "Right side of the art comes off the roll first",
  4: "Left side of the art comes off the roll first",
} as const;

export function dielineFileName(spec: SachetSpec) {
  const d = dims(spec);
  const w = (d.panelW / 25.4).toFixed(2);
  const h = spec.lengthIn.toFixed(2);
  return `PharmaCenter-Sachet-${w}x${h}-${NOTCH_CODE[spec.notch]}${spec.hangHole ? "-HangHole" : ""}.pdf`;
}

const mm = (v: number) => `${(Math.round(v * 10) / 10).toFixed(1)} mm`;
const inMm = (v: number) => `${inches(v)} (${mm(v)})`;

/** Page 1: the dieline. Returns the page; the unwind picture is drawn as "Unwind". */
function dielinePage(spec: SachetSpec, today: string, hasUnwindImage: boolean, hasLogo: boolean) {
  const d = dims(spec);
  const W = d.filmW, H = d.height, half = d.panelW, top = d.topSeal;
  const ox = 22, oy = 30; // film origin on the page
  const notesTop = oy + H + 20;
  const pageW = Math.max(ox + W + 30, 200);
  const pageH = notesTop + 122;
  const p = new PageCanvas(pageW, pageH);
  const X = (x: number) => ox + x;
  const Y = (y: number) => oy + y;
  const hair = 0.1; // ~0.28 pt
  const fine = 0.18;

  // ---- art-area layers, all in the Dieline spot color ----
  p.layer(L.bleed, () => {
    p.rect(X(-BLEED), Y(-BLEED), W + 2 * BLEED, H + 2 * BLEED, { stroke: DIELINE, width: hair, dash: [1, 0.7] });
  });
  p.layer(L.seals, () => {
    const s = { stroke: { kind: "spot", tint: 0.6 } as const, width: hair, dash: [0.6, 0.6] };
    p.line(X(0), Y(top), X(W), Y(top), s);
    p.line(X(0), Y(H - SEAL), X(W), Y(H - SEAL), s);
    p.line(X(W - SEAL), Y(0), X(W - SEAL), Y(H), s);
  });
  p.layer(L.lane, () => {
    p.rect(X(0), Y(0), EYE, H, { stroke: { kind: "spot", tint: 0.6 }, width: hair, dash: [0.6, 0.6] });
  });
  p.layer(L.clear, () => {
    const c = { stroke: { kind: "spot", tint: 0.45 } as const, width: hair, dash: [0.3, 0.6] };
    p.rect(X(SEAL), Y(top), d.clearW, d.clearH, c);
    p.rect(X(half), Y(top), d.clearW, d.clearH, c);
  });
  p.layer(L.fold, () => {
    p.line(X(half), Y(-4), X(half), Y(H + 4), { stroke: DIELINE, width: fine, dash: [3, 1, 0.6, 1] });
  });
  p.layer(L.notch, () => {
    if (spec.notch === "slit") {
      p.line(X(W), Y(slitY(spec)), X(W - SLIT_LEN), Y(slitY(spec)), { stroke: DIELINE, width: 0.25, cap: 1 });
    }
    if (spec.notch === "triangle") {
      const tx = W - SEAL - spec.triangleOffsetMm;
      p.poly(
        [
          [X(tx - TRI_W / 2), Y(H)],
          [X(tx), Y(H - TRI_D)],
          [X(tx + TRI_W / 2), Y(H)],
        ],
        { fill: DIELINE },
      );
    }
    if (spec.hangHole) {
      for (const cx of [half / 2, half * 1.5]) {
        p.circle(X(cx), Y(HANG_SEAL / 2), HANG_HOLE_D / 2, { stroke: DIELINE, width: fine });
      }
    }
  });
  p.layer(L.cut, () => {
    p.rect(X(0), Y(0), W, H, { stroke: DIELINE, width: fine });
  });
  p.layer(L.labels, () => {
    const t = { color: DIELINE, size: 2.2 };
    const tb = { color: DIELINE, size: 3.2, font: "bold" as const, align: "center" as const };
    p.text(X(half / 2 + SEAL / 2), Y(top + 6), "BACK", tb);
    p.text(X(half * 1.5 - SEAL / 2), Y(top + 6), "FRONT", tb);
    const clear = `CLEAR AREA ${inches(d.clearW)} x ${inches(d.clearH)}`;
    p.text(X(half / 2 + SEAL / 2), Y(H - SEAL - 2), clear, { ...t, size: 1.8, align: "center" });
    p.text(X(half * 1.5 - SEAL / 2), Y(H - SEAL - 2), clear, { ...t, size: 1.8, align: "center" });
    p.text(X(half), Y(-5), "FOLD", { ...t, size: 1.8, align: "center" });
    // dimensions above
    const dim = (x1: number, x2: number, y: number, label: string) => {
      p.line(X(x1), Y(y), X(x2), Y(y), { stroke: DIELINE, width: hair });
      p.line(X(x1), Y(y - 1.2), X(x1), Y(y + 1.2), { stroke: DIELINE, width: hair });
      p.line(X(x2), Y(y - 1.2), X(x2), Y(y + 1.2), { stroke: DIELINE, width: hair });
      p.text(X((x1 + x2) / 2), Y(y - 1.2), label, { ...t, align: "center" });
    };
    dim(0, half, -10, inches(half));
    dim(half, W, -10, inches(half));
    dim(0, W, -18, `FILM ${inMm(W)}`);
    // length on the right
    const vx = W + 7;
    p.line(X(vx), Y(0), X(vx), Y(H), { stroke: DIELINE, width: hair });
    p.line(X(vx - 1.2), Y(0), X(vx + 1.2), Y(0), { stroke: DIELINE, width: hair });
    p.line(X(vx - 1.2), Y(H), X(vx + 1.2), Y(H), { stroke: DIELINE, width: hair });
    p.text(X(vx + 2), Y(H / 2), inches(H), { ...t });
    p.text(X(vx + 2), Y(H / 2 + 3), mm(H), { ...t, size: 1.8 });
    // off the roll, bottom edge first
    const ax = W * 0.76;
    p.poly(
      [
        [X(ax - 1.3), Y(H + 3.5)],
        [X(ax + 1.3), Y(H + 3.5)],
        [X(ax + 1.3), Y(H + 6.3)],
        [X(ax + 3), Y(H + 6.3)],
        [X(ax), Y(H + 9.6)],
        [X(ax - 3), Y(H + 6.3)],
        [X(ax - 1.3), Y(H + 6.3)],
      ],
      { fill: DIELINE },
    );
    p.text(X(ax + 4.5), Y(H + 7.6), "OFF THE ROLL", { ...t });
    if (spec.notch === "slit") p.text(X(W + 1.5), Y(slitY(spec) + 0.8), "SLIT", { ...t, size: 1.6 });
  });

  // ---- the one printing element: the eye mark ----
  p.layer(L.eye, () => {
    p.rect(X(0), Y(0), EYE, EYE, { fill: BLACK });
  });

  // ---- notes block, below the art ----
  p.layer(L.notes, () => {
    const ink = gray(0.15);
    const soft = gray(0.45);
    let y = notesTop;
    // Brand band: teal rule, logo, title in house teal, sage accent.
    p.rect(ox, y - 8, pageW - 12 - ox, 0.7, { fill: TEAL });
    let tx = ox;
    if (hasLogo) {
      const lh = 8;
      p.image("Logo", ox, y - 5, lh * LOGO_RATIO, lh);
      tx = ox + lh * LOGO_RATIO + 5;
    }
    p.text(tx, y + 1, "Sachet dieline", { color: TEAL, size: 4.6, font: "bold" });
    p.rect(tx, y + 2.6, 14, 0.6, { fill: SAGE });
    p.text(pageW - 12, y + 1, today, { color: soft, size: 2.6, align: "right" });
    y += 10;
    const notchText =
      spec.notch === "slit"
        ? `Horizontal tear: slit ${SLIT_LEN} mm, right edge, ${mm(slitY(spec))} from top`
        : spec.notch === "triangle"
          ? `Vertical tear: triangle ${TRI_W} mm, bottom of front, tip ${mm(spec.triangleOffsetMm)} in from the right seal`
          : "None";
    const rows: [string, string][] = [
      ["Finished size", `${inches(d.panelW)} x ${inches(H)} (W x H)`],
      ["Film (flat)", `${inMm(W)} x ${inMm(H)}`],
      ["Construction", "3-side seal; folded at center; left panel = back, right panel = front"],
      ["Seals", spec.hangHole ? "Top 20 mm; sides and bottom 6 mm; fold has none" : "6 mm top, bottom and outer side; fold has none"],
      ["Clear area (each panel)", `${inches(d.clearW)} x ${inches(d.clearH)}`],
      ["Bleed", `${BLEED} mm`],
      ["Eye mark", "6 x 6 mm, top-left, on a 6 mm solid high-contrast lane down the left edge"],
      ["Notch", notchText],
      ["Hang hole", spec.hangHole ? `${HANG_HOLE_D} mm diameter, centered in the top seal` : "None"],
      ["Unwind", `Position ${spec.unwind} -- ${UNWIND_TEXT[spec.unwind]}`],
    ];
    for (const [k, v] of rows) {
      p.text(ox, y, k, { color: TEAL_2, size: 2.5 });
      p.text(ox + 42, y, v, { color: ink, size: 2.5 });
      y += 4.1;
    }
    // Artwork guidelines -- the mistakes that stop a run on the machine.
    y += 4;
    p.text(ox, y, "Artwork guidelines", { color: TEAL, size: 3.2, font: "bold" });
    p.rect(ox, y + 1.4, 10, 0.5, { fill: SAGE });
    y += 6;
    const gs = 2.3;
    const maxW = pageW - 12 - (ox + 3.5);
    for (const g of artworkGuidelines(spec, "en")) {
      p.circle(ox + 1, y - 0.8, 0.45, { fill: SAGE });
      const head = `${g.title}: `;
      p.text(ox + 3.5, y, head.trim(), { color: TEAL, size: gs, font: "bold" });
      // Word-wrap the body; the first line starts after the bold title.
      let x0 = ox + 3.5 + textWidth(head, gs, "bold");
      let line = "";
      for (const word of g.text.split(" ")) {
        const next = line ? `${line} ${word}` : word;
        if (x0 + textWidth(next, gs, "regular") > ox + 3.5 + maxW && line) {
          p.text(x0, y, line, { color: ink, size: gs });
          y += 3.3;
          x0 = ox + 3.5;
          line = word;
        } else line = next;
      }
      if (line) p.text(x0, y, line, { color: ink, size: gs });
      y += 4.2;
    }
    if (hasUnwindImage) {
      const iw = 34, ih = iw * (73 / 112);
      p.image("Unwind", pageW - 12 - iw, notesTop + 9, iw, ih);
      p.text(pageW - 12 - iw / 2, notesTop + 11 + ih + 2, `Unwind position ${spec.unwind}`, { color: TEAL, size: 2.4, font: "bold", align: "center" });
    }
    footer(p, dielineFileName(spec), today);
  });
  return p;
}

// ---- reference-page legends: the same keys the builder shows under each drawing ----

const SW = {
  cut: hex("#c0216a"),
  notch: hex("#e07800"),
  sage: SAGE,
  seal: hex("#efe9da"),
  sealLine: hex("#cfc4a8"),
  sealEdge: hex("#e3dcc9"),
  mark: TEAL,
  clear: TEAL_2,
  bleed: hex("#8a9498"),
  white: hex("#ffffff"),
};

type LegendKey = "cut" | "notch" | "tear" | "hole" | "fold" | "foldEdge" | "seal" | "mark" | "clear" | "bleed";
const LEGEND_LABEL: Record<LegendKey, string> = {
  cut: "Cut line",
  notch: "Notch",
  tear: "Tear line",
  hole: "Hang hole 6 mm",
  fold: "Fold",
  foldEdge: "Fold",
  seal: "Seal 6 mm",
  mark: "Eye mark 6 × 6 mm",
  clear: "Clear area",
  bleed: "Bleed 1 mm",
};

/** Which keys each drawing carries -- only what that drawing actually shows. */
export function legendKeys(spec: SachetSpec, view: "flat" | "finished"): LegendKey[] {
  const notch: LegendKey[] = spec.notch !== "none" ? ["notch"] : [];
  const hole: LegendKey[] = spec.hangHole ? ["hole"] : [];
  if (view === "flat") return ["cut", ...notch, ...hole, "fold", "seal", "mark", "clear", "bleed"];
  return ["cut", ...notch, ...(spec.notch !== "none" ? (["tear"] as LegendKey[]) : []), ...hole, "foldEdge", "seal", "mark", "clear"];
}

/** One swatch, 6 x 3.4 mm, top-left at (x, y). */
function swatch(p: PageCanvas, key: LegendKey, spec: SachetSpec, x: number, y: number) {
  const w = 6, h = 3.4, cy = y + h / 2;
  switch (key) {
    case "cut": p.line(x, cy, x + w, cy, { stroke: SW.cut, width: 0.6 }); break;
    case "notch":
      if (spec.notch === "slit") p.line(x, cy, x + w, cy, { stroke: SW.notch, width: 0.6 });
      else p.poly([[x + 1.3, y + h], [x + w / 2, y], [x + w - 1.3, y + h]], { fill: SW.notch });
      break;
    case "tear": p.line(x, cy, x + w, cy, { stroke: SW.cut, width: 0.6, dash: [0.01, 1], cap: 1 }); break;
    case "hole": p.circle(x + w / 2, cy, 1.5, { stroke: SW.cut, fill: SW.white, width: 0.5 }); break;
    case "fold": p.line(x, cy, x + w, cy, { stroke: SW.sage, width: 0.6, dash: [1.4, 0.8] }); break;
    case "foldEdge": p.line(x, cy, x + w, cy, { stroke: SW.sage, width: 0.9 }); break;
    case "seal": {
      p.rect(x, y, w, h, { fill: SW.seal });
      // waffle: 45-degree lines both ways, clipped to the box by hand
      const step = 1.1;
      for (let c = -h; c < w + h; c += step) {
        for (const dir of [1, -1]) {
          // line through (x + c, y) going down-right (dir 1) or down-left (dir -1)
          const pts: [number, number][] = [];
          const x0 = x + c, y0 = y;
          const x1 = x0 + dir * h, y1 = y + h;
          // clip parametric segment to [x, x+w]
          let t0 = 0, t1 = 1;
          const dx = x1 - x0;
          if (dx !== 0) {
            const ta = (x - x0) / dx, tb = (x + w - x0) / dx;
            t0 = Math.max(t0, Math.min(ta, tb));
            t1 = Math.min(t1, Math.max(ta, tb));
          }
          if (t1 <= t0) continue;
          pts.push([x0 + dx * t0, y0 + h * t0], [x0 + dx * t1, y0 + h * t1]);
          p.line(pts[0][0], pts[0][1], pts[1][0], pts[1][1], { stroke: SW.sealLine, width: 0.15 });
        }
      }
      p.rect(x, y, w, h, { stroke: SW.sealEdge, width: 0.2 });
      break;
    }
    case "mark": p.rect(x, y, w, h, { fill: SW.mark }); break;
    case "clear": p.rect(x, y, w, h, { stroke: SW.clear, width: 0.25, dash: [0.8, 0.6] }); break;
    case "bleed": p.rect(x, y, w, h, { stroke: SW.bleed, width: 0.25, dash: [0.8, 0.6] }); break;
  }
}

/** A single centered row of keys with its baseline near y. */
function legendRow(p: PageCanvas, keys: LegendKey[], spec: SachetSpec, y: number) {
  const size = 2.8, swW = 6, gap = 1.8, between = 7;
  const widths = keys.map((k) => swW + gap + textWidth(LEGEND_LABEL[k], size, "regular"));
  const total = widths.reduce((a, b) => a + b, 0) + between * (keys.length - 1);
  let x = (p.widthMm - total) / 2;
  keys.forEach((k, i) => {
    swatch(p, k, spec, x, y - 2.9);
    p.text(x + swW + gap, y, LEGEND_LABEL[k], { color: gray(0.4), size });
    x += widths[i] + between;
  });
}

function referencePage(
  title: string,
  img: { name: string; width: number; height: number },
  hasLogo: boolean,
  fileName: string,
  today: string,
  spec: SachetSpec,
  keys: LegendKey[],
) {
  const pageW = 279.4, pageH = 215.9; // US Letter, landscape
  const p = new PageCanvas(pageW, pageH);
  p.layer(L.ref, () => {
    let tx = 18;
    if (hasLogo) {
      const lh = 9;
      p.image("Logo", 18, 11, lh * LOGO_RATIO, lh);
      tx = 18 + lh * LOGO_RATIO + 6;
    }
    p.text(tx, 18, title, { color: TEAL, size: 5.2, font: "bold" });
    p.rect(tx, 20, 16, 0.7, { fill: SAGE });
    p.text(pageW - 18, 18, "Reference only", { color: TEAL_2, size: 2.8, font: "bold", align: "right" });
    p.rect(18, 25, pageW - 36, 0.7, { fill: TEAL });
    p.text(18, 31, "As drawn in the PharmaCenter dieline builder. Use page 1 for artwork.", { color: gray(0.45), size: 2.6 });
    const maxW = pageW - 36, maxH = pageH - 70; // room below for the legend
    const s = Math.min(maxW / img.width, maxH / img.height);
    const w = img.width * s, h = img.height * s;
    p.image(img.name, (pageW - w) / 2, 38 + (maxH - h) / 2, w, h);
    legendRow(p, keys, spec, pageH - 21);
    footer(p, fileName, today);
  });
  return p;
}

/** Thin teal rule and a quiet line naming the file, on every page. */
function footer(p: PageCanvas, fileName: string, today: string) {
  const y = p.heightMm - 9;
  p.rect(18, y - 4, p.widthMm - 36, 0.3, { fill: TEAL });
  p.text(18, y, `PharmaCenter  ·  ${fileName.replace(/\.pdf$/, "")}`, { color: TEAL_2, size: 2.2 });
  p.text(p.widthMm - 18, y, `Generated ${today} by the PharmaCenter dieline builder`, { color: gray(0.5), size: 2.2, align: "right" });
}

// ---- browser helpers: turn the live SVGs and the unwind PNG into JPEG bytes ----

const STYLE_PROPS = [
  "fill", "fill-opacity", "stroke", "stroke-width", "stroke-dasharray", "stroke-linecap",
  "opacity", "font-family", "font-size", "font-weight", "letter-spacing",
];

/** Copy a live SVG with its computed styles baked in (CSS-module classes and
 *  CSS variables do not survive serialisation on their own). Must run while
 *  the SVG is on screen -- before any await, because the builder re-renders
 *  as soon as the button flips to "Generating…" and a detached element has no
 *  computed style. */
function snapshotSvg(svg: SVGSVGElement) {
  const clone = svg.cloneNode(true) as SVGSVGElement;
  const src = [svg, ...Array.from(svg.querySelectorAll("*"))];
  const dst = [clone, ...Array.from(clone.querySelectorAll("*"))];
  src.forEach((el, i) => {
    const cs = getComputedStyle(el);
    const target = dst[i] as SVGElement;
    const keep = target.getAttribute("style") ?? "";
    const style = STYLE_PROPS.map((prop) => `${prop}:${cs.getPropertyValue(prop)}`).join(";");
    // Inline fills like url(#pattern) must win over the computed value.
    target.setAttribute("style", `${style};${keep}`);
  });
  const vb = svg.viewBox.baseVal;
  return { clone, vbWidth: vb.width, vbHeight: vb.height };
}

/** Rasterise a snapshot taken by snapshotSvg. */
async function svgToJpeg(snap: ReturnType<typeof snapshotSvg>, widthPx: number) {
  const { clone } = snap;
  const vb = { width: snap.vbWidth, height: snap.vbHeight };
  const heightPx = Math.round((widthPx * vb.height) / vb.width);
  clone.setAttribute("width", String(widthPx));
  clone.setAttribute("height", String(heightPx));
  clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  const blob = new Blob([new XMLSerializer().serializeToString(clone)], { type: "image/svg+xml" });
  const url = URL.createObjectURL(blob);
  try {
    const img = await loadImage(url);
    return await toJpeg(img, widthPx, heightPx);
  } finally {
    URL.revokeObjectURL(url);
  }
}

function loadImage(src: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Could not load ${src}`));
    img.src = src;
  });
}

async function toJpeg(img: CanvasImageSource, w: number, h: number) {
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0, w, h);
  const blob = await new Promise<Blob>((res, rej) =>
    canvas.toBlob((b) => (b ? res(b) : rej(new Error("Canvas export failed"))), "image/jpeg", 0.92),
  );
  return { width: w, height: h, bytes: new Uint8Array(await blob.arrayBuffer()) };
}

/** Build the PDF and hand it to the browser as a download. */
export async function downloadDieline(spec: SachetSpec, views: { flat: SVGSVGElement | null; finished: SVGSVGElement | null }) {
  const today = new Date().toISOString().slice(0, 10);
  // Snapshot the drawings first, synchronously, while they are on screen.
  const flatSnap = views.flat ? snapshotSvg(views.flat) : null;
  const finishedSnap = views.finished ? snapshotSvg(views.finished) : null;
  const jpegs: { name: string; width: number; height: number; bytes: Uint8Array }[] = [];

  let hasLogo = false;
  try {
    const logo = await loadImage("/logo.png");
    jpegs.push({ name: "Logo", ...(await toJpeg(logo, logo.naturalWidth, logo.naturalHeight)) });
    hasLogo = true;
  } catch {
    // Text title alone if the logo cannot be read.
  }

  let hasUnwind = false;
  try {
    const img = await loadImage(`/dielines/unwind-${spec.unwind}.png`);
    jpegs.push({ name: "Unwind", ...(await toJpeg(img, img.naturalWidth, img.naturalHeight)) });
    hasUnwind = true;
  } catch {
    // The notes still say the position in words.
  }

  const fileName = dielineFileName(spec);
  const pages = [dielinePage(spec, today, hasUnwind, hasLogo)];
  if (flatSnap) {
    const j = await svgToJpeg(flatSnap, 2600);
    jpegs.push({ name: "RefFlat", ...j });
    pages.push(referencePage("Film laid flat", { name: "RefFlat", ...j }, hasLogo, fileName, today, spec, legendKeys(spec, "flat")));
  }
  if (finishedSnap) {
    const j = await svgToJpeg(finishedSnap, 2600);
    jpegs.push({ name: "RefFinished", ...j });
    pages.push(referencePage("Finished sachet", { name: "RefFinished", ...j }, hasLogo, fileName, today, spec, legendKeys(spec, "finished")));
  }

  const bytes = buildPdf({ title: dielineFileName(spec).replace(/\.pdf$/, ""), pages, layers: LAYERS, jpegs });
  const url = URL.createObjectURL(new Blob([bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer], { type: "application/pdf" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = dielineFileName(spec);
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
