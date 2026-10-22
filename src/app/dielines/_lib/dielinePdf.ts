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
  stampBox,
  captionsY,
  STAMP_MAX_CHARS,
  type SachetSpec,
} from "./sachet";
import { BLACK, DIELINE, PageCanvas, buildPdf, gray, hex, textWidth } from "./pdf";
import { artworkGuidelines } from "./guidelines";

// House brand, as on every PharmaCenter app (globals.css).
const TEAL = hex("#0f4a56");
const TEAL_2 = hex("#1d6c7b");
const SAGE = hex("#7fb04f");
const LOGO_RATIO = 991 / 252; // public/logo.png, width / height

const NOTCH_CODE = { none: "NoNotch", slit: "HSlit", triangle: "VTri" } as const;
type PdfLang = "en" | "es";

/** Every word the PDF prints, in both languages. The file follows the
 *  builder's language; the spot color stays "Dieline" in both, because that
 *  is its name in the file. */
const TX = {
  en: {
    ly: {
      notes: "Notes", cut: "Cut line", bleed: "Bleed", fold: "Fold", seals: "Seals", clear: "Clear area",
      lane: "Eye mark lane", notch: "Notch & hang hole", labels: "Labels & dimensions", eye: "Eye mark (keep)", ref: "Reference",
      stamp: "Hot stamp area",
    },
    stampTag: "LOT / EXP (HOT STAMP)",
    rStamp: "Hot stamp",
    stampV: (n: number, w: string, h: string, std: boolean, white: boolean) =>
      `${white ? "White" : "Black"} foil, LOT / EXP, ${n} line${n > 1 ? "s" : ""} of up to ${STAMP_MAX_CHARS} characters; area ${w} x ${h} mm, ${std ? "back panel, just above the bottom seal" : "as placed on the dieline"}`,
    back: "BACK", front: "FRONT", clearArea: "CLEAR AREA", foldUp: "FOLD", film: "FILM", offRoll: "OFF THE ROLL", slit: "SLIT",
    title: "Sachet dieline",
    none: "None",
    notchSlit: (y: string) => `Horizontal tear: slit ${SLIT_LEN} mm, right edge, ${y} from top`,
    notchTri: (o: string) => `Vertical tear: triangle ${TRI_W} mm, bottom of front, tip ${o} in from the right seal`,
    rFinished: "Finished size", rFilm: "Film (flat)", rConstruction: "Construction", rSeals: "Seals",
    rClear: "Clear area (each panel)", rBleed: "Bleed", rEye: "Eye mark", rNotch: "Notch", rHang: "Hang hole", rUnwind: "Unwind",
    wxh: "(W x H)",
    construction: "3-side seal; folded at center; left panel = back, right panel = front",
    sealsHang: "Top 20 mm; sides and bottom 6 mm; fold has none",
    seals: "6 mm top, bottom and outer side; fold has none",
    eye: "6 x 6 mm, top-left, on a 6 mm solid high-contrast lane down the left edge",
    hang: `${HANG_HOLE_D} mm diameter, centered in the top seal`,
    position: (n: number) => `Position ${n}`,
    unwind: {
      1: "Top of the art comes off the roll first",
      2: "Bottom of the art comes off the roll first",
      3: "Right side of the art comes off the roll first",
      4: "Left side of the art comes off the roll first",
    },
    guidelines: "Artwork guidelines",
    unwindPos: (n: number) => `Unwind position ${n}`,
    flatTitle: "Film laid flat",
    finishedTitle: "Finished sachet",
    refOnly: "Reference only",
    refNote: "As drawn in the PharmaCenter dieline builder. Use page 1 for artwork.",
    generated: (d: string) => `Generated ${d} by the PharmaCenter dieline builder`,
    lg: {
      cut: "Cut line", notch: "Notch", tear: "Tear line", hole: "Hang hole 6 mm", fold: "Fold", foldEdge: "Fold",
      seal: "Seal 6 mm", mark: "Eye mark 6 × 6 mm", clear: "Clear area", bleed: "Bleed 1 mm",
      stamp: "Hot stamp (LOT / EXP)",
    },
  },
  es: {
    ly: {
      notes: "Notas", cut: "Línea de corte", bleed: "Sangrado", fold: "Pliegue", seals: "Sellos", clear: "Área libre",
      lane: "Carril de la marca", notch: "Muesca y orificio", labels: "Etiquetas y medidas", eye: "Marca de fotocelda (conservar)", ref: "Referencia",
      stamp: "Área de estampado en caliente",
    },
    stampTag: "LOTE / VENC. (ESTAMPADO)",
    rStamp: "Estampado en caliente",
    stampV: (n: number, w: string, h: string, std: boolean, white: boolean) =>
      `Foil ${white ? "blanco" : "negro"}, LOTE / VENC., ${n} línea${n > 1 ? "s" : ""} de hasta ${STAMP_MAX_CHARS} caracteres; área de ${w} x ${h} mm, ${std ? "reverso, justo arriba del sello inferior" : "según se ubica en el troquel"}`,
    back: "REVERSO", front: "FRENTE", clearArea: "ÁREA LIBRE", foldUp: "PLIEGUE", film: "PELÍCULA", offRoll: "SALIDA DEL ROLLO", slit: "CORTE",
    title: "Troquel de sachet",
    none: "Ninguno",
    notchSlit: (y: string) => `Rasgado horizontal: corte de ${SLIT_LEN} mm, borde derecho, a ${y} desde arriba`,
    notchTri: (o: string) => `Rasgado vertical: triángulo de ${TRI_W} mm, abajo en el frente, punta a ${o} del sello derecho`,
    rFinished: "Tamaño terminado", rFilm: "Película (extendida)", rConstruction: "Construcción", rSeals: "Sellos",
    rClear: "Área libre (cada panel)", rBleed: "Sangrado", rEye: "Marca de fotocelda", rNotch: "Muesca", rHang: "Orificio para colgar", rUnwind: "Desenrollado",
    wxh: "(ancho x alto)",
    construction: "Sellado en 3 lados; doblado al centro; panel izquierdo = reverso, panel derecho = frente",
    sealsHang: "Superior 20 mm; lados e inferior 6 mm; el pliegue no lleva",
    seals: "6 mm arriba, abajo y en el lado exterior; el pliegue no lleva",
    eye: "6 x 6 mm, arriba a la izquierda, en un carril sólido de 6 mm de alto contraste",
    hang: `${HANG_HOLE_D} mm de diámetro, centrado en el sello superior`,
    position: (n: number) => `Posición ${n}`,
    unwind: {
      1: "La parte superior del arte sale primero del rollo",
      2: "La parte inferior del arte sale primero del rollo",
      3: "El lado derecho del arte sale primero del rollo",
      4: "El lado izquierdo del arte sale primero del rollo",
    },
    guidelines: "Guía para el arte",
    unwindPos: (n: number) => `Posición de desenrollado ${n}`,
    flatTitle: "Película extendida",
    finishedTitle: "Sachet terminado",
    refOnly: "Solo referencia",
    refNote: "Tal como se dibuja en el constructor de troqueles de PharmaCenter. Use la página 1 para el arte.",
    generated: (d: string) => `Generado el ${d} por el constructor de troqueles de PharmaCenter`,
    lg: {
      cut: "Línea de corte", notch: "Muesca", tear: "Línea de rasgado", hole: "Orificio 6 mm", fold: "Pliegue", foldEdge: "Pliegue",
      seal: "Sello 6 mm", mark: "Marca de fotocelda 6 × 6 mm", clear: "Área libre", bleed: "Sangrado 1 mm",
      stamp: "Estampado (LOTE / VENC.)",
    },
  },
};
type Tx = (typeof TX)["en"];
const layerOrder = (T: Tx) => [T.ly.eye, T.ly.cut, T.ly.bleed, T.ly.fold, T.ly.seals, T.ly.clear, T.ly.lane, T.ly.notch, T.ly.stamp, T.ly.labels, T.ly.notes, T.ly.ref];

