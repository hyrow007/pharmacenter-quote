// Streaming Messages API call with tool use, for the SO assistant.
//
// Raw fetch + SSE parsing rather than the SDK, matching the rest of this repo
// (see src/lib/sync/anthropic.ts: one POST is not worth a dependency).
//
// The one thing that must be exactly right: the assistant turn is rebuilt
// block-for-block from the stream -- thinking blocks WITH their signature --
// because a tool-use loop has to send the assistant's content back verbatim.
// Dropping or editing a thinking block makes the next request 400.

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string; signature: string }
  | { type: "redacted_thinking"; data: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean }
  | { type: "image"; source: { type: "base64"; media_type: string; data: string } }
  | { type: "document"; source: { type: "base64"; media_type: string; data: string } };

export type ApiMessage = { role: "user" | "assistant"; content: string | ContentBlock[] };

export type ToolDef = {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
};

export type StreamResult =
  | { ok: true; content: ContentBlock[]; stopReason: string | null }
  | { ok: false; error: string; detail?: string };

type Partial =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string; signature: string }
  | { type: "redacted_thinking"; data: string }
  | { type: "tool_use"; id: string; name: string; json: string };

export async function streamMessage(opts: {
  apiKey: string;
  model: string;
  effort: string;
  system: Array<{ type: "text"; text: string; cache_control?: { type: "ephemeral" } }>;
  messages: ApiMessage[];
  tools: ToolDef[];
  maxTokens: number;
  signal?: AbortSignal;
  onText: (delta: string) => void;
  onThinking?: () => void;
}): Promise<StreamResult> {
  let res: Response;
  try {
    res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": opts.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: opts.model,
        max_tokens: opts.maxTokens,
        stream: true,
        system: opts.system,
        messages: opts.messages,
        tools: opts.tools,
        thinking: { type: "adaptive" },
        output_config: { effort: opts.effort },
      }),
      signal: opts.signal,
    });
  } catch (err) {
    const aborted = err instanceof Error && err.name === "AbortError";
    return { ok: false, error: aborted ? "timeout" : "unreachable" };
  }
  if (!res.ok || !res.body) {
    const detail = await res.text().catch(() => "");
    return { ok: false, error: `anthropic_${res.status}`, detail: detail.slice(0, 400) };
  }

  const blocks: Partial[] = [];
  let stopReason: string | null = null;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";

  const handle = (evt: Record<string, unknown>) => {
    const type = evt.type;
    if (type === "content_block_start") {
      const i = Number(evt.index);
      const cb = (evt.content_block ?? {}) as Record<string, unknown>;
      if (cb.type === "text") blocks[i] = { type: "text", text: String(cb.text ?? "") };
      else if (cb.type === "thinking") {
        blocks[i] = {
          type: "thinking",
          thinking: String(cb.thinking ?? ""),
          signature: String(cb.signature ?? ""),
        };
        opts.onThinking?.();
      } else if (cb.type === "redacted_thinking")
        blocks[i] = { type: "redacted_thinking", data: String(cb.data ?? "") };
      else if (cb.type === "tool_use")
        blocks[i] = { type: "tool_use", id: String(cb.id), name: String(cb.name), json: "" };
    } else if (type === "content_block_delta") {
      const i = Number(evt.index);
      const d = (evt.delta ?? {}) as Record<string, unknown>;
      const b = blocks[i];
      if (!b) return;
      if (d.type === "text_delta" && b.type === "text") {
        const t = String(d.text ?? "");
        b.text += t;
        if (t) opts.onText(t);
      } else if (d.type === "thinking_delta" && b.type === "thinking") {
        b.thinking += String(d.thinking ?? "");
      } else if (d.type === "signature_delta" && b.type === "thinking") {
        b.signature += String(d.signature ?? "");
      } else if (d.type === "input_json_delta" && b.type === "tool_use") {
        b.json += String(d.partial_json ?? "");
      }
    } else if (type === "message_delta") {
      const d = (evt.delta ?? {}) as Record<string, unknown>;
      if (typeof d.stop_reason === "string") stopReason = d.stop_reason;
    } else if (type === "error") {
      throw new Error(JSON.stringify(evt.error ?? evt).slice(0, 400));
    }
  };

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl: number;
      // SSE frames are separated by a blank line; each has "event:" and
      // "data:" lines. Only the data line matters -- it repeats the type.
      while ((nl = buf.indexOf("\n\n")) !== -1) {
        const frame = buf.slice(0, nl);
        buf = buf.slice(nl + 2);
        for (const line of frame.split("\n")) {
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (!payload) continue;
          handle(JSON.parse(payload) as Record<string, unknown>);
        }
      }
    }
  } catch (err) {
    const aborted = err instanceof Error && err.name === "AbortError";
    return {
      ok: false,
      error: aborted ? "timeout" : "stream_error",
      detail: err instanceof Error ? err.message : String(err),
    };
  }

  const content: ContentBlock[] = [];
  for (const b of blocks) {
    if (!b) continue;
    if (b.type === "tool_use") {
      let input: unknown = {};
      try {
        input = b.json ? JSON.parse(b.json) : {};
      } catch {
        input = {};
      }
      content.push({ type: "tool_use", id: b.id, name: b.name, input });
    } else {
      content.push(b);
    }
  }
  return { ok: true, content, stopReason };
}
