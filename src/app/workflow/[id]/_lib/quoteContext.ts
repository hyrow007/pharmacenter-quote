import type { SupabaseClient } from "@supabase/supabase-js";
import {
  formatQuoteNumber,
  type IssuedQuoteTab,
  type PricingSnapshot,
  type WorkflowRow,
  type WorkflowState,
} from "@/lib/workflows";

// What the quote assistant can see about ONE workflow, gathered once per
// turn and pasted into the system prompt.
//
// Deliberately a SUMMARY, not a dump. A workflow's state JSON runs to tens of
// thousands of characters once four costing boards and their scenarios are in
// it — most of it defaults nobody has looked at. The assistant gets the shape
// of the quote here and pulls detail through a tool when it actually needs it,
// which is also what keeps its answers anchored to a specific board rather
// than to a haze of every number at once.

export type CostingSummary = {
  board: string; // "pouch" | "bottle" | …
  productName: string;
  scenarios: { name: string; quantity: number | null }[];
};

export type QuoteContext = {
  quoteNumber: string;
  status: string;
  type: string | null;
  form: string | null;
  packagingType: string | null;
  source: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  customer: {
    name: string | null;
    contact: string | null;
    email: string | null;
    address: string | null;
  };
  products: {
    name: string;
    code: string | null;
    sourceMode: string | null;
    quantities: string[];
    pinnedFormula: { name: string; pcBkCode: string | null } | null;
    stock: { onHand: number | null; avgCost: number | null } | null;
  }[];
  pricingTabs: {
    label: string;
    product: string | null;
    quantity: string;
    unitCost: string;
    margin: string;
    salePerUnit: number | null;
    landedPerUnit: number | null;
    savedAt: string | null;
  }[];
  costings: CostingSummary[];
  issuedQuotes: { label: string; savedAt: string }[];
  salesOrders: { so_number: string; value: number }[];
};

/** Which state key holds each board's saved costing. */
const BOARD_KEYS: { board: string; key: string; moreKey: string }[] = [
  { board: "bottle", key: "bottleCosting", moreKey: "bottleCostingMore" },
  { board: "blister", key: "blisterCosting", moreKey: "blisterCostingMore" },
  { board: "pouch", key: "pouchCosting", moreKey: "pouchCostingMore" },
  { board: "sachet", key: "sachetCosting", moreKey: "sachetCostingMore" },
];

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

