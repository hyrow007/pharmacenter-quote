"use client";

// Packaging Specification Form (Bottles) — inline questionnaire that mirrors
// the PandaDoc form (version 202401) minus everything the workflow already
// captures (company, product name/code, bottle count, dosage type, files).
// Fillable later — nothing here gates Save. A future PandaDoc sync reads the
// saved PackagingSpecBottles object and fills the real form field-for-field.
//
// NOTE ON PICKLISTS: the option lists below are placeholders drawn from the
// printed form + common industry values. Once the PandaDoc connector exposes
// the template we swap them for the exact PandaDoc picklist options (the
// stored ids stay stable — "other" + free text covers anything missing).

import { useState, type CSSProperties } from "react";
import {
  blankPackagingSpecBottles,
  type PackagingSpecBottles,
} from "@/lib/workflows";

type SpecKey = Exclude<keyof PackagingSpecBottles, "formVersion">;

type Props = {
  spec: PackagingSpecBottles | undefined;
  // Mirrors setProduct's updater pattern: receives the current (or blank)
  // spec and must return the next one.
  onChange: (updater: (cur: PackagingSpecBottles) => PackagingSpecBottles) => void;
  // True when the workflow-level Dosage form pill is "other" — reveals the
  // form's "If Dosage Type is Other" free-text question.
  dosageIsOther: boolean;
};

// ----- styles (mirrors /start's local look) --------------------------------

const groupTitle: CSSProperties = {
  fontSize: 12, fontWeight: 700, color: "var(--ink-1)",
  margin: "16px 0 8px", textTransform: "none",
};
const qLabel: CSSProperties = {
  fontSize: 11, fontWeight: 700, letterSpacing: "0.06em",
  textTransform: "uppercase", color: "var(--ink-3)",
  display: "block", marginBottom: 4,
};
const inputStyle: CSSProperties = {
  width: "100%", padding: "8px 12px", border: "1.5px solid #e3dcc9",
  borderRadius: 8, fontSize: 13, background: "#fff",
  color: "var(--ink-1)", boxSizing: "border-box", fontFamily: "inherit",
};
const rowStyle: CSSProperties = {
  display: "flex", flexWrap: "wrap", gap: 12, marginBottom: 10,
};
const fieldStyle: CSSProperties = { flex: "1 1 180px", minWidth: 150 };
const pillBase: CSSProperties = {
  padding: "6px 12px", border: "1.5px solid #e3dcc9", borderRadius: 999,
  background: "transparent", fontSize: 12, fontWeight: 600, cursor: "pointer",
  color: "var(--ink-1)", fontFamily: "inherit",
};
const pillActive: CSSProperties = {
  ...pillBase, background: "var(--teal-900)", color: "#fff",
  borderColor: "var(--teal-900)",
};

// ----- picklists (placeholders until the PandaDoc template is readable) ----

