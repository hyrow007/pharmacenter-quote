"use client";

import { useEffect, useState } from "react";

// Red banner on a quoting screen when overhead did not load.
//
// Owned by Overhead (2026-11-08). The costing boards and the formula editor
// fetch /api/overhead and, if the answer is not ok, keep the built-in
// constants from lib/overheadCosting.ts with no message. This component asks
// the same question on its own and says so out loud. It changes no figure and
// shares no state with the board: drop it in, one line. Shown in both
// languages because the boards carry no language context. It prints on
// purpose — a quote on fallback figures should not go out.

type Props = { line: "contract_packaging" | "gummy_manufacturing" };

export default function OverheadFeedWarning({ line }: Props) {
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      let why: string | null = null;
      try {
        const res = await fetch(`/api/overhead?line=${line}`);
        const json = await res.json().catch(() => null);
        if (!json?.ok) why = json?.reason ?? json?.error ?? `HTTP ${res.status}`;
      } catch {
        why = "network";
      }
      if (!cancelled) setProblem(why);
    })();
    return () => {
      cancelled = true;
    };
  }, [line]);

  if (!problem) return null;
  return (
    <div
      role="alert"
      style={{
        border: "2px solid #b42318",
        background: "#fef3f2",
        color: "#7a271a",
        borderRadius: 8,
        padding: "10px 14px",
        fontSize: 14,
        lineHeight: 1.45,
      }}
    >
      <strong>Overhead didn&apos;t load.</strong> This quote is using built-in figures from summer 2026,
      not the current rent, labor and expenses. Don&apos;t send it until this is fixed — tell an admin.
      <br />
      <strong>No se cargaron los gastos generales.</strong> Esta cotización usa cifras fijas del verano
      de 2026, no la renta, mano de obra y gastos actuales. No la envíe hasta que se corrija; avise a un
      administrador.
      <span style={{ display: "block", fontSize: 12, opacity: 0.75, marginTop: 4 }}>({problem})</span>
    </div>
  );
}
