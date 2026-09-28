"use client";

import { useCallback, useEffect, useRef, useState } from "react";

// The quote assistant panel on /workflow/[id].
//
// One SHARED thread per quote: everyone on the team sees who asked what, the
// same way the SO assistant works. The assistant reads the quote and answers;
// it cannot change anything, which is why there are no Apply buttons here and
// no undo — there is nothing to undo.

type Msg = {
  id: string;
  role: "user" | "assistant";
  content: string;
  tool_events: { label?: string }[] | null;
  author_email: string;
  author_name: string | null;
  created_at: string;
};

type Attachment = { name: string; mediaType: string; dataBase64: string };

const STARTERS = [
  "Check this quote before I send it",
  "What is driving the cost per unit?",
  "Draft a short email to the customer with these prices",
];

function stamp(iso: string) {
  return new Date(iso).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export default function QuoteChat({
  workflowId,
  quoteNumber,
}: {
  workflowId: string;
  quoteNumber: string;
}) {
  const [open, setOpen] = useState(false);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [liveText, setLiveText] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [looks, setLooks] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [atts, setAtts] = useState<Attachment[]>([]);
  const endRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/workflows/${workflowId}/chat`, {
        cache: "no-store",
      });
      const json = await res.json();
      if (json?.ok) setMsgs(json.messages ?? []);
    } catch {
      /* the panel still works; the thread just starts empty */
    } finally {
      setLoaded(true);
    }
  }, [workflowId]);

  useEffect(() => {
    if (open && !loaded) void load();
  }, [open, loaded, load]);

  useEffect(() => {
    if (open) endRef.current?.scrollIntoView({ block: "end" });
  }, [msgs, liveText, open]);

  async function send(text: string) {
    const body = text.trim();
    if ((!body && atts.length === 0) || streaming) return;
    setInput("");
    setError(null);
    setLiveText("");
    setLooks([]);
    setStatus(null);
    setStreaming(true);
    // Show the question immediately — waiting for the round trip to see your
    // own words makes the panel feel broken.
    const optimistic: Msg = {
      id: `local-${Date.now()}`,
      role: "user",
      content: body || "(attachment)",
      tool_events: null,
      author_email: "",
      author_name: "You",
      created_at: new Date().toISOString(),
    };
    setMsgs((m) => [...m, optimistic]);
    const sending = atts;
    setAtts([]);

    try {
      const res = await fetch(`/api/workflows/${workflowId}/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          message: body,
          lang: "en",
          attachments: sending,
        }),
      });
      if (!res.ok || !res.body) {
        const j = await res.json().catch(() => null);
        throw new Error(j?.error || `http_${res.status}`);
      }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          let ev: Record<string, unknown>;
          try {
            ev = JSON.parse(line);
          } catch {
            continue;
          }
          if (ev.t === "text") setLiveText((t) => t + String(ev.d ?? ""));
          else if (ev.t === "status") setStatus(String(ev.label ?? ""));
          else if (ev.t === "look")
            setLooks((l) => [...l, String(ev.label ?? "")]);
          else if (ev.t === "error") setError(String(ev.error ?? "failed"));
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed");
    } finally {
      setStreaming(false);
      setStatus(null);
      setLiveText("");
      setLoaded(false);
      await load();
    }
  }

  async function onFiles(files: FileList | null) {
    if (!files) return;
    const out: Attachment[] = [];
    for (const f of Array.from(files).slice(0, 4)) {
      const buf = await f.arrayBuffer();
      let bin = "";
      const bytes = new Uint8Array(buf);
      for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
      out.push({
        name: f.name,
        mediaType: f.type,
        dataBase64: btoa(bin),
      });
    }
    setAtts((a) => [...a, ...out].slice(0, 4));
    if (fileRef.current) fileRef.current.value = "";
  }

  const bubble = (m: Msg) => {
    const mine = m.role === "user";
    return (
      <div key={m.id} style={{ marginBottom: 14 }}>
        <div
          style={{
            fontSize: 11,
            color: "var(--ink-3, #7b7364)",
            marginBottom: 3,
          }}
        >
          {mine ? m.author_name || m.author_email || "You" : "Quote assistant"}
          {" · "}
          {stamp(m.created_at)}
        </div>
        {!mine && m.tool_events && m.tool_events.length > 0 ? (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginBottom: 5 }}>
            {m.tool_events.map((t, i) => (
              <span key={i} style={chip}>
                {t.label}
              </span>
            ))}
          </div>
        ) : null}
        <div
          style={{
            whiteSpace: "pre-wrap",
            fontSize: 14,
            lineHeight: 1.55,
            color: "var(--ink, #2b2b2b)",
            background: mine ? "#f4f1e8" : "transparent",
            border: mine ? "1px solid #e3dcc9" : "none",
            borderRadius: mine ? 10 : 0,
            padding: mine ? "8px 11px" : 0,
          }}
        >
          {m.content}
        </div>
      </div>
    );
  };

  return (
    <div style={{ marginBottom: 28 }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          width: "100%",
          padding: "12px 14px",
          borderRadius: 10,
          border: "1.5px solid #e3dcc9",
          background: "#fffdf8",
          color: "var(--teal-900, #0f4a56)",
          fontFamily: "inherit",
          fontSize: 15,
          fontWeight: 700,
          cursor: "pointer",
          textAlign: "left",
        }}
      >
        <span>Ask about this quote</span>
        <span style={{ fontSize: 12, fontWeight: 400, color: "var(--ink-3, #7b7364)" }}>
          {msgs.length > 0 ? `${msgs.length} messages` : "reads the quote, drafts the email"}
        </span>
        <span style={{ marginLeft: "auto", opacity: 0.7 }}>{open ? "▴" : "▾"}</span>
      </button>

      {open ? (
        <div
          style={{
            marginTop: 10,
            border: "1.5px solid #e3dcc9",
            borderRadius: 12,
            background: "#fffdf8",
            padding: 14,
          }}
        >
          <div style={{ maxHeight: 460, overflowY: "auto", paddingRight: 4 }}>
            {!loaded ? (
              <p style={{ fontSize: 13, color: "var(--ink-3, #7b7364)" }}>Loading…</p>
            ) : msgs.length === 0 && !streaming ? (
              <div style={{ marginBottom: 10 }}>
                <p style={{ fontSize: 13, color: "var(--ink-3, #7b7364)", marginTop: 0 }}>
                  Ask anything about {quoteNumber}. It can read the costings,
                  the pricing tabs, Fishbowl costs and stock, and the pinned
                  formula. It cannot change the quote.
                </p>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                  {STARTERS.map((s) => (
                    <button
                      key={s}
                      type="button"
                      onClick={() => void send(s)}
                      style={{ ...chip, cursor: "pointer" }}
                    >
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            ) : null}

            {msgs.map(bubble)}

            {streaming ? (
              <div style={{ marginBottom: 14 }}>
                <div style={{ fontSize: 11, color: "var(--ink-3, #7b7364)", marginBottom: 3 }}>
                  Quote assistant
                </div>
                {looks.length > 0 ? (
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginBottom: 5 }}>
                    {looks.map((l, i) => (
                      <span key={i} style={chip}>
                        {l}
                      </span>
                    ))}
                  </div>
                ) : null}
                <div style={{ whiteSpace: "pre-wrap", fontSize: 14, lineHeight: 1.55 }}>
                  {liveText}
                  {status && !liveText ? (
                    <span style={{ color: "var(--ink-3, #7b7364)" }}>{status}</span>
                  ) : null}
                </div>
              </div>
            ) : null}
            <div ref={endRef} />
          </div>

          {error ? (
            <p style={{ fontSize: 12.5, color: "#a3281f", margin: "6px 0 0" }}>
              {error}
            </p>
          ) : null}

          {atts.length > 0 ? (
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 8 }}>
              {atts.map((a, i) => (
                <span key={i} style={chip}>
                  {a.name}{" "}
                  <button
                    type="button"
                    onClick={() => setAtts((x) => x.filter((_, j) => j !== i))}
                    style={{ border: "none", background: "none", cursor: "pointer" }}
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          ) : null}

          <div style={{ display: "flex", gap: 8, marginTop: 10, alignItems: "flex-end" }}>
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                // Enter sends; Shift+Enter is a newline. A quote question is
                // usually one line.
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void send(input);
                }
              }}
              placeholder={streaming ? "Thinking…" : "Ask about this quote…"}
              rows={2}
              disabled={streaming}
              style={{
                flex: 1,
                resize: "vertical",
                padding: "9px 11px",
                borderRadius: 8,
                border: "1px solid #e3dcc9",
                background: "#fff",
                font: "inherit",
                fontSize: 14,
              }}
            />
            <input
              ref={fileRef}
              type="file"
              multiple
              accept="image/png,image/jpeg,image/webp,image/gif,application/pdf"
              onChange={(e) => void onFiles(e.target.files)}
              style={{ display: "none" }}
            />
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              disabled={streaming}
              title="Attach an image or PDF"
              style={{ ...btn, padding: "9px 11px" }}
            >
              +
            </button>
            <button
              type="button"
              onClick={() => void send(input)}
              disabled={streaming || (!input.trim() && atts.length === 0)}
              style={btn}
            >
              {streaming ? "…" : "Send"}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

const chip: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 4,
  padding: "3px 9px",
  borderRadius: 999,
  border: "1px solid #e3dcc9",
  background: "#f7f4ec",
  color: "var(--teal-900, #0f4a56)",
  fontSize: 11.5,
  fontWeight: 600,
};

const btn: React.CSSProperties = {
  padding: "9px 16px",
  borderRadius: 8,
  border: "1.5px solid var(--teal-900, #0f4a56)",
  background: "var(--teal-900, #0f4a56)",
  color: "#fff",
  fontFamily: "inherit",
  fontSize: 14,
  fontWeight: 700,
  cursor: "pointer",
};
