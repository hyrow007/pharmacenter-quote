import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  streamMessage,
  type ApiMessage,
  type ContentBlock,
} from "@/app/orders/_lib/anthropicStream";
import { loadQuoteContext } from "@/app/workflow/[id]/_lib/quoteContext";
import {
  TOOLS,
  TOOL_LABELS,
  DEFAULT_MODEL,
  DEFAULT_EFFORT,
  buildSystem,
  runTool,
} from "@/app/workflow/[id]/_lib/quoteAssistant";
import type { WorkflowRow } from "@/lib/workflows";

// /api/workflows/[id]/chat — the quote assistant.
//
// GET   the shared thread for this quote.
// POST  { message, lang, attachments? } -> NDJSON stream of events:
//         {"t":"text","d":"…"}         reply text as it is written
//         {"t":"status","label":"…"}   thinking / reading something
//         {"t":"look","label":"…"}     what it read, for the chips
//         {"t":"done","id":"…"}
//         {"t":"error","error":"…"}
//
// The loop runs server-side: model -> tools -> model. Vercel kills a function
// at 60s, so it stops itself at ~52s and says so rather than being cut off
// mid-sentence. Every tool is a read; nothing here writes to the quote.

export const runtime = "nodejs";
export const maxDuration = 60;

const BUDGET_MS = 52_000;
const MAX_ROUNDS = 8;
const HISTORY_TURNS = 30;
const COLS =
  "id, quote_number, created_by_email, created_at, updated_at, state, status, sales_orders, description_override";

type Params = { params: Promise<{ id: string }> };

type Ok = {
  error: null;
  supabase: SupabaseClient;
  email: string;
  name: string | null;
};
type Gated = { error: NextResponse } | Ok;

async function gate(): Promise<Gated> {
  const supabase = (await createClient()) as unknown as SupabaseClient;
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user?.email)
    return {
      error: NextResponse.json({ ok: false, error: "not_signed_in" }, { status: 401 }),
    };
  if (!user.email.endsWith("@pharmacenterusa.com"))
    return {
      error: NextResponse.json({ ok: false, error: "wrong_domain" }, { status: 403 }),
    };
  const meta = (user.user_metadata ?? {}) as Record<string, unknown>;
  const name =
    (typeof meta.full_name === "string" && meta.full_name) ||
    (typeof meta.name === "string" && meta.name) ||
    null;
  return { error: null, supabase, email: user.email, name };
}

export async function GET(_req: Request, { params }: Params) {
  const g = await gate();
  if (g.error) return g.error;
  const { id } = await params;
  const { data, error } = await g.supabase
    .from("quote_chat_messages")
    .select("id, role, content, lang, tool_events, author_email, author_name, created_at")
    .eq("workflow_id", id)
    .order("created_at", { ascending: true })
    .limit(200);
  if (error)
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, me: g.email, messages: data ?? [] });
}

const ALLOWED_IMAGE = ["image/jpeg", "image/png", "image/webp", "image/gif"];

