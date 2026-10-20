// The downloadable bottle label dieline: one page, 1:1, layered.
//
// Same conventions as the sachet file (dielinePdf.ts): every technical line in
// the non-printing spot color "Dieline" with overprint, each kind of line on
// its own layer, a branded notes block below the art, and the language of the
// builder. Drawn from the same numbers as the preview (bottle.ts).

import {
  ARROW,
  LABEL_BLEED,
  LABEL_SAFE,
  dieOf,
  inText,
  labelDims,
  leadEdge,
  mmText,
  type Die,
  type LabelSpec,
} from "./bottle";
import { DIELINE, PageCanvas, buildPdf, gray, hex, textWidth } from "./pdf";
import { labelGuidelines } from "./guidelines";
import { loadImage, toJpeg } from "./dielinePdf";

const TEAL = hex("#0f4a56");
const TEAL_2 = hex("#1d6c7b");
const SAGE = hex("#7fb04f");
const LOGO_RATIO = 991 / 252;

type PdfLang = "en" | "es";

const TX = {
  en: {
    ly: { cut: "Cut line", bleed: "Bleed", safe: "Text safe zone", labels: "Labels & dimensions", notes: "Notes" },
    safeZone: "TEXT SAFE ZONE",
    offRoll: "OFF THE ROLL",
    title: "Bottle label dieline",
    rSize: "Label size", rDie: "Die cut", rCorners: "Corners", rBleed: "Bleed", rSafe: "Text safe zone", rUnwind: "Unwind",
    hxl: "(height x length; the length wraps around the bottle)",
    corners: (r: string) => `Rounded, ${r} mm radius`,
    safe: (s: string) => `${s}, ${LABEL_SAFE} mm inside the cut`,
    position: (n: number) => `Position ${n}`,
    standard: "standard",
    unwind: {
      1: "Top of the art comes off the roll first",
      2: "Bottom of the art comes off the roll first",
      3: "Right side of the art comes off the roll first",
      4: "Left side of the art comes off the roll first",
    },
    guidelines: "Artwork guidelines",
    unwindPos: (n: number) => `Unwind position ${n}`,
    generated: (d: string) => `Generated ${d} by the PharmaCenter dieline builder`,
  },
  es: {
    ly: { cut: "Línea de corte", bleed: "Sangrado", safe: "Zona segura de texto", labels: "Etiquetas y medidas", notes: "Notas" },
    safeZone: "ZONA SEGURA DE TEXTO",
    offRoll: "SALIDA DEL ROLLO",
    title: "Troquel de etiqueta para frasco",
    rSize: "Tamaño de etiqueta", rDie: "Troquel", rCorners: "Esquinas", rBleed: "Sangrado", rSafe: "Zona segura de texto", rUnwind: "Desenrollado",
    hxl: "(alto x largo; el largo rodea el frasco)",
    corners: (r: string) => `Redondeadas, radio de ${r} mm`,
    safe: (s: string) => `${s}, ${LABEL_SAFE} mm dentro del corte`,
    position: (n: number) => `Posición ${n}`,
    standard: "estándar",
    unwind: {
      1: "La parte superior del arte sale primero del rollo",
      2: "La parte inferior del arte sale primero del rollo",
      3: "El lado derecho del arte sale primero del rollo",
      4: "El lado izquierdo del arte sale primero del rollo",
    },
    guidelines: "Guía para el arte",
    unwindPos: (n: number) => `Posición de desenrollado ${n}`,
    generated: (d: string) => `Generado el ${d} por el constructor de troqueles de PharmaCenter`,
  },
};
type Tx = (typeof TX)["en"];

export function labelFileName(spec: LabelSpec) {
  const d = dieOf(spec);
  return `PharmaCenter-BottleLabel-${mmText(d.h)}x${mmText(d.l)}mm-Die${d.die}.pdf`;
}

const both = (mm: number) => `${inText(mm)} (${mmText(mm)} mm)`;

