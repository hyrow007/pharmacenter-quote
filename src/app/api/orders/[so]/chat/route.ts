import { NextResponse } from "next/server";
import { gate, cleanSo } from "../../_lib/gate";
import { loadFishbowlLexicon } from "@/lib/plaud/fishbowlLexicon";
import { loadSoContext } from "@/app/orders/_lib/soContext";
import {
  streamMessage,
  type ApiMessage,
  type ContentBlock,
} from "@/app/orders/_lib/anthropicStream";
import {
  TOOLS,
  TOOL_LABELS,
  DEFAULT_MODEL,
  DEFAULT_EFFORT,
  buildSystem,
  runTool,
  type ActionEvent,
} from "@/app/orders/_lib/soAssistant";

// /api/orders/[so]/chat -- the SO assistant.
//
// GET   the shared thread for this SO, its action log, and active corrections.
// POST  { message, lang, attachments? } -> NDJSON stream of events:
//         {"t":"text","d":"…"}                     reply text as it is written
//         {"t":"status","label":"…"}               thinking / running a tool
//         {"t":"action","action":{id,kind,status,summary}}
//         {"t":"done","id":"<assistant message id>"}
//         {"t":"error","error":"…"}
//
// The loop runs server-side: model -> tools -> model, until it answers or the
// clock runs out. Vercel Hobby kills a function at 60s, so the loop stops
// itself at ~52s and says so rather than being cut off mid-sentence.

export const runtime = "nodejs";
export const maxDuration = 60;

const BUDGET_MS = 52_000;
const MAX_ROUNDS = 8;
const HISTORY_TURNS = 30;

type Params = { params: Promise<{ so: string }> };

export async function GET(_req: Request, { params }: Params) {
  const g = await gate();
  if (g.error) return g.error;
  const so = cleanSo((await params).so);
  if (!so) return NextResponse.json({ ok: false, error: "bad_so" }, { status: 400 });

  const [msgs, actions, corrections] = await Promise.all([
    g.supabase
      .from("so_chat_messages")
      .select("id, role, content, lang, attachment_names, tool_events, author_email, author_name, created_at")
      .eq("so_number", so)
      .order("created_at", { ascending: true })
      .limit(200),
    g.supabase
      .from("so_chat_actions")
      .select("id, kind, status, summary, message_id, created_by, created_at, resolved_by, resolved_at")
      .eq("so_number", so)
      .order("created_at", { ascending: true })
      .limit(300),
    g.supabase
      .from("so_corrections")
      .select("id, topic, text, text_es, supersedes, created_by, created_by_name, created_at")
      .eq("so_number", so)
      .is("retracted_at", null)
      .order("created_at", { ascending: false }),
  ]);
  const err = msgs.error ?? actions.error ?? corrections.error;
  if (err) return NextResponse.json({ ok: false, error: err.message }, { status: 500 });
  return NextResponse.json({
    ok: true,
    me: g.email,
    messages: msgs.data ?? [],
    actions: actions.data ?? [],
    corrections: corrections.data ?? [],
  });
}

const ALLOWED_IMAGE = ["image/jpeg", "image/png", "image/webp", "image/gif"];

