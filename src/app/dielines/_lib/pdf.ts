// A tiny PDF writer -- just enough for a print dieline, with no dependency.
//
// What it supports, because a dieline needs it:
//   * layers (Optional Content Groups), so the file opens in Acrobat with the
//     Cut line, Fold, Bleed... toggleable
//   * a named spot colour ("Dieline") with overprint, the convention printers
//     use for non-printing technical lines
//   * the 14 standard fonts (Helvetica) with WinAnsi text
//   * JPEG images (DCTDecode) -- the bytes go in as they are
//
// Drawing happens in millimetres with the origin at the TOP-LEFT and y going
// down, like the SVG drawings; the page transform flips it once.

const PT_PER_MM = 72 / 25.4;

// WinAnsi bytes for the handful of non-Latin-1 characters we might write.
const WIN_ANSI: Record<string, number> = { "—": 0x97, "–": 0x96, "…": 0x85, "’": 0x92, "‘": 0x91, "“": 0x93, "”": 0x94, "•": 0x95 };

function latin1(s: string): number[] {
  const out: number[] = [];
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (WIN_ANSI[ch] !== undefined) out.push(WIN_ANSI[ch]);
    else out.push(c < 256 ? c : 0x3f);
  }
  return out;
}

function pdfString(s: string): string {
  // Escaped literal string; bytes above 127 become octal escapes so the whole
  // content stream stays 7-bit text.
  let out = "(";
  for (const b of latin1(s)) {
    if (b === 0x28 || b === 0x29 || b === 0x5c) out += "\\" + String.fromCharCode(b);
    else if (b < 32 || b > 126) out += "\\" + b.toString(8).padStart(3, "0");
    else out += String.fromCharCode(b);
  }
  return out + ")";
}

const n = (v: number) => (Math.round(v * 1000) / 1000).toString();

export type Color =
  | { kind: "spot"; tint: number } // the Dieline spot colour
  | { kind: "gray"; g: number }
  | { kind: "rgb"; r: number; g: number; b: number }
  | { kind: "cmyk"; c: number; m: number; y: number; k: number };

export const DIELINE: Color = { kind: "spot", tint: 1 };
export const BLACK: Color = { kind: "cmyk", c: 0, m: 0, y: 0, k: 1 };
export const gray = (g: number): Color => ({ kind: "gray", g });
export const hex = (h: string): Color => ({
  kind: "rgb",
  r: parseInt(h.slice(1, 3), 16) / 255,
  g: parseInt(h.slice(3, 5), 16) / 255,
  b: parseInt(h.slice(5, 7), 16) / 255,
});

export type Font = "regular" | "bold";

/** One page's drawing commands, in mm, top-left origin. */
export class PageCanvas {
  ops: string[] = [];
  images = new Set<string>();
  layersUsed = new Set<string>();
  constructor(public widthMm: number, public heightMm: number) {}

  private stroke(c: Color) {
    if (c.kind === "spot") return `/CSd CS ${n(c.tint)} SCN /GSo gs`;
    if (c.kind === "gray") return `${n(c.g)} G /GSn gs`;
    if (c.kind === "rgb") return `${n(c.r)} ${n(c.g)} ${n(c.b)} RG /GSn gs`;
    return `${n(c.c)} ${n(c.m)} ${n(c.y)} ${n(c.k)} K /GSn gs`;
  }
  private fill(c: Color) {
    if (c.kind === "spot") return `/CSd cs ${n(c.tint)} scn /GSo gs`;
    if (c.kind === "gray") return `${n(c.g)} g /GSn gs`;
    if (c.kind === "rgb") return `${n(c.r)} ${n(c.g)} ${n(c.b)} rg /GSn gs`;
    return `${n(c.c)} ${n(c.m)} ${n(c.y)} ${n(c.k)} k /GSn gs`;
  }

  /** Everything drawn inside `fn` belongs to the named layer. */
  layer(name: string, fn: () => void) {
    this.layersUsed.add(name);
    this.ops.push(`/OC /${layerKey(name)} BDC`);
    fn();
    this.ops.push("EMC");
  }