export async function loadQuoteContext(
  supabase: SupabaseClient,
  workflow: WorkflowRow,
): Promise<QuoteContext> {
  const state = (workflow.state ?? {}) as WorkflowState;
  const raw = state as unknown as Record<string, unknown>;

  // ---- customer ----------------------------------------------------------
  const newCustomer = asRecord(raw.newCustomer);
  let customerName =
    (typeof newCustomer?.name === "string" ? newCustomer.name : null) ?? null;
  let customerContact =
    (typeof newCustomer?.contact === "string" ? newCustomer.contact : null) ??
    null;
  let customerEmail =
    (typeof newCustomer?.email === "string" ? newCustomer.email : null) ?? null;
  let customerAddress: string | null = null;
  const customerId =
    typeof raw.customerId === "string" ? raw.customerId : null;
  if (customerId) {
    const { data } = await supabase
      .from("customers")
      .select("name, default_ship_to")
      .eq("id", customerId)
      .maybeSingle();
    if (data?.name) customerName = data.name as string;
    customerAddress = (data?.default_ship_to as string | undefined) ?? null;
    // Contact and email on the workflow belong to "new customer" mode.
    customerContact = null;
    customerEmail = null;
  }

  // ---- products ----------------------------------------------------------
  const productRows = Array.isArray(raw.products)
    ? (raw.products as Record<string, unknown>[])
    : [];
  const pickedIds = productRows
    .map((p) => (typeof p.productId === "string" ? p.productId : null))
    .filter((id): id is string => !!id && id !== "new");
  const byId = new Map<
    string,
    { name: string; fp_code: string | null; avg_cost: number | null; qty_on_hand: number | null }
  >();
  if (pickedIds.length > 0) {
    const { data } = await supabase
      .from("products")
      .select("id, name, fp_code, avg_cost, qty_on_hand")
      .in("id", pickedIds);
    for (const r of data ?? []) {
      byId.set(String(r.id), {
        name: String(r.name ?? ""),
        fp_code: (r.fp_code as string | null) ?? null,
        avg_cost: r.avg_cost === null || r.avg_cost === undefined ? null : Number(r.avg_cost),
        qty_on_hand:
          r.qty_on_hand === null || r.qty_on_hand === undefined
            ? null
            : Number(r.qty_on_hand),
      });
    }
  }
  const products = productRows.map((p) => {
    const pid = typeof p.productId === "string" ? p.productId : null;
    const picked = pid && pid !== "new" ? byId.get(pid) : undefined;
    const np = asRecord(p.newProduct);
    const pinned = asRecord(p.pinnedFormula);
    return {
      name:
        picked?.name ??
        (typeof np?.name_desc === "string" ? np.name_desc : "") ??
        "(unnamed)",
      code: picked?.fp_code ?? null,
      sourceMode: typeof p.sourceMode === "string" ? p.sourceMode : null,
      quantities: Array.isArray(p.quantities)
        ? (p.quantities as unknown[]).map((q) => String(q))
        : [],
      pinnedFormula: pinned
        ? {
            name: String(pinned.name ?? ""),
            pcBkCode:
              typeof pinned.pcBkCode === "string" ? pinned.pcBkCode : null,
          }
        : null,
      stock: picked
        ? { onHand: picked.qty_on_hand, avgCost: picked.avg_cost }
        : null,
    };
  });

  // ---- pricing tabs ------------------------------------------------------
  const tabs = Array.isArray(raw.pricing)
    ? (raw.pricing as PricingSnapshot[])
    : [];
  const nameByUid = new Map<string, string>();
  productRows.forEach((p, i) => {
    const uid = typeof p.uid === "string" ? p.uid : null;
    if (uid) nameByUid.set(uid, products[i]?.name ?? `Product ${i + 1}`);
  });
  const pricingTabs = tabs.map((t, i) => ({
    label: (t.label && t.label.trim()) || `Tab ${i + 1}`,
    product: nameByUid.get(t.workflowProductUid) ?? null,
    quantity: t.quantity,
    unitCost: t.unitCost,
    margin: `${t.margin} (${t.marginMode})`,
    // The saved result, NOT a recomputation — this is what the calculator
    // showed when it was saved, which is the number a person acted on.
    salePerUnit: t.result?.salePerUnit ?? null,
    landedPerUnit: t.result?.landedPerUnit ?? null,
    savedAt: t.savedAt ?? null,
  }));

  // ---- costing boards ----------------------------------------------------
  const costings: CostingSummary[] = [];
  for (const { board, key, moreKey } of BOARD_KEYS) {
    const first = asRecord(raw[key]);
    const more = Array.isArray(raw[moreKey])
      ? (raw[moreKey] as unknown[])
      : [];
    const all = [first, ...more.map(asRecord)];
    all.forEach((st, idx) => {
      if (!st) return;
      const scenarios = Array.isArray(st.scenarios)
        ? (st.scenarios as Record<string, unknown>[])
        : [];
      costings.push({
        board,
        productName: products[idx]?.name ?? `Product ${idx + 1}`,
        scenarios: [
          {
            name: typeof st.baseName === "string" ? st.baseName : "Base",
            quantity:
              typeof st.quantityOverride === "number"
                ? st.quantityOverride
                : null,
          },
          ...scenarios.map((sc) => {
            const scState = asRecord(sc.state);
            return {
              name: String(sc.name ?? "Scenario"),
              quantity:
                typeof scState?.quantityOverride === "number"
                  ? (scState.quantityOverride as number)
                  : null,
            };
          }),
        ],
      });
    });
  }

  const issued = Array.isArray(raw.issuedQuotes)
    ? (raw.issuedQuotes as IssuedQuoteTab[])
    : [];

  return {
    quoteNumber: formatQuoteNumber(workflow.quote_number),
    status: workflow.status,
    type: typeof raw.type === "string" ? raw.type : null,
    form: typeof raw.form === "string" ? raw.form : null,
    packagingType:
      typeof raw.packagingType === "string" ? raw.packagingType : null,
    source: typeof raw.source === "string" ? raw.source : null,
    createdBy: workflow.created_by_email,
    createdAt: workflow.created_at,
    updatedAt: workflow.updated_at,
    customer: {
      name: customerName,
      contact: customerContact,
      email: customerEmail,
      address: customerAddress,
    },
    products,
    pricingTabs,
    costings,
    issuedQuotes: issued.map((q) => ({
      label: q.label,
      savedAt: q.savedAt,
    })),
    salesOrders: Array.isArray(workflow.sales_orders)
      ? workflow.sales_orders
      : [],
  };
}