const OPTS: Record<string, Array<{ id: string; name: string }>> = {
  bottleMaterial: [
    { id: "pet", name: "PET" }, { id: "hdpe", name: "HDPE" },
    { id: "glass", name: "Glass" }, { id: "pcr", name: "PCR" },
    { id: "other", name: "Other" },
  ],
  bottleSize: [
    { id: "75cc", name: "75 cc" }, { id: "100cc", name: "100 cc" },
    { id: "120cc", name: "120 cc" }, { id: "150cc", name: "150 cc" },
    { id: "200cc", name: "200 cc" }, { id: "250cc", name: "250 cc" },
    { id: "300cc", name: "300 cc" }, { id: "other", name: "Other" },
  ],
  bottleShape: [
    { id: "round", name: "Round" }, { id: "packer", name: "Packer" },
    { id: "square", name: "Square" }, { id: "oval", name: "Oval" },
    { id: "other", name: "Other" },
  ],
  bottleColor: [
    { id: "clear", name: "Clear" }, { id: "white", name: "White" },
    { id: "amber", name: "Amber" }, { id: "black", name: "Black" },
    { id: "other", name: "Other" },
  ],
  closureFinish: [
    { id: "smooth", name: "Smooth" }, { id: "ribbed", name: "Ribbed" },
    { id: "crc", name: "Child-resistant (CRC)" }, { id: "flip-top", name: "Flip-top" },
    { id: "other", name: "Other" },
  ],
  closureSizeMm: [
    { id: "33-400", name: "33/400" }, { id: "38-400", name: "38/400" },
    { id: "45-400", name: "45/400" }, { id: "53-400", name: "53/400" },
    { id: "other", name: "Other" },
  ],
  closureColor: [
    { id: "white", name: "White" }, { id: "black", name: "Black" },
    { id: "other", name: "Other" },
  ],
  closureLiner: [
    { id: "induction", name: "Induction (heat seal)" },
    { id: "pressure-sensitive", name: "Pressure-sensitive" },
    { id: "foam", name: "Foam" }, { id: "none", name: "None" },
    { id: "other", name: "Other" },
  ],
  neckbandColor: [
    { id: "clear", name: "Clear" }, { id: "other", name: "Other" },
  ],
  sleeveColor: [
    { id: "clear", name: "Clear" }, { id: "other", name: "Other" },
  ],
  lotPrintFormat: [
    { id: "julian", name: "Julian" }, { id: "yymmdd", name: "YYMMDD" },
    { id: "lot-alpha", name: "Alphanumeric lot" }, { id: "other", name: "Other" },
  ],
  expPrintFormat: [
    { id: "mm-yyyy", name: "MM/YYYY" }, { id: "mm-dd-yyyy", name: "MM/DD/YYYY" },
    { id: "yyyy-mm", name: "YYYY-MM" }, { id: "other", name: "Other" },
  ],
  printLocation: [
    { id: "bottle", name: "Bottle" }, { id: "label", name: "Label" },
    { id: "cap", name: "Cap" }, { id: "other", name: "Other" },
  ],
  retailType: [
    { id: "carton", name: "Carton" }, { id: "display-box", name: "Display box" },
    { id: "other", name: "Other" },
  ],
  innerPackHow: [
    { id: "upright", name: "Upright" }, { id: "laydown", name: "Laydown" },
    { id: "bulk", name: "Bulk" }, { id: "other", name: "Other" },
  ],
  palletType: [
    { id: "gma-wood", name: "GMA wood" }, { id: "heat-treated", name: "Heat-treated wood" },
    { id: "plastic", name: "Plastic" }, { id: "other", name: "Other" },
  ],
  palletSize: [
    { id: "48x40", name: "48 × 40 in" }, { id: "48x42", name: "48 × 42 in" },
    { id: "euro", name: "Euro (1200 × 800)" }, { id: "other", name: "Other" },
  ],
};

// ----- field helpers (module-level so React keeps input identity across
// renders — inline component definitions remount on every keystroke and
// drop focus, the same pitfall we hit in the FormulaEditor) --------------

type Ctx = { s: PackagingSpecBottles; set: (k: SpecKey, v: string) => void };

function YesNo({ ctx, k, label }: { ctx: Ctx; k: SpecKey; label: string }) {
  const { s, set } = ctx;
  return (
    <div style={fieldStyle}>
      <span style={qLabel}>{label}</span>
      <div style={{ display: "flex", gap: 6 }}>
        {(["yes", "no"] as const).map((v) => (
          <button key={v} type="button"
            onClick={() => set(k, s[k] === v ? "" : v)}
            style={s[k] === v ? pillActive : pillBase}>
            {v === "yes" ? "Yes" : "No"}
          </button>
        ))}
      </div>
    </div>
  );
}