export async function POST(request: Request, { params }: Params) {
  const started = Date.now();
  const g = await gate();
  if (g.error) return g.error;
  const { id } = await params;

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey)
    return NextResponse.json({ ok: false, error: "no_api_key" }, { status: 503 });
  const model = process.env.QUOTE_CHAT_MODEL || DEFAULT_MODEL;
  const effort = process.env.QUOTE_CHAT_EFFORT || DEFAULT_EFFORT;

  let body: {
    message?: string;
    lang?: string;
    attachments?: Array<{ name?: string; mediaType?: string; dataBase64?: string }>;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }
  const message =
    typeof body.message === "string" ? body.message.trim().slice(0, 8000) : "";
  const lang: "en" | "es" = body.lang === "es" ? "es" : "en";
  const attachments = (body.attachments ?? [])
    .filter(
      (a) =>
        a &&
        typeof a.dataBase64 === "string" &&
        a.dataBase64.length > 0 &&
        typeof a.mediaType === "string" &&
        (ALLOWED_IMAGE.includes(a.mediaType) || a.mediaType === "application/pdf"),
    )
    .slice(0, 4);
  if (!message && attachments.length === 0)
    return NextResponse.json({ ok: false, error: "empty_message" }, { status: 400 });
  const attachmentNames = attachments
    .map((a) => a.name)
    .filter((n): n is string => typeof n === "string" && n.length > 0);

  const { data: wf, error: wfErr } = await g.supabase
    .from("workflows")
    .select(COLS)
    .eq("id", id)
    .maybeSingle();
  if (wfErr)
    return NextResponse.json({ ok: false, error: wfErr.message }, { status: 500 });
  if (!wf)
    return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  const workflow = wf as unknown as WorkflowRow;

  // Prior thread, BEFORE this message is saved.
  const { data: priorRaw } = await g.supabase
    .from("quote_chat_messages")
    .select("role, content, author_name, author_email, created_at")
    .eq("workflow_id", id)
    .order("created_at", { ascending: false })
    .limit(HISTORY_TURNS);
  const prior = (
    (priorRaw ?? []) as Array<{
      role: "user" | "assistant";
      content: string;
      author_name: string | null;
      author_email: string;
      created_at: string;
    }>
  ).reverse();

  const { error: userErr } = await g.supabase.from("quote_chat_messages").insert({
    workflow_id: id,
    role: "user",
    content: message || "(attachment)",
    lang,
    author_email: g.email,
    author_name: g.name,
  });
  if (userErr)
    return NextResponse.json(
      { ok: false, error: `could not save message: ${userErr.message}` },
      { status: 500 },
    );

  // Captured before the stream starts: `request` is not in scope inside it,
  // and a tool that calls one of our own routes has to do it as this person.
  const reqOrigin = new URL(request.url).origin;
  const reqCookie = request.headers.get("cookie") ?? "";

  const context = await loadQuoteContext(g.supabase, workflow);
  const system = buildSystem(context, g.name);

  // Shared thread: label each human turn with who wrote it and when, so the
  // model can tell two people's questions apart.
  const stamp = (iso: string) =>
    new Date(iso).toLocaleString("en-US", {
      timeZone: "America/New_York",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  const turns: ApiMessage[] = [];
  const push = (role: "user" | "assistant", text: string) => {
    const last = turns[turns.length - 1];
    if (last && last.role === role && typeof last.content === "string") {
      last.content += `\n\n${text}`;
    } else {
      turns.push({ role, content: text });
    }
  };
  for (const m of prior) {
    if (m.role === "user") {
      push(
        "user",
        `[${m.author_name ?? m.author_email}, ${stamp(m.created_at)}]: ${m.content}`,
      );
    } else if (turns.length > 0) {
      push("assistant", m.content);
    }
  }
  const currentBlocks: ContentBlock[] = [
    ...attachments.map((a): ContentBlock =>
      a.mediaType === "application/pdf"
        ? {
            type: "document",
            source: {
              type: "base64",
              media_type: "application/pdf",
              data: a.dataBase64!,
            },
          }
        : {
            type: "image",
            source: {
              type: "base64",
              media_type: a.mediaType!,
              data: a.dataBase64!,
            },
          },
    ),
    {
      type: "text",
      text: `[${g.name ?? g.email}, now]: ${message || "(see attachment)"}${
        attachmentNames.length ? `\n(Attached: ${attachmentNames.join(", ")})` : ""
      }`,
    },
  ];
  const lastTurn = turns[turns.length - 1];
  if (lastTurn && lastTurn.role === "user") {
    const prev =
      typeof lastTurn.content === "string"
        ? [{ type: "text", text: lastTurn.content } as ContentBlock]
        : lastTurn.content;
    lastTurn.content = [...prev, ...currentBlocks];
  } else {
    turns.push({ role: "user", content: currentBlocks });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      // If the browser goes away mid-reply, enqueue throws on the closed
      // stream. Keep going so the reply is still saved to the thread.
      let closed = false;
      const send = (obj: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(JSON.stringify(obj) + "\n"));
        } catch {
          closed = true;
        }
      };
      const looks: string[] = [];
      let replyText = "";
      let failure: string | null = null;
      const abort = new AbortController();
      const timer = setTimeout(
        () => abort.abort(),
        Math.max(1000, BUDGET_MS - (Date.now() - started)),
      );

      try {
        send({
          t: "status",
          label: lang === "es" ? "Leyendo la cotización…" : "Reading the quote…",
        });
        for (let round = 0; round < MAX_ROUNDS; round++) {
          const result = await streamMessage({
            apiKey,
            model,
            effort,
            system,
            messages: turns,
            tools: TOOLS,
            maxTokens: 8000,
            signal: abort.signal,
            onThinking: () =>
              send({
                t: "status",
                label: lang === "es" ? "Pensando…" : "Thinking…",
              }),
            onText: (d) => {
              replyText += d;
              send({ t: "text", d });
            },
          });
          if (!result.ok) {
            failure =
              result.error === "timeout"
                ? "timeout"
                : `${result.error}${result.detail ? `: ${result.detail}` : ""}`;
            break;
          }
          turns.push({ role: "assistant", content: result.content });
          const calls = result.content.filter(
            (b): b is Extract<ContentBlock, { type: "tool_use" }> =>
              b.type === "tool_use",
          );
          if (result.stopReason !== "tool_use" || calls.length === 0) break;

          const results: ContentBlock[] = [];
          for (const call of calls) {
            send({ t: "status", label: `${TOOL_LABELS[call.name] ?? call.name}…` });
            const out = await runTool(
              call.name,
              (call.input ?? {}) as Record<string, unknown>,
              {
                workflow,
                supabase: g.supabase,
                context,
                origin: reqOrigin,
                cookie: reqCookie,
                onLook: (label) => {
                  if (!looks.includes(label)) {
                    looks.push(label);
                    send({ t: "look", label });
                  }
                },
              },
            );
            results.push({
              type: "tool_result",
              tool_use_id: call.id,
              content: out,
            });
          }
          turns.push({ role: "user", content: results });
          if (replyText && !replyText.endsWith("\n")) {
            replyText += "\n\n";
            send({ t: "text", d: "\n\n" });
          }
          if (round === MAX_ROUNDS - 1) failure = "too_many_steps";
        }
      } catch (err) {
        failure = err instanceof Error ? err.message : String(err);
      } finally {
        clearTimeout(timer);
      }

      if (failure) {
        const note =
          failure === "timeout"
            ? lang === "es"
              ? "(Se acabó el tiempo antes de terminar. Pregunta de nuevo para continuar.)"
              : "(Ran out of time before finishing. Ask again to continue.)"
            : `(Error: ${failure.slice(0, 200)})`;
        replyText = replyText ? `${replyText.trimEnd()}\n\n${note}` : note;
        send({
          t: failure === "timeout" ? "text" : "error",
          d: `\n\n${note}`,
          error: failure,
        });
      }

      const { data: asstRow } = await g.supabase
        .from("quote_chat_messages")
        .insert({
          workflow_id: id,
          role: "assistant",
          content: replyText.trim() || "(no reply)",
          lang,
          tool_events: looks.map((label) => ({ label })),
          model,
          author_email: g.email,
          author_name: "Quote assistant",
        })
        .select("id")
        .single();
      send({ t: "done", id: asstRow ? String((asstRow as { id: string }).id) : null });
      if (!closed) {
        try {
          controller.close();
        } catch {
          /* already closed by the client */
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "no-store",
      "x-accel-buffering": "no",
    },
  });
}
