"use client";

import { useRouter } from "next/navigation";

// "Ask AI" chip on each Orders card. The card itself is a <Link> to the SO
// page, and an <a> cannot nest inside another <a>, so this is a button that
// stops the card's navigation and goes to the same page with #chat -- which
// SoChat reads on mount to open its drawer.

export default function AskChip({
  so,
  label,
  pushRight = false,
}: {
  so: string;
  label: string;
  pushRight?: boolean;
}) {
  const router = useRouter();
  return (
    <button
      type="button"
      className="meetings-noprint"
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        router.push(`/meetings/sales-orders/orders/${encodeURIComponent(so)}#chat`);
      }}
      style={{
        marginLeft: pushRight ? "auto" : 4,
        padding: "3px 10px",
        borderRadius: 999,
        border: "1px solid var(--teal-900, #0f4a56)",
        background: "#fff",
        color: "var(--teal-900, #0f4a56)",
        fontSize: 11,
        fontWeight: 800,
        cursor: "pointer",
        whiteSpace: "nowrap",
      }}
    >
      ✦ {label}
    </button>
  );
}
