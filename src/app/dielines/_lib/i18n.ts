// Dielines' own strings, EN and ES. Kept beside the app rather than in the
// shared dict.ts (Master's file), the same way Yields does it. Every key exists
// in both languages -- the `satisfies` on `es` makes a missing key a type
// error, which is the parity check.

import type { Lang } from "@/lib/i18n/dict";

const en = {
  eyebrow: "PharmaCenter · Dielines",
  title: "Sachet Dieline Builder",
  lede: "Pick the size, notch and unwind position. The film and the finished sachet redraw to scale from the house rules.",

  width: "Sachet width",
  widthTooling: "tooling",
  widthHint: "Finished width. The tooling (film width, flat) is twice this.",
  length: "Length",
  lengthHint: "2.5 to 4.5 in. Length is the finished height.",
  standards: "Standards",
  notch: "Tear notch",
  notchNone: "None",
  notchHorizontal: "Horizontal",
  notchVertical: "Vertical",
  notchSlit: "Slit",
  notchTriangle: "Triangle",
  notchHintNone: "No notch.",
  notchHintSlit: "Tears across. 4 mm slit on the right edge, 4.5 mm below the top seal.",
  notchHintTriangle: "Tears upward. 1.5 mm triangle on the bottom edge of the front.",
  offset: "Triangle position",
  offsetHint: "From the inside of the right seal to the tip. 2 to 17 mm, standard 4.5.",
  unwind: "Unwind position",
  unwindHint1: "Top of the art comes off the roll first.",
  unwindHint2: "Bottom of the art comes off the roll first.",
  unwindHint3: "Right side of the art comes off the roll first.",
  unwindHint4: "Left side of the art comes off the roll first.",
  unwindNote: "Only the copy turns. The film, seals, eye mark and notch stay where they are.",
  position: "Position {n}",

  flat: "Film laid flat",
  finished: "Finished sachet",
  back: "Back",
  front: "Front",
  fold: "Fold",
  offRoll: "Off the roll",
  clear: "Clear area",

  lgCut: "Cut line",
  lgNotch: "Notch",
  lgTear: "Tear line",
  lgFold: "Fold",
  lgSeal: "Seal 6 mm",
  lgMark: "Eye mark 6 × 6 mm",
  lgClear: "Clear area",
  lgBleed: "Bleed 1 mm",
  lgLead: "Direction off the roll",

  sFinished: "Finished",
  sFilm: "Film",
  sClear: "Clear area, each panel",
  sSeals: "Seals",
  sSealsV: "6 mm, 3 sides; fold has none",
  sBleed: "Bleed",
  sEye: "Eye mark",
  sEyeV: "6 × 6 mm, top-left, 6 mm high-contrast lane",
  sNotch: "Notch",
  sNotchNone: "None",
  sNotchSlit: "Slit 4 mm, right edge, 10.5 mm from top",
  sNotchTriangle: "Triangle 1.5 mm, bottom of front, tip {o} mm from seal",
  sUnwind: "Unwind",

  foot: "Drawn to scale from the house rules. A preview for checking the layout; it is not yet a print file.",
};

export type DKey = keyof typeof en;

const es = {
  eyebrow: "PharmaCenter · Troqueles",
  title: "Constructor de troqueles de sachet",
  lede: "Elija el tamaño, la muesca y la posición de desenrollado. La película y el sachet terminado se redibujan a escala según las reglas de la casa.",

  width: "Ancho del sachet",
  widthTooling: "herramental",
  widthHint: "Ancho terminado. El herramental (ancho de la película extendida) es el doble.",
  length: "Largo",
  lengthHint: "2.5 a 4.5 in. El largo es la altura terminada.",
  standards: "Estándar",
  notch: "Muesca de apertura",
  notchNone: "Ninguna",
  notchHorizontal: "Horizontal",
  notchVertical: "Vertical",
  notchSlit: "Corte",
  notchTriangle: "Triángulo",
  notchHintNone: "Sin muesca.",
  notchHintSlit: "Se rasga de lado a lado. Corte de 4 mm en el borde derecho, 4.5 mm bajo el sello superior.",
  notchHintTriangle: "Se rasga hacia arriba. Triángulo de 1.5 mm en el borde inferior del frente.",
  offset: "Posición del triángulo",
  offsetHint: "Desde el interior del sello derecho hasta la punta. 2 a 17 mm, estándar 4.5.",
  unwind: "Posición de desenrollado",
  unwindHint1: "La parte superior del arte sale primero del rollo.",
  unwindHint2: "La parte inferior del arte sale primero del rollo.",
  unwindHint3: "El lado derecho del arte sale primero del rollo.",
  unwindHint4: "El lado izquierdo del arte sale primero del rollo.",
  unwindNote: "Solo gira el texto del arte. La película, los sellos, la marca de fotocelda y la muesca no se mueven.",
  position: "Posición {n}",

  flat: "Película extendida",
  finished: "Sachet terminado",
  back: "Reverso",
  front: "Frente",
  fold: "Pliegue",
  offRoll: "Salida del rollo",
  clear: "Área libre",

  lgCut: "Línea de corte",
  lgNotch: "Muesca",
  lgTear: "Línea de rasgado",
  lgFold: "Pliegue",
  lgSeal: "Sello 6 mm",
  lgMark: "Marca de fotocelda 6 × 6 mm",
  lgClear: "Área libre",
  lgBleed: "Sangrado 1 mm",
  lgLead: "Dirección de salida del rollo",

  sFinished: "Terminado",
  sFilm: "Película",
  sClear: "Área libre, cada panel",
  sSeals: "Sellos",
  sSealsV: "6 mm, 3 lados; el pliegue no lleva",
  sBleed: "Sangrado",
  sEye: "Marca de fotocelda",
  sEyeV: "6 × 6 mm, arriba a la izquierda, carril de 6 mm con alto contraste",
  sNotch: "Muesca",
  sNotchNone: "Ninguna",
  sNotchSlit: "Corte 4 mm, borde derecho, 10.5 mm desde arriba",
  sNotchTriangle: "Triángulo 1.5 mm, inferior del frente, punta a {o} mm del sello",
  sUnwind: "Desenrollado",

  foot: "Dibujado a escala según las reglas de la casa. Es una vista previa para revisar el diseño; todavía no es un archivo de impresión.",
} satisfies Record<DKey, string>;

export type DT = (key: DKey, vars?: Record<string, string | number>) => string;

export function makeDT(lang: Lang): DT {
  const dict: Record<DKey, string> = lang === "es" ? es : en;
  return (key, vars) => {
    let out = dict[key] ?? en[key] ?? key;
    if (vars) for (const [k, v] of Object.entries(vars)) out = out.replace(`{${k}}`, String(v));
    return out;
  };
}
