"use client";

import { useEffect, useState } from "react";
import type { Lang } from "@/lib/i18n/dict";
import SoChat from "./SoChat";

// Lets the Orders landing open any SO's assistant in place, without leaving
// the card list. Each card's "Ask AI" chip fires a `pc:so-chat` event with
// the SO number; this host mounts that SO's drawer. Switching SOs remounts
// the drawer (key) so threads never bleed into each other.
//
// The data attribute tells AskChip a host is present. Where there is none
// (any other page), the chip falls back to navigating to the SO page.

export const SO_CHAT_EVENT = "pc:so-chat";

export default function OrdersChatHost({ lang }: { lang: Lang }) {
  const [so, setSo] = useState<string | null>(null);

  useEffect(() => {
    document.body.dataset.soChatHost = "1";
    const onOpen = (e: Event) => {
      const next = (e as CustomEvent<{ so?: string }>).detail?.so;
      if (next) setSo(next);
    };
    window.addEventListener(SO_CHAT_EVENT, onOpen);
    return () => {
      delete document.body.dataset.soChatHost;
      window.removeEventListener(SO_CHAT_EVENT, onOpen);
    };
  }, []);

  if (!so) return null;
  return (
    <SoChat
      key={so}
      so={so}
      lang={lang}
      initialOpen
      hideLauncher
      onClose={() => setSo(null)}
    />
  );
}