function Supplied({ ctx, k, label }: { ctx: Ctx; k: SpecKey; label?: string }) {
  const { s, set } = ctx;
  return (
    <div style={fieldStyle}>
      <span style={qLabel}>{label ?? "Supplied by"}</span>
      <div style={{ display: "flex", gap: 6 }}>
        {([["pharmacenter", "PharmaCenter"], ["customer", "Customer"]] as const).map(([v, name]) => (
          <button key={v} type="button"
            onClick={() => set(k, s[k] === v ? "" : v)}
            style={s[k] === v ? pillActive : pillBase}>
            {name}
          </button>
        ))}
      </div>
    </div>
  );
}

function Pick({ ctx, k, otherK, label, opts }: {
  ctx: Ctx; k: SpecKey; otherK?: SpecKey; label: string;
  opts: Array<{ id: string; name: string }>;
}) {
  const { s, set } = ctx;
  return (
    <>
      <div style={fieldStyle}>
        <span style={qLabel}>{label}</span>
        <select value={s[k]} onChange={(e) => set(k, e.target.value)} style={inputStyle}>
          <option value="">Choose…</option>
          {opts.map((o) => (
            <option key={o.id} value={o.id}>{o.name}</option>
          ))}
        </select>
      </div>
      {otherK && s[k] === "other" ? (
        <div style={fieldStyle}>
          <span style={qLabel}>If other</span>
          <input type="text" value={s[otherK]} onChange={(e) => set(otherK, e.target.value)}
            style={inputStyle} autoComplete="off" />
        </div>
      ) : null}
    </>
  );
}

function Text({ ctx, k, label, placeholder }: {
  ctx: Ctx; k: SpecKey; label: string; placeholder?: string;
}) {
  const { s, set } = ctx;
  return (
    <div style={fieldStyle}>
      <span style={qLabel}>{label}</span>
      <input type="text" value={s[k]} onChange={(e) => set(k, e.target.value)}
        placeholder={placeholder ?? ""} style={inputStyle} autoComplete="off" />
    </div>
  );
}

// Lot / EXP / other printing trio — used for both the bottle (Section I)
// and the retail packaging (Section J.1), so it's parameterised on keys.
function PrintTrio({ ctx, prefix, keys }: {
  ctx: Ctx; prefix: string;
  keys: {
    lotReq: SpecKey; lotSrc: SpecKey; lotFmt: SpecKey; lotFmtOther: SpecKey; lotLine: SpecKey;
    expReq: SpecKey; expSrc: SpecKey; expFmt: SpecKey; expFmtOther: SpecKey; expLine: SpecKey;
    othReq: SpecKey; othWhat: SpecKey; othSrc: SpecKey; othLine: SpecKey;
  };
}) {
  const { s } = ctx;
  return (
    <>
      <div style={rowStyle}>
        <YesNo ctx={ctx} k={keys.lotReq} label={`${prefix} lot number printing?`} />
        {s[keys.lotReq] === "yes" ? (
          <>
            <Text ctx={ctx} k={keys.lotSrc} label="Lot info obtained from" />
            <Pick ctx={ctx} k={keys.lotFmt} otherK={keys.lotFmtOther} label="Lot print format" opts={OPTS.lotPrintFormat} />
            <Text ctx={ctx} k={keys.lotLine} label="Print on line" />
          </>
        ) : null}
      </div>
      <div style={rowStyle}>
        <YesNo ctx={ctx} k={keys.expReq} label={`${prefix} EXP / best-by printing?`} />
        {s[keys.expReq] === "yes" ? (
          <>
            <Text ctx={ctx} k={keys.expSrc} label="Date info obtained from" />
            <Pick ctx={ctx} k={keys.expFmt} otherK={keys.expFmtOther} label="Date print format" opts={OPTS.expPrintFormat} />
            <Text ctx={ctx} k={keys.expLine} label="Print on line" />
          </>
        ) : null}
      </div>
      <div style={rowStyle}>
        <YesNo ctx={ctx} k={keys.othReq} label="Other info printed?" />
        {s[keys.othReq] === "yes" ? (
          <>
            <Text ctx={ctx} k={keys.othWhat} label="What to print (desired format)" />
            <Text ctx={ctx} k={keys.othSrc} label="Obtained from" />
            <Text ctx={ctx} k={keys.othLine} label="Print on line" />
          </>
        ) : null}
      </div>
    </>
  );
}

