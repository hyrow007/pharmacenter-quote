import type { SupabaseClient } from "@supabase/supabase-js";
import type { ToolDef } from "@/app/orders/_lib/anthropicStream";
import { formatQuoteNumber, type WorkflowRow } from "@/lib/workflows";
import { renderQuoteContext, type QuoteContext } from "./quoteContext";

// The quote assistant's brain: what it is told, what it may look at, and the
// code behind each tool. The route owns the loop and the streaming.
//
// READ-ONLY, on purpose. Every tool here is a SELECT. The assistant explains
// a quote, checks it, and drafts text; it never edits one. That boundary is
// the reason this file has no action log and no undo: there is nothing to
// undo. If it is ever given the power to change a quote, the audit trail
// arrives in the same change, not later.

export const DEFAULT_MODEL = "claude-opus-5";
export const DEFAULT_EFFORT = "medium";

export type ToolCtx = {
  workflow: WorkflowRow;
  supabase: SupabaseClient; // the caller's RLS client — reads only
  context: QuoteContext;
  /** This request's own origin and cookie, so a tool can call one of the
   *  app's own authenticated routes AS the signed-in person. Without the
   *  cookie that call is anonymous and the route rejects it. */
  origin: string;
  cookie: string;
  onLook: (label: string) => void;
};

// ---- tools -----------------------------------------------------------------

export const TOOLS: ToolDef[] = [
  {
    name: "get_costing_detail",
    description:
      "The full saved costing for one board on THIS quote: every bill-of-materials line with its part, supplier, cost source, waste % and $/unit, plus the labor, overhead and margin inputs. Use whenever a question is about how a price was built, which component drives it, or why a line is blocked. The summary in the context lists which boards exist; this reads one.",
    input_schema: {
      type: "object",
      properties: {
        board: {
          type: "string",
          enum: ["bottle", "blister", "pouch", "sachet"],
        },
        product_index: {
          type: "number",
          description:
            "0 for the first product on the workflow (the default), 1 for the second, and so on.",
        },
        scenario: {
          type: "string",
          description:
            "Scenario name to read instead of Base — e.g. 'Scenario 1'. Omit for Base.",
        },
      },
      required: ["board"],
    },
  },
  {
    name: "search_packaging_components",
    description:
      "Search Fishbowl packaging components by part number or name, with their inventory and last-order costs. Use to check what a component costs, to find an alternative, or to confirm a part exists before suggesting it.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Part number or words from the name." },
      },
      required: ["query"],
    },
  },
  {
    name: "get_fishbowl_product",
    description:
      "One Fishbowl product by its code (PC-BK-0123 etc): average cost and quantity on hand. Use to check whether bulk actually exists before a quote leans on existing stock, and to see what it cost.",
    input_schema: {
      type: "object",
      properties: {
        code: { type: "string" },
      },
      required: ["code"],
    },
  },
  {
    name: "get_formula_costing",
    description:
      "The costed breakdown of a gummy formula — material, direct labor, overhead and lab testing per gummy, cost per thousand, and the batch total. Use when this quote is priced off a pinned formula and the question is about what the bulk costs or why.",
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "Formula name or PC-BK code. Omit to use the formula pinned to this quote.",
        },
      },
    },
  },
  {
    name: "search_quotes",
    description:
      "Search other quote workflows by customer name or product description, returning quote number, customer, status and when it was last touched. Use to compare this quote against what was quoted before, or to find what a customer was charged last time.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string" },
        include_lost: {
          type: "boolean",
          description: "Include quotes marked Lost. Default false.",
        },
      },
      required: ["query"],
    },
  },
];

export const TOOL_LABELS: Record<string, string> = {
  get_costing_detail: "Reading the costing",
  search_packaging_components: "Checking Fishbowl components",
  get_fishbowl_product: "Checking stock and cost",
  get_formula_costing: "Reading the formula cost",
  search_quotes: "Looking at other quotes",
};

const BOARD_KEYS: Record<string, { key: string; moreKey: string }> = {
  bottle: { key: "bottleCosting", moreKey: "bottleCostingMore" },
  blister: { key: "blisterCosting", moreKey: "blisterCostingMore" },
  pouch: { key: "pouchCosting", moreKey: "pouchCostingMore" },
  sachet: { key: "sachetCosting", moreKey: "sachetCostingMore" },
};

