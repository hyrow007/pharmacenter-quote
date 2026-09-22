"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { makeT, type Lang } from "@/lib/i18n/dict";

// The SO assistant drawer. A launcher pinned bottom-right opens a panel with
// the SO's shared thread; replies stream in; anything the assistant changed
// shows as a card with Undo, and Monday drafts wait for Send.
//
// Opens by itself when the URL hash is #chat -- that is how the "Ask AI"
// chip on each Orders card lands here.

type Msg = {
  id: string;
  role: "user" | "assistant";
  content: string;
  author_email: string;
  author_name: string | null;
  attachment_names: string[] | null;
  created_at: string;
  pending?: boolean;
};

type Action = {
  id: string;
  kind: "correction" | "retract_correction" | "meeting_note_edit" | "key_points" | "monday_post";
  status: "applied" | "pending" | "sent" | "cancelled" | "undone" | "failed";
  summary: string | null;
  created_by?: string;
  created_at: string;
  resolved_by?: string | null;
};

type Attachment = { name: string; mediaType: string; dataBase64: string; size: number };

// Vercel rejects request bodies over 4.5 MB; base64 adds a third.
const MAX_ATTACH_BYTES = 3.2 * 1024 * 1024;

// Chrome ships speech recognition under a prefix and TypeScript's DOM lib
// does not declare it, so it is typed by hand here.
type Recognition = {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  start: () => void;
  stop: () => void;
  onresult:
    | ((e: {
        results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }>;
      }) => void)
    | null;
  onend: (() => void) | null;
  onerror: (() => void) | null;
};

