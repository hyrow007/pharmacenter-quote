"use client";

/**
 * Overhead breakdown tables — the pool-model "logic chain" cards shared by
 * the bottle costing board and the gummy formula editor's Costing tab.
 *
 * Extracted from BottleCostingBoard (its v75-v77) so both calculators render
 * ONE implementation of the traceable lease / indirect / other tables. The
 * only per-calculator differences are words: what a unit is called ("bottle"
 * vs "gummy") — so those are props, defaulting to the bottle originals.
 */

import React, { Fragment } from "react";

// Table chrome — the module's own copies, so neither giant calculator file
// has to export its styles.
const labSub: React.CSSProperties = {
  border: "1px solid var(--line, #e3dcc9)",
  borderRadius: 8,
  margin: "12px 14px",
  background: "var(--paper, #fffdf8)",
  overflow: "hidden",
};
const labSubTitle: React.CSSProperties = {
  padding: "10px 14px 4px",
  fontSize: 13,
  fontWeight: 700,
  color: "var(--teal-900, #0f4a56)",
};
const labTable: React.CSSProperties = {
  width: "100%",
  borderCollapse: "collapse",
  tableLayout: "fixed",
};
const labHeadRow: React.CSSProperties = {
  borderBottom: "1.5px solid var(--teal-700, #1d6c7b)",
};
const labBodyRow: React.CSSProperties = {
  borderBottom: "1px solid var(--line-2, #efe9da)",
};
const labTotalRow: React.CSSProperties = {
  background: "var(--cream-soft, #fbf6ec)",
};
const labTh: React.CSSProperties = {
  padding: "8px 12px",
  fontSize: 11,
  fontWeight: 700,
  letterSpacing: "0.09em",
  textTransform: "uppercase",
  color: "var(--ink-3, #8a9498)",
  textAlign: "right",
};
const labTd: React.CSSProperties = {
  padding: "8px 12px",
  fontSize: 13,
  textAlign: "right",
  fontVariantNumeric: "tabular-nums",
  fontWeight: 600,
  color: "var(--ink-1, #1f2a2d)",
};
const labSum = (v: number | null, dec = 2) => (
  <input
    type="text"
    readOnly
    tabIndex={-1}
    value={
      v === null
        ? ""
        : v.toLocaleString("en-US", {
            minimumFractionDigits: dec,
            maximumFractionDigits: dec,
          })
    }
    style={{
      width: "100%",
      maxWidth: 120,
      border: "none",
      background: "transparent",
      textAlign: "right",
      fontVariantNumeric: "tabular-nums",
      fontWeight: 700,
      fontSize: 13,
      color: "var(--teal-900, #0f4a56)",
      pointerEvents: "none",
      paddingRight: 14,
    }}
  />
);

/** One suite x pool line of the lease rate, from /api/overhead. */
export type LeaseBreakdownRow = {
  suiteKey: string;
  suiteLabel: string;
  poolKey: string;
  poolLabel: string;
  sqFt: number | null;
  pctOfSuite: number | null;
  baseMonthly: number | null;
  camMonthly: number | null;
  chargedMonthly: number | null;
  divisorDays: number | null;
  ratePerDay: number | null;
  sharePctApplied: number | null;
};

/** Dotted-underline figure with a native hover explanation. */
export function Tip({ tip, children }: { tip: string; children: React.ReactNode }) {
  return (
    <span
      title={tip}
      style={{
        borderBottom: "1px dotted var(--ink-3, #7b7364)",
        cursor: "help",
      }}
    >
      {children}
    </span>
  );
}

/**
 * The Lease Expenses card when rent is charged per RUN-DAY (v75).
 *
 * Grouped by suite so it reads like the leases do, but every row is ONE
 * checkable calculation — Base + CAM apportioned by floor area, the margin
 * share applied where the row says so, then a single division by the days in
 * the next column. The old Share % column is gone because nothing typed
 * drives this table: the splits come from the floor plan and the margin
 * figures in the database, and showing an editable number next to money it
 * does not move is how people stop trusting a screen.
 *
 * Read-only on purpose. Change the floor plan or the shares where they live
 * (overhead_space_functions / overhead_facility_shares) and every calculator
 * follows.
 */