export async function POST(request: Request, { params }: Params) {
  const started = Date.now();
  const g = await gate();
  if (g.error) return g.error;
  const so = cleanSo((await params).so);
  if (!so) return NextResponse.json({ ok: false, error: "bad_so" }, { status: 400 });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return NextResponse.json({ ok: false, error: "no_api_key" }, { status: 503 });
  const model = process.env.SO_CHAT_MODEL || DEFAULT_MODEL;
  const effort = process.env.SO_CHAT_EFFORT || DEFAULT_EFFORT;

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
  const message = typeof body.message === "string" ? body.message.trim().slice(0, 8000) : "";
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
  if (!message && attachments.length === 0) {
    return NextResponse.json({ ok: false, error: "empty_message" }, { status: 400 });
  }
  const attachmentNames = attachments
    .map((a) => a.name)
    .filter((n): n is string => typeof n === "string" && n.length > 0);

  // Prior thread, BEFORE this message is saved.
  const { data: priorRaw } = await g.supabase
    .from("so_chat_messages")
    .select("role, content, author_name, author_email, created_at")
    .eq("so_number", so)
    .order("created_at", { ascending: false })
    .limit(HISTORY_TURNS);
  const prior = ((priorRaw ?? []) as Array<{
    role: "user" | "assistant";
    content: string;
    author_name: string | null;
    author_email: string;
    created_at: string;
  }>).reverse();

  const { data: userRow, error: userErr } = await g.supabase
    .from("so_chat_messages")
    .insert({
      so_number: so,
      role: "user",
      content: message || "(attachment)",
      lang,
      attachment_names: attachmentNames.length ? attachmentNames : null,
      author_email: g.email,
      author_name: g.name,
    })
    .select("id")
    .single();
  if (userErr || !userRow) {
    return NextResponse.json(
      { ok: false, error: `could not save message: ${userErr?.message ?? "unknown"}` },
      { status: 500 },
    );
  }
  const userMessageId = String((userRow as { id: string }).id);

  const lexicon = await loadFishbowlLexicon(g.supabase);
  const context = await loadSoContext(g.supabase, so, lexicon);
  const system = buildSystem({ so, userName: g.name, userEmail: g.email, lang, context });

  // Shared thread: label each human turn with who wrote it and when.
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
      push("user", `[${m.author_name ?? m.author_email}, ${stamp(m.created_at)}]: ${m.content}`);
    } else if (turns.length > 0) {
      push("assistant", m.content);
    }
  }
  const currentBlocks: ContentBlock[] = [
    ...attachments.map((a): ContentBlock =>
      a.mediaType === "application/pdf"
        ? { type: "document", source: { type: "base64", media_type: "application/pdf", data: a.dataBase64! } }
        : { type: "image", source: { type: "base64", media_type: a.mediaType!, data: a.dataBase64! } },
    ),
    {
      type: "text",
      text: `[${g.name ?? g.email}, now]: ${message || "(see attachment)"}${
        attachmentNames.length ? `\n(Attached: ${attachmentNames.join(", ")})` : ""
      }`,
    },
  ];
  const last = turns[turns.length - 1];
  if (last && last.role === "user") {
    const prev = typeof last.content === "string" ? [{ type: "text", text: last.content } as ContentBlock] : last.content;
    last.content = [...prev, ...currentBlocks];
  } else {
    turns.push({ role: "user", content: currentBlocks });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      // If the browser goes away mid-reply, enqueue throws on the closed
      // stream. Keep going anyway so the reply and actions are still saved.
      let closed = false;
      const send = (obj: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(JSON.stringify(obj) + "\n"));
        } catch {
          closed = true;
        }
      };
      const actions: ActionEvent[] = [];
      let replyText = "";
      let failure: string | null = null;
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), BUDGET_MS - (Date.now() - started));

      try {
        send({ t: "status", label: lang === "es" ? "Leyendo la orden…" : "Reading the order…" });
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
              send({ t: "status", label: lang === "es" ? "Pensando…" : "Thinking…" }),
            onText: (d) => {
              replyText += d;
              send({ t: "text", d });
            },
          });
          if (!result.ok) {
            failure = result.error === "timeout" ? "timeout" : `${result.error}${result.detail ? `: ${result.detail}` : ""}`;
            break;
          }
          turns.push({ role: "assistant", content: result.content });
          const calls = result.content.filter(
            (b): b is Extract<ContentBlock, { type: "tool_use" }> => b.type === "tool_use",
          );
          if (result.stopReason !== "tool_use" || calls.length === 0) break;

          const results: ContentBlock[] = [];
          for (const call of calls) {
            const label = TOOL_LABELS[call.name]?.[lang] ?? call.name;
            send({ t: "status", label: `${label}…` });
            const out = await runTool(call.name, call.input, {
              so,
              userEmail: g.email,
              userName: g.name,
              messageId: userMessageId,
              supabase: g.supabase,
              admin: g.admin,
              lexicon,
              context,
              onAction: (a) => {
                actions.push(a);
                send({ t: "action", action: a });
              },
            });
            results.push({
              type: "tool_result",
              tool_use_id: call.id,
              content: out.content,
              ...(out.isError ? { is_error: true } : {}),
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
            : lang === "es"
              ? `(Error: ${failure.slice(0, 200)})`
              : `(Error: ${failure.slice(0, 200)})`;
        replyText = replyText ? `${replyText.trimEnd()}\n\n${note}` : note;
        send({ t: failure === "timeout" ? "text" : "error", d: `\n\n${note}`, error: failure });
      }

      const { data: asstRow } = await g.supabase
        .from("so_chat_messages")
        .insert({
          so_number: so,
          role: "assistant",
          content: replyText.trim() || "(no reply)",
          lang,
          tool_events: actions,
          model,
          author_email: g.email,
          author_name: "SO assistant",
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
