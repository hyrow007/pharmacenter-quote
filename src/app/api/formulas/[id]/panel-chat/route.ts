import { NextResponse } from "next/server";
import { createClient } from "@/lib/auth/server";

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

const SYSTEM_PROMPT = `You are the Supplement Facts panel assistant inside PharmaCenter's formula tool. You edit ONLY the label panel via structured ops — never the recipe, claims, amounts, or costing (amounts come from the Label Claim section; if asked to change an amount, explain that it's edited in the Label Claim section on the Bench top tab).

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

Rules: use rowId/variantId values exactly as given in the state JSON. When the request is ambiguous, ask instead of guessing (ops may be empty). Keep replies plain text, no markdown. Answer in the language the user wrote in.`;

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ ok: false, error: "not_signed_in" }, { status: 401 });
  }
  if (!user.email?.endsWith("@pharmacenterusa.com")) {
    return NextResponse.json({ ok: false, error: "wrong_domain" }, { status: 403 });
  }
  await params; // formula id is context only; edits stay client-side

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ ok: false, error: "no_api_key" }, { status: 503 });
  }

  let body: { messages?: ChatMessage[]; panel?: unknown };
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

  // Fold the panel snapshot into the latest user turn so the model
  // always reasons against the state the user is looking at.
  const messages = history.map((m, i) =>
    i === history.length - 1
      ? {
          role: m.role,
          content: `Current panel state:\n${JSON.stringify(body.panel ?? {}, null, 2)}\n\nUser request: ${m.content}`,
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
        max_tokens: 1500,
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

  return NextResponse.json({ ok: true, reply, ops });
}