export function dielineFileName(spec: SachetSpec) {
  const d = dims(spec);
  const w = (d.panelW / 25.4).toFixed(2);
  const h = spec.lengthIn.toFixed(2);
  return `PharmaCenter-Sachet-${w}x${h}-${NOTCH_CODE[spec.notch]}${spec.hangHole ? "-HangHole" : ""}${spec.stamp ? "-LotExp" : ""}.pdf`;
}

const mm = (v: number) => `${(Math.round(v * 10) / 10).toFixed(1)} mm`;
const inMm = (v: number) => `${inches(v)} (${mm(v)})`;

/** Page 1: the dieline. Returns the page; the unwind picture is drawn as "Unwind". */
function dielinePage(spec: SachetSpec, today: string, hasUnwindImage: boolean, hasLogo: boolean, T: Tx, lang: PdfLang) {
  const d = dims(spec);
  const W = d.filmW, H = d.height, half = d.panelW, top = d.topSeal;
  const ox = 22, oy = 30; // film origin on the page
  const notesTop = oy + H + 20;
  const pageW = Math.max(ox + W + 30, 200);
  const pageH = notesTop + 122 + (spec.stamp ? 12 : 0);
  const p = new PageCanvas(pageW, pageH);
  const X = (x: number) => ox + x;
  const Y = (y: number) => oy + y;
  const hair = 0.1; // ~0.28 pt
  const fine = 0.18;

  // ---- art-area layers, all in the Dieline spot color ----
  p.layer(T.ly.bleed, () => {
    p.rect(X(-BLEED), Y(-BLEED), W + 2 * BLEED, H + 2 * BLEED, { stroke: DIELINE, width: hair, dash: [1, 0.7] });
  });
  p.layer(T.ly.seals, () => {
    const s = { stroke: { kind: "spot", tint: 0.6 } as const, width: hair, dash: [0.6, 0.6] };
    p.line(X(0), Y(top), X(W), Y(top), s);
    p.line(X(0), Y(H - SEAL), X(W), Y(H - SEAL), s);
    p.line(X(W - SEAL), Y(0), X(W - SEAL), Y(H), s);
  });
  p.layer(T.ly.lane, () => {
    p.rect(X(0), Y(0), EYE, H, { stroke: { kind: "spot", tint: 0.6 }, width: hair, dash: [0.6, 0.6] });
  });
  p.layer(T.ly.clear, () => {
    const c = { stroke: { kind: "spot", tint: 0.45 } as const, width: hair, dash: [0.3, 0.6] };
    p.rect(X(SEAL), Y(top), d.clearW, d.clearH, c);
    p.rect(X(half), Y(top), d.clearW, d.clearH, c);
  });
  p.layer(T.ly.fold, () => {
    p.line(X(half), Y(-4), X(half), Y(H + 4), { stroke: DIELINE, width: fine, dash: [3, 1, 0.6, 1] });
  });
  p.layer(T.ly.notch, () => {
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
  p.layer(T.ly.cut, () => {
    p.rect(X(0), Y(0), W, H, { stroke: DIELINE, width: fine });
  });
  p.layer(T.ly.labels, () => {
    const t = { color: DIELINE, size: 2.2 };
    const tb = { color: DIELINE, size: 3.2, font: "bold" as const, align: "center" as const };
    p.text(X(half / 2 + SEAL / 2), Y(top + 6), T.back, tb);
    p.text(X(half * 1.5 - SEAL / 2), Y(top + 6), T.front, tb);
    const clear = `${T.clearArea} ${inches(d.clearW)} x ${inches(d.clearH)}`;
    p.text(X(half / 2 + SEAL / 2), Y(captionsY(spec, H - SEAL - 2)), clear, { ...t, size: 1.8, align: "center" });
    p.text(X(half * 1.5 - SEAL / 2), Y(captionsY(spec, H - SEAL - 2)), clear, { ...t, size: 1.8, align: "center" });
    p.text(X(half), Y(-5), T.foldUp, { ...t, size: 1.8, align: "center" });
    // dimensions above
    const dim = (x1: number, x2: number, y: number, label: string) => {
      p.line(X(x1), Y(y), X(x2), Y(y), { stroke: DIELINE, width: hair });
      p.line(X(x1), Y(y - 1.2), X(x1), Y(y + 1.2), { stroke: DIELINE, width: hair });
      p.line(X(x2), Y(y - 1.2), X(x2), Y(y + 1.2), { stroke: DIELINE, width: hair });
      p.text(X((x1 + x2) / 2), Y(y - 1.2), label, { ...t, align: "center" });
    };
    dim(0, half, -10, inches(half));
    dim(half, W, -10, inches(half));
    dim(0, W, -18, `${T.film} ${inMm(W)}`);
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
    p.text(X(ax + 4.5), Y(H + 7.6), T.offRoll, { ...t });
    if (spec.notch === "slit") p.text(X(W + 1.5), Y(slitY(spec) + 0.8), T.slit, { ...t, size: 1.6 });
  });

  // ---- hot stamp area (LOT / EXP), stamped at PharmaCenter after printing ----
  const sb = stampBox(spec);
  if (sb) {
    p.layer(T.ly.stamp, () => {
      p.rect(X(sb.x), Y(sb.y), sb.w, sb.h, { stroke: DIELINE, width: 0.18, dash: [0.8, 0.5] });
      p.text(X(sb.x + sb.w / 2), Y(sb.y + sb.h / 2 + 0.6), T.stampTag, { color: DIELINE, size: 1.5, align: "center" });
    });
  }

  // ---- the one printing element: the eye mark ----
  p.layer(T.ly.eye, () => {
    p.rect(X(0), Y(0), EYE, EYE, { fill: BLACK });
  });

  // ---- notes block, below the art ----
  p.layer(T.ly.notes, () => {
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
    p.text(tx, y + 1, T.title, { color: TEAL, size: 4.6, font: "bold" });
    p.rect(tx, y + 2.6, 14, 0.6, { fill: SAGE });
    p.text(pageW - 12, y + 1, today, { color: soft, size: 2.6, align: "right" });
    y += 10;
    const notchText =
      spec.notch === "slit"
        ? T.notchSlit(mm(slitY(spec)))
        : spec.notch === "triangle"
          ? T.notchTri(mm(spec.triangleOffsetMm))
          : T.none;
    const rows: [string, string][] = [
      [T.rFinished, `${inches(d.panelW)} x ${inches(H)} ${T.wxh}`],
      [T.rFilm, `${inMm(W)} x ${inMm(H)}`],
      [T.rConstruction, T.construction],
      [T.rSeals, spec.hangHole ? T.sealsHang : T.seals],
      [T.rClear, `${inches(d.clearW)} x ${inches(d.clearH)}`],
      [T.rBleed, `${BLEED} mm`],
      [T.rEye, T.eye],
      [T.rNotch, notchText],
      [T.rHang, spec.hangHole ? T.hang : T.none],
      [T.rStamp, sb ? T.stampV(spec.stampLines, String(sb.w), String(Math.round(sb.h * 10) / 10), spec.stampPos === null, spec.stampColor === "white") : T.none],
      [T.rUnwind, `${T.position(spec.unwind)} -- ${T.unwind[spec.unwind]}`],
    ];
    for (const [k, v] of rows) {
      p.text(ox, y, k, { color: TEAL_2, size: 2.5 });
      p.text(ox + 42, y, v, { color: ink, size: 2.5 });
      y += 4.1;
    }
    // Artwork guidelines -- the mistakes that stop a run on the machine.
    y += 4;
    p.text(ox, y, T.guidelines, { color: TEAL, size: 3.2, font: "bold" });
    p.rect(ox, y + 1.4, 10, 0.5, { fill: SAGE });
    y += 6;
    const gs = 2.3;
    const maxW = pageW - 12 - (ox + 3.5);
    for (const g of artworkGuidelines(spec, lang)) {
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
      const iw = 34, ih = iw * (700 / 960);
      p.image("Unwind", pageW - 12 - iw, notesTop + 9, iw, ih);
      p.text(pageW - 12 - iw / 2, notesTop + 11 + ih + 2, T.unwindPos(spec.unwind), { color: TEAL, size: 2.4, font: "bold", align: "center" });
    }
    footer(p, dielineFileName(spec), today, T);
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
  stamp: hex("#5b4b9a"),
  stampFill: hex("#efeaf7"),
};

type LegendKey = "cut" | "notch" | "tear" | "hole" | "fold" | "foldEdge" | "seal" | "mark" | "clear" | "bleed" | "stamp";
/** Which keys each drawing carries -- only what that drawing actually shows. */
export function legendKeys(spec: SachetSpec, view: "flat" | "finished"): LegendKey[] {
  const notch: LegendKey[] = spec.notch !== "none" ? ["notch"] : [];
  const hole: LegendKey[] = spec.hangHole ? ["hole"] : [];
  const stamp: LegendKey[] = spec.stamp ? ["stamp"] : [];
  if (view === "flat") return ["cut", ...notch, ...hole, "fold", "seal", "mark", "clear", ...stamp, "bleed"];
  return ["cut", ...notch, ...(spec.notch !== "none" ? (["tear"] as LegendKey[]) : []), ...hole, "foldEdge", "seal", "mark", "clear", ...stamp];
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
    case "stamp": p.rect(x, y, w, h, { stroke: SW.stamp, fill: SW.stampFill, width: 0.25, dash: [0.8, 0.5] }); break;
  }
}

/** A single centered row of keys with its baseline near y. */
function legendRow(p: PageCanvas, keys: LegendKey[], spec: SachetSpec, y: number, T: Tx) {
  const size = 2.8, swW = 6, gap = 1.8, between = 5.5;
  const widths = keys.map((k) => swW + gap + textWidth(T.lg[k], size, "regular"));
  const total = widths.reduce((a, b) => a + b, 0) + between * (keys.length - 1);
  let x = (p.widthMm - total) / 2;
  keys.forEach((k, i) => {
    swatch(p, k, spec, x, y - 2.9);
    p.text(x + swW + gap, y, T.lg[k], { color: gray(0.4), size });
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
  T: Tx,
) {
  const pageW = 279.4, pageH = 215.9; // US Letter, landscape
  const p = new PageCanvas(pageW, pageH);
  p.layer(T.ly.ref, () => {
    let tx = 18;
    if (hasLogo) {
      const lh = 9;
      p.image("Logo", 18, 11, lh * LOGO_RATIO, lh);
      tx = 18 + lh * LOGO_RATIO + 6;
    }
    p.text(tx, 18, title, { color: TEAL, size: 5.2, font: "bold" });
    p.rect(tx, 20, 16, 0.7, { fill: SAGE });
    p.text(pageW - 18, 18, T.refOnly, { color: TEAL_2, size: 2.8, font: "bold", align: "right" });
    p.rect(18, 25, pageW - 36, 0.7, { fill: TEAL });
    p.text(18, 31, T.refNote, { color: gray(0.45), size: 2.6 });
    const maxW = pageW - 36, maxH = pageH - 70; // room below for the legend
    const s = Math.min(maxW / img.width, maxH / img.height);
    const w = img.width * s, h = img.height * s;
    p.image(img.name, (pageW - w) / 2, 38 + (maxH - h) / 2, w, h);
    legendRow(p, keys, spec, pageH - 21, T);
    footer(p, fileName, today, T);
  });
  return p;
}

/** Thin teal rule and a quiet line naming the file, on every page. */
function footer(p: PageCanvas, fileName: string, today: string, T: Tx) {
  const y = p.heightMm - 9;
  p.rect(18, y - 4, p.widthMm - 36, 0.3, { fill: TEAL });
  p.text(18, y, `PharmaCenter  ·  ${fileName.replace(/\.pdf$/, "")}`, { color: TEAL_2, size: 2.2 });
  p.text(p.widthMm - 18, y, T.generated(today), { color: gray(0.5), size: 2.2, align: "right" });
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

export function loadImage(src: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Could not load ${src}`));
    img.src = src;
  });
}

export async function toJpeg(img: CanvasImageSource, w: number, h: number) {
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
export async function downloadDieline(
  spec: SachetSpec,
  views: { flat: SVGSVGElement | null; finished: SVGSVGElement | null },
  lang: PdfLang = "en",
) {
  const T = TX[lang];
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
  const pages = [dielinePage(spec, today, hasUnwind, hasLogo, T, lang)];
  if (flatSnap) {
    const j = await svgToJpeg(flatSnap, 2600);
    jpegs.push({ name: "RefFlat", ...j });
    pages.push(referencePage(T.flatTitle, { name: "RefFlat", ...j }, hasLogo, fileName, today, spec, legendKeys(spec, "flat"), T));
  }
  if (finishedSnap) {
    const j = await svgToJpeg(finishedSnap, 2600);
    jpegs.push({ name: "RefFinished", ...j });
    pages.push(referencePage(T.finishedTitle, { name: "RefFinished", ...j }, hasLogo, fileName, today, spec, legendKeys(spec, "finished"), T));
  }

  const bytes = buildPdf({ title: dielineFileName(spec).replace(/\.pdf$/, ""), pages, layers: layerOrder(T), jpegs });
  const url = URL.createObjectURL(new Blob([bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer], { type: "application/pdf" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = dielineFileName(spec);
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
