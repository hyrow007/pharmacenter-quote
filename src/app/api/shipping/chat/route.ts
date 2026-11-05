import { NextResponse } from "next/server";
import { shipGate } from "@/app/shipping/_lib/gate";
import { streamMessage, type ApiMessage, type ContentBlock } from "@/app/orders/_lib/anthropicStream";
import { TOOLS, TOOL_LABELS, MODEL, EFFORT, buildSystem, runTool } from "@/app/shipping/_lib/agent";
import { checkDraft } from "@/app/shipping/_lib/draft";

// /api/shipping/chat -- the shipping assistant.
//
// POST { messages: [{ role, text }], draft, lang } -> NDJSON:
//   {"t":"text","d":"…"}  {"t":"status","label":"…"}
//   {"t":"draft","draft":{…},"problems":[…]}  {"t":"done"}  {"t":"error","error":"…"}
//
// Stateless: the browser holds the conversation for one shipment and sends it
// back each turn. Nothing here can create a label -- see _lib/agent.ts.
// Vercel Hobby stops a function at 60 s, so the loop stops itself at ~52 s.

export const runtime = "nodejs";
export const maxDuration = 60;

const BUDGET_MS = 52_000;
const MAX_ROUNDS = 8;

export async function POST(req: Request) {
  const started = Date.now();
  const g = await shipGate();
  if (!g.ok) return NextResponse.json({ ok: false, error: g.error }, { status: g.error === "server_misconfigured" ? 500 : 401 });
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return NextResponse.json({ ok: false, error: "no_anthropic_key" }, { status: 500 });

  const body = (await req.json().catch(() => null)) as {
    messages?: Array<{ role?: string; text?: string }>;
    draft?: unknown;
    lang?: string;
  } | null;
  const lang = body?.lang === "es" ? "es" : "en";
  const history = (Array.isArray(body?.messages) ? body!.messages : [])
    .filter((m) => (m.role === "user" || m.role === "assistant") && typeof m.text === "string" && m.text.trim())
    .slice(-30)
    .map((m) => ({ role: m.role as "user" | "assistant", text: String(m.text).slice(0, 4000) }));
  if (!history.length || history[history.length - 1].role !== "user") {
    return NextResponse.json({ ok: false, error: "no_message" }, { status: 400 });
  }

  const turns: ApiMessage[] = [];
  for (const m of history) {
    const last = turns[turns.length - 1];
    if (last && last.role === m.role && typeof last.content === "string") last.content += `\n\n${m.text}`;
    else if (turns.length || m.role === "user") turns.push({ role: m.role, content: m.text });
  }
  // The draft on screen, so the model continues from it rather than from memory.
  if (body?.draft) {
    const { draft, problems } = checkDraft(body.draft);
    const last = turns[turns.length - 1];
    last.content = `${last.content}\n\n[Current draft on screen: ${JSON.stringify(draft)}; missing: ${problems.join(", ") || "nothing"}]`;
  }

  const system = buildSystem({ userName: g.name, userEmail: g.email, lang });
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const send = (obj: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(JSON.stringify(obj) + "\n"));
        } catch {
          closed = true;
        }
      };
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), BUDGET_MS - (Date.now() - started));
      let wrote = "";
      let failure: string | null = null;
      try {
        for (let round = 0; round < MAX_ROUNDS; round++) {
          const result = await streamMessage({
            apiKey,
            model: MODEL,
            effort: EFFORT,
            system,
            messages: turns,
            tools: TOOLS,
            maxTokens: 6000,
            signal: abort.signal,
            onThinking: () => send({ t: "status", label: lang === "es" ? "Pensando…" : "Thinking…" }),
            onText: (d) => {
              wrote += d;
              send({ t: "text", d });
            },
          });
          if (!result.ok) {
            failure = result.error;
            break;
          }
          turns.push({ role: "assistant", content: result.content });
          const calls = result.content.filter(
            (b): b is Extract<ContentBlock, { type: "tool_use" }> => b.type === "tool_use",
          );
          if (result.stopReason !== "tool_use" || calls.length === 0) break;
          const results: ContentBlock[] = [];
          for (const call of calls) {
            send({ t: "status", label: `${TOOL_LABELS[call.name]?.[lang] ?? call.name}…` });
            const out = await runTool(call.name, call.input, {
              supabase: g.supabase,
              onDraft: (d) => send({ t: "draft", draft: d.draft, problems: d.problems }),
            });
            results.push({ type: "tool_result", tool_use_id: call.id, content: out.content, ...(out.isError ? { is_error: true } : {}) });
          }
          turns.push({ role: "user", content: results });
          if (wrote && !wrote.endsWith("\n")) {
            wrote += "\n\n";
            send({ t: "text", d: "\n\n" });
          }
          if (round === MAX_ROUNDS - 1) failure = "too_many_steps";
        }
      } catch (err) {
        failure = err instanceof Error ? err.message : String(err);
      } finally {
        clearTimeout(timer);
      }
      if (failure) send({ t: "error", error: failure.slice(0, 200) });
      send({ t: "done" });
      if (!closed) {
        try {
          controller.close();
        } catch {
          /* client went away */
        }
      }
    },
  });

  return new Response(stream, {
    headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store", "x-accel-buffering": "no" },
  });
}
