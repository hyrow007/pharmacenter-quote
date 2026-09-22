"use client";

import { useRouter } from "next/navigation";

// "Ask AI" chip on each Orders card. The card itself is a <Link> to the SO
// page, and an <a> cannot nest inside another <a>, so this is a button that
// stops the card's navigation. On the landing it opens the assistant in
// place (OrdersChatHost); anywhere else it goes to the SO page with #chat.

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
        // On the Orders landing, open the drawer right here over the list.
        if (document.body.dataset.soChatHost === "1") {
          window.dispatchEvent(new CustomEvent("pc:so-chat", { detail: { so } }));
          return;
        }
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
