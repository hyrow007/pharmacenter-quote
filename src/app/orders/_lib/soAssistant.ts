import type { SupabaseClient } from "@supabase/supabase-js";
import { STAFF_NAMES, STAFF_ROLES, type Lexicon } from "@/lib/plaud/fishbowlLexicon";
import type { ToolDef } from "./anthropicStream";
import {
  loadSoContext,
  searchSalesOrders,
  getPurchaseOrder,
  type SoContext,
} from "./soContext";

// The SO assistant's brain: what it is told, what it can do, and the code
// behind each tool. The route (api/orders/[so]/chat) owns the loop and the
// streaming; this file owns the behaviour.

// Most capable model that fits a 60s Vercel Hobby function with a tool loop.
// Override without a code change: SO_CHAT_MODEL / SO_CHAT_EFFORT in Vercel env.
export const DEFAULT_MODEL = "claude-opus-5";
export const DEFAULT_EFFORT = "medium";

export type ActionEvent = {
  id: string;
  kind: "correction" | "retract_correction" | "meeting_note_edit" | "key_points" | "monday_post";
  status: "applied" | "pending" | "sent" | "cancelled" | "undone" | "failed";
  summary: string;
};

export type ToolCtx = {
  so: string;
  userEmail: string;
  userName: string | null;
  messageId: string | null;
  supabase: SupabaseClient; // caller's RLS client -- reads
  admin: SupabaseClient; // service role -- writes
  lexicon: Lexicon;
  context: SoContext;
  onAction: (a: ActionEvent) => void;
};

// ---- tools -----------------------------------------------------------------

const TOPICS = [
  "eta", "ship_date", "status", "quantity", "customer", "product",
  "vendor", "price", "meeting", "note", "other",
];

export const TOOLS: ToolDef[] = [
  {
    name: "search_sales_orders",
    description:
      "Search the Fishbowl sales-order mirror by SO number, customer name, customer PO, memo text, or product number/description. Use for questions that reach beyond this SO (other orders for a customer, where else a product is on order).",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string" },
        include_closed: { type: "boolean", description: "Also search closed/fulfilled orders. Default false." },
      },
      required: ["query"],
    },
  },
  {
    name: "get_sales_order",
    description:
      "Load the full context (Fishbowl lines, POs, Monday, meeting notes, key points, corrections) for ANOTHER sales order. The current SO is already in your context -- do not call this for it.",
    input_schema: {
      type: "object",
      properties: { so_number: { type: "string" } },
      required: ["so_number"],
    },
  },
  {
    name: "get_purchase_order",
    description: "Load one purchase order by PO number, including its line items, vendor and status.",
    input_schema: {
      type: "object",
      properties: { po_number: { type: "string" } },
      required: ["po_number"],
    },
  },
  {
    name: "add_correction",
    description:
      "Record a verified fact or addition on THIS sales order. Applies immediately and appears on the SO card for the whole team; it becomes the most authoritative input to the key points. Use only for what the user states or confirms -- never for your own inferences. Write it as a standalone fact a teammate can read cold (who/what/when), in both English and Spanish.",
    input_schema: {
      type: "object",
      properties: {
        topic: { type: "string", enum: TOPICS },
        text: { type: "string", description: "English. One or two sentences." },
        text_es: { type: "string", description: "The same fact in Spanish." },
        supersedes: {
          type: "string",
          description: "The wrong statement this replaces, quoted or closely paraphrased from its source, with the source (e.g. 'Monday 8/26: arrives at port Sept 19'). Omit for pure additions.",
        },
      },
      required: ["topic", "text", "text_es"],
    },
  },
  {
    name: "retract_correction",
    description: "Withdraw an earlier correction on this SO (it stays in history, marked retracted). Use the correction id from context.",
    input_schema: {
      type: "object",
      properties: { correction_id: { type: "string" } },
      required: ["correction_id"],
    },
  },
  {
    name: "edit_meeting_note",
    description:
      "Rewrite a meeting note on this SO -- typically to fix a Plaud mistranscription or a wrong fact recorded in the meeting. Send the COMPLETE corrected note in both languages (it replaces the stored text). Use the note id from context.",
    input_schema: {
      type: "object",
      properties: {
        note_id: { type: "string" },
        note_md: { type: "string", description: "Full corrected note, English." },
        note_md_es: { type: "string", description: "Full corrected note, Spanish." },
      },
      required: ["note_id", "note_md", "note_md_es"],
    },
  },
  {
    name: "update_key_points",
    description:
      "Replace this SO's key points (the green callout on its card) with a new headline and 3-5 points, in English and Spanish. Use after corrections change the story, or when the user asks. Lead with what is blocking or time-sensitive. Tag points with source 'monday', 'plaud' or 'correction' where one applies.",
    input_schema: {
      type: "object",
      properties: {
        headline: { type: "string" },
        headline_es: { type: "string" },
        points: {
          type: "array",
          items: {
            type: "object",
            properties: { text: { type: "string" }, source: { type: "string" } },
            required: ["text"],
          },
        },
        points_es: {
          type: "array",
          items: {
            type: "object",
            properties: { text: { type: "string" }, source: { type: "string" } },
            required: ["text"],
          },
        },
      },
      required: ["headline", "headline_es", "points", "points_es"],
    },
  },
  {
    name: "draft_monday_update",
    description:
      "Draft an update to post on this SO's Monday.com item. It is NOT posted: the user sees a preview with a Send button, because the whole team sees Monday. Use when the user asks to tell/notify/ask the team or post to Monday. Write it the way a teammate would, in the language the team uses on that item; @-mention people by full name when the user asks you to address them.",
    input_schema: {
      type: "object",
      properties: { body: { type: "string" } },
      required: ["body"],
    },
  },
];

