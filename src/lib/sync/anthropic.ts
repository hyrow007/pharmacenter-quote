// Minimal Anthropic client for the server-side sync jobs.
//
// Same shape as the call in api/formulas/[id]/panel-chat — a raw fetch, no
// SDK. Adding a dependency for one POST is not worth the install size or the
// version drift, and this repo already proved the pattern works.

import { extractJsonObject } from "./llm-core";

const API = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-sonnet-4-5";
const VERSION = "2023-06-01";

export type AskResult =
  | { ok: true; json: unknown }
  | { ok: false; error: string; detail?: string };

/**
 * Send one prompt, get parsed JSON back.
 *
 * `signal` carries the caller's time budget. Vercel Hobby kills a function at
 * 60s with no useful error, so every job here races its own clock and returns
 * partial progress rather than being cut off mid-write.
 */
export async function askForJson(
  prompt: string,
  maxTokens: number,
  signal?: AbortSignal,
): Promise<AskResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return { ok: false, error: "no_api_key" };

  let res: Response;
  try {
    res = await fetch(API, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": VERSION,
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: maxTokens,
        messages: [{ role: "user", content: prompt }],
      }),
      signal,
    });
  } catch (err) {
    // An abort here is the time budget expiring, not a failure of the model.
    // The caller needs to tell those apart to decide whether to retry.
    const aborted = err instanceof Error && err.name === "AbortError";
    return { ok: false, error: aborted ? "timeout" : "unreachable" };
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    return {
      ok: false,
      error: `anthropic_${res.status}`,
      detail: detail.slice(0, 300),
    };
  }

  let text: string;
  try {
    const body = (await res.json()) as {
      content?: Array<{ type?: string; text?: string }>;
    };
    text = (body.content ?? [])
      .filter((b) => b.type === "text")
      .map((b) => b.text ?? "")
      .join("");
  } catch {
    return { ok: false, error: "bad_response_envelope" };
  }

  try {
    return { ok: true, json: extractJsonObject(text) };
  } catch (err) {
    return {
      ok: false,
      error: "unparseable_json",
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}
