"use client";

import { useState } from "react";

// A tracking number that opens FedEx tracking, with a copy button. The copy
// puts BOTH a rich link and plain text on the clipboard, so pasting into
// Outlook/Gmail/Teams gives "FedEx Tracking: 384996233845" with the number
// clickable, and pasting into plain text gives the same line plus the URL.

export const trackUrl = (n: string) => `https://www.fedex.com/fedextrack/?trknbr=${encodeURIComponent(n)}`;

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export default function TrackingCell({ number, link = true, copyLabel, copiedLabel }: { number: string; link?: boolean; copyLabel: string; copiedLabel: string }) {
  const [copied, setCopied] = useState(false);
  const url = trackUrl(number);

  async function copy() {
    const plain = `FedEx Tracking: ${number} ${url}`;
    const html = `FedEx Tracking: <a href="${esc(url)}">${esc(number)}</a>`;
    try {
      if (typeof ClipboardItem !== "undefined" && navigator.clipboard?.write) {
        await navigator.clipboard.write([
          new ClipboardItem({
            "text/html": new Blob([html], { type: "text/html" }),
            "text/plain": new Blob([plain], { type: "text/plain" }),
          }),
        ]);
      } else {
        await navigator.clipboard.writeText(plain);
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      window.prompt(copyLabel, plain);
    }
  }

  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6, whiteSpace: "nowrap" }}>
      {link ? (
        <a href={url} target="_blank" rel="noreferrer" style={{ color: "inherit" }}>
          {number}
        </a>
      ) : (
        number
      )}
      <button
        type="button"
        onClick={copy}
        title={copied ? copiedLabel : copyLabel}
        aria-label={copied ? copiedLabel : copyLabel}
        style={{
          border: "1px solid var(--stone)",
          background: "var(--paper)",
          color: "var(--teal-900)",
          borderRadius: 6,
          padding: "2px 5px",
          lineHeight: 0,
          cursor: "pointer",
        }}
      >
        {copied ? (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M20 6 9 17l-5-5" />
          </svg>
        ) : (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <rect x="9" y="9" width="13" height="13" rx="2" />
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
          </svg>
        )}
      </button>
    </span>
  );
}
