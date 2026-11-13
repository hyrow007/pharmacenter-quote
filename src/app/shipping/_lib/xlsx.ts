// Minimal .xlsx reader for the browser: first worksheet → rows of strings.
// No dependency: an .xlsx is a zip of XML, and the browser can inflate it
// (DecompressionStream "deflate-raw") and parse it (DOMParser). Enough for
// fedex.com's Ship Manager shipment report; not a general spreadsheet library
// (no formulas, dates come through as whatever text/number the cell holds).

type Entry = { name: string; method: number; compSize: number; offset: number };

function entries(buf: ArrayBuffer): Entry[] {
  const v = new DataView(buf);
  // End of central directory: scan back for its signature.
  let eocd = -1;
  for (let i = buf.byteLength - 22; i >= Math.max(0, buf.byteLength - 66000); i--) {
    if (v.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("not_zip");
  const count = v.getUint16(eocd + 10, true);
  let p = v.getUint32(eocd + 16, true);
  const dec = new TextDecoder();
  const out: Entry[] = [];
  for (let n = 0; n < count; n++) {
    if (v.getUint32(p, true) !== 0x02014b50) throw new Error("not_zip");
    const method = v.getUint16(p + 10, true);
    const compSize = v.getUint32(p + 20, true);
    const nameLen = v.getUint16(p + 28, true);
    const extraLen = v.getUint16(p + 30, true);
    const commentLen = v.getUint16(p + 32, true);
    const offset = v.getUint32(p + 42, true);
    const name = dec.decode(new Uint8Array(buf, p + 46, nameLen));
    out.push({ name, method, compSize, offset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

async function read(buf: ArrayBuffer, e: Entry): Promise<string> {
  const v = new DataView(buf);
  const nameLen = v.getUint16(e.offset + 26, true);
  const extraLen = v.getUint16(e.offset + 28, true);
  const start = e.offset + 30 + nameLen + extraLen;
  const data = new Uint8Array(buf, start, e.compSize);
  if (e.method === 0) return new TextDecoder().decode(data);
  if (e.method !== 8) throw new Error("unsupported_zip");
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return await new Response(stream).text();
}

function colIndex(ref: string): number {
  const letters = ref.replace(/\d+$/, "");
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

export async function readXlsxRows(buf: ArrayBuffer): Promise<string[][]> {
  const list = entries(buf);
  const find = (re: RegExp) => list.find((x) => re.test(x.name));
  const sheetEntry = find(/^xl\/worksheets\/sheet1\.xml$/) ?? find(/^xl\/worksheets\/[^/]+\.xml$/);
  if (!sheetEntry) throw new Error("not_xlsx");
  const parser = new DOMParser();
  const shared: string[] = [];
  const ssEntry = find(/^xl\/sharedStrings\.xml$/);
  if (ssEntry) {
    const doc = parser.parseFromString(await read(buf, ssEntry), "application/xml");
    for (const si of Array.from(doc.getElementsByTagName("si"))) {
      shared.push(Array.from(si.getElementsByTagName("t")).map((t) => t.textContent ?? "").join(""));
    }
  }
  const doc = parser.parseFromString(await read(buf, sheetEntry), "application/xml");
  const rows: string[][] = [];
  for (const row of Array.from(doc.getElementsByTagName("row"))) {
    const out: string[] = [];
    for (const c of Array.from(row.getElementsByTagName("c"))) {
      const ref = c.getAttribute("r");
      const i = ref ? colIndex(ref) : out.length;
      const type = c.getAttribute("t");
      let val = "";
      if (type === "s") val = shared[Number(c.getElementsByTagName("v")[0]?.textContent ?? -1)] ?? "";
      else if (type === "inlineStr") val = Array.from(c.getElementsByTagName("t")).map((t) => t.textContent ?? "").join("");
      else val = c.getElementsByTagName("v")[0]?.textContent ?? "";
      while (out.length < i) out.push("");
      out[i] = val;
    }
    rows.push(out);
  }
  return rows;
}