  rect(x: number, y: number, w: number, h: number, o: { stroke?: Color; fill?: Color; width?: number; dash?: number[] }) {
    this.path(`${n(x)} ${n(y)} ${n(w)} ${n(h)} re`, o);
  }
  line(x1: number, y1: number, x2: number, y2: number, o: { stroke: Color; width?: number; dash?: number[]; cap?: 0 | 1 | 2 }) {
    this.path(`${n(x1)} ${n(y1)} m ${n(x2)} ${n(y2)} l`, o);
  }
  poly(points: [number, number][], o: { stroke?: Color; fill?: Color; width?: number; close?: boolean }) {
    const [first, ...rest] = points;
    let d = `${n(first[0])} ${n(first[1])} m`;
    for (const p of rest) d += ` ${n(p[0])} ${n(p[1])} l`;
    if (o.close !== false) d += " h";
    this.path(d, o);
  }
  circle(cx: number, cy: number, r: number, o: { stroke?: Color; fill?: Color; width?: number }) {
    const k = 0.5523 * r;
    const d =
      `${n(cx + r)} ${n(cy)} m ` +
      `${n(cx + r)} ${n(cy + k)} ${n(cx + k)} ${n(cy + r)} ${n(cx)} ${n(cy + r)} c ` +
      `${n(cx - k)} ${n(cy + r)} ${n(cx - r)} ${n(cy + k)} ${n(cx - r)} ${n(cy)} c ` +
      `${n(cx - r)} ${n(cy - k)} ${n(cx - k)} ${n(cy - r)} ${n(cx)} ${n(cy - r)} c ` +
      `${n(cx + k)} ${n(cy - r)} ${n(cx + r)} ${n(cy - k)} ${n(cx + r)} ${n(cy)} c h`;
    this.path(d, o);
  }
  private path(d: string, o: { stroke?: Color; fill?: Color; width?: number; dash?: number[]; cap?: 0 | 1 | 2 }) {
    const parts = ["q"];
    if (o.width !== undefined) parts.push(`${n(o.width)} w`);
    parts.push(o.dash && o.dash.length ? `[${o.dash.map(n).join(" ")}] 0 d` : "[] 0 d");
    if (o.cap !== undefined) parts.push(`${o.cap} J`);
    if (o.stroke) parts.push(this.stroke(o.stroke));
    if (o.fill) parts.push(this.fill(o.fill));
    parts.push(d);
    parts.push(o.fill && o.stroke ? "B" : o.fill ? "f" : "S");
    parts.push("Q");
    this.ops.push(parts.join(" "));
  }

  /** Text with its baseline at y. `size` is the cap-ish size in mm. */
  text(x: number, y: number, s: string, o: { size: number; color: Color; font?: Font; align?: "left" | "center" | "right" }) {
    const w = textWidth(s, o.size, o.font ?? "regular");
    const dx = o.align === "center" ? -w / 2 : o.align === "right" ? -w : 0;
    const f = o.font === "bold" ? "F2" : "F1";
    this.ops.push(
      `q ${this.fill(o.color)} BT /${f} 1 Tf ${n(o.size)} 0 0 ${n(-o.size)} ${n(x + dx)} ${n(y)} Tm ${pdfString(s)} Tj ET Q`,
    );
  }

  /** Draw a JPEG registered with buildPdf under `name`. */
  image(name: string, x: number, y: number, w: number, h: number) {
    this.images.add(name);
    this.ops.push(`q ${n(w)} 0 0 ${n(-h)} ${n(x)} ${n(y + h)} cm /${name} Do Q`);
  }
}

// Helvetica / Helvetica-Bold advance widths (Adobe AFM, 1/1000 em) for
// characters 32-126, so centring and wrapping line up exactly.
const HELV = [278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556,1015,667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,667,778,722,667,611,722,667,944,667,667,611,278,278,278,469,556,333,556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,556,556,333,500,278,556,500,722,500,500,500,334,260,334,584];
const HELV_B = [278,333,474,556,556,889,722,238,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,333,333,584,584,584,611,975,722,722,722,722,667,611,778,722,278,556,722,611,833,722,778,667,778,722,667,611,722,667,944,667,667,611,333,278,333,584,556,333,556,611,556,611,556,333,611,611,278,278,556,278,889,611,611,611,611,389,556,333,611,556,778,556,556,500,389,280,389,584];
const WIDE: Record<string, number> = { "×": 584, "·": 278, "—": 1000, "–": 556, "Ø": 778, "°": 400 };

export function textWidth(s: string, size: number, font: Font) {
  const table = font === "bold" ? HELV_B : HELV;
  let w = 0;
  for (const ch of s) {
    const c = ch.charCodeAt(0);
    w += c >= 32 && c <= 126 ? table[c - 32] : (WIDE[ch] ?? 556);
  }
  return (w / 1000) * size;
}

const layerKey = (name: string) => "L" + name.replace(/[^A-Za-z0-9]/g, "");

