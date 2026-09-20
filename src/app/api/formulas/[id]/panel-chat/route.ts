import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

// POST /api/formulas/[id]/panel-chat — the Panel tab's edit assistant.
//
// The browser sends the chat history plus a snapshot of the current
// Supplement Facts panel; Claude replies with a short message and a list
// of structured ops the client applies to its React state (the user
// still Saves the formula normally, so nothing here writes to the DB).
// Scope is deliberately panel-only: the ops vocabulary can rename rows,
// adjust %DV, serving sizes, and the other-ingredients line — it cannot
// touch claims, the recipe, or costing.
//
// Needs ANTHROPIC_API_KEY in the Vercel env. Without it the route
// answers no_api_key and the chat card explains how to enable it.
// (v83.5: key added to the Vercel project — this comment bump exists
// to force the deployment that picks it up.)

export const maxDuration = 30;

type ChatMessage = { role: "user" | "assistant"; content: string };

async function gate() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return {
      error: NextResponse.json({ ok: false, error: "not_signed_in" }, { status: 401 }),
      supabase: null,
      email: null,
    };
  }
  if (!user.email?.endsWith("@pharmacenterusa.com")) {
    return {
      error: NextResponse.json({ ok: false, error: "wrong_domain" }, { status: 403 }),
      supabase: null,
      email: null,
    };
  }
  return { error: null, supabase, email: user.email };
}

// GET /api/formulas/[id]/panel-chat — persisted chat history (v83.9),
// oldest first, capped at the last 80 turns.
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const g = await gate();
  if (g.error) return g.error;
  const { id } = await params;
  const { data, error } = await g.supabase!
    .from("gummy_formula_panel_chat_messages")
    .select("role, content, attachment_names, created_at")
    .eq("formula_id", id)
    .order("created_at", { ascending: true })
    .limit(80);
  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }
  return NextResponse.json({
    ok: true,
    messages: (data ?? []).map((r) => ({
      role: r.role as "user" | "assistant",
      content: r.content as string,
      attachmentNames: (r.attachment_names as string[] | null) ?? undefined,
    })),
  });
}

// DELETE /api/formulas/[id]/panel-chat — clear the thread.
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const g = await gate();
  if (g.error) return g.error;
  const { id } = await params;
  const { error } = await g.supabase!
    .from("gummy_formula_panel_chat_messages")
    .delete()
    .eq("formula_id", id);
  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}

