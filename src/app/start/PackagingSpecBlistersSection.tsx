"use client";

// Packaging Specification Form (Blisters) — inline questionnaire that mirrors
// the PandaDoc "Packaging Form (Blisters)" (sections A–L) minus everything the
// workflow already captures (company, product name/code, files). Fillable
// later — nothing here gates Save. A future PandaDoc sync reads the saved
// PackagingSpecBlisters object and fills the real form field-for-field.
//
// Structure and styling are a sibling of PackagingSpecSection (Bottles) —
// kept as its own file rather than parameterised because the two forms share
// conventions but not fields, and the costing boards read them differently.
//
// NOTE ON PICKLISTS: option lists are drawn from filled forms (Tetraxyl 1385,
// Gaspari NMN 1356 …) + common industry values. "other" + free text covers
// anything missing; stored ids stay stable if we later swap in the exact
// PandaDoc picklists.

import { useState, type CSSProperties } from "react";
import {
  blankPackagingSpecBlisters,
  type PackagingSpecBlisters,
} from "@/lib/workflows";

type SpecKey = Exclude<keyof PackagingSpecBlisters, "formVersion">;

type Props = {
  spec: PackagingSpecBlisters | undefined;
  // Mirrors setProduct's updater pattern: receives the current (or blank)
  // spec and must return the next one.
  onChange: (
    updater: (cur: PackagingSpecBlisters) => PackagingSpecBlisters,
  ) => void;
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

// ----- picklists -----------------------------------------------------------

const OPTS: Record<string, Array<{ id: string; name: string }>> = {
  dosageType: [
    { id: "tablet", name: "Tablet" }, { id: "capsule", name: "Capsule" },
    { id: "softgel", name: "Softgel" }, { id: "gummy", name: "Gummy" },
    { id: "other", name: "Other" },
  ],
  filmMaterial: [
    { id: "pvc", name: "PVC" }, { id: "pvdc", name: "PVDC" },
    { id: "aclar", name: "Aclar" }, { id: "pet", name: "PET" },
    { id: "other", name: "Other" },
  ],
  filmThickness: [
    { id: "7.5-mil", name: "7.5 mil" }, { id: "10-mil", name: "10 mil" },
    { id: "12-mil", name: "12 mil" }, { id: "other", name: "Other" },
  ],
  filmColor: [
    { id: "natural", name: "Natural (clear)" }, { id: "amber", name: "Amber" },
    { id: "white", name: "White" }, { id: "other", name: "Other" },
  ],
  liddingMaterial: [
    { id: "aluminum", name: "Aluminum" },
    { id: "paper-alu", name: "Paper-backed aluminum" },
    { id: "child-resistant", name: "Child-resistant (peel-push)" },
    { id: "other", name: "Other" },
  ],
  liddingThickness: [
    { id: "20-um", name: "20 µm" }, { id: "25-um", name: "25 µm" },
    { id: "other", name: "Other" },
  ],
  liddingColor: [
    { id: "natural", name: "Natural (silver)" }, { id: "white", name: "White" },
    { id: "other", name: "Other" },
  ],
  liddingPrintSides: [
    { id: "single", name: "Single-sided" }, { id: "double", name: "Double-sided" },
  ],
  codingType: [
    { id: "printed-thermal", name: "Printed (Thermal Transfer)" },
    { id: "embossed", name: "Embossed" },
    { id: "none", name: "None" },
    { id: "other", name: "Other" },
  ],
  retailType: [
    { id: "ifc", name: "IFC (folding carton)" },
    { id: "carton", name: "Unit carton" },
    { id: "display-box", name: "Display box" },
    { id: "bifold-card", name: "Bifold card" },
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

type Ctx = { s: PackagingSpecBlisters; set: (k: SpecKey, v: string) => void };

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

export default function PackagingSpecBlistersSection({ spec, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const s = spec ?? blankPackagingSpecBlisters();

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
          Packaging spec (Blisters)
        </span>
        <span style={{ fontSize: 12, color: "var(--ink-3)" }}>
          {answered > 0 ? `${answered} answered · ` : "Fill now or later · "}
          {open ? "▴" : "▾"}
        </span>
      </button>

      {open ? (
        <div style={{ padding: "0 14px 14px" }}>
          <p style={{ fontSize: 12, color: "var(--ink-3)", margin: "0 0 4px" }}>
            Mirrors the PandaDoc Packaging Form (Blisters). Nothing here blocks
            saving — answer what you know now and finish later.
          </p>

          <div style={groupTitle}>Bulk</div>
          <div style={rowStyle}>
            <Supplied ctx={ctx} k="bulkSuppliedBy" label="Bulk supplied by" />
            {s.bulkSuppliedBy === "pharmacenter" ? (
              <Text ctx={ctx} k="bulkProductCode" label="PC bulk product code" placeholder="PC-BK-0000" />
            ) : null}
            <Pick ctx={ctx} k="dosageType" otherK="dosageTypeOther" label="Dosage type" opts={OPTS.dosageType} />
            <Text ctx={ctx} k="dosageSize" label="Dosage size" placeholder={'e.g. "00"'} />
            <Text ctx={ctx} k="dosageShape" label="Dosage shape" placeholder="e.g. oblong" />
          </div>

          <div style={groupTitle}>Blister card</div>
          <div style={rowStyle}>
            <Text ctx={ctx} k="cardFormatCode" label="Format code (tooling)" placeholder="e.g. C709" />
            <Text ctx={ctx} k="cardCount" label="Count (doses per card)" placeholder="e.g. 15" />
            <Text ctx={ctx} k="cardLengthMm" label="Card length (mm)" placeholder="e.g. 82" />
            <Text ctx={ctx} k="cardWidthMm" label="Card width (mm)" placeholder="e.g. 102" />
          </div>

          <div style={groupTitle}>Film (forming web)</div>
          <div style={rowStyle}>
            <Supplied ctx={ctx} k="filmSuppliedBy" label="Film supplied by" />
            <Pick ctx={ctx} k="filmMaterial" otherK="filmMaterialOther" label="Material" opts={OPTS.filmMaterial} />
            <Pick ctx={ctx} k="filmThickness" otherK="filmThicknessOther" label="Thickness" opts={OPTS.filmThickness} />
            <Pick ctx={ctx} k="filmColor" otherK="filmColorOther" label="Color" opts={OPTS.filmColor} />
          </div>

          <div style={groupTitle}>Lidding (foil)</div>
          <div style={rowStyle}>
            <Supplied ctx={ctx} k="liddingSuppliedBy" label="Lidding supplied by" />
            <Pick ctx={ctx} k="liddingMaterial" otherK="liddingMaterialOther" label="Material" opts={OPTS.liddingMaterial} />
            <Pick ctx={ctx} k="liddingThickness" otherK="liddingThicknessOther" label="Thickness" opts={OPTS.liddingThickness} />
            <Pick ctx={ctx} k="liddingColor" otherK="liddingColorOther" label="Color" opts={OPTS.liddingColor} />
          </div>
          <div style={rowStyle}>
            <YesNo ctx={ctx} k="liddingPreprinted" label="Pre-printed foil?" />
            {s.liddingPreprinted === "yes" ? (
              <Pick ctx={ctx} k="liddingPrintSides" label="Print sides" opts={OPTS.liddingPrintSides} />
            ) : null}
          </div>

          <div style={groupTitle}>Blister card extras</div>
          <div style={rowStyle}>
            <YesNo ctx={ctx} k="perforationRequired" label="Perforation required?" />
            <YesNo ctx={ctx} k="butterflyHoleRequired" label="Butterfly hole required?" />
          </div>

          <div style={groupTitle}>Lot &amp; date coding</div>
          <div style={rowStyle}>
            <Pick ctx={ctx} k="codingType" otherK="codingTypeOther" label="Coding type" opts={OPTS.codingType} />
          </div>
          <div style={rowStyle}>
            <YesNo ctx={ctx} k="lotPrintRequired" label="Lot number printing?" />
            {s.lotPrintRequired === "yes" ? (
              <>
                <Text ctx={ctx} k="lotPrintSource" label="Lot info obtained from" placeholder="e.g. PharmaCenter issued" />
                <Text ctx={ctx} k="lotPrintFormat" label="Lot print format" placeholder="e.g. Lot: L####" />
              </>
            ) : null}
          </div>
          <div style={rowStyle}>
            <YesNo ctx={ctx} k="expPrintRequired" label="EXP / best-by printing?" />
            {s.expPrintRequired === "yes" ? (
              <>
                <Text ctx={ctx} k="expPrintSource" label="Date info obtained from" placeholder="e.g. Certificate of Analysis" />
                <Text ctx={ctx} k="expPrintFormat" label="Date print format" placeholder="e.g. EXP: MM/YYYY" />
              </>
            ) : null}
          </div>
          <div style={rowStyle}>
            <YesNo ctx={ctx} k="otherPrintRequired" label="Other info printed?" />
            {s.otherPrintRequired === "yes" ? (
              <>
                <Text ctx={ctx} k="otherPrintWhat" label="What to print (desired format)" />
                <Text ctx={ctx} k="otherPrintSource" label="Obtained from" />
              </>
            ) : null}
          </div>

          <div style={groupTitle}>Secondary / retail packaging</div>
          <div style={rowStyle}>
            <YesNo ctx={ctx} k="retailRequired" label="Secondary/retail packaging required?" />
            {s.retailRequired === "yes" ? (
              <>
                <Supplied ctx={ctx} k="retailSuppliedBy" label="Retail pack supplied by" />
                <Pick ctx={ctx} k="retailType" otherK="retailTypeOther" label="Type" opts={OPTS.retailType} />
                <Text ctx={ctx} k="retailBlistersPerPack" label="Blisters per pack" placeholder="e.g. 2" />
              </>
            ) : null}
          </div>
          {s.retailRequired === "yes" ? (
            <>
              <div style={rowStyle}>
                <Text ctx={ctx} k="retailArtwork" label="Artwork" placeholder="blank = provided by customer" />
                <Text ctx={ctx} k="retailPrintWhere" label="Lot & EXP printed where" placeholder="blank = not printed" />
                <Text ctx={ctx} k="retailPrintColor" label="Print color" />
                <Text ctx={ctx} k="retailPrintFormat" label="Print format" />
              </div>
              <div style={rowStyle}>
                <Text ctx={ctx} k="retailLotSource" label="Lot info obtained from" />
                <Text ctx={ctx} k="retailExpSource" label="EXP info obtained from" />
              </div>
              <div style={rowStyle}>
                <YesNo ctx={ctx} k="safetySealRequired" label="Safety seal?" />
                {s.safetySealRequired === "yes" ? (
                  <Supplied ctx={ctx} k="safetySealSuppliedBy" label="Seal supplied by" />
                ) : null}
                <YesNo ctx={ctx} k="insertRequired" label="Insert?" />
                {s.insertRequired === "yes" ? (
                  <Supplied ctx={ctx} k="insertSuppliedBy" label="Insert supplied by" />
                ) : null}
              </div>
              <div style={rowStyle}>
                <YesNo ctx={ctx} k="stickersRequired" label="Sticker(s)?" />
                {s.stickersRequired === "yes" ? (
                  <>
                    <Supplied ctx={ctx} k="stickersSuppliedBy" label="Stickers supplied by" />
                    <Text ctx={ctx} k="stickersWhere" label="Where to apply" />
                  </>
                ) : null}
                <Text ctx={ctx} k="retailExtraOther" label="Other applications" placeholder="blank = none" />
              </div>
            </>
          ) : null}

          <div style={groupTitle}>Bundling or Kitting</div>
          <div style={rowStyle}>
            <YesNo ctx={ctx} k="bundlingRequired" label="Bundling or kitting required?" />
            {s.bundlingRequired === "yes" ? (
              <>
                <Text ctx={ctx} k="bundleUnitsPerBundle" label="Finished units per bundle" />
                <YesNo ctx={ctx} k="bundleShrinkWrap" label="Shrink wrapping?" />
                {s.bundleShrinkWrap === "yes" ? (
                  <Supplied ctx={ctx} k="bundleShrinkWrapSuppliedBy" label="Shrink wrap supplied by" />
                ) : null}
                <YesNo ctx={ctx} k="bundleTrays" label="Trays?" />
                {s.bundleTrays === "yes" ? (
                  <Supplied ctx={ctx} k="bundleTraysSuppliedBy" label="Trays supplied by" />
                ) : null}
              </>
            ) : null}
          </div>
          {s.bundlingRequired === "yes" ? (
            <div style={rowStyle}>
              <Text ctx={ctx} k="bundleOther" label="Other bundling requirements" placeholder="blank = none" />
              <YesNo ctx={ctx} k="bundleStickersRequired" label="Sticker(s) on bundle?" />
              {s.bundleStickersRequired === "yes" ? (
                <Text ctx={ctx} k="bundleStickersWhere" label="Where to apply" />
              ) : null}
              <Text ctx={ctx} k="bundleExtraOther" label="Other bundle applications" placeholder="blank = none" />
            </div>
          ) : null}

          <div style={groupTitle}>Inner pack</div>
          <div style={rowStyle}>
            <YesNo ctx={ctx} k="innerPackRequired" label="Inner pack required?" />
            {s.innerPackRequired === "yes" ? (
              <>
                <Supplied ctx={ctx} k="innerPackSuppliedBy" label="Inner pack supplied by" />
                <Pick ctx={ctx} k="innerPackHow" otherK="innerPackHowOther" label="How to pack" opts={OPTS.innerPackHow} />
                <Text ctx={ctx} k="innerPackQty" label="Finished units per inner" placeholder="blank = our standard" />
                <Text ctx={ctx} k="innerPackSize" label="Size requirements" placeholder="blank = standard" />
                <Text ctx={ctx} k="innerPackLabelInfo" label="Label info required" placeholder="blank = standard" />
                <Text ctx={ctx} k="innerPackLabelSize" label="Label size" placeholder="blank = standard" />
              </>
            ) : null}
          </div>

          <div style={groupTitle}>Master box</div>
          <div style={rowStyle}>
            <Supplied ctx={ctx} k="masterBoxSuppliedBy" label="Master box supplied by" />
            <Text ctx={ctx} k="masterBoxQty" label="Units / inner cases per box" placeholder="blank = our standard" />
            <Text ctx={ctx} k="masterBoxSize" label="Size requirements" placeholder="blank = standard" />
            <Text ctx={ctx} k="masterBoxLabelInfo" label="Label info required" placeholder="blank = standard" />
            <Text ctx={ctx} k="masterBoxLabelSize" label="Label size" placeholder="blank = standard" />
          </div>

          <div style={groupTitle}>Pallet</div>
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

          <div style={groupTitle}>Additional information</div>
          <textarea value={s.additionalInfo} onChange={(e) => set("additionalInfo", e.target.value)}
            placeholder="Any packaging requirements not covered above. Supporting files go in Attachments."
            style={{ ...inputStyle, resize: "vertical", minHeight: 70, lineHeight: 1.5 }} />
        </div>
      ) : null}
    </div>
  );
}