export function LeaseBreakdownTable({
  rows,
  jobDays,
  quantity,
  effRate,
  dec = 4,
  unit = "bottle",
  unitPlural = "bottles",
  lineLabel = "CP",
}: {
  rows: LeaseBreakdownRow[];
  /** Decimal places for the per-unit column — the board-wide picker value. */
  dec?: number;
  /** What one unit is called on this calculator: "bottle" or "gummy". */
  unit?: string;
  unitPlural?: string;
  /** Short department name in captions: "CP" on the bottle board, "Gummy"
   *  on the formula editor. The share %s themselves come from the rows. */
  lineLabel?: string;
  jobDays: number | null;
  quantity: number | null;
  /** The rate the model is actually pricing at (saved or live). */
  effRate: number | null;
}) {
  const money = (v: number | null | undefined, dec = 2) =>
    v === null || v === undefined
      ? "—"
      : v.toLocaleString("en-US", {
          minimumFractionDigits: dec,
          maximumFractionDigits: dec,
        });
  // Dollar-prefixed variant for the job-money columns. The $/mo columns stay
  // bare because their header already carries the unit; the Job and $/bottle
  // figures are the ones that read as prices and get the sign.
  const moneyD = (v: number | null | undefined, dec = 2) =>
    v === null || v === undefined ? "—" : `$${money(v, dec)}`;
  const days = jobDays !== null && jobDays > 0 ? jobDays : null;
  const daysLabel = days === null ? "—" : days.toLocaleString("en-US", { maximumFractionDigits: 2 });
  const jobOf = (rate: number | null) =>
    rate === null || days === null ? null : rate * days;
  const perOf = (rate: number | null) => {
    const j = jobOf(rate);
    return j === null || !quantity || quantity <= 0 ? null : j / quantity;
  };

  // "Space serves", as two stacked lines: the label, then the area maths.
  // One long nowrap line crowded the Base column right off the screen —
  // stacking keeps the column narrow without losing the derivation. Facility
  // rows carry the margin share in the second line because that is exactly
  // where it is applied in the Charged column.
  const servesLabel = (r: LeaseBreakdownRow) => {
    if (r.poolKey === "facility") return "wh + office";
    if (r.poolKey === "cp_packaging") return "packaging floor";
    if (r.poolKey === "gummy_manufacturing") return "gummy manufacturing";
    return r.poolLabel;
  };
  const servesDetail = (r: LeaseBreakdownRow) => {
    const area = `${money(r.sqFt, 0)} ft²${r.pctOfSuite !== null ? ` (${r.pctOfSuite}%)` : ""}`;
    return r.poolKey === "facility" && r.sharePctApplied !== null
      ? `${area} × ${r.sharePctApplied}%`
      : area;
  };
  const divisorLabel = (r: LeaseBreakdownRow) => {
    if (!r.chargedMonthly || r.divisorDays === null) return "";
    return r.poolKey === "facility"
      ? `${money(r.divisorDays, 2)} ${lineLabel} run-days`
      : `${money(r.divisorDays, 1)} run-days, all lines`;
  };
  const divisorTip = (r: LeaseBreakdownRow) =>
    r.poolKey === "facility"
      ? "Run-days worked by Contract Packaging jobs alone, 12-month average from the yield log"
      : "Yield log, 12-month average: all packaging lines together, about 3 jobs in parallel";
  const chargedTip = (r: LeaseBreakdownRow) => {
    if (!r.chargedMonthly) return "This suite's rent is absorbed by another line, not this one";
    const sum = `${money(r.baseMonthly)} + ${money(r.camMonthly)}`;
    return r.sharePctApplied !== null
      ? `(${sum}) × ${r.sharePctApplied}%`
      : `${sum} — the whole floor is Contract Packaging work`;
  };

  // Group rows by suite, preserving order. A suite whose space serves two
  // pools gets a subtotal line so the per-suite figure is still on screen.
  const suites: { key: string; label: string; rows: LeaseBreakdownRow[] }[] = [];
  for (const r of rows) {
    const last = suites[suites.length - 1];
    if (last && last.key === r.suiteKey) last.rows.push(r);
    else suites.push({ key: r.suiteKey, label: r.suiteLabel, rows: [r] });
  }

  const totRate = rows.reduce((s, r) => s + (r.ratePerDay ?? 0), 0);
  // Price at what the model actually charges. A saved job keeps its frozen
  // rate; the strip below the card already explains any difference.
  const priceRate = effRate ?? totRate;
  const totBase = rows.reduce((s, r) => s + (r.baseMonthly ?? 0), 0);
  const totCam = rows.reduce((s, r) => s + (r.camMonthly ?? 0), 0);
  const totCharged = rows.reduce((s, r) => s + (r.chargedMonthly ?? 0), 0);

  const num: React.CSSProperties = { ...labTd, whiteSpace: "nowrap" };
  const sub: React.CSSProperties = {
    ...labTd,
    fontSize: 12,
    color: "var(--ink-3, #7b7364)",
    textAlign: "left",
    whiteSpace: "nowrap",
  };

  return (
    <div className="bc-sub" style={labSub}>
      <div style={labSubTitle}>Lease Expenses</div>
      <div style={{ overflowX: "auto" }}>
        <table style={{ ...labTable, minWidth: 1080 }}>
          <thead>
            <tr style={labHeadRow}>
              {/* Item gets a FIXED width so the table's surplus space lands in
                  the data columns, not in a gulf between the suite name and
                  its description. */}
              <th style={{ ...labTh, textAlign: "left", width: 105 }}>Item</th>
              <th style={{ ...labTh, textAlign: "left", minWidth: 175 }}>Space serves</th>
              <th style={{ ...labTh, width: 115 }}>Base ($/mo)</th>
              <th style={{ ...labTh, width: 105 }}>CAM ($/mo)</th>
              <th style={{ ...labTh, width: 125 }}>Charged ($/mo)</th>
              <th style={{ ...labTh, textAlign: "left", minWidth: 150 }}>÷ absorbed over</th>
              <th style={{ ...labTh, width: 100 }}>$ / run-day</th>
              <th style={{ ...labTh, width: 100 }}>Job (×{daysLabel})</th>
              <th style={{ ...labTh, width: 100 }}>$ / {unit}</th>
            </tr>
          </thead>
          <tbody>
            {suites.map((s) => {
              const multi = s.rows.length > 1;
              const suiteRate = s.rows.reduce((a, r) => a + (r.ratePerDay ?? 0), 0);
              const charged = s.rows.some((r) => (r.chargedMonthly ?? 0) > 0);
              const mute: React.CSSProperties = charged
                ? {}
                : { color: "var(--ink-3, #7b7364)" };
              return (
                <Fragment key={s.key}>
                  {s.rows.map((r, i) => (
                    // In a multi-row suite the divider belongs UNDER the
                    // subtotal, not between the suite's own rows and it — the
                    // subtotal is part of the suite's block, and a line above
                    // it reads as if the block ended one row early.
                    <tr
                      key={r.poolKey}
                      style={{
                        ...labBodyRow,
                        ...(multi && i === s.rows.length - 1
                          ? { borderBottom: "none" }
                          : {}),
                        ...mute,
                      }}
                    >
                      <td style={{ ...labTd, textAlign: "left", fontWeight: i === 0 ? 700 : 400 }}>
                        {i === 0 ? s.label : ""}
                      </td>
                      <td style={{ ...sub, lineHeight: 1.4 }}>
                        {servesLabel(r)}
                        <br />
                        <span style={{ fontSize: 11, opacity: 0.85 }}>
                          {servesDetail(r)}
                        </span>
                      </td>
                      <td style={num}>
                        <Tip tip={`${r.pctOfSuite ?? 100}% of ${s.label}'s lease rent`}>
                          {money(r.baseMonthly)}
                        </Tip>
                      </td>
                      <td style={num}>
                        <Tip tip={`${r.pctOfSuite ?? 100}% of ${s.label}'s CAM`}>
                          {money(r.camMonthly)}
                        </Tip>
                      </td>
                      <td style={num}>
                        <Tip tip={chargedTip(r)}>{money(r.chargedMonthly)}</Tip>
                      </td>
                      <td style={sub}>
                        {divisorLabel(r) ? (
                          <Tip tip={divisorTip(r)}>{divisorLabel(r)}</Tip>
                        ) : null}
                      </td>
                      <td style={num}>
                        {r.chargedMonthly && r.divisorDays ? (
                          <Tip tip={`${money(r.chargedMonthly)} ÷ ${money(r.divisorDays, 2)}`}>
                            {money(r.ratePerDay)}
                          </Tip>
                        ) : (
                          money(r.ratePerDay)
                        )}
                      </td>
                      <td style={num}>
                        {r.chargedMonthly && days !== null ? (
                          <Tip tip={`${money(r.ratePerDay)} × ${daysLabel} days this job holds the floor`}>
                            {moneyD(jobOf(r.ratePerDay))}
                          </Tip>
                        ) : (
                          moneyD(charged ? jobOf(r.ratePerDay) : null)
                        )}
                      </td>
                      <td style={num}>
                        {moneyD(charged ? perOf(r.ratePerDay) : null, dec)}
                      </td>
                    </tr>
                  ))}
                  {multi ? (
                    // Every money column foots, so the subtotal reads as a
                    // complete row of its own — the suite's whole lease, its
                    // whole CAM, and CP's whole slice — rather than a label
                    // floating five empty columns away from its numbers.
                    <tr key={`${s.key}-subtotal`} style={{ ...labBodyRow, fontSize: 12 }}>
                      <td style={{ ...sub, fontSize: 11.5 }}>suite subtotal</td>
                      <td style={labTd} />
                      <td style={{ ...num, fontWeight: 700 }}>
                        {money(s.rows.reduce((a, r) => a + (r.baseMonthly ?? 0), 0))}
                      </td>
                      <td style={{ ...num, fontWeight: 700 }}>
                        {money(s.rows.reduce((a, r) => a + (r.camMonthly ?? 0), 0))}
                      </td>
                      <td style={{ ...num, fontWeight: 700 }}>
                        {money(s.rows.reduce((a, r) => a + (r.chargedMonthly ?? 0), 0))}
                      </td>
                      <td style={labTd} />
                      <td style={{ ...num, fontWeight: 700 }}>{money(suiteRate)}</td>
                      <td style={{ ...num, fontWeight: 700 }}>{moneyD(jobOf(suiteRate))}</td>
                      <td style={{ ...num, fontWeight: 700 }}>{moneyD(perOf(suiteRate), dec)}</td>
                    </tr>
                  ) : null}
                </Fragment>
              );
            })}
            <tr style={labTotalRow}>
              <td style={{ ...labTh, textAlign: "left" }}>Group total</td>
              <td style={labTd} />
              <td style={num}>{money(totBase)}</td>
              <td style={num}>{money(totCam)}</td>
              <td style={num}>{money(totCharged)}</td>
              <td style={labTd} />
              <td style={num}>
                <Tip tip="Sum of every row above — the rate the model charges">
                  {money(priceRate)}
                </Tip>
              </td>
              <td style={num}>
                {days === null ? (
                  labSum(null)
                ) : (
                  <Tip tip={`${money(priceRate)} × ${daysLabel}`}>
                    {moneyD(priceRate * days)}
                  </Tip>
                )}
              </td>
              <td style={num}>
                {days === null || !quantity || quantity <= 0 ? (
                  labSum(null)
                ) : (
                  <Tip tip={`${money(priceRate * days)} ÷ ${quantity.toLocaleString()} ${unitPlural}`}>
                    {moneyD((priceRate * days) / quantity, dec)}
                  </Tip>
                )}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** One role line of the indirect-labour rate, from /api/overhead. */
export type IndirectBreakdownRow = {
  itemKey: string;
  roleLabel: string;
  poolKey: string;
  poolLabel: string;
  burdenedMonthly: number | null;
  chargedMonthly: number | null;
  divisorDays: number | null;
  ratePerDay: number | null;
  sharePctApplied: number | null;
};

/**
 * The Indirect Labor card when payroll is charged per RUN-DAY (v76).
 *
 * Same grammar as the lease table, grouped by POOL rather than suite because
 * a person belongs to a pool the way square feet do. Production-support
 * people pass through untouched (Burdened = Charged — their whole cost
 * serves production days, both floors, at equal weight per the 2026-08-30
 * decision); facility people show the margin-share haircut in the Charged
 * column, exactly where the lease's warehouse rows show it. The hand-typed
 * Share % is gone — nothing typed drives this table.
 */
export function IndirectBreakdownTable({
  rows,
  jobDays,
  quantity,
  effRate,
  dec = 4,
  unit = "bottle",
  unitPlural = "bottles",
  lineLabel = "CP",
}: {
  rows: IndirectBreakdownRow[];
  /** Decimal places for the per-unit column — the board-wide picker value. */
  dec?: number;
  /** What one unit is called on this calculator: "bottle" or "gummy". */
  unit?: string;
  unitPlural?: string;
  /** Short department name in captions: "CP" on the bottle board, "Gummy"
   *  on the formula editor. The share %s themselves come from the rows. */
  lineLabel?: string;
  jobDays: number | null;
  quantity: number | null;
  effRate: number | null;
}) {
  const money = (v: number | null | undefined, dec = 2) =>
    v === null || v === undefined
      ? "—"
      : v.toLocaleString("en-US", {
          minimumFractionDigits: dec,
          maximumFractionDigits: dec,
        });
  const moneyD = (v: number | null | undefined, dec = 2) =>
    v === null || v === undefined ? "—" : `$${money(v, dec)}`;
  const days = jobDays !== null && jobDays > 0 ? jobDays : null;
  const daysLabel =
    days === null ? "—" : days.toLocaleString("en-US", { maximumFractionDigits: 2 });
  const jobOf = (rate: number | null) =>
    rate === null || days === null ? null : rate * days;
  const perOf = (rate: number | null) => {
    const j = jobOf(rate);
    return j === null || !quantity || quantity <= 0 ? null : j / quantity;
  };

  // What the person actually DOES plus its scope — the justification for
  // their pool. "Both floors" marks a time-driven scope (production days can
  // charge them fairly); "entire operation" marks an economics-driven one
  // (they also serve floorless work like bulk resale, so margin share is the
  // only fair divisor). Per-role, because "goods and buying" stretched one
  // phrase over two different jobs.
  const SERVES: Record<string, string> = {
    production_manager: "oversees all production, both floors",
    plant_mechanic: "maintains all machines, both floors",
    quality_manager: "releases every job, both floors",
    quality_tech: "releases every job, both floors",
    quality_tech_ii: "releases every job, both floors",
    warehouse_staff: "moves goods, entire operation",
    purchasing_logistics: "buys materials, entire operation",
  };
  const serves = (r: IndirectBreakdownRow) =>
    SERVES[r.itemKey] ??
    (r.poolKey === "facility"
      ? "serves the entire operation"
      : "serves production, both floors");
  const divisorLabel = (r: IndirectBreakdownRow) =>
    r.divisorDays === null
      ? ""
      : r.poolKey === "facility"
        ? `${money(r.divisorDays, 2)} ${lineLabel} run-days`
        : `${money(r.divisorDays, 1)} days, all lines`;
  const divisorTip = (r: IndirectBreakdownRow) =>
    r.poolKey === "facility"
      ? "Run-days worked by Contract Packaging jobs alone, 12-month average"
      : "All production days in the plant: packaging run-days plus gummy batch-days, equal weight";
  const chargedTip = (r: IndirectBreakdownRow) =>
    r.sharePctApplied !== null
      ? `${money(r.burdenedMonthly)} × ${r.sharePctApplied}% ${lineLabel} margin share`
      : "Full burdened cost — this role serves production days wherever they happen";

  // Group by pool, preserving the resolver's order (production support first).
  const pools: { key: string; label: string; rows: IndirectBreakdownRow[] }[] = [];
  for (const r of rows) {
    const last = pools[pools.length - 1];
    if (last && last.key === r.poolKey) last.rows.push(r);
    else pools.push({ key: r.poolKey, label: r.poolLabel, rows: [r] });
  }

  const totRate = rows.reduce((s, r) => s + (r.ratePerDay ?? 0), 0);
  const priceRate = effRate ?? totRate;
  const totBurdened = rows.reduce((s, r) => s + (r.burdenedMonthly ?? 0), 0);
  const totCharged = rows.reduce((s, r) => s + (r.chargedMonthly ?? 0), 0);

  const num: React.CSSProperties = { ...labTd, whiteSpace: "nowrap" };
  const sub: React.CSSProperties = {
    ...labTd,
    fontSize: 12,
    color: "var(--ink-3, #7b7364)",
    textAlign: "left",
    whiteSpace: "nowrap",
  };

  return (
    <div className="bc-sub" style={labSub}>
      <div style={labSubTitle}>Indirect Labor</div>
      <div style={{ overflowX: "auto" }}>
        <table style={{ ...labTable, minWidth: 1050 }}>
          <thead>
            <tr style={labHeadRow}>
              <th style={{ ...labTh, textAlign: "left", width: 160 }}>Role</th>
              <th style={{ ...labTh, textAlign: "left", minWidth: 165 }}>Serves</th>
              <th style={{ ...labTh, width: 125 }}>Burdened ($/mo)</th>
              <th style={{ ...labTh, width: 120 }}>Charged ($/mo)</th>
              <th style={{ ...labTh, textAlign: "left", minWidth: 145 }}>÷ absorbed over</th>
              <th style={{ ...labTh, width: 100 }}>$ / run-day</th>
              <th style={{ ...labTh, width: 100 }}>Job (×{daysLabel})</th>
              <th style={{ ...labTh, width: 100 }}>$ / {unit}</th>
            </tr>
          </thead>
          <tbody>
            {pools.map((p) => {
              const poolRate = p.rows.reduce((a, r) => a + (r.ratePerDay ?? 0), 0);
              return (
                <Fragment key={p.key}>
                  <tr>
                    <td
                      colSpan={8}
                      style={{
                        ...labTd,
                        textAlign: "left",
                        fontSize: 11,
                        fontWeight: 700,
                        letterSpacing: "0.06em",
                        textTransform: "uppercase",
                        color: "var(--ink-3, #7b7364)",
                        paddingTop: 12,
                      }}
                    >
                      {p.key === "facility"
                        ? `Facility — × ${p.rows[0]?.sharePctApplied ?? ""}% ${lineLabel} margin share, like warehouse and office rent`
                        : "Production support — runs with the floors"}
                    </td>
                  </tr>
                  {p.rows.map((r, i) => (
                    <tr
                      key={r.itemKey}
                      style={{
                        ...labBodyRow,
                        ...(i === p.rows.length - 1 ? { borderBottom: "none" } : {}),
                      }}
                    >
                      <td style={{ ...labTd, textAlign: "left" }}>{r.roleLabel}</td>
                      <td style={sub}>{serves(r)}</td>
                      <td style={num}>{money(r.burdenedMonthly)}</td>
                      <td style={num}>
                        <Tip tip={chargedTip(r)}>{money(r.chargedMonthly)}</Tip>
                      </td>
                      <td style={sub}>
                        {divisorLabel(r) ? (
                          <Tip tip={divisorTip(r)}>{divisorLabel(r)}</Tip>
                        ) : null}
                      </td>
                      <td style={num}>
                        {r.chargedMonthly && r.divisorDays ? (
                          <Tip tip={`${money(r.chargedMonthly)} ÷ ${money(r.divisorDays, 2)}`}>
                            {money(r.ratePerDay)}
                          </Tip>
                        ) : (
                          money(r.ratePerDay)
                        )}
                      </td>
                      <td style={num}>
                        {days !== null && r.ratePerDay ? (
                          <Tip tip={`${money(r.ratePerDay)} × ${daysLabel} days`}>
                            {moneyD(jobOf(r.ratePerDay))}
                          </Tip>
                        ) : (
                          moneyD(jobOf(r.ratePerDay))
                        )}
                      </td>
                      <td style={num}>{moneyD(perOf(r.ratePerDay), dec)}</td>
                    </tr>
                  ))}
                  <tr style={{ ...labBodyRow, fontSize: 12 }}>
                    <td style={{ ...sub, fontSize: 11.5 }}>pool subtotal</td>
                    <td style={labTd} />
                    <td style={{ ...num, fontWeight: 700 }}>
                      {money(p.rows.reduce((a, r) => a + (r.burdenedMonthly ?? 0), 0))}
                    </td>
                    <td style={{ ...num, fontWeight: 700 }}>
                      {money(p.rows.reduce((a, r) => a + (r.chargedMonthly ?? 0), 0))}
                    </td>
                    <td style={labTd} />
                    <td style={{ ...num, fontWeight: 700 }}>{money(poolRate)}</td>
                    <td style={{ ...num, fontWeight: 700 }}>{moneyD(jobOf(poolRate))}</td>
                    <td style={{ ...num, fontWeight: 700 }}>{moneyD(perOf(poolRate), dec)}</td>
                  </tr>
                </Fragment>
              );
            })}
            <tr style={labTotalRow}>
              <td style={{ ...labTh, textAlign: "left" }}>Group total</td>
              <td style={labTd} />
              <td style={{ ...num, color: "var(--ink-3, #7b7364)" }}>{money(totBurdened)}</td>
              <td style={{ ...num, fontWeight: 700 }}>{money(totCharged)}</td>
              <td style={labTd} />
              <td style={num}>
                <Tip tip="Sum of every row above — the rate the model charges">
                  {money(priceRate)}
                </Tip>
              </td>
              <td style={num}>
                {days === null ? (
                  labSum(null)
                ) : (
                  <Tip tip={`${money(priceRate)} × ${daysLabel}`}>
                    {moneyD(priceRate * days)}
                  </Tip>
                )}
              </td>
              <td style={num}>
                {days === null || !quantity || quantity <= 0 ? (
                  labSum(null)
                ) : (
                  <Tip tip={`${money(priceRate * days)} ÷ ${quantity.toLocaleString()} ${unitPlural}`}>
                    {moneyD((priceRate * days) / quantity, dec)}
                  </Tip>
                )}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** One expense line of the other-expenses rate, from /api/overhead. */
export type OtherBreakdownRow = {
  itemKey: string;
  expenseLabel: string;
  qbAccount: string | null;
  poolKey: string;
  poolLabel: string;
  monthly: number | null;
  chargedMonthly: number | null;
  divisorDays: number | null;
  ratePerDay: number | null;
  sharePctApplied: number | null;
};

/**
 * The Other Expenses card when charged per RUN-DAY (v77) — the last
 * calendar-day holdout, on the same grammar as the lease and the people.
 * Electricity and repairs run with production days at equal weight;
 * everything else serves the entire operation and takes the margin share.
 */
export function OtherBreakdownTable({
  rows,
  jobDays,
  quantity,
  effRate,
  dec = 4,
  unit = "bottle",
  unitPlural = "bottles",
  lineLabel = "CP",
}: {
  rows: OtherBreakdownRow[];
  /** Decimal places for the per-unit column — the board-wide picker value. */
  dec?: number;
  /** What one unit is called on this calculator: "bottle" or "gummy". */
  unit?: string;
  unitPlural?: string;
  /** Short department name in captions: "CP" on the bottle board, "Gummy"
   *  on the formula editor. The share %s themselves come from the rows. */
  lineLabel?: string;
  jobDays: number | null;
  quantity: number | null;
  effRate: number | null;
}) {
  const money = (v: number | null | undefined, dec = 2) =>
    v === null || v === undefined
      ? "—"
      : v.toLocaleString("en-US", {
          minimumFractionDigits: dec,
          maximumFractionDigits: dec,
        });
  const moneyD = (v: number | null | undefined, dec = 2) =>
    v === null || v === undefined ? "—" : `$${money(v, dec)}`;
  const days = jobDays !== null && jobDays > 0 ? jobDays : null;
  const daysLabel =
    days === null ? "—" : days.toLocaleString("en-US", { maximumFractionDigits: 2 });
  const jobOf = (rate: number | null) =>
    rate === null || days === null ? null : rate * days;
  const perOf = (rate: number | null) => {
    const j = jobOf(rate);
    return j === null || !quantity || quantity <= 0 ? null : j / quantity;
  };

  const SERVES: Record<string, string> = {
    electricity: "powers the machines, both floors",
    repairs_maintenance: "maintains machines and building, both floors",
    warehouse_supplies: "goods handling, entire operation",
    insurance: "covers the entire operation",
    licenses_permits: "licenses the entire operation",
    cleaning: "janitorial, entire operation",
    other_utilities: "serves the entire operation",
  };
  const serves = (r: OtherBreakdownRow) =>
    SERVES[r.itemKey] ??
    (r.poolKey === "facility"
      ? "serves the entire operation"
      : "serves production, both floors");
  const divisorLabel = (r: OtherBreakdownRow) =>
    r.divisorDays === null
      ? ""
      : r.poolKey === "facility"
        ? `${money(r.divisorDays, 2)} ${lineLabel} run-days`
        : `${money(r.divisorDays, 1)} days, all lines`;
  const divisorTip = (r: OtherBreakdownRow) =>
    r.poolKey === "facility"
      ? "Run-days worked by Contract Packaging jobs alone, 12-month average"
      : "All production days in the plant: packaging run-days plus gummy batch-days, equal weight";
  const chargedTip = (r: OtherBreakdownRow) =>
    r.sharePctApplied !== null
      ? `${money(r.monthly)} × ${r.sharePctApplied}% ${lineLabel} margin share`
      : "Full monthly cost — this expense runs with production days";

  const pools: { key: string; rows: OtherBreakdownRow[] }[] = [];
  for (const r of rows) {
    const last = pools[pools.length - 1];
    if (last && last.key === r.poolKey) last.rows.push(r);
    else pools.push({ key: r.poolKey, rows: [r] });
  }

  const totRate = rows.reduce((s, r) => s + (r.ratePerDay ?? 0), 0);
  const priceRate = effRate ?? totRate;
  const totMonthly = rows.reduce((s, r) => s + (r.monthly ?? 0), 0);
  const totCharged = rows.reduce((s, r) => s + (r.chargedMonthly ?? 0), 0);

  const num: React.CSSProperties = { ...labTd, whiteSpace: "nowrap" };
  const sub: React.CSSProperties = {
    ...labTd,
    fontSize: 12,
    color: "var(--ink-3, #7b7364)",
    textAlign: "left",
    whiteSpace: "nowrap",
  };

  return (
    <div className="bc-sub" style={labSub}>
      <div style={labSubTitle}>Other Expenses</div>
      <div style={{ overflowX: "auto" }}>
        <table style={{ ...labTable, minWidth: 1050 }}>
          <thead>
            <tr style={labHeadRow}>
              <th style={{ ...labTh, textAlign: "left", width: 190 }}>Item</th>
              <th style={{ ...labTh, textAlign: "left", minWidth: 185 }}>Serves</th>
              <th style={{ ...labTh, width: 115 }}>Monthly ($/mo)</th>
              <th style={{ ...labTh, width: 120 }}>Charged ($/mo)</th>
              <th style={{ ...labTh, textAlign: "left", minWidth: 145 }}>÷ absorbed over</th>
              <th style={{ ...labTh, width: 100 }}>$ / run-day</th>
              <th style={{ ...labTh, width: 100 }}>Job (×{daysLabel})</th>
              <th style={{ ...labTh, width: 100 }}>$ / {unit}</th>
            </tr>
          </thead>
          <tbody>
            {pools.map((p) => {
              const poolRate = p.rows.reduce((a, r) => a + (r.ratePerDay ?? 0), 0);
              return (
                <Fragment key={p.key}>
                  <tr>
                    <td
                      colSpan={8}
                      style={{
                        ...labTd,
                        textAlign: "left",
                        fontSize: 11,
                        fontWeight: 700,
                        letterSpacing: "0.06em",
                        textTransform: "uppercase",
                        color: "var(--ink-3, #7b7364)",
                        paddingTop: 12,
                      }}
                    >
                      {p.key === "facility"
                        ? `Facility — × ${p.rows[0]?.sharePctApplied ?? ""}% ${lineLabel} margin share, like warehouse and office rent`
                        : "Production support — runs with the floors"}
                    </td>
                  </tr>
                  {p.rows.map((r, i) => (
                    <tr
                      key={r.itemKey}
                      style={{
                        ...labBodyRow,
                        ...(i === p.rows.length - 1 ? { borderBottom: "none" } : {}),
                      }}
                    >
                      <td style={{ ...labTd, textAlign: "left", lineHeight: 1.4 }}>
                        {r.expenseLabel}
                        {r.qbAccount ? (
                          <>
                            <br />
                            <span style={{ fontSize: 11, color: "var(--ink-3, #7b7364)" }}>
                              QB {r.qbAccount}
                            </span>
                          </>
                        ) : null}
                      </td>
                      <td style={sub}>{serves(r)}</td>
                      <td style={num}>{money(r.monthly)}</td>
                      <td style={num}>
                        <Tip tip={chargedTip(r)}>{money(r.chargedMonthly)}</Tip>
                      </td>
                      <td style={sub}>
                        {divisorLabel(r) ? (
                          <Tip tip={divisorTip(r)}>{divisorLabel(r)}</Tip>
                        ) : null}
                      </td>
                      <td style={num}>
                        {r.chargedMonthly && r.divisorDays ? (
                          <Tip tip={`${money(r.chargedMonthly)} ÷ ${money(r.divisorDays, 2)}`}>
                            {money(r.ratePerDay)}
                          </Tip>
                        ) : (
                          money(r.ratePerDay)
                        )}
                      </td>
                      <td style={num}>
                        {days !== null && r.ratePerDay ? (
                          <Tip tip={`${money(r.ratePerDay)} × ${daysLabel} days`}>
                            {moneyD(jobOf(r.ratePerDay))}
                          </Tip>
                        ) : (
                          moneyD(jobOf(r.ratePerDay))
                        )}
                      </td>
                      <td style={num}>{moneyD(perOf(r.ratePerDay), dec)}</td>
                    </tr>
                  ))}
                  <tr style={{ ...labBodyRow, fontSize: 12 }}>
                    <td style={{ ...sub, fontSize: 11.5 }}>pool subtotal</td>
                    <td style={labTd} />
                    <td style={{ ...num, fontWeight: 700 }}>
                      {money(p.rows.reduce((a, r) => a + (r.monthly ?? 0), 0))}
                    </td>
                    <td style={{ ...num, fontWeight: 700 }}>
                      {money(p.rows.reduce((a, r) => a + (r.chargedMonthly ?? 0), 0))}
                    </td>
                    <td style={labTd} />
                    <td style={{ ...num, fontWeight: 700 }}>{money(poolRate)}</td>
                    <td style={{ ...num, fontWeight: 700 }}>{moneyD(jobOf(poolRate))}</td>
                    <td style={{ ...num, fontWeight: 700 }}>{moneyD(perOf(poolRate), dec)}</td>
                  </tr>
                </Fragment>
              );
            })}
            <tr style={labTotalRow}>
              <td style={{ ...labTh, textAlign: "left" }}>Group total</td>
              <td style={labTd} />
              <td style={{ ...num, color: "var(--ink-3, #7b7364)" }}>{money(totMonthly)}</td>
              <td style={{ ...num, fontWeight: 700 }}>{money(totCharged)}</td>
              <td style={labTd} />
              <td style={num}>
                <Tip tip="Sum of every row above — the rate the model charges">
                  {money(priceRate)}
                </Tip>
              </td>
              <td style={num}>
                {days === null ? (
                  labSum(null)
                ) : (
                  <Tip tip={`${money(priceRate)} × ${daysLabel}`}>
                    {moneyD(priceRate * days)}
                  </Tip>
                )}
              </td>
              <td style={num}>
                {days === null || !quantity || quantity <= 0 ? (
                  labSum(null)
                ) : (
                  <Tip tip={`${money(priceRate * days)} ÷ ${quantity.toLocaleString()} ${unitPlural}`}>
                    {moneyD((priceRate * days) / quantity, dec)}
                  </Tip>
                )}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}

