"use client";

import { useEffect, useState } from "react";

// Live total of the ticked QuickBooks lines on /admin/overhead. Reads the
// checkboxes the server rendered (form="qbo-decide", data-diff = monthly change),
// so the server page stays the source of every figure; this only adds them up.

export default function TickedTotal({ label, locale, none }: { label: string; locale: string; none: string }) {
  const [sum, setSum] = useState<number | null>(null);

  useEffect(() => {
    const read = () => {
      const boxes = document.querySelectorAll<HTMLInputElement>('input[form="qbo-decide"][name="item"]');
      let s = 0;
      boxes.forEach((b) => {
        if (b.checked) s += Number(b.dataset.diff) || 0;
      });
      setSum(Math.round(s * 100) / 100);
    };
    read();
    document.addEventListener("change", read);
    return () => document.removeEventListener("change", read);
  }, []);

  const text =
    sum === null
      ? none
      : `${sum >= 0 ? "+" : "−"}${Math.abs(sum).toLocaleString(locale, { style: "currency", currency: "USD" })}`;
  return (
    <span style={{ fontSize: 13 }}>
      {label}:{" "}
      <strong style={{ fontFamily: "var(--mono, monospace)", color: sum === null ? undefined : sum > 0 ? "#9b2c2c" : "#3f6b1f" }}>
        {text}
      </strong>
    </span>
  );
}