// Short labels the UI shows while a tool runs.
export const TOOL_LABELS: Record<string, { en: string; es: string }> = {
  search_sales_orders: { en: "Searching sales orders", es: "Buscando órdenes de venta" },
  get_sales_order: { en: "Reading another sales order", es: "Leyendo otra orden de venta" },
  get_purchase_order: { en: "Reading purchase order", es: "Leyendo orden de compra" },
  add_correction: { en: "Recording correction", es: "Registrando corrección" },
  retract_correction: { en: "Retracting correction", es: "Retirando corrección" },
  edit_meeting_note: { en: "Editing meeting note", es: "Editando nota de reunión" },
  update_key_points: { en: "Updating key points", es: "Actualizando puntos clave" },
  draft_monday_update: { en: "Drafting Monday update", es: "Redactando actualización de Monday" },
};

// ---- system prompt ---------------------------------------------------------

export function buildSystem(ctx: {
  so: string;
  userName: string | null;
  userEmail: string;
  lang: "en" | "es";
  context: SoContext;
}): Array<{ type: "text"; text: string; cache_control?: { type: "ephemeral" } }> {
  const now = new Date();
  const today = now.toLocaleString("en-US", {
    timeZone: "America/New_York",
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
  // STAFF_ROLES is keyed role -> people; STAFF_NAMES also carries bare first
  // names for the transcript matcher, which the prompt does not need.
  const roleOf = new Map<string, string[]>();
  for (const [role, people] of Object.entries(STAFF_ROLES)) {
    for (const p of people) roleOf.set(p, [...(roleOf.get(p) ?? []), role]);
  }
  const staff = Array.from(new Set(STAFF_NAMES.filter((n) => n.includes(" "))))
    .map((n) => {
      const roles = roleOf.get(n);
      return roles && roles.length ? `${n} (${roles.join(", ")})` : n;
    })
    .join("; ");

  const rules = `You are the sales-order assistant inside PharmaCenter's Orders tracker (order.pharmacenter.app). PharmaCenter is a contract manufacturer of dietary supplements and pharmaceuticals in Davie, Florida -- softgels, gummies, capsules, tablets, powders, sachets -- producing private-label product for customers, with raw materials and components bought from vendors (often overseas) on purchase orders.

You are talking with ${ctx.userName ?? ctx.userEmail} (${ctx.userEmail}) about SO ${ctx.so}. The thread is SHARED: teammates read it and earlier messages may be from other people (each user line is prefixed with who wrote it). Now: ${today} (Eastern).

YOUR JOB
Be the teammate who has read every source on this order and can answer instantly and precisely: status, what is blocking it, what arrives when, quantities, money, who said what and when, and what to do next. Do the arithmetic (extended totals, fulfilled vs ordered, days until ship date, days overdue, units per PO vs units ordered) instead of making the user do it. When sources disagree, say so plainly, name each source with its date, and say which you believe and why. If something is unknown, say it is unknown and who would know.

THE SOURCES (all in the context below) AND HOW MUCH TO TRUST THEM
1. corrections -- facts a teammate verified and recorded here. MOST authoritative. When one conflicts with any other source, the correction wins; mention that it came from a correction and who added it. Ignore retracted ones except as history.
2. fishbowl -- the system of record for the order itself: customer, customer PO, lines, quantities, prices, dates, status, memo. A read-only nightly mirror (~4:30am ET); the synced_at stamp says how old it is. You CANNOT change Fishbowl. If the user wants something in Fishbowl changed, say it must be changed in Fishbowl itself (it will show here after the next nightly sync), and offer to record a correction now so the tracker is right in the meantime, and/or to draft a Monday update asking whoever handles it.
3. purchase_orders -- Fishbowl POs linked to this SO (raw materials, components, packaging). Same mirror, same limits.
4. monday -- the team's day-to-day conversation on the order, newest first. Entries with kind "reply" answer an earlier update (parent_id). The newest messages are usually the truth about ETAs and blockers.
5. meeting_notes -- AI summaries of the weekly sales-order meeting recorded with Plaud. Useful, but transcription garbles names: Fishbowl names are authoritative for customers, vendors and products. Staff: ${staff}. "Olivia" is not a person on staff -- any "Olivia said/will" in a transcript is a mistranscription; never attribute an action to her.
6. key_points -- an earlier AI summary of all of the above. Can be stale; never cite it as evidence over the sources.

CHANGING THINGS -- only when the user states a fact, asks you to fix/add/update something, or confirms a change you offered
- add_correction: the user tells you something that is new or contradicts a source ("ETA is 10/01, not 9/19", "customer approved the label"). Applies instantly with an Undo button. Write it so a teammate reading the card cold understands it; include the date and who said it when known.
- edit_meeting_note: fix a garbled or wrong meeting note. Send the whole corrected note in both languages.
- update_key_points: after a correction changes the story, refresh the key points so the card reflects it -- do this in the same turn without being asked, as long as the change is material.
- draft_monday_update: when the user wants the team told or asked something. It is only a draft until they click Send -- say so; never say it was posted.
- Do not record your own inferences, guesses, or summaries as corrections. If the user is unsure, ask before recording.
- NEVER say you changed, recorded, updated, or posted anything unless you called the tool for it in THIS turn and it returned ok. If a tool fails, say it failed.
- Ask a short clarifying question instead of guessing when a request is ambiguous (which line? which PO? which date?).

HOW TO ANSWER
- Reply in the language the user just wrote in (English or Spanish), even if earlier messages were in the other one.
- Lead with the answer. Be brief: a few short lines for simple questions; more only when asked for detail. Plain text with short "- " bullet lists when listing; no headings, no tables, no code blocks. Bold is not rendered.
- Cite where a fact came from in passing ("per Rosie on Monday, 9/17", "Fishbowl memo", "meeting 9/8").
- Money: $ with two decimals and thousands separators. Dates: short US style (9/19) unless a year is needed.
- The user may attach images or PDFs (packing slips, BOLs, CoAs, emails, screenshots). Read them carefully and use them; say what you see when it matters, and offer to record what they prove as a correction.

CONTEXT FOR SO ${ctx.so} (JSON; fishbowl.found=false means the SO is not in the mirror -- it may be closed before history began on 9/15/2026, mistyped, or not yet synced):`;

  return [
    { type: "text", text: rules },
    {
      type: "text",
      text: JSON.stringify(ctx.context),
      cache_control: { type: "ephemeral" },
    },
  ];
}

// ---- tool execution --------------------------------------------------------

type ToolOut = { content: string; isError?: boolean };

const ok = (v: unknown): ToolOut => ({ content: JSON.stringify(v) });
const fail = (msg: string): ToolOut => ({ content: JSON.stringify({ ok: false, error: msg }), isError: true });

const str = (v: unknown, max = 4000): string | null =>
  typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null;

async function logAction(
  ctx: ToolCtx,
  row: {
    kind: ActionEvent["kind"];
    status: ActionEvent["status"];
    summary: string;
    payload: unknown;
    before?: unknown;
    result?: unknown;
  },
): Promise<string | null> {
  const { data, error } = await ctx.admin
    .from("so_chat_actions")
    .insert({
      so_number: ctx.so,
      kind: row.kind,
      status: row.status,
      summary: row.summary.slice(0, 500),
      payload: row.payload ?? {},
      before: row.before ?? null,
      result: row.result ?? null,
      message_id: ctx.messageId,
      created_by: ctx.userEmail,
    })
    .select("id")
    .single();
  if (error || !data) {
    console.error("so_chat_actions insert failed:", error?.message);
    return null;
  }
  const id = String((data as { id: string }).id);
  ctx.onAction({ id, kind: row.kind, status: row.status, summary: row.summary });
  return id;
}

export async function runTool(name: string, input: unknown, ctx: ToolCtx): Promise<ToolOut> {
  const a = (input ?? {}) as Record<string, unknown>;
  try {
    switch (name) {
      case "search_sales_orders": {
        const q = str(a.query, 80);
        if (!q) return fail("query is required");
        const rows = await searchSalesOrders(ctx.supabase, q, a.include_closed === true);
        return ok({ ok: true, count: rows.length, results: rows });
      }
      case "get_sales_order": {
        const so = str(a.so_number, 40);
        if (!so) return fail("so_number is required");
        const c = await loadSoContext(ctx.supabase, so, ctx.lexicon);
        return ok(c);
      }
      case "get_purchase_order": {
        const po = str(a.po_number, 40);
        if (!po) return fail("po_number is required");
        const p = await getPurchaseOrder(ctx.supabase, po);
        return p ? ok({ ok: true, purchase_order: p }) : fail(`PO ${po} not found in the Fishbowl mirror`);
      }

      case "add_correction": {
        const text = str(a.text, 2000);
        if (!text) return fail("text is required");
        const topic = typeof a.topic === "string" && TOPICS.includes(a.topic) ? a.topic : "other";
        const row = {
          so_number: ctx.so,
          topic,
          text,
          text_es: str(a.text_es, 2000),
          supersedes: str(a.supersedes, 2000),
          source: "chat",
          created_by: ctx.userEmail,
          created_by_name: ctx.userName,
        };
        const { data, error } = await ctx.admin.from("so_corrections").insert(row).select("id").single();
        if (error || !data) return fail(error?.message ?? "insert failed");
        const correctionId = String((data as { id: string }).id);
        await logAction(ctx, {
          kind: "correction",
          status: "applied",
          summary: text,
          payload: { ...row, correction_id: correctionId },
          result: { correction_id: correctionId },
        });
        return ok({ ok: true, correction_id: correctionId, note: "Recorded and visible on the SO card; user can undo." });
      }

      case "retract_correction": {
        const id = str(a.correction_id, 60);
        if (!id) return fail("correction_id is required");
        const { data: existing } = await ctx.admin
          .from("so_corrections")
          .select("id, text, retracted_at")
          .eq("id", id)
          .eq("so_number", ctx.so)
          .maybeSingle();
        if (!existing) return fail("no such correction on this SO");
        const ex = existing as { text: string; retracted_at: string | null };
        if (ex.retracted_at) return fail("already retracted");
        const { error } = await ctx.admin
          .from("so_corrections")
          .update({ retracted_at: new Date().toISOString(), retracted_by: ctx.userEmail })
          .eq("id", id);
        if (error) return fail(error.message);
        await logAction(ctx, {
          kind: "retract_correction",
          status: "applied",
          summary: ex.text,
          payload: { correction_id: id },
        });
        return ok({ ok: true });
      }

      case "edit_meeting_note": {
        const id = str(a.note_id, 60);
        const md = str(a.note_md, 12000);
        if (!id || !md) return fail("note_id and note_md are required");
        const { data: existing } = await ctx.admin
          .from("meeting_so_notes")
          .select("id, so_number, note_md, note_md_es")
          .eq("id", id)
          .maybeSingle();
        const ex = existing as { so_number: string; note_md: string | null; note_md_es: string | null } | null;
        if (!ex || ex.so_number !== ctx.so) return fail("no such meeting note on this SO");
        const next = { note_md: md, note_md_es: str(a.note_md_es, 12000) ?? ex.note_md_es };
        const { error } = await ctx.admin.from("meeting_so_notes").update(next).eq("id", id);
        if (error) return fail(error.message);
        await logAction(ctx, {
          kind: "meeting_note_edit",
          status: "applied",
          summary: md.slice(0, 200),
          payload: { note_id: id, ...next },
          before: { note_id: id, note_md: ex.note_md, note_md_es: ex.note_md_es },
        });
        return ok({ ok: true });
      }

      case "update_key_points": {
        const headline = str(a.headline, 300);
        const pts = Array.isArray(a.points) ? a.points : [];
        const clean = (arr: unknown) =>
          (Array.isArray(arr) ? arr : [])
            .map((p) => {
              const o = (p ?? {}) as Record<string, unknown>;
              const t = str(o.text, 600);
              if (!t) return null;
              const s = str(o.source, 20);
              return s ? { text: t, source: s } : { text: t };
            })
            .filter(Boolean)
            .slice(0, 6);
        const points = clean(pts);
        if (!headline || points.length === 0) return fail("headline and at least one point are required");
        const { data: prior } = await ctx.admin
          .from("so_synthesis")
          .select("so_number, headline, points, headline_es, points_es, generated_at, based_on")
          .eq("so_number", ctx.so)
          .maybeSingle();
        const row = {
          so_number: ctx.so,
          headline,
          points,
          headline_es: str(a.headline_es, 300),
          points_es: clean(a.points_es),
          generated_at: new Date().toISOString(),
          based_on: { source: "so_assistant", by: ctx.userEmail },
        };
        const { error } = await ctx.admin.from("so_synthesis").upsert(row, { onConflict: "so_number" });
        if (error) return fail(error.message);
        await logAction(ctx, {
          kind: "key_points",
          status: "applied",
          summary: headline,
          payload: row,
          before: prior ?? null,
        });
        return ok({ ok: true });
      }

      case "draft_monday_update": {
        const body = str(a.body, 5000);
        if (!body) return fail("body is required");
        const itemId = ctx.context.monday?.monday_item_id;
        if (!itemId) return fail("this SO has no Monday item on the Open Sales Orders board, so there is nowhere to post");
        const id = await logAction(ctx, {
          kind: "monday_post",
          status: "pending",
          summary: body,
          payload: { body, monday_item_id: String(itemId) },
        });
        if (!id) return fail("could not save the draft");
        return ok({
          ok: true,
          status: "draft_shown_to_user",
          note: "NOT posted. The user sees it with a Send button and must click it.",
        });
      }
    }
    return fail(`unknown tool ${name}`);
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}