function rec(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

export async function runTool(
  name: string,
  input: Record<string, unknown>,
  ctx: ToolCtx,
): Promise<string> {
  ctx.onLook(TOOL_LABELS[name] ?? name);
  switch (name) {
    case "get_costing_detail": {
      const board = String(input.board ?? "");
      const keys = BOARD_KEYS[board];
      if (!keys) return `Unknown board "${board}".`;
      const state = (ctx.workflow.state ?? {}) as Record<string, unknown>;
      const idx = Number(input.product_index ?? 0) || 0;
      const saved =
        idx === 0
          ? rec(state[keys.key])
          : rec((state[keys.moreKey] as unknown[] | undefined)?.[idx - 1]);
      if (!saved)
        return `No ${board} costing saved for product ${idx} on this quote.`;
      const wanted =
        typeof input.scenario === "string" ? input.scenario.trim() : "";
      let target: Record<string, unknown> = saved;
      if (wanted && wanted.toLowerCase() !== "base") {
        const list = Array.isArray(saved.scenarios)
          ? (saved.scenarios as Record<string, unknown>[])
          : [];
        const hit = list.find(
          (s) => String(s.name ?? "").toLowerCase() === wanted.toLowerCase(),
        );
        if (!hit)
          return `No scenario named "${wanted}" on the ${board} costing. Scenarios: ${
            list.map((s) => String(s.name)).join(", ") || "(none)"
          }.`;
        target = rec(hit.state) ?? {};
      }
      // Scenarios nested inside the payload would double its size for no
      // gain — they are listed in the context and fetched one at a time.
      const { scenarios: _drop, ...rest } = target as Record<string, unknown> & {
        scenarios?: unknown;
      };
      void _drop;
      return JSON.stringify(rest).slice(0, 24000);
    }

    case "search_packaging_components": {
      const q = String(input.query ?? "").trim();
      if (!q) return "Give me a part number or some words from the name.";
      const { data, error } = await ctx.supabase
        .from("packaging_components_costed")
        .select(
          "fp_code, name, effective_cost_per_unit, inventory_cost_per_unit, last_order_cost_per_unit, cost_status",
        )
        .or(`fp_code.ilike.%${q}%,name.ilike.%${q}%`)
        .limit(25);
      if (error) return `Search failed: ${error.message}`;
      if (!data || data.length === 0) return `No components match "${q}".`;
      return JSON.stringify(data);
    }

    case "get_fishbowl_product": {
      const code = String(input.code ?? "").trim();
      if (!code) return "Give me a product code.";
      const { data, error } = await ctx.supabase
        .from("products")
        .select("fp_code, name, avg_cost, qty_on_hand, qty_on_hand_at, active")
        .ilike("fp_code", code)
        .limit(5);
      if (error) return `Lookup failed: ${error.message}`;
      if (!data || data.length === 0) return `No product with code ${code}.`;
      // qty_on_hand null means the sync has never reported on this product.
      // Say so rather than letting it read as zero.
      return JSON.stringify(
        data.map((p) => ({
          ...p,
          qty_on_hand:
            p.qty_on_hand === null ? "not synced yet (NOT zero)" : p.qty_on_hand,
        })),
      );
    }

    case "get_formula_costing": {
      const q = String(input.query ?? "").trim();
      let formulaId: string | null = null;
      if (!q) {
        const products = Array.isArray(
          (ctx.workflow.state as Record<string, unknown>)?.products,
        )
          ? ((ctx.workflow.state as Record<string, unknown>)
              .products as Record<string, unknown>[])
          : [];
        for (const p of products) {
          const pinned = rec(p.pinnedFormula);
          if (pinned && typeof pinned.formulaId === "string") {
            formulaId = pinned.formulaId;
            break;
          }
        }
        if (!formulaId)
          return "No formula is pinned to this quote — give me a name or PC-BK code.";
      } else {
        const { data } = await ctx.supabase
          .from("gummy_formulas")
          .select("id, name, pc_bk_code")
          .or(`name.ilike.%${q}%,pc_bk_code.ilike.%${q}%`)
          .limit(5);
        if (!data || data.length === 0) return `No formula matches "${q}".`;
        if (data.length > 1)
          return `Several formulas match "${q}": ${data
            .map((f) => `${f.name} (${f.pc_bk_code ?? "no code"})`)
            .join("; ")}. Ask again with one of them.`;
        formulaId = String(data[0].id);
      }
      // The costed breakdown is computed by the formulas API, which is the
      // one place that arithmetic lives — do not re-implement it here. The
      // call carries the caller's cookie so it runs as them: the route is
      // gated, and an anonymous call would just 401.
      const res = await fetch(`${ctx.origin}/api/formulas/${formulaId}`, {
        headers: { cookie: ctx.cookie },
        cache: "no-store",
      }).catch(() => null);
      if (!res || !res.ok)
        return `Could not read the formula costing (${res ? `http ${res.status}` : "request failed"}).`;
      const json = (await res.json()) as {
        formula?: { name?: string };
        latestVersion?: { costingComputed?: unknown };
      };
      if (!json.latestVersion?.costingComputed)
        return `${json.formula?.name ?? "That formula"} has no Costing tab filled in yet.`;
      return JSON.stringify({
        formula: json.formula?.name,
        costing: json.latestVersion.costingComputed,
      });
    }

    case "search_quotes": {
      const q = String(input.query ?? "").trim();
      if (!q) return "Give me a customer name or product words to search for.";
      let query = ctx.supabase
        .from("workflows")
        .select("id, quote_number, status, description_override, updated_at, state")
        .order("updated_at", { ascending: false })
        .limit(40);
      if (!input.include_lost) query = query.neq("status", "lost");
      const { data, error } = await query;
      if (error) return `Search failed: ${error.message}`;
      const needle = q.toLowerCase();
      const hits = (data ?? [])
        .filter((w) => {
          if (w.id === ctx.workflow.id) return false;
          const blob = JSON.stringify(w.state ?? {}).toLowerCase();
          return (
            blob.includes(needle) ||
            String(w.description_override ?? "")
              .toLowerCase()
              .includes(needle)
          );
        })
        .slice(0, 12)
        .map((w) => ({
          quote: formatQuoteNumber(w.quote_number as number),
          status: w.status,
          description: w.description_override,
          updated_at: w.updated_at,
        }));
      if (hits.length === 0) return `No other quotes mention "${q}".`;
      return JSON.stringify(hits);
    }

    default:
      return `Unknown tool ${name}.`;
  }
}

// ---- system prompt ---------------------------------------------------------

export function buildSystem(ctx: QuoteContext, userName: string | null) {
  const who = userName ? `You are talking to ${userName}.` : "";
  return [
    {
      type: "text" as const,
      text: `You are the quote assistant inside PharmaCenter's Quote app, sitting on one quote workflow. ${who}

PharmaCenter is a contract manufacturer in Davie, FL: it makes and packages supplements — softgels, gummies, tablets, capsules — for other brands. A "quote" here is the workflow that prices one job: what the customer wants, what it costs us to buy or make and to package, and what we will charge.

WHAT YOU ARE FOR
Explaining a quote to the person working on it, checking it before it goes out, and drafting the words that go with it. You are the second pair of eyes on a number that is about to reach a customer.

WHAT YOU CANNOT DO
You cannot change anything. Every tool you have is a read. When someone asks you to change a margin, a quantity or a cost line, tell them plainly that you cannot and say exactly where to do it — the pricing calculator, or the costing board for that packaging type. Do not pretend an edit happened.

HOW THIS APP THINKS ABOUT NUMBERS — these are house rules, follow them:
- A cost that cannot be resolved BLOCKS a total. It never silently reads as $0. If a component has no cost, the price is not "lower", it is not yet a price.
- Quantity on hand of null means the nightly Fishbowl sync has not reported on that product. It does NOT mean zero. Only a real 0 means there is none.
- A product with stock on hand of 0 is quoted as a PURCHASE, not from stock — its average cost is what the LAST units cost us, not what new ones will.
- Commissions are part of the landed cost: the sale price is solved so it covers them on top of the margin. A price computed without them is under-priced.
- Waste is applied by dividing by (1 − waste%), not by multiplying.
- Customer-supplied components cost us $0 and say so explicitly; that is different from a component whose cost is unknown.

HOW TO ANSWER
Work from the numbers in front of you and say where each came from — "the pouch board's Base scenario", "Fishbowl inventory cost", "the saved pricing tab". If two places disagree, say so and show both rather than picking one silently; a disagreement between the calculator and a board is usually the interesting thing, not a rounding detail.

When you do arithmetic, show the line of it that matters: "46.21 ÷ 0.765 = 60.41". A number with no derivation is not checkable, and being checkable is the point.

If something looks wrong — a margin far off the others, a scenario priced below cost, stock that does not exist, a part that has been $0 for months — say so without being asked. That is the job.

Be brief. The person is mid-quote and wants the answer, not an essay. Prose, not bullet lists, unless a list genuinely is the answer. Never invent a part number, a cost, or a customer name: if you do not have it, say what you would need.

If the person writes in Spanish, answer in Spanish.

THE QUOTE IN FRONT OF YOU
${renderQuoteContext(ctx)}`,
    },
  ];
}
