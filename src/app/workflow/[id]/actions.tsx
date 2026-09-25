"use client";

// Interactive bits for /workflow/[id]: the Push/Update Monday button, the
// Delete button, and the toast. Lives in its own client module so the parent
// server component can do `auth.getUser()` + Supabase fetches without dragging
// the whole page over the client boundary.

import { useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { useRouter } from "next/navigation";
import {
  WORKFLOW_STATUS_LABELS,
  formatQuoteNumber,
  type MondayMaterialRow,
  type SalesOrder,
  type WorkflowRow,
  type WorkflowStatus,
} from "@/lib/workflows";
import { type Customer } from "@/lib/supabase/rows";
import { buildQuoteHtml } from "@/app/pricing/PricingCalculator";

// Draft row used by the inline Won form. Both fields are strings until we
// validate-and-coerce on save (numbers via parseFloat). Keeps controlled
// inputs predictable and avoids "" → 0 surprises while the user types.
type SalesOrderDraft = { so_number: string; value: string };

// Strip everything except digits + one decimal point, then re-insert commas
// every 3 digits to the left of the decimal so the user sees "1,234.56" as
// they type. The value gets parsed back to a Number on submit.
function formatValueInput(raw: string): string {
  const cleaned = raw.replace(/[^\d.]/g, "");
  // Collapse multiple dots — keep only the first.
  const firstDot = cleaned.indexOf(".");
  const safe =
    firstDot === -1
      ? cleaned
      : cleaned.slice(0, firstDot + 1) + cleaned.slice(firstDot + 1).replace(/\./g, "");
  const [intPart, decPart] = safe.split(".");
  const withCommas = (intPart || "").replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  if (decPart === undefined) return withCommas;
  // Cap decimals at 2 places — anything more is dropped.
  return `${withCommas}.${decPart.slice(0, 2)}`;
}

function parseValueInput(formatted: string): number {
  return parseFloat(formatted.replace(/,/g, ""));
}

// ----- Action-card icons ---------------------------------------------------
// Inline Tabler outline icons (MIT) at 20px so they inherit the card's text
// color. Monday gets the real brand mark, served from monday.com's own CDN
// (their apple-touch-icon) rather than a hand-drawn approximation.
const iconProps = {
  width: 20,
  height: 20,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
};

function IconSliders() {
  return (
    <svg {...iconProps}>
      <circle cx="14" cy="6" r="2" />
      <path d="M4 6h8M16 6h4" />
      <circle cx="8" cy="12" r="2" />
      <path d="M4 12h2M10 12h10" />
      <circle cx="17" cy="18" r="2" />
      <path d="M4 18h11M19 18h1" />
    </svg>
  );
}

function IconCalculator() {
  return (
    <svg {...iconProps}>
      <rect x="4" y="3" width="16" height="18" rx="2" />
      <rect x="8" y="7" width="8" height="3" rx="1" />
      <path d="M8 14v.01M12 14v.01M16 14v.01M8 17v.01M12 17v.01M16 17v.01" />
    </svg>
  );
}

function IconFileDollar() {
  return (
    <svg {...iconProps}>
      <path d="M14 3v4a1 1 0 0 0 1 1h4" />
      <path d="M17 21H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7l5 5v11a2 2 0 0 1-2 2z" />
      <path d="M14 11h-2.5a1.5 1.5 0 0 0 0 3h1a1.5 1.5 0 0 1 0 3H10" />
      <path d="M12 17v1m0-8v1" />
    </svg>
  );
}

function IconMonday() {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src="https://cdn.monday.com/apple-touch-icon-180x180.png"
      alt=""
      width={20}
      height={20}
      style={{ borderRadius: 4, display: "block" }}
      aria-hidden
    />
  );
}

// Icon + title on one row, subtitle below — shared by all action cards.
const actionTitleRow: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
};