/** Assemble pages into PDF bytes. `layers` sets the order shown in Acrobat. */
export function buildPdf(opts: {
  title: string;
  pages: PageCanvas[];
  layers: string[];
  jpegs: { name: string; width: number; height: number; bytes: Uint8Array }[];
}): Uint8Array {
  const objects: (Uint8Array | string)[] = []; // index = object number - 1
  const reserve = () => {
    objects.push("");
    return objects.length;
  };
  const set = (id: number, body: string | Uint8Array) => {
    objects[id - 1] = body;
  };

  const catalogId = reserve();
  const pagesId = reserve();
  const fontRegId = reserve();
  const fontBoldId = reserve();
  const tintFnId = reserve();
  const infoId = reserve();

  set(fontRegId, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
  set(fontBoldId, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>");
  // Dieline renders as 100% magenta on screen and in proofs.
  set(tintFnId, "<< /FunctionType 2 /Domain [0 1] /C0 [0 0 0 0] /C1 [0 1 0 0] /N 1 >>");
  set(
    infoId,
    `<< /Title ${pdfString(opts.title)} /Producer (PharmaCenter Dielines) /Creator (dieline.pharmacenter.app) >>`,
  );

  const layerIds = new Map<string, number>();
  for (const name of opts.layers) {
    const id = reserve();
    set(id, `<< /Type /OCG /Name ${pdfString(name)} >>`);
    layerIds.set(name, id);
  }

  const imageIds = new Map<string, number>();
  for (const img of opts.jpegs) {
    const id = reserve();
    imageIds.set(img.name, id);
    const head =
      `<< /Type /XObject /Subtype /Image /Width ${img.width} /Height ${img.height} ` +
      `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${img.bytes.length} >>\nstream\n`;
    set(id, concat([ascii(head), img.bytes, ascii("\nendstream")]));
  }

  const ocProps = Array.from(layerIds.entries())
    .map(([name, id]) => `/${layerKey(name)} ${id} 0 R`)
    .join(" ");
  const pageIds: number[] = [];
  for (const page of opts.pages) {
    const pageId = reserve();
    const contentId = reserve();
    pageIds.push(pageId);
    const wPt = page.widthMm * PT_PER_MM;
    const hPt = page.heightMm * PT_PER_MM;
    // Flip once: mm units, origin top-left.
    const content = `${n(PT_PER_MM)} 0 0 ${n(-PT_PER_MM)} 0 ${n(hPt)} cm 1 j\n` + page.ops.join("\n");
    const bytes = ascii(content);
    set(contentId, concat([ascii(`<< /Length ${bytes.length} >>\nstream\n`), bytes, ascii("\nendstream")]));
    const xobj = Array.from(page.images)
      .map((name) => `/${name} ${imageIds.get(name)} 0 R`)
      .join(" ");
    set(
      pageId,
      `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${n(wPt)} ${n(hPt)}] /Contents ${contentId} 0 R ` +
        `/Resources << /Font << /F1 ${fontRegId} 0 R /F2 ${fontBoldId} 0 R >> ` +
        `/ColorSpace << /CSd [/Separation /Dieline /DeviceCMYK ${tintFnId} 0 R] >> ` +
        `/ExtGState << /GSo << /Type /ExtGState /OP true /op true /OPM 1 >> /GSn << /Type /ExtGState /OP false /op false >> >> ` +
        `/Properties << ${ocProps} >>` +
        (xobj ? ` /XObject << ${xobj} >>` : "") +
        ` >> >>`,
    );
  }
  set(pagesId, `<< /Type /Pages /Kids [${pageIds.map((i) => `${i} 0 R`).join(" ")}] /Count ${pageIds.length} >>`);
  const allLayers = Array.from(layerIds.values()).map((i) => `${i} 0 R`).join(" ");
  set(
    catalogId,
    `<< /Type /Catalog /Pages ${pagesId} 0 R /PageMode /UseOC ` +
      `/OCProperties << /OCGs [${allLayers}] /D << /Name (Layers) /Order [${allLayers}] /ON [${allLayers}] >> >> >>`,
  );

  // Serialise with a correct cross-reference table.
  // Header, then the conventional binary-marker comment line.
  const chunks: Uint8Array[] = [ascii("%PDF-1.6\n"), new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a])];
  let offset = chunks.reduce((s, c) => s + c.length, 0);
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(offset);
    const head = ascii(`${i + 1} 0 obj\n`);
    const b = typeof body === "string" ? ascii(body) : body;
    const tail = ascii("\nendobj\n");
    chunks.push(head, b, tail);
    offset += head.length + b.length + tail.length;
  });
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) xref += `${String(o).padStart(10, "0")} 00000 n \n`;
  xref += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R /Info ${infoId} 0 R >>\nstartxref\n${offset}\n%%EOF\n`;
  chunks.push(ascii(xref));
  return concat(chunks);

  function ascii(s: string) {
    const u = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i) & 0xff;
    return u;
  }
}

function concat(parts: Uint8Array[]) {
  const len = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