/** A rounded rectangle as a closed polygon of short segments (PageCanvas has no arcs). */
function roundedRect(x: number, y: number, w: number, h: number, r: number): [number, number][] {
  const pts: [number, number][] = [];
  const corner = (cx: number, cy: number, a0: number) => {
    for (let i = 0; i <= 8; i++) {
      const a = ((a0 + (i * 90) / 8) * Math.PI) / 180;
      pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
    }
  };
  corner(x + w - r, y + r, -90);
  corner(x + w - r, y + h - r, 0);
  corner(x + r, y + h - r, 90);
  corner(x + r, y + r, 180);
  return pts;
}

function labelPage(spec: LabelSpec, d: Die, today: string, hasLogo: boolean, hasUnwind: boolean, T: Tx, lang: PdfLang) {
  const { safeH, safeL, safeR } = labelDims(d);
  const W = d.l, H = d.h;
  const pageW = 279.4;
  const ox = (pageW - W) / 2;
  const oy = spec.unwind === 1 ? 44 : 34;
  const notesTop = oy + H + 26;
  const pageH = notesTop + 104;
  const p = new PageCanvas(pageW, pageH);
  const X = (x: number) => ox + x;
  const Y = (y: number) => oy + y;
  const hair = 0.1, fine = 0.18;
  const rr = (x: number, y: number, w: number, h: number, r: number) =>
    roundedRect(X(x), Y(y), w, h, r);

  p.layer(T.ly.bleed, () => {
    p.poly(rr(-LABEL_BLEED, -LABEL_BLEED, W + 2 * LABEL_BLEED, H + 2 * LABEL_BLEED, d.r + LABEL_BLEED), { stroke: DIELINE, width: hair });
  });
  p.layer(T.ly.safe, () => {
    p.poly(rr(LABEL_SAFE, LABEL_SAFE, safeL, safeH, safeR), { stroke: { kind: "spot", tint: 0.5 }, width: hair });
  });
  p.layer(T.ly.cut, () => {
    p.poly(rr(0, 0, W, H, d.r), { stroke: DIELINE, width: fine });
  });
  p.layer(T.ly.labels, () => {
    const t = { color: DIELINE, size: 2.2 };
    p.text(X(W / 2), Y(H - LABEL_SAFE - 2), `${T.safeZone} ${inText(safeH)} x ${inText(safeL)}`, { ...t, size: 1.8, align: "center" });
    const dy = spec.unwind === 1 ? -14 : -7;
    p.line(X(0), Y(dy), X(W), Y(dy), { stroke: DIELINE, width: hair });
    p.line(X(0), Y(dy - 1.2), X(0), Y(dy + 1.2), { stroke: DIELINE, width: hair });
    p.line(X(W), Y(dy - 1.2), X(W), Y(dy + 1.2), { stroke: DIELINE, width: hair });
    p.text(X(W / 2), Y(dy - 1.2), both(W), { ...t, align: "center" });
    const vx = W + (spec.unwind === 3 ? 16 : 7);
    p.line(X(vx), Y(0), X(vx), Y(H), { stroke: DIELINE, width: hair });
    p.line(X(vx - 1.2), Y(0), X(vx + 1.2), Y(0), { stroke: DIELINE, width: hair });
    p.line(X(vx - 1.2), Y(H), X(vx + 1.2), Y(H), { stroke: DIELINE, width: hair });
    p.text(X(vx + 2), Y(H / 2), inText(H), t);
    p.text(X(vx + 2), Y(H / 2 + 3), `${mmText(H)} mm`, { ...t, size: 1.8 });
    // off the roll
    const e = leadEdge(spec.unwind, d);
    const a = (e.angle * Math.PI) / 180;
    const pts = ARROW.map(([x, y]) => [
      X(e.x + x * Math.cos(a) - y * Math.sin(a)),
      Y(e.y + x * Math.sin(a) + y * Math.cos(a)),
    ]) as [number, number][];
    p.poly(pts, { fill: DIELINE });
    if (spec.unwind === 1 || spec.unwind === 2) {
      p.text(X(e.x + 4.5), Y(spec.unwind === 1 ? -6.4 : H + 7.6), T.offRoll, t);
    } else {
      const right = spec.unwind === 3;
      p.text(X(right ? W + 2.5 : -2.5), Y(H / 2 + 9), T.offRoll, { ...t, align: right ? "left" : "right" });
    }
  });

  p.layer(T.ly.notes, () => {
    const ink = gray(0.15), soft = gray(0.45);
    const left = 22, right = pageW - 22;
    let y = notesTop;
    p.rect(left, y - 8, right - left, 0.7, { fill: TEAL });
    let tx = left;
    if (hasLogo) {
      const lh = 8;
      p.image("Logo", left, y - 5, lh * LOGO_RATIO, lh);
      tx = left + lh * LOGO_RATIO + 5;
    }
    p.text(tx, y + 1, T.title, { color: TEAL, size: 4.6, font: "bold" });
    p.rect(tx, y + 2.6, 14, 0.6, { fill: SAGE });
    p.text(right, y + 1, today, { color: soft, size: 2.6, align: "right" });
    y += 10;
    const pos = `${T.position(spec.unwind)}${spec.unwind === 4 ? ` (${T.standard})` : ""} -- ${T.unwind[spec.unwind]}`;
    const rows: [string, string][] = [
      [T.rSize, `${inText(H)} x ${inText(W)}  (${mmText(H)} x ${mmText(W)} mm)  ${T.hxl}`],
      [T.rDie, `#${d.die}`],
      [T.rCorners, T.corners(mmText(d.r))],
      [T.rBleed, `${LABEL_BLEED} mm`],
      [T.rSafe, T.safe(`${inText(safeH)} x ${inText(safeL)}`)],
      [T.rUnwind, pos],
    ];
    for (const [k, v] of rows) {
      p.text(left, y, k, { color: TEAL_2, size: 2.5 });
      p.text(left + 42, y, v, { color: ink, size: 2.5 });
      y += 4.1;
    }
    y += 4;
    p.text(left, y, T.guidelines, { color: TEAL, size: 3.2, font: "bold" });
    p.rect(left, y + 1.4, 10, 0.5, { fill: SAGE });
    y += 6;
    const gs = 2.3;
    const maxW = right - (left + 3.5);
    for (const g of labelGuidelines(d.r, lang)) {
      p.circle(left + 1, y - 0.8, 0.45, { fill: SAGE });
      const head = `${g.title}: `;
      p.text(left + 3.5, y, head.trim(), { color: TEAL, size: gs, font: "bold" });
      let x0 = left + 3.5 + textWidth(head, gs, "bold");
      let line = "";
      for (const word of g.text.split(" ")) {
        const next = line ? `${line} ${word}` : word;
        if (x0 + textWidth(next, gs, "regular") > left + 3.5 + maxW && line) {
          p.text(x0, y, line, { color: ink, size: gs });
          y += 3.3;
          x0 = left + 3.5;
          line = word;
        } else line = next;
      }
      if (line) p.text(x0, y, line, { color: ink, size: gs });
      y += 4.2;
    }
    if (hasUnwind) {
      const iw = 34, ih = iw * (700 / 960);
      p.image("Unwind", right - iw, notesTop + 9, iw, ih);
      p.text(right - iw / 2, notesTop + 11 + ih + 2, T.unwindPos(spec.unwind), { color: TEAL, size: 2.4, font: "bold", align: "center" });
    }
    const fy = pageH - 9;
    p.rect(left, fy - 4, right - left, 0.3, { fill: TEAL });
    p.text(left, fy, `PharmaCenter  ·  ${labelFileName(spec).replace(/\.pdf$/, "")}`, { color: TEAL_2, size: 2.2 });
    p.text(right, fy, T.generated(today), { color: gray(0.5), size: 2.2, align: "right" });
  });
  return p;
}

/** Build the label PDF and hand it to the browser as a download. */
export async function downloadLabel(spec: LabelSpec, lang: PdfLang = "en") {
  const T = TX[lang];
  const d = dieOf(spec);
  const today = new Date().toISOString().slice(0, 10);
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
  const fileName = labelFileName(spec);
  const page = labelPage(spec, d, today, hasLogo, hasUnwind, T, lang);
  const layers = [T.ly.cut, T.ly.bleed, T.ly.safe, T.ly.labels, T.ly.notes];
  const bytes = buildPdf({ title: fileName.replace(/\.pdf$/, ""), pages: [page], layers, jpegs });
  const url = URL.createObjectURL(new Blob([bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer], { type: "application/pdf" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