function fmtTime(iso: string, lang: Lang): string {
  return new Date(iso).toLocaleString(lang === "es" ? "es" : "en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function pill(bg: string, fg: string, border: string): React.CSSProperties {
  return {
    padding: "5px 12px",
    borderRadius: 999,
    border: `1px solid ${border}`,
    background: bg,
    color: fg,
    fontSize: 12,
    fontWeight: 700,
    cursor: "pointer",
  };
}

export default function SoChat({
  so,
  lang,
  initialOpen = false,
  hideLauncher = false,
  onClose,
}: {
  so: string;
  lang: Lang;
  // Used by OrdersChatHost on the landing page: the drawer opens straight
  // away over the card list and has no launcher of its own.
  initialOpen?: boolean;
  hideLauncher?: boolean;
  onClose?: () => void;
}) {
  const t = makeT(lang);
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [actions, setActions] = useState<Action[]>([]);
  const [me, setMe] = useState("");
  const [input, setInput] = useState("");
  const [files, setFiles] = useState<Attachment[]>([]);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [listening, setListening] = useState(false);
  const [micOk, setMicOk] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const recRef = useRef<Recognition | null>(null);
  const baseRef = useRef("");
  const fileRef = useRef<HTMLInputElement | null>(null);
  const taRef = useRef<HTMLTextAreaElement | null>(null);

  const api = `/api/orders/${encodeURIComponent(so)}`;

  useEffect(() => {
    if (initialOpen || window.location.hash === "#chat") setOpen(true);
    const w = window as unknown as { SpeechRecognition?: unknown; webkitSpeechRecognition?: unknown };
    setMicOk(!!(w.SpeechRecognition || w.webkitSpeechRecognition));
  }, []);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`${api}/chat`, { cache: "no-store" });
      const j = (await res.json()) as {
        ok: boolean;
        error?: string;
        me?: string;
        messages?: Msg[];
        actions?: Action[];
      };
      if (!j.ok) throw new Error(j.error);
      setMsgs(j.messages ?? []);
      setActions(j.actions ?? []);
      setMe(j.me ?? "");
      setLoaded(true);
    } catch (err) {
      setError(`${makeT(lang)("soChatError")} ${err instanceof Error ? err.message : ""}`.trim());
    }
  }, [api, lang]);

  useEffect(() => {
    if (open && !loaded) void load();
    if (open) setTimeout(() => taRef.current?.focus(), 50);
  }, [open, loaded, load]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [msgs, actions, status, open]);

  const close = () => {
    setOpen(false);
    onClose?.();
    if (window.location.hash === "#chat") {
      history.replaceState(null, "", window.location.pathname + window.location.search);
    }
  };

  // ---- attachments ---------------------------------------------------------
  const onFiles = async (list: FileList | null) => {
    if (!list) return;
    const next = [...files];
    for (const f of Array.from(list).slice(0, 4 - next.length)) {
      if (!/^image\/(jpeg|png|webp|gif)$/.test(f.type) && f.type !== "application/pdf") continue;
      const bytes = new Uint8Array(await f.arrayBuffer());
      let bin = "";
      for (let i = 0; i < bytes.length; i += 0x8000) {
        bin += String.fromCharCode(...Array.from(bytes.subarray(i, i + 0x8000)));
      }
      next.push({ name: f.name, mediaType: f.type, dataBase64: btoa(bin), size: f.size });
    }
    if (next.reduce((n, a) => n + a.size, 0) > MAX_ATTACH_BYTES) {
      setError(t("soChatTooBig"));
      return;
    }
    setError(null);
    setFiles(next);
  };

  // ---- voice -------------------------------------------------------------
  const toggleMic = () => {
    if (listening) {
      recRef.current?.stop();
      return;
    }
    const w = window as unknown as {
      SpeechRecognition?: new () => Recognition;
      webkitSpeechRecognition?: new () => Recognition;
    };
    const Ctor = w.SpeechRecognition ?? w.webkitSpeechRecognition;
    if (!Ctor) return;
    const rec = new Ctor();
    rec.lang = lang === "es" ? "es-US" : "en-US";
    rec.interimResults = true;
    rec.continuous = true;
    baseRef.current = input ? input.trimEnd() + " " : "";
    rec.onresult = (e) => {
      let text = "";
      for (let i = 0; i < e.results.length; i++) text += e.results[i][0].transcript;
      setInput(baseRef.current + text);
    };
    rec.onend = () => setListening(false);
    rec.onerror = () => setListening(false);
    recRef.current = rec;
    rec.start();
    setListening(true);
  };

  // ---- send ----------------------------------------------------------------
  const send = async (text?: string) => {
    const message = (text ?? input).trim();
    if ((!message && files.length === 0) || busy) return;
    if (listening) recRef.current?.stop();
    setBusy(true);
    setError(null);
    setStatus(t("soChatThinking"));
    const now = new Date().toISOString();
    const asstId = `local-a-${now}`;
    setMsgs((m) => [
      ...m,
      {
        id: `local-u-${now}`,
        role: "user",
        content: message || "(attachment)",
        author_email: me,
        author_name: null,
        attachment_names: files.map((f) => f.name),
        created_at: now,
      },
      {
        id: asstId,
        role: "assistant",
        content: "",
        author_email: me,
        author_name: "SO assistant",
        attachment_names: null,
        created_at: now,
        pending: true,
      },
    ]);
    const payload = {
      message,
      lang,
      attachments: files.map(({ name, mediaType, dataBase64 }) => ({ name, mediaType, dataBase64 })),
    };
    setInput("");
    setFiles([]);

    let changed = false;
    try {
      const res = await fetch(`${api}/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok || !res.body) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error ?? `HTTP ${res.status}`);
      }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      const append = (d: string) =>
        setMsgs((m) => m.map((x) => (x.id === asstId ? { ...x, content: x.content + d } : x)));
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf("\n")) !== -1) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          const ev = JSON.parse(line) as {
            t: string;
            d?: string;
            label?: string;
            action?: Action;
            id?: string | null;
          };
          if (ev.t === "text" && ev.d) {
            setStatus(null);
            append(ev.d);
          } else if (ev.t === "status" && ev.label) {
            setStatus(ev.label);
          } else if (ev.t === "action" && ev.action) {
            changed = true;
            const a = ev.action;
            setActions((list) => [...list, { ...a, created_at: new Date().toISOString() }]);
          } else if (ev.t === "error") {
            if (ev.d) append(ev.d);
          } else if (ev.t === "done") {
            setMsgs((m) =>
              m.map((x) => (x.id === asstId ? { ...x, pending: false, id: ev.id ?? x.id } : x)),
            );
          }
        }
      }
    } catch (err) {
      setError(`${t("soChatError")} ${err instanceof Error ? err.message : ""}`.trim());
      setMsgs((m) => m.filter((x) => x.id !== asstId || x.content));
    } finally {
      setBusy(false);
      setStatus(null);
      // Corrections / key points / notes changed underneath the page.
      if (changed) router.refresh();
    }
  };

  const act = async (a: Action, op: "undo" | "send" | "cancel") => {
    setError(null);
    try {
      const res = await fetch(`${api}/actions/${a.id}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ op }),
      });
      const j = (await res.json()) as { ok: boolean; status?: Action["status"]; error?: string };
      if (!j.ok) throw new Error(j.error);
      setActions((list) =>
        list.map((x) => (x.id === a.id ? { ...x, status: j.status ?? x.status, resolved_by: me } : x)),
      );
      router.refresh();
    } catch (err) {
      setError(`${t("soChatError")} ${err instanceof Error ? err.message : ""}`.trim());
      void load();
    }
  };

  // ---- render ----------------------------------------------------------------
  type Item = { at: string; order: number; msg?: Msg; action?: Action };
  const timeline: Item[] = [
    ...msgs.map((m, i) => ({ at: m.created_at, order: i, msg: m })),
    ...actions.map((a, i) => ({ at: a.created_at, order: 10_000 + i, action: a })),
  ].sort((x, y) => (x.at === y.at ? x.order - y.order : x.at.localeCompare(y.at)));

  const kindLabel: Record<Action["kind"], string> = {
    correction: t("soActionCorrection"),
    retract_correction: t("soActionRetract"),
    meeting_note_edit: t("soActionNote"),
    key_points: t("soActionKeyPoints"),
    monday_post: t("soActionMonday"),
  };
  const statusLabel: Partial<Record<Action["status"], string>> = {
    undone: t("soStatusUndone"),
    sent: t("soStatusSent"),
    cancelled: t("soStatusCancelled"),
    failed: t("soStatusFailed"),
    pending: t("soStatusPending"),
  };
  const canSend = !busy && (input.trim().length > 0 || files.length > 0);

  return (
    <>
      {!open && !hideLauncher ? (
        <button
          type="button"
          className="meetings-noprint"
          onClick={() => setOpen(true)}
          style={{
            position: "fixed",
            right: 20,
            bottom: 20,
            zIndex: 60,
            padding: "12px 18px",
            borderRadius: 999,
            border: "1px solid var(--teal-900, #0f4a56)",
            background: "var(--teal-900, #0f4a56)",
            color: "#fff",
            fontWeight: 800,
            fontSize: 14,
            boxShadow: "0 6px 20px rgba(15,74,86,0.28)",
            cursor: "pointer",
          }}
        >
          ✦ {t("soChatOpen")}
        </button>
      ) : null}

      {open ? (
        <aside
          className="meetings-noprint"
          role="dialog"
          aria-label={t("soChatTitle", { so })}
          style={{
            position: "fixed",
            top: 0,
            right: 0,
            bottom: 0,
            width: "min(460px, 100vw)",
            zIndex: 70,
            background: "var(--paper, #fffdf8)",
            borderLeft: "1px solid var(--stone, #e3dcc9)",
            boxShadow: "-10px 0 30px rgba(15,74,86,0.14)",
            display: "flex",
            flexDirection: "column",
          }}
        >
          <header
            style={{
              padding: "14px 16px 10px",
              borderBottom: "1px solid var(--stone-2, #efe9da)",
              display: "flex",
              alignItems: "flex-start",
              gap: 10,
            }}
          >
            <div style={{ flex: 1 }}>
              <div
                style={{
                  fontFamily: "var(--serif, 'Cormorant Garamond', Georgia, serif)",
                  fontSize: 22,
                  fontWeight: 600,
                  color: "var(--teal-900, #0f4a56)",
                }}
              >
                {t("soChatTitle", { so })}
              </div>
              <div style={{ fontSize: 11, color: "var(--ink-3, #8a9498)" }}>{t("soChatShared")}</div>
            </div>
            <button
              type="button"
              onClick={close}
              aria-label={t("soChatClose")}
              style={{ ...pill("transparent", "var(--ink-2, #415056)", "var(--stone, #e3dcc9)"), fontSize: 14 }}
            >
              ✕
            </button>
          </header>

          <div
            ref={scrollRef}
            style={{
              flex: 1,
              overflowY: "auto",
              padding: "14px 16px",
              display: "flex",
              flexDirection: "column",
              gap: 10,
            }}
          >
            {loaded && msgs.length === 0 ? (
              <div style={{ fontSize: 13, color: "var(--ink-2, #415056)", lineHeight: 1.5 }}>
                <p style={{ marginTop: 0 }}>{t("soChatEmpty")}</p>
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  {[t("soChatSuggest1"), t("soChatSuggest2"), t("soChatSuggest3")].map((s) => (
                    <button
                      key={s}
                      type="button"
                      disabled={busy}
                      onClick={() => void send(s)}
                      style={{
                        ...pill("#fff", "var(--teal-700, #1d6c7b)", "var(--stone, #e3dcc9)"),
                        textAlign: "left",
                        fontWeight: 600,
                        borderRadius: 10,
                      }}
                    >
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            ) : null}

            {timeline.map((item) => {
              if (item.msg) {
                const m = item.msg;
                const isUser = m.role === "user";
                const mine = isUser && m.author_email === me;
                return (
                  <div
                    key={m.id}
                    style={{ alignSelf: isUser ? "flex-end" : "stretch", maxWidth: isUser ? "86%" : "100%" }}
                  >
                    <div
                      style={{
                        fontSize: 10.5,
                        color: "var(--ink-3, #8a9498)",
                        marginBottom: 2,
                        textAlign: isUser ? "right" : "left",
                      }}
                    >
                      {isUser ? (mine ? t("soChatYou") : m.author_name ?? m.author_email) : "✦"} ·{" "}
                      {fmtTime(m.created_at, lang)}
                    </div>
                    <div
                      style={{
                        whiteSpace: "pre-wrap",
                        fontSize: 13.5,
                        lineHeight: 1.55,
                        color: "var(--ink-1, #1f2a2d)",
                        padding: isUser ? "8px 12px" : "2px 0",
                        borderRadius: 12,
                        background: isUser ? (mine ? "#e6f1f3" : "#f1efe8") : "transparent",
                      }}
                    >
                      {m.content}
                      {m.attachment_names && m.attachment_names.length ? (
                        <div style={{ fontSize: 11, color: "var(--ink-3, #8a9498)", marginTop: 4 }}>
                          📎 {m.attachment_names.join(", ")}
                        </div>
                      ) : null}
                    </div>
                  </div>
                );
              }
              const a = item.action!;
              const isMonday = a.kind === "monday_post";
              const faded = a.status === "undone" || a.status === "cancelled";
              const color = faded
                ? "#8a9498"
                : a.status === "failed"
                  ? "#8b2f2f"
                  : isMonday
                    ? "#2c4d8f"
                    : "#6b5410";
              return (
                <div
                  key={a.id}
                  style={{
                    border: `1px solid ${isMonday ? "#cddffb" : "#ecd9a0"}`,
                    background: isMonday ? "#eff5ff" : "#fdf6e3",
                    borderRadius: 10,
                    padding: "8px 10px",
                    fontSize: 12.5,
                    opacity: faded ? 0.6 : 1,
                  }}
                >
                  <div
                    style={{
                      fontSize: 10,
                      fontWeight: 800,
                      letterSpacing: "0.12em",
                      textTransform: "uppercase",
                      color,
                    }}
                  >
                    {kindLabel[a.kind]}
                    {statusLabel[a.status] ? ` · ${statusLabel[a.status]}` : ""}
                  </div>
                  {a.summary ? (
                    <div
                      style={{
                        whiteSpace: "pre-wrap",
                        marginTop: 4,
                        color: "var(--ink-1, #1f2a2d)",
                        textDecoration: a.status === "undone" ? "line-through" : undefined,
                      }}
                    >
                      {a.summary}
                    </div>
                  ) : null}
                  {a.status === "applied" && !isMonday ? (
                    <div style={{ marginTop: 6 }}>
                      <button type="button" onClick={() => void act(a, "undo")} style={pill("#fff", "#6b5410", "#ecd9a0")}>
                        {t("soActionUndo")}
                      </button>
                    </div>
                  ) : null}
                  {a.status === "pending" && isMonday ? (
                    <div style={{ marginTop: 8, display: "flex", gap: 8 }}>
                      <button type="button" onClick={() => void act(a, "send")} style={pill("#2c4d8f", "#fff", "#2c4d8f")}>
                        {t("soActionSend")}
                      </button>
                      <button type="button" onClick={() => void act(a, "cancel")} style={pill("#fff", "#2c4d8f", "#cddffb")}>
                        {t("soActionCancel")}
                      </button>
                    </div>
                  ) : null}
                </div>
              );
            })}

            {status ? (
              <div style={{ fontSize: 12, color: "var(--ink-3, #8a9498)", fontStyle: "italic" }}>{status}</div>
            ) : null}
            {error ? <div style={{ fontSize: 12, color: "#8b2f2f" }}>{error}</div> : null}
          </div>

          <footer style={{ borderTop: "1px solid var(--stone-2, #efe9da)", padding: "10px 12px 12px" }}>
            {files.length ? (
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 6 }}>
                {files.map((f, i) => (
                  <span
                    key={f.name + i}
                    style={{ fontSize: 11, padding: "3px 8px", borderRadius: 999, background: "#f1efe8" }}
                  >
                    📎 {f.name}{" "}
                    <button
                      type="button"
                      onClick={() => setFiles((x) => x.filter((_, j) => j !== i))}
                      style={{ border: "none", background: "none", cursor: "pointer", color: "#8a9498" }}
                    >
                      ✕
                    </button>
                  </span>
                ))}
              </div>
            ) : null}
            <textarea
              ref={taRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void send();
                }
              }}
              rows={3}
              placeholder={listening ? t("soChatListening") : t("soChatPlaceholder")}
              style={{
                width: "100%",
                boxSizing: "border-box",
                resize: "none",
                border: `1px solid ${listening ? "#c0392b" : "var(--stone, #e3dcc9)"}`,
                borderRadius: 10,
                padding: "8px 10px",
                fontSize: 14,
                fontFamily: "inherit",
                background: "#fff",
              }}
            />
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8 }}>
              <input
                ref={fileRef}
                type="file"
                accept="image/jpeg,image/png,image/webp,image/gif,application/pdf"
                multiple
                hidden
                onChange={(e) => {
                  void onFiles(e.target.files);
                  e.target.value = "";
                }}
              />
              <button
                type="button"
                title={t("soChatAttach")}
                aria-label={t("soChatAttach")}
                onClick={() => fileRef.current?.click()}
                disabled={busy || files.length >= 4}
                style={pill("#fff", "var(--ink-2, #415056)", "var(--stone, #e3dcc9)")}
              >
                📎
              </button>
              {micOk ? (
                <button
                  type="button"
                  title={listening ? t("soChatListening") : t("soChatMic")}
                  aria-label={t("soChatMic")}
                  onClick={toggleMic}
                  disabled={busy}
                  style={
                    listening
                      ? pill("#c0392b", "#fff", "#c0392b")
                      : pill("#fff", "var(--ink-2, #415056)", "var(--stone, #e3dcc9)")
                  }
                >
                  🎤
                </button>
              ) : null}
              <div style={{ flex: 1 }} />
              <button
                type="button"
                onClick={() => void send()}
                disabled={!canSend}
                style={{
                  ...pill("var(--teal-700, #1d6c7b)", "#fff", "var(--teal-900, #0f4a56)"),
                  opacity: canSend ? 1 : 0.5,
                }}
              >
                {t("soChatSend")}
              </button>
            </div>
          </footer>
        </aside>
      ) : null}
    </>
  );
}
