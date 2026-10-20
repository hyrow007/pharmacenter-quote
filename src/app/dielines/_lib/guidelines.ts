// Artwork guidelines for sachet film -- one list, shown on the builder page and
// printed in the dieline PDF, so the two can never say different things.
// These are the mistakes that stop a run on the machine.

import type { Lang } from "@/lib/i18n/dict";
import type { SachetSpec } from "./sachet";

export type Guideline = { title: string; text: string };

export function artworkGuidelines(spec: SachetSpec, lang: Lang): Guideline[] {
  const seal = spec.hangHole
    ? lang === "es" ? "6 mm, y 20 mm arriba" : "6 mm, and 20 mm at the top"
    : "6 mm";
  if (lang === "es") {
    return [
      { title: "Carril de la marca", text: "Mantenga el carril de 6 mm del borde izquierdo de un solo color sólido, en todo el largo: sin imágenes, texto ni degradados." },
      { title: "Contraste", text: "La marca debe resaltar claramente sobre su carril. En un carril claro use una marca negra; en un carril oscuro, una blanca." },
      { title: "Marca de fotocelda", text: "La marca en el archivo es negra. Cámbiela a blanca si el carril es oscuro; conserve su tamaño y posición." },
      { title: `Sellos (${seal})`, text: "Sin texto, códigos de barras, logotipos ni detalles finos. Las mordazas aplastan y deforman la impresión ahí; el color de fondo liso sí puede pasar." },
      { title: "Área libre", text: "Mantenga todo el texto y los gráficos importantes dentro del área libre." },
      { title: "Sangrado", text: "Extienda el color de fondo y las imágenes 1 mm más allá de la línea de corte." },
      { title: "Capas Dieline", text: "Las líneas en el color directo \"Dieline\" no se imprimen. Oculte o borre esas capas antes de enviar el arte; conserve la marca de fotocelda." },
    ];
  }
  return [
    { title: "Eye mark lane", text: "Keep the 6 mm lane down the left edge one solid color, full length -- no images, text or gradients." },
    { title: "Contrast", text: "The eye mark must stand out clearly from its lane. On a light lane use a black mark; on a dark lane use a white one." },
    { title: "Eye mark", text: "The eye mark in the file is black. Change it to white if your lane is dark; keep its size and position." },
    { title: `Seals (${seal})`, text: "No text, barcodes, logos or fine detail. The seal jaws crush and distort print there; plain background color may run through." },
    { title: "Clear area", text: "Keep all text and important graphics inside the clear area." },
    { title: "Bleed", text: "Run background color and images 1 mm past the cut line." },
    { title: "Dieline layers", text: "Lines in the spot color \"Dieline\" do not print. Hide or delete those layers before sending art to print; keep the eye mark." },
  ];
}

/** Bottle labels -- the same idea, for a plain wrap-around label. */
export function labelGuidelines(cornerR: number, lang: Lang): Guideline[] {
  const r = String(Math.round(cornerR * 100) / 100);
  if (lang === "es") {
    return [
      { title: "Zona segura de texto", text: "Mantenga todo el texto, los códigos de barras y los gráficos importantes dentro de la zona segura, a 1.5 mm del corte." },
      { title: "Sangrado", text: "Extienda el color de fondo y las imágenes 1 mm más allá de la línea de corte." },
      { title: `Esquinas (radio ${r} mm)`, text: "La etiqueta se corta con esquinas redondeadas; no coloque detalles importantes en las esquinas." },
      { title: "Capas Dieline", text: "Las líneas en el color directo \"Dieline\" no se imprimen. Oculte o borre esas capas antes de enviar el arte." },
    ];
  }
  return [
    { title: "Text safe zone", text: "Keep all text, barcodes and important graphics inside the text safe zone, 1.5 mm in from the cut." },
    { title: "Bleed", text: "Run background color and images 1 mm past the cut line." },
    { title: `Corners (${r} mm radius)`, text: "The label is cut with rounded corners; keep important detail out of the corners." },
    { title: "Dieline layers", text: "Lines in the spot color \"Dieline\" do not print. Hide or delete those layers before sending art to print." },
  ];
}