/** The context as the model sees it: compact, labelled, no JSON noise. */
export function renderQuoteContext(c: QuoteContext): string {
  const lines: string[] = [];
  const L = (s: string) => lines.push(s);
  L(`QUOTE ${c.quoteNumber} — status ${c.status}`);
  L(
    `Type: ${c.type ?? "—"}${c.form ? ` · form ${c.form}` : ""}${
      c.packagingType ? ` · packaging ${c.packagingType}` : ""
    }${c.source ? ` · source ${c.source}` : ""}`,
  );
  L(`Created by ${c.createdBy} on ${c.createdAt}; updated ${c.updatedAt}`);
  L("");
  L(
    `CUSTOMER: ${c.customer.name ?? "—"}${
      c.customer.contact ? ` · ${c.customer.contact}` : ""
    }${c.customer.email ? ` · ${c.customer.email}` : ""}`,
  );
  if (c.customer.address) L(`Ship to: ${c.customer.address}`);
  L("");
  L("PRODUCTS");
  if (c.products.length === 0) L("  (none)");
  for (const p of c.products) {
    const bits: string[] = [];
    if (p.code) bits.push(p.code);
    if (p.sourceMode) bits.push(p.sourceMode);
    if (p.pinnedFormula)
      bits.push(
        `formula ${p.pinnedFormula.name}${
          p.pinnedFormula.pcBkCode ? ` (${p.pinnedFormula.pcBkCode})` : ""
        }`,
      );
    if (p.stock) {
      bits.push(
        `Fishbowl on hand ${p.stock.onHand === null ? "not synced" : p.stock.onHand}`,
      );
      if (p.stock.avgCost !== null)
        bits.push(`avg cost $${p.stock.avgCost.toFixed(4)}`);
    }
    L(`  • ${p.name}${bits.length ? ` — ${bits.join(" · ")}` : ""}`);
    if (p.quantities.length) L(`      quantities: ${p.quantities.join(", ")}`);
  }
  L("");
  L("PRICING TABS (saved results — what the calculator showed when saved)");
  if (c.pricingTabs.length === 0) L("  (none)");
  for (const t of c.pricingTabs) {
    L(
      `  • ${t.label}${t.product ? ` [${t.product}]` : ""} — qty ${t.quantity}, unit cost ${t.unitCost}, margin ${t.margin}`,
    );
    L(
      `      landed/unit ${t.landedPerUnit === null ? "—" : `$${t.landedPerUnit.toFixed(4)}`} · sale/unit ${
        t.salePerUnit === null ? "—" : `$${t.salePerUnit.toFixed(4)}`
      }${t.savedAt ? ` · saved ${t.savedAt}` : ""}`,
    );
  }
  L("");
  L("COSTING BOARDS");
  if (c.costings.length === 0) L("  (none started)");
  for (const b of c.costings) {
    L(
      `  • ${b.board} — ${b.productName}: ${b.scenarios
        .map((s) => `${s.name}${s.quantity ? ` (${s.quantity.toLocaleString("en-US")})` : ""}`)
        .join(", ")}`,
    );
  }
  L("");
  L("ISSUED QUOTES");
  if (c.issuedQuotes.length === 0) L("  (none recorded)");
  for (const q of c.issuedQuotes) L(`  • ${q.label} — ${q.savedAt}`);
  if (c.salesOrders.length > 0) {
    L("");
    L("SALES ORDERS (this quote was won)");
    for (const so of c.salesOrders)
      L(`  • ${so.so_number} — $${so.value.toLocaleString("en-US")}`);
  }
  return lines.join("\n");
}