export default function PackagingSpecSection({ spec, onChange, dosageIsOther }: Props) {
  const [open, setOpen] = useState(false);
  const s = spec ?? blankPackagingSpecBottles();

  const set = (k: SpecKey, v: string) =>
    onChange((cur) => ({ ...cur, [k]: v }));
  const ctx: Ctx = { s, set };

  // Answered-question count for the collapsed header. formVersion excluded.
  const answered = Object.entries(s).filter(
    ([k, v]) => k !== "formVersion" && v !== "",
  ).length;

  return (
    <div style={{ marginTop: 14, border: "1.5px solid #e3dcc9", borderRadius: 10, background: "#fffdf8" }}>
      <button type="button" onClick={() => setOpen(!open)}
        style={{
          width: "100%", display: "flex", justifyContent: "space-between", alignItems: "center",
          padding: "12px 14px", background: "transparent", border: "none", cursor: "pointer",
          fontFamily: "inherit",
        }}>
        <span style={{ fontSize: 12, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--ink-3)" }}>
          Packaging spec (Bottles)
        </span>
        <span style={{ fontSize: 12, color: "var(--ink-3)" }}>
          {answered > 0 ? `${answered} answered · ` : "Fill now or later · "}
          {open ? "▴" : "▾"}
        </span>
      </button>

      {open ? (
        <div style={{ padding: "0 14px 14px" }}>
          <p style={{ fontSize: 12, color: "var(--ink-3)", margin: "0 0 4px" }}>
            Mirrors the PandaDoc Packaging Specification Form (v202401). Nothing
            here blocks saving — answer what you know now and finish later.
          </p>

          <div style={groupTitle}>Bulk (Section B)</div>
          <div style={rowStyle}>
            <Supplied ctx={ctx} k="bulkSuppliedBy" label="Bulk supplied by" />
            {s.bulkSuppliedBy === "pharmacenter" ? (
              <Text ctx={ctx} k="bulkProductCode" label="PC bulk product code" placeholder="PC-BK-0000" />
            ) : null}
            {dosageIsOther ? <Text ctx={ctx} k="dosageTypeOther" label="Dosage type (other)" /> : null}
            <Text ctx={ctx} k="dosageSize" label="Dosage size" placeholder="e.g. 1,000 mg" />
            <Text ctx={ctx} k="dosageShape" label="Dosage shape" placeholder="e.g. oblong" />
          </div>

          <div style={groupTitle}>Bottle (Section C)</div>
          <div style={rowStyle}>
            <Supplied ctx={ctx} k="bottleSuppliedBy" label="Bottle supplied by" />
            <Pick ctx={ctx} k="bottleMaterial" otherK="bottleMaterialOther" label="Material" opts={OPTS.bottleMaterial} />
            <Pick ctx={ctx} k="bottleSize" otherK="bottleSizeOther" label="Size" opts={OPTS.bottleSize} />
            <Pick ctx={ctx} k="bottleShape" otherK="bottleShapeOther" label="Shape" opts={OPTS.bottleShape} />
            <Pick ctx={ctx} k="bottleColor" otherK="bottleColorOther" label="Color" opts={OPTS.bottleColor} />
          </div>

          <div style={groupTitle}>Bottle filler (Section D)</div>
          <div style={rowStyle}>
            <YesNo ctx={ctx} k="fillerRequired" label="Filler required?" />
            {s.fillerRequired === "yes" ? (
              <>
                <Supplied ctx={ctx} k="fillerSuppliedBy" label="Filler supplied by" />
                <YesNo ctx={ctx} k="fillerCotton" label="Cotton?" />
                <YesNo ctx={ctx} k="fillerDesiccant" label="Desiccant?" />
                <Text ctx={ctx} k="fillerOther" label="Other filler" placeholder="leave blank if none" />
              </>
            ) : null}
          </div>

          <div style={groupTitle}>Closure (Section E)</div>
          <div style={rowStyle}>
            <Supplied ctx={ctx} k="closureSuppliedBy" label="Closure supplied by" />
            <Pick ctx={ctx} k="closureFinish" otherK="closureFinishOther" label="Finish" opts={OPTS.closureFinish} />
            <Pick ctx={ctx} k="closureSizeMm" otherK="closureSizeOther" label="Size (mm)" opts={OPTS.closureSizeMm} />
            <Pick ctx={ctx} k="closureColor" otherK="closureColorOther" label="Color" opts={OPTS.closureColor} />
            <Pick ctx={ctx} k="closureLiner" otherK="closureLinerOther" label="Liner type" opts={OPTS.closureLiner} />
          </div>

          <div style={groupTitle}>Neckband (Section F)</div>
          <div style={rowStyle}>
            <YesNo ctx={ctx} k="neckbandRequired" label="Neckband required?" />
            {s.neckbandRequired === "yes" ? (
              <>
                <Supplied ctx={ctx} k="neckbandSuppliedBy" label="Neckbands supplied by" />
                <Pick ctx={ctx} k="neckbandColor" otherK="neckbandColorOther" label="Color" opts={OPTS.neckbandColor} />
                <Text ctx={ctx} k="neckbandPrint" label="Print" placeholder="leave blank if none" />
                <YesNo ctx={ctx} k="neckbandPerforation" label="Perforation required?" />
              </>
            ) : null}
          </div>

          <div style={groupTitle}>Full sleeve (Section G)</div>
          <div style={rowStyle}>
            <YesNo ctx={ctx} k="sleeveRequired" label="Full sleeve required?" />
            {s.sleeveRequired === "yes" ? (
              <>
                <Supplied ctx={ctx} k="sleeveSuppliedBy" label="Sleeves supplied by" />
                <Pick ctx={ctx} k="sleeveColor" otherK="sleeveColorOther" label="Color" opts={OPTS.sleeveColor} />
                <Text ctx={ctx} k="sleevePrint" label="Print" placeholder="leave blank if none" />
                <YesNo ctx={ctx} k="sleevePerforation" label="Perforation required?" />
              </>
            ) : null}
          </div>

          <div style={groupTitle}>Bottle label (Section H)</div>
          <div style={rowStyle}>
            <YesNo ctx={ctx} k="labelRequired" label="Bottle label required?" />
            {s.labelRequired === "yes" ? (
              <>
                <Supplied ctx={ctx} k="labelSuppliedBy" label="Labels supplied by" />
                <Text ctx={ctx} k="labelArtwork" label="Label artwork" placeholder="reference or attach above" />
              </>
            ) : null}
          </div>

          <div style={groupTitle}>Bottle lot &amp; date printing (Section I)</div>
          <PrintTrio ctx={ctx} prefix="Bottle" keys={{
            lotReq: "lotPrintRequired", lotSrc: "lotPrintSource", lotFmt: "lotPrintFormat",
            lotFmtOther: "lotPrintFormatOther", lotLine: "lotPrintLine",
            expReq: "expPrintRequired", expSrc: "expPrintSource", expFmt: "expPrintFormat",
            expFmtOther: "expPrintFormatOther", expLine: "expPrintLine",
            othReq: "otherPrintRequired", othWhat: "otherPrintWhat",
            othSrc: "otherPrintSource", othLine: "otherPrintLine",
          }} />
          <div style={rowStyle}>
            <Pick ctx={ctx} k="printLocation" label="Print location" opts={OPTS.printLocation} />
            {s.printLocation === "label" ? (
              <Text ctx={ctx} k="printLocationOnLabel" label="Where on the label" />
            ) : null}
            <Text ctx={ctx} k="printColor" label="Print color" />
          </div>

          <div style={groupTitle}>Secondary / retail packaging (Section J)</div>
          <div style={rowStyle}>
            <YesNo ctx={ctx} k="retailRequired" label="Retail packaging required?" />
            {s.retailRequired === "yes" ? (
              <>
                <Supplied ctx={ctx} k="retailSuppliedBy" label="Supplied by" />
                <Pick ctx={ctx} k="retailType" otherK="retailTypeOther" label="Type" opts={OPTS.retailType} />
                <Text ctx={ctx} k="retailBottlesPerPack" label="Bottles per pack" placeholder="e.g. 1" />
              </>
            ) : null}
          </div>
          {s.retailRequired === "yes" ? (
            <>
              <div style={groupTitle}>Retail packaging printing (Section J.1)</div>
              <div style={rowStyle}>
                <Text ctx={ctx} k="retailArtwork" label="Retail packaging artwork" placeholder="reference or attach above" />
              </div>
              <PrintTrio ctx={ctx} prefix="Retail" keys={{
                lotReq: "retailLotPrintRequired", lotSrc: "retailLotPrintSource", lotFmt: "retailLotPrintFormat",
                lotFmtOther: "retailLotPrintFormatOther", lotLine: "retailLotPrintLine",
                expReq: "retailExpPrintRequired", expSrc: "retailExpPrintSource", expFmt: "retailExpPrintFormat",
                expFmtOther: "retailExpPrintFormatOther", expLine: "retailExpPrintLine",
                othReq: "retailOtherPrintRequired", othWhat: "retailOtherPrintWhat",
                othSrc: "retailOtherPrintSource", othLine: "retailOtherPrintLine",
              }} />
              <div style={rowStyle}>
                <Text ctx={ctx} k="retailPrintLocation" label="Print location" />
                <Text ctx={ctx} k="retailPrintColor" label="Print color" />
              </div>
              <div style={groupTitle}>Retail extra applications (Section J.2)</div>
              <div style={rowStyle}>
                <YesNo ctx={ctx} k="safetySealRequired" label="Safety seal?" />
                {s.safetySealRequired === "yes" ? <Supplied ctx={ctx} k="safetySealSuppliedBy" label="Seal supplied by" /> : null}
                <YesNo ctx={ctx} k="insertRequired" label="Insert?" />
                {s.insertRequired === "yes" ? <Supplied ctx={ctx} k="insertSuppliedBy" label="Insert supplied by" /> : null}
              </div>
              <div style={rowStyle}>
                <YesNo ctx={ctx} k="stickersRequired" label="Sticker(s)?" />
                {s.stickersRequired === "yes" ? (
                  <>
                    <Supplied ctx={ctx} k="stickersSuppliedBy" label="Stickers supplied by" />
                    <Text ctx={ctx} k="stickersWhere" label="Where to apply" />
                  </>
                ) : null}
                <Text ctx={ctx} k="retailExtraOther" label="Other application" placeholder="leave blank if none" />
              </div>
            </>
          ) : null}

          <div style={groupTitle}>Bundling (Section K)</div>
          <div style={rowStyle}>
            <YesNo ctx={ctx} k="bundlingRequired" label="Bundling required?" />
            {s.bundlingRequired === "yes" ? (
              <>
                <Text ctx={ctx} k="bundleUnitsPerBundle" label="Units per bundle" />
                <YesNo ctx={ctx} k="bundleShrinkWrap" label="Shrink wrapping?" />
                {s.bundleShrinkWrap === "yes" ? <Supplied ctx={ctx} k="bundleShrinkWrapSuppliedBy" label="Shrink wrap supplied by" /> : null}
                <YesNo ctx={ctx} k="bundleTrays" label="Trays?" />
                {s.bundleTrays === "yes" ? <Supplied ctx={ctx} k="bundleTraysSuppliedBy" label="Trays supplied by" /> : null}
              </>
            ) : null}
          </div>
          {s.bundlingRequired === "yes" ? (
            <div style={rowStyle}>
              <Text ctx={ctx} k="bundleOther" label="Other bundling requirement" placeholder="leave blank if none" />
              <YesNo ctx={ctx} k="bundleStickersRequired" label="Bundle sticker(s)?" />
              {s.bundleStickersRequired === "yes" ? <Text ctx={ctx} k="bundleStickersWhere" label="Where to apply" /> : null}
              <Text ctx={ctx} k="bundleExtraOther" label="Other bundle application" placeholder="leave blank if none" />
            </div>
          ) : null}

          <div style={groupTitle}>Inner pack (Section L)</div>
          <div style={rowStyle}>
            <YesNo ctx={ctx} k="innerPackRequired" label="Inner pack required?" />
            {s.innerPackRequired === "yes" ? (
              <>
                <Supplied ctx={ctx} k="innerPackSuppliedBy" label="Inner pack supplied by" />
                <Pick ctx={ctx} k="innerPackHow" otherK="innerPackHowOther" label="How to inner pack" opts={OPTS.innerPackHow} />
                <Text ctx={ctx} k="innerPackQty" label="Qty per inner pack" placeholder="blank = no specific qty" />
                <Text ctx={ctx} k="innerPackSize" label="Size requirements" placeholder="blank = no specific size" />
                <Text ctx={ctx} k="innerPackLabelInfo" label="Label info required" placeholder="blank = standard" />
                <Text ctx={ctx} k="innerPackLabelSize" label="Label size" placeholder="blank = standard" />
              </>
            ) : null}
          </div>

          <div style={groupTitle}>Master box (Section M)</div>
          <div style={rowStyle}>
            <Supplied ctx={ctx} k="masterBoxSuppliedBy" label="Master box supplied by" />
            <Text ctx={ctx} k="masterBoxQty" label="Units / inner cases per box" placeholder="blank = our standard" />
            <Text ctx={ctx} k="masterBoxSize" label="Size requirements" placeholder="blank = standard" />
            <Text ctx={ctx} k="masterBoxLabelInfo" label="Label info required" placeholder="blank = standard" />
            <Text ctx={ctx} k="masterBoxLabelSize" label="Label size" placeholder="blank = standard" />
          </div>

          <div style={groupTitle}>Pallet (Section N)</div>
          <div style={rowStyle}>
            <Pick ctx={ctx} k="palletType" otherK="palletTypeOther" label="Pallet type" opts={OPTS.palletType} />
            <Pick ctx={ctx} k="palletSize" otherK="palletSizeOther" label="Pallet size" opts={OPTS.palletSize} />
            <Text ctx={ctx} k="palletConfig" label="Specific configuration" placeholder="blank = none" />
            <Text ctx={ctx} k="palletDimensionLimits" label="Dimension limits" placeholder="blank = none" />
          </div>
          <div style={rowStyle}>
            <YesNo ctx={ctx} k="palletLabelRequired" label="Pallet label required?" />
            {s.palletLabelRequired === "yes" ? (
              <>
                <Text ctx={ctx} k="palletLabelInfo" label="Label info required" placeholder="blank = standard" />
                <Text ctx={ctx} k="palletLabelSize" label="Label size" placeholder="blank = standard" />
              </>
            ) : null}
            <YesNo ctx={ctx} k="palletTemptale" label="Temptale on pallet?" />
          </div>

          <div style={groupTitle}>Additional information (Section O)</div>
          <textarea value={s.additionalInfo} onChange={(e) => set("additionalInfo", e.target.value)}
            placeholder="Any packaging requirements not covered above. Supporting files go in Attachments."
            style={{ ...inputStyle, resize: "vertical", minHeight: 70, lineHeight: 1.5 }} />
        </div>
      ) : null}
    </div>
  );
}
