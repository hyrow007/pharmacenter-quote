"use client";

// Print / Save PDF for the Orders landing. The only interactive piece on an
// otherwise server-rendered page, so it lives in its own tiny client
// component (same pattern as LangToggle). Tagged .meetings-noprint so the
// shared print rules in globals.css keep it off the paper.

export default function PrintButton({ label }: { label: string }) {
  return (
    <button
      type="button"
      className="meetings-noprint"
      onClick={() => window.print()}
      style={{
        padding: "6px 14px",
        background: "var(--teal-700, #1d6c7b)",
        color: "#fff",
        border: "1px solid var(--teal-900, #0f4a56)",
        borderRadius: 999,
        fontSize: 12,
        fontWeight: 700,
        cursor: "pointer",
        whiteSpace: "nowrap",
      }}
    >
      {label}
    </button>
  );
}