function valueForDisplay(n: number): string {
  // For pre-filling the edit form with existing SOs: re-format with commas
  // and two decimals.
  return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function draftsFromSalesOrders(rows: SalesOrder[]): SalesOrderDraft[] {
  if (!rows || rows.length === 0) return [{ so_number: "", value: "" }];
  return rows.map((r) => ({ so_number: r.so_number, value: valueForDisplay(r.value) }));
}

type ProductRow = { id: string; name: string; fp_code: string | null };

type Props = {
  workflow: WorkflowRow;
  customer: Pick<Customer, "id" | "name"> | null;
  productMap: Record<string, ProductRow>;
  isOwner: boolean;
  isAdmin: boolean;
  // Auto-computed description label ("Omega 3 + Vitamin D3 Softgels") used as
  // the placeholder for the inline description editor. When the user clears
  // their override we fall back to this on the listing page too.
  autoDescription: string;
};

const primaryAction: CSSProperties = {
  display: "flex", flexDirection: "column", gap: 4,
  padding: "16px 18px", borderRadius: 10, border: "1.5px solid var(--teal-900)",
  background: "var(--teal-900)", color: "#fff", cursor: "pointer",
  fontFamily: "inherit", fontSize: 15, fontWeight: 700, textAlign: "left",
  transition: "transform 0.12s ease, box-shadow 0.12s ease",
};
const editAction: CSSProperties = {
  display: "flex", flexDirection: "column", gap: 4,
  padding: "16px 18px", borderRadius: 10, border: "1.5px solid #e3dcc9",
  background: "#fffdf8", color: "var(--teal-900)", cursor: "pointer",
  fontFamily: "inherit", fontSize: 15, fontWeight: 700, textAlign: "left",
  textDecoration: "none",
};
const deleteAction: CSSProperties = {
  display: "flex", flexDirection: "column", gap: 4,
  padding: "16px 18px", borderRadius: 10, border: "1.5px solid #d8b3b3",
  background: "#fffdf8", color: "#8b2f2f", cursor: "pointer",
  fontFamily: "inherit", fontSize: 15, fontWeight: 700, textAlign: "left",
};
const blankAction: CSSProperties = {
  display: "flex", flexDirection: "column", gap: 4,
  padding: "16px 18px", borderRadius: 10, border: "1.5px dashed #e3dcc9",
  background: "#fffdf8", color: "var(--ink-3)", cursor: "not-allowed",
  fontFamily: "inherit", fontSize: 15, fontWeight: 700, textAlign: "left",
};

function cleanQty(q: string): string {
  const t = q.replace(/,/g, "").trim();
  return /^\d+(\.\d+)?$/.test(t) ? t : "";
}

export default function WorkflowActions({
  workflow,
  customer,
  productMap,
  isOwner,
  isAdmin,
  autoDescription,
}: Props) {
  const router = useRouter();

  // Customer-facing quotes already saved on this workflow by the pricing
  // calculator. Newest first — the last thing sent is the thing you are
  // usually looking for.
  const issuedQuotes = [...(workflow.state?.issuedQuotes ?? [])].sort((a, b) =>
    (b.savedAt ?? "").localeCompare(a.savedAt ?? ""),
  );

  /**
   * Reopen the saved quotes in the same popup the calculator uses, with
   * `startTabId` selected. Passing the saved tabs in makes buildQuoteHtml
   * render THEM rather than synthesise a fresh sheet, so there are no line
   * items to hand it. Saving is off: this is a record of what went out, and
   * a re-issue belongs in the calculator where the numbers live.
   */
  function openIssuedQuote(startTabId: string) {
    const html = buildQuoteHtml({
      customerName: customer?.name ?? null,
      customerAddress: null,
      customerContact: null,
      customerEmail: null,
      workflowLabel: formatQuoteNumber(workflow.quote_number),
      preparerName: "",
      preparerEmail: "",
      lineItems: [],
      backUrl:
        typeof window !== "undefined"
          ? `${window.location.origin}/workflow/${workflow.id}`
          : null,
      backLabel: "Back to workflow",
      initialTabs: issuedQuotes,
      startTabId,
      saveEnabled: false,
    });
    const url = URL.createObjectURL(new Blob([html], { type: "text/html" }));
    const w = window.open(url, "_blank");
    if (!w) {
      setToast(
        "Couldn't open the quote — allow popups for this site and try again.",
      );
      URL.revokeObjectURL(url);
      return;
    }
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  const [submitting, setSubmitting] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  // Inline description editor. Persists to workflows.description_override.
  // We hold the input as the "draft" while editing, then commit on blur or
  // Enter. Empty/whitespace clears the override and the listing reverts to
  // the auto-computed label. baseline is the last value we successfully
  // committed — used to skip no-op saves and to roll back on error.
  const initialOverride = workflow.description_override?.trim() ?? "";
  const [descDraft, setDescDraft] = useState<string>(initialOverride);
  const [descBaseline, setDescBaseline] = useState<string>(initialOverride);
  const [descSaving, setDescSaving] = useState(false);

  // Local mirror of the monday URL so the button can flip its label without
  // a full page refresh (server-rendered URL is the source of truth on load).
  const [mondayUrl, setMondayUrl] = useState<string | null>(workflow.monday_item_url);
  const alreadyPushed = !!mondayUrl;

  // Optimistic status — the API roundtrips and we render the new pill
  // immediately. Falls back to the server value on next render.
  const [status, setStatus] = useState<WorkflowStatus>(workflow.status ?? "in_progress");
  const [statusSaving, setStatusSaving] = useState<WorkflowStatus | null>(null);

  // Inline Sales Order form. Opens when the user clicks the Won pill (either
  // to flip *into* Won, or to edit the SOs while already Won). We hold the
  // current SOs locally so the summary card can re-render after a save
  // without waiting for the router refresh roundtrip.
  const [salesOrders, setSalesOrders] = useState<SalesOrder[]>(workflow.sales_orders ?? []);
  const [soFormOpen, setSoFormOpen] = useState(false);
  const [soDrafts, setSoDrafts] = useState<SalesOrderDraft[]>(
    draftsFromSalesOrders(workflow.sales_orders ?? []),
  );
  const [soError, setSoError] = useState<string | null>(null);
  const [soSaving, setSoSaving] = useState(false);

  const showToast = (msg: string, ms = 5500) => {
    setToast(msg);
    window.setTimeout(() => setToast((prev) => (prev === msg ? null : prev)), ms);
  };

  // ----- PC-gummy "Materials for Rosy" pre-push review --------------------
  // For Bulk → Gummy → Manufactured-at-PharmaCenter workflows the sourcing
  // ask isn't the finished product (we make it) — it's the raw materials on
  // the formula's Material Costs card. Push opens this review screen first:
  // reorder (drag), delete, edit quantities, add rows; Water never appears.
  // The curated list is saved on the workflow at push time so the next push
  // seeds from the user's last edits.
  const wfState = workflow.state;
  const gummyDosageOrForm = (wfState.form ?? "") || (wfState.dosage ?? "");
  const isPcGummy =
    (gummyDosageOrForm === "gummy" || gummyDosageOrForm === "gummies") &&
    (wfState.source ?? "") === "pharmacenter";

  const [matOpen, setMatOpen] = useState(false);
  const [matLoading, setMatLoading] = useState(false);
  const [matError, setMatError] = useState<string | null>(null);
  const [matRows, setMatRows] = useState<MondayMaterialRow[]>([]);
  const [matDragIdx, setMatDragIdx] = useState<number | null>(null);
  const [matDropIdx, setMatDropIdx] = useState<number | null>(null);

  const newRowId = () => `mat_${Math.random().toString(36).slice(2, 10)}`;
  const isWaterName = (n: string) => {
    const t = n.trim().toLowerCase();
    return t === "water" || t === "agua";
  };

  const openMaterials = async () => {
    setMatOpen(true);
    setMatError(null);
    // Saved list from a previous push wins — it carries the user's edits.
    const saved = wfState.mondayMaterials;
    if (saved && saved.length > 0) {
      setMatRows(saved.filter((r) => !isWaterName(r.name)));
      return;
    }
    await seedFromFormula();
  };

  // Seed (or re-seed, via the "Reseed from formula" link) from the pinned
  // formula(s)' Material Costs tables. Discards any rows on screen.
  const seedFromFormula = async () => {
    setMatError(null);
    const formulaIds = Array.from(
      new Set(
        wfState.products
          .map((p) => p.pinnedFormula?.formulaId)
          .filter((id): id is string => !!id),
      ),
    );
    if (formulaIds.length === 0) {
      setMatRows([]);
      setMatError(
        "No formula is pinned to this workflow — add rows by hand, or pin a formula on the workflow first.",
      );
      return;
    }
    setMatLoading(true);
    try {
      const seeded: MondayMaterialRow[] = [];
      for (const fid of formulaIds) {
        const res = await fetch(`/api/formulas/${fid}`, { cache: "no-store" });
        const data = await res.json();
        if (!res.ok || !data?.ok) throw new Error(data?.error || `HTTP ${res.status}`);
        type ApiMaterial = { name: string; fpCode?: string | null; totalKg: number; source: string };
        const mats: ApiMaterial[] =
          (data.latestVersion?.costingComputed?.materials as ApiMaterial[] | undefined) ?? [];
        for (const m of mats) {
          if (isWaterName(m.name)) continue; // water is never quoted
          seeded.push({
            id: newRowId(),
            // Prefix the Fishbowl product code when the material has one —
            // same "PC-RW-0010 · Pectin Classic CS 502" convention as the
            // formula editor's Material Costs table. Lives in the editable
            // name so the pusher can trim it if they want.
            name: m.fpCode ? `${m.fpCode} · ${m.name}` : m.name,
            qty: String(m.totalKg),
            unit: "kg",
            customerSupplied: m.source === "Customer Supplied",
          });
        }
      }
      setMatRows(seeded);
      if (seeded.length === 0) {
        setMatError(
          "The formula's Costing tab has no material rows yet — fill it in, or add rows by hand.",
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setMatRows([]);
      setMatError(`Couldn't load the formula's materials: ${msg}. You can still add rows by hand.`);
    } finally {
      setMatLoading(false);
    }
  };

  const setMatField = (id: string, field: "name" | "qty" | "unit", val: string) => {
    setMatRows((rows) => rows.map((r) => (r.id === id ? { ...r, [field]: val } : r)));
  };
  const removeMatRow = (id: string) => {
    setMatRows((rows) => rows.filter((r) => r.id !== id));
  };
  const addMatRow = () => {
    setMatRows((rows) => [
      ...rows,
      { id: newRowId(), name: "", qty: "", unit: "kg", customerSupplied: false },
    ]);
  };

  // "+ From Fishbowl" — type-to-search over the synced raw_materials table
  // (Fishbowl PARTS with -RW- in the number: PC-RW, CA-RW, …). The products
  // table only carries Fishbowl *product* records, so a raw material with no
  // product wrapper (e.g. PC-RW-0068 Melatonin) would never appear there.
  // The full list is small (~120 rows) — fetch once, filter locally, hyphens
  // kept so "PC-RW-0012" matches (same rule as every picker in the app).
  // Picking adds a "CODE · Name" row with an empty qty for the pusher to fill.
  type MatPick = { id: string; fp_code: string | null; name: string; unit: string };
  const [matPickerOpen, setMatPickerOpen] = useState(false);
  const [matSearch, setMatSearch] = useState("");
  const [matResults, setMatResults] = useState<MatPick[]>([]);
  const [matSearching, setMatSearching] = useState(false);
  const matAllRef = useRef<MatPick[] | null>(null);

  const loadMatAll = async (): Promise<MatPick[]> => {
    if (matAllRef.current) return matAllRef.current;
    const res = await fetch("/api/raw-materials");
    const json = (await res.json()) as {
      ok?: boolean;
      raw_materials?: Array<{
        id: string;
        fp_code: string | null;
        name: string | null;
        default_unit: string | null;
        active: boolean;
      }>;
    };
    const all: MatPick[] = (json.raw_materials ?? [])
      .filter((m) => m.active && m.name)
      .map((m) => ({
        id: m.id,
        fp_code: m.fp_code,
        name: m.name as string,
        unit: m.default_unit || "kg",
      }))
      .sort((a, b) => (a.fp_code ?? "￿").localeCompare(b.fp_code ?? "￿"));
    matAllRef.current = all;
    return all;
  };

  const runMatSearch = async (q: string) => {
    setMatSearch(q);
    const t = q.trim().toLowerCase();
    if (t.length < 2) {
      setMatResults([]);
      return;
    }
    setMatSearching(true);
    try {
      const all = await loadMatAll();
      setMatResults(
        all
          .filter(
            (m) =>
              m.name.toLowerCase().includes(t) ||
              (m.fp_code ?? "").toLowerCase().includes(t),
          )
          .slice(0, 12),
      );
    } catch {
      setMatResults([]);
    } finally {
      setMatSearching(false);
    }
  };

  const addMatFromFishbowl = (p: { fp_code: string | null; name: string; unit?: string }) => {
    setMatRows((rows) => [
      ...rows,
      {
        id: newRowId(),
        name: p.fp_code ? `${p.fp_code} · ${p.name}` : p.name,
        qty: "",
        unit: p.unit || "kg",
        customerSupplied: false,
      },
    ]);
    setMatSearch("");
    setMatResults([]);
    setMatPickerOpen(false);
  };
  const reorderMatRows = (from: number, to: number) => {
    setMatRows((rows) => {
      if (from === to || from < 0 || to < 0 || from >= rows.length || to >= rows.length) return rows;
      const next = rows.slice();
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return next;
    });
  };

  const confirmMaterialsPush = async () => {
    const cleaned = matRows
      .map((r) => ({ ...r, name: r.name.trim(), qty: r.qty.trim(), unit: r.unit.trim() || "kg" }))
      .filter((r) => r.name.length > 0);
    if (cleaned.length === 0) {
      setMatError("Add at least one material to quote.");
      return;
    }
    setMatError(null);
    await pushToMonday(cleaned);
  };

  const openSoForm = (initial: SalesOrder[]) => {
    setSoDrafts(draftsFromSalesOrders(initial));
    setSoError(null);
    setSoFormOpen(true);
  };

  const closeSoForm = () => {
    setSoFormOpen(false);
    setSoError(null);
  };

  // Won click: either open the form (to enter SOs) or, if already won, open
  // it pre-populated with the current SOs so the user can tweak them.
  const onWonClick = () => {
    if (statusSaving || soSaving) return;
    openSoForm(salesOrders);
  };

  // In-progress / Lost click. If we're leaving Won, warn first — server will
  // clear sales_orders, and we don't want that to be a silent surprise.
  const onNonWonClick = async (next: WorkflowStatus) => {
    if (status === next || statusSaving || soSaving) return;
    if (status === "won") {
      const ok = window.confirm(
        "Changing away from Won will clear the recorded sales orders. Continue?",
      );
      if (!ok) return;
    }
    const prev = status;
    const prevSos = salesOrders;
    setStatus(next);
    setSalesOrders([]);
    setStatusSaving(next);
    try {
      const res = await fetch(`/api/workflows/${workflow.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: next }),
      });
      const data = await res.json();
      if (!res.ok || !data?.ok) {
        setStatus(prev);
        setSalesOrders(prevSos);
        showToast(`Couldn't change status: ${data?.error || res.status}`, 6500);
        return;
      }
      showToast(`Marked as ${WORKFLOW_STATUS_LABELS[next]}.`);
      router.refresh();
    } catch (err) {
      setStatus(prev);
      setSalesOrders(prevSos);
      const msg = err instanceof Error ? err.message : String(err);
      showToast(`Status save errored: ${msg}`, 6500);
    } finally {
      setStatusSaving(null);
    }
  };

  const setDraftField = (idx: number, field: keyof SalesOrderDraft, val: string) => {
    setSoDrafts((rows) => rows.map((r, i) => (i === idx ? { ...r, [field]: val } : r)));
  };
  const addDraftRow = () => {
    setSoDrafts((rows) => [...rows, { so_number: "", value: "" }]);
  };
  const removeDraftRow = (idx: number) => {
    setSoDrafts((rows) => (rows.length <= 1 ? rows : rows.filter((_, i) => i !== idx)));
  };

  const submitSoForm = async () => {
    if (soSaving) return;
    // Validate: at least one row, every row has a non-empty SO + value > 0.
    const cleaned: SalesOrder[] = [];
    for (const d of soDrafts) {
      const so = d.so_number.trim();
      const val = parseValueInput(d.value);
      if (!so) {
        setSoError("Every row needs an SO number.");
        return;
      }
      if (!Number.isFinite(val) || val <= 0) {
        setSoError("Every row needs a dollar value greater than zero.");
        return;
      }
      cleaned.push({ so_number: so, value: val });
    }
    if (cleaned.length === 0) {
      setSoError("Add at least one sales order.");
      return;
    }

    // Optimistic: flip status + SOs immediately, roll back on error.
    const wasWon = status === "won";
    const prevStatus = status;
    const prevSos = salesOrders;
    setStatus("won");
    setSalesOrders(cleaned);
    setSoError(null);
    setSoSaving(true);
    try {
      const body = wasWon
        ? { sales_orders: cleaned }
        : { status: "won" as const, sales_orders: cleaned };
      const res = await fetch(`/api/workflows/${workflow.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok || !data?.ok) {
        setStatus(prevStatus);
        setSalesOrders(prevSos);
        showToast(`Couldn't save sales orders: ${data?.error || res.status}`, 6500);
        return;
      }
      showToast(wasWon ? "Sales orders updated." : "Marked as Won.");
      setSoFormOpen(false);
      router.refresh();
    } catch (err) {
      setStatus(prevStatus);
      setSalesOrders(prevSos);
      const msg = err instanceof Error ? err.message : String(err);
      showToast(`Sales order save errored: ${msg}`, 6500);
    } finally {
      setSoSaving(false);
    }
  };

  const commitDescription = async () => {
    const next = descDraft.trim();
    if (next === descBaseline) return; // no-op save
    if (descSaving) return;
    setDescSaving(true);
    const prevBaseline = descBaseline;
    // Optimistic: assume the save succeeds and only roll back on error.
    setDescBaseline(next);
    try {
      const res = await fetch(`/api/workflows/${workflow.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        // Send null when cleared so the API stores NULL and the listing
        // falls back to the auto-label.
        body: JSON.stringify({ description_override: next === "" ? null : next }),
      });
      const data = await res.json();
      if (!res.ok || !data?.ok) {
        setDescBaseline(prevBaseline);
        setDescDraft(prevBaseline);
        const reason = data?.error || `HTTP ${res.status}`;
        if (reason === "description_too_long") {
          showToast("Description is too long — keep it under 200 characters.", 6500);
        } else {
          showToast(`Couldn't save description: ${reason}`, 6500);
        }
        return;
      }
      showToast(next === "" ? "Reset to default description." : "Description saved.", 3500);
      router.refresh();
    } catch (err) {
      setDescBaseline(prevBaseline);
      setDescDraft(prevBaseline);
      const msg = err instanceof Error ? err.message : String(err);
      showToast(`Description save errored: ${msg}`, 6500);
    } finally {
      setDescSaving(false);
    }
  };

  const onDescKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      e.currentTarget.blur(); // triggers commit via onBlur
    } else if (e.key === "Escape") {
      e.preventDefault();
      setDescDraft(descBaseline); // discard pending edits
      e.currentTarget.blur();
    }
  };

  const pushToMonday = async (materials?: MondayMaterialRow[] | null) => {
    if (submitting) return;
    setSubmitting(true);
    try {
      const state = workflow.state;
      const products = state.products.map((p) => ({
        productId: p.productId,
        productName:
          (p.mode === "new"
            ? p.newProduct.name_desc
            : productMap[p.productId ?? ""]?.name ?? null) ||
          // PC-gummy products carry their identity on the pinned formula.
          p.pinnedFormula?.name ||
          null,
        productCode:
          p.mode === "new" ? null : productMap[p.productId ?? ""]?.fp_code ?? null,
        // "F0017"-style tag so the monday item can name the formula.
        formulaLabel: p.pinnedFormula
          ? `F${String(p.pinnedFormula.formulaNumber).padStart(4, "0")}`
          : null,
        notes: p.mode === "new" ? p.newProduct.notes : "",
        quantities: p.quantities.map(cleanQty).filter((q) => q.length > 0),
        attachments: p.attachments,
        // Carry the source mode through so the route can filter out stock
        // items from the items-to-source list before sending to Rosy.
        sourceMode: p.sourceMode ?? "purchase",
      }));
      const customerName =
        state.customerMode === "existing" ? customer?.name ?? null : state.newCustomer.name;

      const mode: "create" | "update" = alreadyPushed ? "update" : "create";

      const payload = {
        workflowId: workflow.id,
        mode,
        type: state.type,
        form: state.form,
        source: state.source,
        customer: state.customerMode === "existing" ? state.customerId : "new",
        customerName,
        newCustomer: state.customerMode === "new" ? state.newCustomer : null,
        products,
        // PC-gummy pushes: the curated raw-materials list from the review
        // screen. Presence of this array flips the route into its
        // "please quote these raw materials" message shape.
        materialsForQuote:
          materials && materials.length > 0
            ? materials.map((m) => ({
                name: m.name,
                qty: m.qty,
                unit: m.unit,
                customerSupplied: m.customerSupplied,
              }))
            : undefined,
      };

      const res = await fetch("/api/monday/create-item", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok || !data?.ok) {
        const reason = data?.error || `HTTP ${res.status}`;
        if (reason === "not_signed_in") {
          showToast("You need to sign in first.");
          return;
        }
        if (reason === "wrong_domain") {
          showToast("Only @pharmacenterusa.com accounts can push to monday.");
          return;
        }
        if (reason === "all_products_in_stock") {
          showToast(
            "Nothing to push — every product on this workflow is marked Existing stock. Mark at least one as Purchase needed first.",
            8000,
          );
          return;
        }
        showToast(`monday push failed: ${reason}`, 6500);
        return;
      }
      const url = data.item?.url || mondayUrl;
      if (url) setMondayUrl(url);
      const totalFiles = products.reduce((n, p) => n + p.attachments.length, 0);
      const uploaded = data.uploaded ?? 0;
      const skipped = data.skipped ?? 0;
      const verb = mode === "update" ? "Update posted to monday" : "Added to monday";
      // For an update push we want the user to know that files already on the
      // monday item weren't re-uploaded (that's the point of dedup). For a
      // create push, skipped should be zero so we don't mention it.
      const fileMsg =
        totalFiles === 0
          ? `${verb} — opening the item in a new tab.`
          : uploaded === 0 && skipped > 0
            ? `${verb}. No new files — ${skipped} already on the item.`
            : skipped > 0
              ? `${verb} with ${uploaded} new attachment${uploaded === 1 ? "" : "s"} (${skipped} already on the item).`
              : uploaded === totalFiles
                ? `${verb} with ${uploaded} attachment${uploaded === 1 ? "" : "s"}.`
                : `${verb}, but only ${uploaded}/${totalFiles} attachments uploaded.`;
      showToast(fileMsg);
      setMatOpen(false);
      if (url) window.open(url, "_blank", "noopener,noreferrer");
      // Refresh server-side data so the "Last pushed" timestamp is current.
      router.refresh();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      showToast(`monday push errored: ${msg}`, 6500);
    } finally {
      setSubmitting(false);
    }
  };

  const deleteWorkflow = async () => {
    if (deleting) return;
    const ok = window.confirm(
      "Delete this workflow? This cannot be undone. Files in storage will remain.",
    );
    if (!ok) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/workflows/${workflow.id}`, { method: "DELETE" });
      const data = await res.json();
      if (!res.ok || !data?.ok) {
        const reason = data?.error || `HTTP ${res.status}`;
        showToast(
          reason === "forbidden"
            ? "Only the workflow owner or an admin can delete this."
            : `Delete failed: ${reason}`,
          6500,
        );
        setDeleting(false);
        return;
      }
      router.push("/workflows");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      showToast(`Delete errored: ${msg}`, 6500);
      setDeleting(false);
    }
  };

  const canDelete = isOwner || isAdmin;

  /**
   * Contract-packaging bottles. These jobs price from their own board, which
   * models components + line crew + overhead + margin. The generic pricing
   * calculator models an imported landed cost instead, so it is hidden here
   * rather than left as a trap that quotes from the wrong basis.
   */
  const isCpBottles =
    (workflow.state.type ?? "") === "contract-packaging" &&
    (workflow.state.form ?? "") === "bottles";

  /** Contract-packaging blisters — same reasoning, its own board. */
  const isCpBlisters =
    (workflow.state.type ?? "") === "contract-packaging" &&
    (workflow.state.form ?? "") === "blisters";

  /** Contract-packaging pouches / stand-up bags — same reasoning again. */
  const isCpPouches =
    (workflow.state.type ?? "") === "contract-packaging" &&
    (workflow.state.form ?? "") === "pouches";

  /**
   * Finished Product — bulk + packaging priced as one retail-ready unit, on a
   * two-tab calculator: the Bulk tab is the generic pricing calculator, the
   * Packaging tab is the board for the chosen packaging type. The quote
   * document comes from the Packaging tab (it carries the finished-unit
   * price), so the generic Issue Quote is not offered here.
   */
  const isFinishedProduct =
    (workflow.state.type ?? "") === "finished-product";

  /** Contract-packaging sachets — the pouch board's sibling. */
  const isCpSachets =
    (workflow.state.type ?? "") === "contract-packaging" &&
    (workflow.state.form ?? "") === "sachets";

  const STATUS_ORDER: WorkflowStatus[] = ["in_progress", "won", "lost"];

  return (
    <>
      <div className="description-editor">
        <label htmlFor="workflow-description-input" className="description-editor__label">
          Description
        </label>
        <div className="description-editor__field">
          <input
            id="workflow-description-input"
            type="text"
            className="description-editor__input"
            value={descDraft}
            placeholder={autoDescription || "Add a short description"}
            onChange={(e) => setDescDraft(e.target.value)}
            onBlur={commitDescription}
            onKeyDown={onDescKeyDown}
            maxLength={200}
            disabled={descSaving}
            autoComplete="off"
          />
          {descSaving ? (
            <span className="description-editor__status">Saving…</span>
          ) : descBaseline ? (
            <button
              type="button"
              className="description-editor__reset"
              onClick={() => {
                setDescDraft("");
                // Defer the commit by a tick so the input reflects "" first.
                window.setTimeout(commitDescription, 0);
              }}
              disabled={descSaving}
              title="Reset to the default (auto-generated) description"
            >
              Reset to default
            </button>
          ) : (
            <span className="description-editor__status description-editor__status--muted">
              Using default
            </span>
          )}
        </div>
        <p className="description-editor__hint">
          Shows in the workflows list. Leave blank to use the auto-generated label.
        </p>
      </div>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          marginBottom: 16,
          flexWrap: "wrap",
        }}
      >
        <span
          style={{
            fontSize: 11,
            fontWeight: 700,
            letterSpacing: "0.08em",
            textTransform: "uppercase",
            color: "var(--ink-3)",
            marginRight: 4,
          }}
        >
          Status
        </span>
        {STATUS_ORDER.map((s) => {
          const active = status === s;
          const saving = statusSaving === s;
          // Won is special: clicking it never PUTs directly — it opens the SO
          // form. Whether the form turns into a "create" or an "edit" save is
          // decided inside submitSoForm based on the current status.
          const onClick = s === "won" ? onWonClick : () => onNonWonClick(s);
          // We allow clicking Won even when active so users can edit SOs.
          const isDisabled = s === "won"
            ? !!statusSaving || soSaving
            : active || !!statusSaving || soSaving;
          return (
            <button
              key={s}
              type="button"
              onClick={onClick}
              disabled={isDisabled}
              className={`status-pill status-pill--${s.replace("_", "-")} status-pill--button ${active ? "status-pill--active" : ""}`}
            >
              {saving ? "Saving…" : WORKFLOW_STATUS_LABELS[s]}
            </button>
          );
        })}
        {status === "won" && !soFormOpen ? (
          <button
            type="button"
            onClick={() => openSoForm(salesOrders)}
            className="so-edit-link"
            disabled={soSaving}
          >
            Edit sales orders
          </button>
        ) : null}
      </div>

      {soFormOpen ? (
        <div className="so-form">
          <div className="so-form__header">
            <span className="so-form__title">
              {status === "won" ? "Edit sales orders" : "Record sales orders for this win"}
            </span>
            <span className="so-form__hint">
              At least one SO number and a dollar value greater than zero.
            </span>
          </div>
          <div className="so-form__rows">
            {soDrafts.map((d, idx) => (
              <div key={idx} className="so-form__row">
                <input
                  type="text"
                  className="so-form__input so-form__input--so"
                  placeholder="SO # (e.g. 12345)"
                  value={d.so_number}
                  onChange={(e) => setDraftField(idx, "so_number", e.target.value)}
                  disabled={soSaving}
                />
                <div className="so-form__value-wrap">
                  <span className="so-form__value-prefix">$</span>
                  <input
                    type="text"
                    inputMode="decimal"
                    className="so-form__input so-form__input--value"
                    placeholder="Value"
                    value={d.value}
                    onChange={(e) => setDraftField(idx, "value", formatValueInput(e.target.value))}
                    disabled={soSaving}
                  />
                </div>
                <button
                  type="button"
                  className="so-form__remove"
                  onClick={() => removeDraftRow(idx)}
                  aria-label="Remove sales order"
                  disabled={soDrafts.length <= 1 || soSaving}
                  title={soDrafts.length <= 1 ? "Keep at least one row" : "Remove this row"}
                >
                  &times;
                </button>
              </div>
            ))}
          </div>
          <button
            type="button"
            className="so-form__add"
            onClick={addDraftRow}
            disabled={soSaving}
          >
            + Add another sales order
          </button>
          {soError ? <div className="so-form__error">{soError}</div> : null}
          <div className="so-form__actions">
            <button
              type="button"
              className="so-form__cancel"
              onClick={closeSoForm}
              disabled={soSaving}
            >
              Cancel
            </button>
            <button
              type="button"
              className="so-form__save"
              onClick={submitSoForm}
              disabled={soSaving}
            >
              {soSaving ? "Saving…" : "Save as Won"}
            </button>
          </div>
        </div>
      ) : null}

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 28 }}>
        <a href={`/start?workflow=${workflow.id}`} style={editAction}>
          <span style={actionTitleRow}><IconSliders />Edit workflow →</span>
          <span style={{ fontSize: 12, fontWeight: 400, color: "var(--ink-3)" }}>
            Tweak any field, then push again.
          </span>
        </a>

        <button
          type="button"
          style={primaryAction}
          onClick={() => (isPcGummy ? openMaterials() : pushToMonday())}
          disabled={submitting}
        >
          <span style={actionTitleRow}>
            <IconMonday />
            {submitting
              ? alreadyPushed
                ? "Updating…"
                : "Pushing…"
              : alreadyPushed
                ? "Update Monday →"
                : "Push to Monday →"}
          </span>
          <span style={{ fontSize: 12, fontWeight: 400, opacity: 0.85 }}>
            {isPcGummy
              ? "Review the raw materials for Rosy to quote, then push."
              : alreadyPushed
                ? "Post a fresh comment. Only files added since the last push are uploaded."
                : "Create the Quotes-board item and ping Rosy."}
          </span>
        </button>

        {/* The generic pricing calculator models a LANDED cost — freight,
            duty, incoterms, a purchased unit cost. Contract-packaging bottles
            have none of that shape: the customer supplies the components and
            we sell labour plus overhead. Pointing a bottles workflow at this
            calculator produces a quote built from the wrong model with an
            empty cost, so both entry points are hidden for bottles and
            blisters alike — each has a calculator below that carries the job
            end to end. */}
        {isFinishedProduct && (
          <a
            href={`/pricing?from=${workflow.id}`}
            style={editAction}
            aria-label="Open the finished product pricing calculator"
          >
            <span style={actionTitleRow}><IconCalculator />Pricing Calculator (Finished Product) →</span>
            <span style={{ fontSize: 12, fontWeight: 400, color: "var(--ink-3)" }}>
              Bulk tab + Packaging tab → price per finished unit.
            </span>
          </a>
        )}

        {!isCpBottles && !isCpBlisters && !isCpPouches && !isCpSachets && !isFinishedProduct && (
          <>
            <a
              href={`/pricing?from=${workflow.id}`}
              style={editAction}
              aria-label="Open the pricing calculator"
            >
              <span style={actionTitleRow}><IconCalculator />Pricing Calculator →</span>
              <span style={{ fontSize: 12, fontWeight: 400, color: "var(--ink-3)" }}>
                Landed cost + margin → sale price.
              </span>
            </a>

            <a
              href={`/pricing?from=${workflow.id}&issue=1`}
              style={editAction}
              aria-label="Open the pricing calculator and issue a quote"
            >
              <span style={actionTitleRow}><IconFileDollar />Issue Quote →</span>
              <span style={{ fontSize: 12, fontWeight: 400, color: "var(--ink-3)" }}>
                Generate a customer-facing quote PDF.
              </span>
            </a>
          </>
        )}

        {/* The old per-workflow Gummy Formula card was retired 2026-09-19:
            the formula catalog (formula.pharmacenter.app) is where formulas
            live now, and the pricing tool imports material cost from the
            pinned formula's Costing tab. The /gummy-formula route still
            exists for direct links but has no entry point here. */}

        {/* Bottle costing — the Contract-Packaging counterpart to the gummy
            formula. Gated on the same two facts the /start form records:
            quote type is contract-packaging AND the packaging type is bottles.
            Sachets, pouches and kitting have a different bill of materials
            and still need boards of their own. */}
        {isCpBottles && (
          <a
            href={`/workflow/${workflow.id}/bottle-costing`}
            style={editAction}
            aria-label="Open the bottles pricing calculator"
          >
            <span style={actionTitleRow}><IconCalculator />Pricing Calculator (Bottles) →</span>
            <span style={{ fontSize: 12, fontWeight: 400, color: "var(--ink-3)" }}>
              Components + line crew + margin → price per bottle.
            </span>
          </a>
        )}

        {/* Blister costing — same architecture, its own labour model: stroke
            speed x blisters per stroke with the house 20% penalty, and hand
            stations (packout / cartoning / bundling) at per-person speeds. */}
        {isCpBlisters && (
          <a
            href={`/workflow/${workflow.id}/blister-costing`}
            style={editAction}
            aria-label="Open the blisters pricing calculator"
          >
            <span style={actionTitleRow}><IconCalculator />Pricing Calculator (Blisters) →</span>
            <span style={{ fontSize: 12, fontWeight: 400, color: "var(--ink-3)" }}>
              Film + foil + crews + margin → price per finished unit.
            </span>
          </a>
        )}

        {/* Pouch costing — same architecture again: pouch machine PPM with
            the house 20% penalty, printing / packout / cartoning / bundling
            hand stations at per-person speeds, BOM seeded from the pouch
            packaging spec. */}
        {isCpPouches && (
          <a
            href={`/workflow/${workflow.id}/pouch-costing`}
            style={editAction}
            aria-label="Open the pouches pricing calculator"
          >
            <span style={actionTitleRow}><IconCalculator />Pricing Calculator (Pouches) →</span>
            <span style={{ fontSize: 12, fontWeight: 400, color: "var(--ink-3)" }}>
              Bulk + pouches + crews + margin → price per finished unit.
            </span>
          </a>
        )}

        {/* Sachet costing — the pouch board's sibling: sachet film charged
            per impression (per sachet), printed on the line only. */}
        {isCpSachets && (
          <a
            href={`/workflow/${workflow.id}/sachet-costing`}
            style={editAction}
            aria-label="Open the sachets pricing calculator"
          >
            <span style={actionTitleRow}><IconCalculator />Pricing Calculator (Sachets) →</span>
            <span style={{ fontSize: 12, fontWeight: 400, color: "var(--ink-3)" }}>
              Bulk + sachet film + crews + margin → price per finished unit.
            </span>
          </a>
        )}
      </div>

      {/* ---------- Issued quotes ----------
          Every customer-facing quote saved from the calculator, newest
          first. They were already being persisted on the workflow; there
          was just nowhere outside the calculator to see that a quote had
          ever gone out, let alone read the one that did. */}
      {(
        <div style={{ marginBottom: 28 }}>
          <div
            style={{
              fontSize: 11,
              fontWeight: 700,
              letterSpacing: "0.09em",
              textTransform: "uppercase",
              color: "var(--ink-3)",
              marginBottom: 10,
            }}
          >
            Issued quotes
          </div>
          {issuedQuotes.length === 0 ? (
            <p style={{ fontSize: 13, color: "var(--ink-3)", margin: 0 }}>
              None yet. A quote issued from the pricing calculator is
              recorded here.
            </p>
          ) : null}
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            {issuedQuotes.map((q) => (
              <button
                key={q.id}
                type="button"
                onClick={() => openIssuedQuote(q.id)}
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: 2,
                  alignItems: "flex-start",
                  padding: "10px 14px",
                  borderRadius: 10,
                  border: "1.5px solid #e3dcc9",
                  background: "#fffdf8",
                  color: "var(--teal-900)",
                  fontFamily: "inherit",
                  fontSize: 14,
                  fontWeight: 700,
                  cursor: "pointer",
                  textAlign: "left",
                }}
              >
                <span>{q.label}</span>
                <span
                  style={{
                    fontSize: 12,
                    fontWeight: 400,
                    color: "var(--ink-3)",
                  }}
                >
                  {q.savedAt
                    ? new Date(q.savedAt).toLocaleString("en-US", {
                        month: "short",
                        day: "numeric",
                        year: "numeric",
                        hour: "numeric",
                        minute: "2-digit",
                      })
                    : "—"}
                </span>
              </button>
            ))}
          </div>
          {issuedQuotes.length > 0 ? (
            <p
              style={{
                fontSize: 12,
                color: "var(--ink-3)",
                margin: "8px 0 0",
              }}
            >
              Opens read-only. To change a quote or issue a new version, go
              through the pricing calculator.
            </p>
          ) : null}
        </div>
      )}

      {/* Delete workflow lives on its own row, separated from the everyday
          actions above so an accidental click is less likely. Only the
          owner (or an admin) sees this button at all. */}
      {canDelete ? (
        <div style={{ marginBottom: 28, display: "flex", alignItems: "center", gap: 12 }}>
          <button
            type="button"
            onClick={deleteWorkflow}
            disabled={deleting}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              padding: "7px 14px",
              borderRadius: 8,
              border: "1px solid #d8b3b3",
              background: "#fffdf8",
              color: "#8b2f2f",
              fontFamily: "inherit",
              fontSize: 13,
              fontWeight: 700,
              cursor: deleting ? "not-allowed" : "pointer",
            }}
          >
            {deleting ? "Deleting…" : "Delete workflow"}
          </button>
          <span style={{ fontSize: 12, color: "var(--ink-3)" }}>
            {isAdmin && !isOwner
              ? "Admin override — created by someone else."
              : "Owner-only action."}
          </span>
        </div>
      ) : null}

      {matOpen ? (
        <div
          style={{
            position: "fixed", inset: 0, zIndex: 90,
            background: "rgba(15, 74, 86, 0.35)",
            display: "flex", alignItems: "center", justifyContent: "center",
            padding: 20,
          }}
          onClick={(e) => {
            if (e.target === e.currentTarget && !submitting) setMatOpen(false);
          }}
        >
          <div
            style={{
              width: "min(680px, 100%)", maxHeight: "85vh", overflowY: "auto",
              background: "#fffdf8", borderRadius: 14, border: "1.5px solid #e3dcc9",
              boxShadow: "0 12px 40px rgba(0,0,0,0.18)", padding: "20px 22px",
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 4 }}>
              <span style={{ fontSize: 16, fontWeight: 800, color: "var(--teal-900)" }}>
                Materials for Rosy
              </span>
              <button
                type="button"
                onClick={() => !submitting && setMatOpen(false)}
                style={{ border: "none", background: "transparent", color: "var(--ink-3)", cursor: "pointer", fontSize: 18 }}
                aria-label="Close"
              >
                ×
              </button>
            </div>
            <p style={{ fontSize: 12.5, color: "var(--ink-3)", margin: "0 0 14px", lineHeight: 1.5 }}>
              Seeded from the formula&apos;s Material Costs (water excluded).
              Drag ⋮⋮ to reorder, × to drop a row from the push, edit
              quantities, or add rows. This exact list goes to Rosy.{" "}
              <button
                type="button"
                onClick={seedFromFormula}
                disabled={submitting || matLoading}
                style={{
                  border: "none", background: "transparent", padding: 0,
                  color: "var(--teal-700)", fontFamily: "inherit", fontSize: 12.5,
                  fontWeight: 700, cursor: "pointer", textDecoration: "underline",
                }}
                title="Discard the edits on screen and re-derive the list from the formula's Material Costs table"
              >
                Reseed from formula
              </button>
            </p>

            {matLoading ? (
              <p style={{ fontSize: 13, color: "var(--ink-3)" }}>Loading the formula&apos;s materials…</p>
            ) : (
              <>
                {matRows.map((r, idx) => (
                  <div
                    key={r.id}
                    onDragOver={(e) => { e.preventDefault(); setMatDropIdx(idx); }}
                    onDrop={(e) => {
                      e.preventDefault();
                      if (matDragIdx !== null) reorderMatRows(matDragIdx, idx);
                      setMatDragIdx(null); setMatDropIdx(null);
                    }}
                    style={{
                      display: "flex", alignItems: "center", gap: 8, padding: "6px 0",
                      borderTop: matDropIdx === idx && matDragIdx !== null && matDragIdx !== idx
                        ? "2px solid var(--teal-700)" : "2px solid transparent",
                    }}
                  >
                    <span
                      draggable
                      onDragStart={() => setMatDragIdx(idx)}
                      onDragEnd={() => { setMatDragIdx(null); setMatDropIdx(null); }}
                      style={{ cursor: "grab", color: "var(--ink-3)", userSelect: "none", fontSize: 14, padding: "0 2px" }}
                      title="Drag to reorder"
                    >
                      ⋮⋮
                    </span>
                    <input
                      type="text"
                      value={r.name}
                      placeholder="Material name"
                      onChange={(e) => setMatField(r.id, "name", e.target.value)}
                      style={{
                        flex: "1 1 auto", minWidth: 0, padding: "7px 10px",
                        border: "1.5px solid #e3dcc9", borderRadius: 8, fontSize: 13,
                        background: "#fff", fontFamily: "inherit", color: "var(--ink-1)",
                      }}
                      disabled={submitting}
                    />
                    {r.customerSupplied ? (
                      <span
                        style={{
                          fontSize: 10, fontWeight: 700, letterSpacing: "0.04em",
                          textTransform: "uppercase", color: "var(--teal-700)",
                          border: "1px solid var(--sage-300)", borderRadius: 999,
                          padding: "2px 8px", whiteSpace: "nowrap", background: "#f4f8ec",
                        }}
                        title="The customer ships this material — delete the row if Rosy shouldn't quote it."
                      >
                        customer supplied
                      </span>
                    ) : null}
                    <input
                      type="text"
                      inputMode="decimal"
                      value={r.qty}
                      placeholder="Qty"
                      onChange={(e) => setMatField(r.id, "qty", e.target.value)}
                      style={{
                        width: 90, padding: "7px 10px", textAlign: "right",
                        border: "1.5px solid #e3dcc9", borderRadius: 8, fontSize: 13,
                        background: "#fff", fontFamily: "inherit", color: "var(--ink-1)",
                      }}
                      disabled={submitting}
                    />
                    <input
                      type="text"
                      value={r.unit}
                      onChange={(e) => setMatField(r.id, "unit", e.target.value)}
                      style={{
                        width: 46, padding: "7px 6px", textAlign: "center",
                        border: "1.5px solid #e3dcc9", borderRadius: 8, fontSize: 13,
                        background: "#fff", fontFamily: "inherit", color: "var(--ink-3)",
                      }}
                      disabled={submitting}
                      aria-label="Unit"
                    />
                    <button
                      type="button"
                      onClick={() => removeMatRow(r.id)}
                      disabled={submitting}
                      style={{ border: "none", background: "transparent", color: "var(--ink-3)", cursor: "pointer", fontSize: 16 }}
                      aria-label="Remove material"
                      title="Drop this row from the push"
                    >
                      ×
                    </button>
                  </div>
                ))}
                <div style={{ display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap" }}>
                  <button
                    type="button"
                    onClick={() => {
                      setMatPickerOpen((v) => !v);
                      setMatSearch("");
                      setMatResults([]);
                    }}
                    disabled={submitting}
                    style={{
                      padding: "7px 12px", border: "1.5px dashed #e3dcc9",
                      borderRadius: 8, background: matPickerOpen ? "#f4f8ec" : "transparent",
                      color: "var(--teal-900)", fontFamily: "inherit", fontSize: 13,
                      fontWeight: 700, cursor: "pointer",
                    }}
                  >
                    + From Fishbowl
                  </button>
                  <button
                    type="button"
                    onClick={addMatRow}
                    disabled={submitting}
                    style={{
                      padding: "7px 12px", border: "1.5px dashed #e3dcc9",
                      borderRadius: 8, background: "transparent", color: "var(--teal-900)",
                      fontFamily: "inherit", fontSize: 13, fontWeight: 700, cursor: "pointer",
                    }}
                  >
                    + Custom row
                  </button>
                </div>

                {matPickerOpen ? (
                  <div style={{ marginTop: 10 }}>
                    <input
                      type="text"
                      value={matSearch}
                      onChange={(e) => runMatSearch(e.target.value)}
                      placeholder='Search Fishbowl raw materials (RW) by name or number (e.g. "PC-RW-0012")'
                      autoComplete="off"
                      autoFocus
                      style={{
                        width: "100%", padding: "8px 12px", border: "1.5px solid #e3dcc9",
                        borderRadius: 8, fontSize: 13, background: "#fff",
                        fontFamily: "inherit", color: "var(--ink-1)", boxSizing: "border-box",
                      }}
                      disabled={submitting}
                    />
                    {matSearch.trim().length >= 2 ? (
                      <div
                        style={{
                          border: "1.5px solid #e3dcc9", borderTop: "none",
                          borderRadius: "0 0 8px 8px", background: "#fff",
                          maxHeight: 180, overflowY: "auto",
                        }}
                      >
                        {matSearching ? (
                          <div style={{ padding: "8px 12px", fontSize: 12.5, color: "var(--ink-3)" }}>
                            Searching…
                          </div>
                        ) : matResults.length === 0 ? (
                          <div style={{ padding: "8px 12px", fontSize: 12.5, color: "var(--ink-3)" }}>
                            No Fishbowl raw materials (RW) match — use + Custom row instead.
                          </div>
                        ) : (
                          matResults.map((p) => (
                            <button
                              key={p.id}
                              type="button"
                              onClick={() => addMatFromFishbowl(p)}
                              style={{
                                display: "block", width: "100%", textAlign: "left",
                                padding: "8px 12px", border: "none", background: "transparent",
                                fontFamily: "inherit", fontSize: 13, color: "var(--ink-1)",
                                cursor: "pointer", borderBottom: "1px solid #f0ead9",
                              }}
                            >
                              {p.fp_code ? (
                                <span style={{ color: "var(--teal-700)", fontWeight: 700 }}>
                                  {p.fp_code}
                                </span>
                              ) : null}
                              {p.fp_code ? " · " : ""}
                              {p.name}
                            </button>
                          ))
                        )}
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </>
            )}

            {matError ? (
              <div style={{ marginTop: 10, fontSize: 12.5, color: "#8b2f2f" }}>{matError}</div>
            ) : null}

            <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 18 }}>
              <button
                type="button"
                onClick={() => setMatOpen(false)}
                disabled={submitting}
                style={{
                  padding: "9px 16px", borderRadius: 8, border: "1.5px solid #e3dcc9",
                  background: "#fffdf8", color: "var(--ink-1)", fontFamily: "inherit",
                  fontSize: 13, fontWeight: 700, cursor: "pointer",
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={confirmMaterialsPush}
                disabled={submitting || matLoading}
                style={{
                  padding: "9px 18px", borderRadius: 8, border: "1.5px solid var(--teal-900)",
                  background: "var(--teal-900)", color: "#fff", fontFamily: "inherit",
                  fontSize: 13, fontWeight: 700, cursor: submitting ? "wait" : "pointer",
                }}
              >
                {submitting
                  ? alreadyPushed ? "Updating…" : "Pushing…"
                  : alreadyPushed ? "Update Monday →" : "Push to Monday →"}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {toast ? (
        <div
          style={{
            position: "fixed", bottom: 24, left: "50%", transform: "translateX(-50%)",
            background: "var(--teal-900)", color: "#fff",
            padding: "12px 20px", borderRadius: 10, fontSize: 14,
            boxShadow: "0 4px 12px rgba(0,0,0,0.15)", maxWidth: 480, textAlign: "center",
            zIndex: 100,
          }}
        >
          {toast}
        </div>
      ) : null}
    </>
  );
}