const SYSTEM_PROMPT = `You are the Supplement Facts panel assistant inside PharmaCenter's formula tool. You edit ONLY the label panel via structured ops — never the recipe, claims, amounts, or costing (amounts come from the Label Claim section; if asked to change an amount, explain that it's edited in the Label Claim section on the Bench top tab).

Alongside the panel state you receive a READ-ONLY snapshot of the whole formula: the bench recipe (every ingredient with grams and blend phase), batch setup (bench batch grams, piece weights, gummies per batch), and the label claims. Use it to answer questions accurately — e.g. compute per-gummy contributions as (ingredient grams ÷ gummies per bench batch), account for stated solids/potency in ingredient names ("goFOS syrup (75%) 95% fiber" means 75% solids of which 95% is fiber), and account for moistureLossPct boiling off during cooking. Show brief arithmetic when it helps. You still cannot edit any of it — only the panel ops below.

You receive the current panel state as JSON. Respond with ONLY a JSON object, no markdown fences, shaped:
{"reply": "<short confirmation or answer, 1-2 sentences>", "ops": [ ... ]}

Available ops:
- {"op":"renameRow","rowId":"<id>","name":"<new panel display name>"}  (empty name resets to the formula's own name)
- {"op":"setDv","rowId":"<id>","pct":<number>}  — pin %DV as shown for the CURRENT serving size
- {"op":"clearDv","rowId":"<id>"}  — back to automatic %DV / † footnote
- {"op":"setServingsPerContainer","variantId":<"base" or variant id>,"value":<number or null>}  (null omits the line)
- {"op":"addVariant","name":"<pill name>","gummiesPerServing":<int>,"servingsPerContainer":<number or null>}
- {"op":"renameVariant","variantId":<"base" or variant id>,"name":"<new name>"}
- {"op":"setVariantServing","variantId":"<variant id>","gummiesPerServing":<int>}  (base is always 1 — offer a new variant instead)
- {"op":"deleteVariant","variantId":"<variant id>"}
- {"op":"setOtherIngredients","text":"<full replacement line>"}
- {"op":"resetOtherIngredients"}  — back to auto-generated from the blend
- {"op":"setNutrition","field":"calories|carbsG|sugarsG|addedSugarsG|fiberG|sodiumMg","value":<number PER SINGLE GUMMY, or null to return to the auto-estimate>}  — the Calories / Sodium / Total Carbohydrate / Dietary Fiber / Total Sugars / Added Sugars rows
- {"op":"setAllergens","text":"<FALCPA Contains line, e.g. 'Tree Nuts (Coconut), Soy'; empty string removes it>"}
- {"op":"hideRow","rowId":"<id>"}  — suppress a claim row from the PANEL display only (claim + recipe stay intact; e.g. fiber sources represented by the Dietary Fiber line instead of listed as actives)
- {"op":"showRow","rowId":"<id>"}  — bring a hidden row back

HARD LIMITS — be honest about them:
- A claim row's AMOUNT (the mg value) comes from the Label Claim section and CANNOT be changed here. renameRow changes only its display text. If the user wants a different amount, say it must be edited in the Label Claims section on the Bench top tab — and offer hideRow when the row shouldn't appear at all.
- Never state that you changed something unless you emitted the exact op for it in THIS reply. If no op exists for a request, say so plainly instead of pretending.
- Watch for contradictions you create: e.g. a Dietary Fiber nutrition line AND visible fiber-source claim rows double-represent the same fiber — when the user asks for a fiber-only label, set the fiber value and hideRow the fiber-source claim rows.

The user may attach images or PDFs (label artwork, competitor panels, CoAs, lab reports). Read them as reference material for answering and for panel edits (e.g. matching wording), and say what you see when relevant.

MATCHING A REFERENCE PANEL — when the user attaches a panel and asks to match/copy/read like it, do a FULL reconciliation in one reply, not a single edit:
1. Transcribe the reference completely: serving size line, servings per container, every nutrition row (calories, sodium, carbs, fiber, sugars, added sugars) with amounts and %DV, every active row with its exact display wording and amount, footnotes, other-ingredients line, allergen line.
2. Emit EVERY op needed to reproduce what is expressible: renameVariant/addVariant for the serving line, setServingsPerContainer, setNutrition for each nutrition row (per single gummy — divide by the reference's gummies-per-serving), renameRow for each active's wording, setDv where the reference shows a %DV, hideRow for rows the reference doesn't show, setOtherIngredients, setAllergens. A thorough match is often 8-15 ops — emit them all.
3. In the reply, list plainly what you could NOT reproduce and why: claim AMOUNTS that differ (Label Claims section owns those — state the reference's number so the user can enter it), actives on the reference that have no claim row here (they must be added in Label Claims first), and pure layout/typography differences.

Rules: use rowId/variantId values exactly as given in the state JSON. When the request is ambiguous, ask instead of guessing (ops may be empty). Keep replies plain text, no markdown. Answer in the language the user wrote in.`;

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const g = await gate();
  if (g.error) return g.error;
  const { id: formulaId } = await params;

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ ok: false, error: "no_api_key" }, { status: 503 });
  }

  let body: {
    messages?: ChatMessage[];
    panel?: unknown;
    formula?: unknown;
    attachments?: Array<{
      name?: string;
      mediaType?: string;
      dataBase64?: string;
    }>;
  };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }
  const history = (body.messages ?? [])
    .filter(
      (m): m is ChatMessage =>
        !!m &&
        (m.role === "user" || m.role === "assistant") &&
        typeof m.content === "string" &&
        m.content.length > 0,
    )
    .slice(-12);
  if (history.length === 0 || history[history.length - 1].role !== "user") {
    return NextResponse.json({ ok: false, error: "no_user_message" }, { status: 400 });
  }

  // v83.8: attachments (images/PDFs) ride the final user turn as real
  // content blocks. Only vetted media types pass through; 4 max.
  const ALLOWED_IMAGE = ["image/jpeg", "image/png", "image/webp", "image/gif"];
  const attachmentBlocks = (body.attachments ?? [])
    .filter(
      (a) =>
        a &&
        typeof a.dataBase64 === "string" &&
        a.dataBase64.length > 0 &&
        typeof a.mediaType === "string" &&
        (ALLOWED_IMAGE.includes(a.mediaType) ||
          a.mediaType === "application/pdf"),
    )
    .slice(0, 4)
    .map((a) =>
      a.mediaType === "application/pdf"
        ? {
            type: "document" as const,
            source: {
              type: "base64" as const,
              media_type: "application/pdf",
              data: a.dataBase64 as string,
            },
          }
        : {
            type: "image" as const,
            source: {
              type: "base64" as const,
              media_type: a.mediaType as string,
              data: a.dataBase64 as string,
            },
          },
    );

  // Fold the panel snapshot into the latest user turn so the model
  // always reasons against the state the user is looking at.
  const messages = history.map((m, i) =>
    i === history.length - 1
      ? {
          role: m.role,
          content: [
            ...attachmentBlocks,
            {
              type: "text" as const,
              text: `Current panel state:\n${JSON.stringify(body.panel ?? {}, null, 2)}\n\nFormula snapshot (read-only):\n${JSON.stringify(body.formula ?? {}, null, 2)}\n\nUser request: ${m.content}`,
            },
          ],
        }
      : m,
  );

  let resText: string;
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-5",
        // v84.7: a full panel-match pass can be 15 ops + a reconciliation
        // reply — 1500 risked truncating the JSON mid-op-list.
        max_tokens: 4000,
        system: SYSTEM_PROMPT,
        messages,
      }),
    });
    if (!res.ok) {
      const detail = await res.text();
      return NextResponse.json(
        { ok: false, error: `anthropic_${res.status}`, detail: detail.slice(0, 300) },
        { status: 502 },
      );
    }
    const data = (await res.json()) as {
      content?: Array<{ type: string; text?: string }>;
    };
    resText =
      (data.content ?? [])
        .filter((b) => b.type === "text" && typeof b.text === "string")
        .map((b) => b.text)
        .join("") || "";
  } catch {
    return NextResponse.json({ ok: false, error: "anthropic_unreachable" }, { status: 502 });
  }

  // Parse the model's JSON (tolerate stray text around the object).
  let reply = "";
  let ops: unknown[] = [];
  try {
    const start = resText.indexOf("{");
    const end = resText.lastIndexOf("}");
    const parsed = JSON.parse(resText.slice(start, end + 1)) as {
      reply?: unknown;
      ops?: unknown;
    };
    reply = typeof parsed.reply === "string" ? parsed.reply : "";
    ops = Array.isArray(parsed.ops) ? parsed.ops : [];
  } catch {
    reply = resText.trim().slice(0, 600) || "Sorry — I couldn't process that.";
    ops = [];
  }

  // v83.9: persist both turns so the thread survives reloads. Chat
  // history is best-effort — a failed insert must not eat the reply.
  try {
    const lastUser = history[history.length - 1];
    const attachmentNames = (body.attachments ?? [])
      .map((a) => a?.name)
      .filter((n): n is string => typeof n === "string" && n.length > 0);
    await g.supabase!.from("gummy_formula_panel_chat_messages").insert([
      {
        formula_id: formulaId,
        role: "user",
        content: lastUser.content,
        attachment_names: attachmentNames.length ? attachmentNames : null,
        author_email: g.email,
      },
      {
        formula_id: formulaId,
        role: "assistant",
        content: reply,
        author_email: g.email,
      },
    ]);
  } catch {
    /* best-effort */
  }

  return NextResponse.json({ ok: true, reply, ops });
}
