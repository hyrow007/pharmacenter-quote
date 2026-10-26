"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import type { Lang } from "@/lib/i18n/dict";
import { makeYT } from "../_lib/i18n";
import { DAY_OPTIONS } from "../_lib/model";
import s from "../yields.module.css";

// Controls for the log page's "Every entry" list: how many working days to
// show (default 10) and an optional single product. Both live in the URL
// (?days=, ?product=) so a filtered view can be bookmarked or shared.


type Hit = { fp_code: string; name: string };

export default function EntriesFilter({
  lang,
  days,
  product,
  productName,
}: {
  lang: Lang;
  days: string;
  product: string | null;
  productName: string | null;
}) {
  const t = makeYT(lang);
  const router = useRouter();
  const params = useSearchParams();
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<Hit[]>([]);
  const [open, setOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const go = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(params.toString());
    next.delete("edit");
    for (const [k, v] of Object.entries(patch)) {
      if (v === null || v === "") next.delete(k);
      else next.set(k, v);
    }
    router.push(`?${next.toString()}#entries`, { scroll: false });
  };

  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    const term = q.trim();
    if (term.length < 2) {
      setHits([]);
      return;
    }
    timer.current = setTimeout(async () => {
      try {
        const r = await fetch(`/api/yields/lookup?logged=${encodeURIComponent(term)}`);
        const j = await r.json();
        setHits(Array.isArray(j.products) ? j.products : []);
        setOpen(true);
      } catch {
        setHits([]);
      }
    }, 200);
  }, [q]);

  return (
    <div className={s.entriesFilter}>
      <label className={s.inlineField}>
        <span>{t("showLast")}</span>
        <select className={s.input} value={days} onChange={(e) => go({ days: e.target.value === "10" ? null : e.target.value })}>
          {DAY_OPTIONS.map((d) => (
            <option key={d} value={d}>
              {d === "all" ? t("allDays") : t("nWorkingDays", { n: d })}
            </option>
          ))}
        </select>
      </label>

      {product ? (
        <span className={s.filterChip}>
          <span className={s.code}>{product}</span> {productName}
          <button type="button" className={s.linkBtn} onClick={() => go({ product: null })} aria-label={t("clearFilter")}>
            ✕ {t("clearFilter")}
          </button>
        </span>
      ) : (
        <div className={`${s.inlineField} ${s.combo}`} style={{ position: "relative" }}>
          <input
            className={s.input}
            value={q}
            placeholder={t("filterProduct")}
            onChange={(e) => setQ(e.target.value)}
            onFocus={() => hits.length && setOpen(true)}
            onBlur={() => setTimeout(() => setOpen(false), 150)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && hits[0]) {
                e.preventDefault();
                go({ product: hits[0].fp_code });
              }
            }}
          />
          {open && hits.length > 0 ? (
            <ul className={s.suggest}>
              {hits.map((h) => (
                <li key={h.fp_code}>
                  <button type="button" onMouseDown={() => go({ product: h.fp_code })}>
                    <span className={s.code}>{h.fp_code}</span> {h.name}
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      )}
    </div>
  );
}
