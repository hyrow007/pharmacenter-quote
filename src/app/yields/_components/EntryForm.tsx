"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { Lang } from "@/lib/i18n/dict";
import { makeYT, type YKey } from "../_lib/i18n";
import {
  isHouseCustomer,
  LINES,
  fmtDate,
  fmtInt,
  fmtMoney,
  fmtUnitMoney,
  lineLabelKey,
  parseSoNumbers,
  singlesFor,
  toNum,
  type YieldEntry,
} from "../_lib/model";
import { saveYieldEntry } from "../actions";
import s from "../yields.module.css";

type Product = { fp_code: string; name: string; avg_cost: number | null };
type OrderLine = {
  so_number: string;
  customer_name: string | null;
  is_open: boolean;
  status_name: string | null;
  date_issued: string | null;
  unit_price: number | null;
  qty_ordered: number | null;
  each_price: number | null;
  unit_factor: number | null;
  unit_label: string | null;
  total_price: number | null;
  total_cost: number | null;
  each_cost: number | null;
  each_gross: number | null;
};
type LastGross = { value: number | null; run_date: string; source: string | null };

// The leader's form. Fills the way the sheet's Data tab did, with the two
// things the sheet could not do: the product comes from Fishbowl, and the
// gross is read from the sales order instead of typed (or, as it was for the
// last five weeks of the sheet, silently not computed at all).

export default function EntryForm({
  lang,
  date,
  editing,
}: {
  lang: Lang;
  date: string;
  editing: YieldEntry | null;
}) {
  const t = makeYT(lang);
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const [runDate, setRunDate] = useState(editing?.run_date ?? date);
  const [line, setLine] = useState(editing?.line_key ?? "bottle");
  const [query, setQuery] = useState(editing ? editing.product_num : "");
  const [product, setProduct] = useState<Product | null>(
    editing ? { fp_code: editing.product_num, name: editing.product_name ?? "", avg_cost: editing.unit_cost } : null,
  );
  const [suggestions, setSuggestions] = useState<Product[]>([]);
  const [showSuggest, setShowSuggest] = useState(false);
  const [orders, setOrders] = useState<OrderLine[] | null>(null);
  // The last gross recorded for this product, offered when the SO line
  // cannot give one.
  const [lastGross, setLastGross] = useState<LastGross | null>(null);
  const [soText, setSoText] = useState(editing?.so_numbers.join(", ") ?? "");
  const [multipack, setMultipack] = useState(editing?.is_multipack ?? false);
  const [perPack, setPerPack] = useState(editing?.units_per_pack?.toString() ?? "");
  const [finished, setFinished] = useState(editing ? String(editing.finished_units) : "");
  const [people, setPeople] = useState(editing?.people?.toString() ?? "");
  const [hours, setHours] = useState(editing?.hours?.toString() ?? "");
  const [note, setNote] = useState(editing?.note ?? "");
  const [grossMode, setGrossMode] = useState<"fishbowl" | "manual">(
    editing?.gross_source === "manual" || editing?.gross_source === "sheet" ? "manual" : "fishbowl",
  );
  const [manualGross, setManualGross] = useState(
    editing?.gross_source === "manual" || editing?.gross_source === "sheet" ? String(editing.gross_per_unit ?? "") : "",
  );
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Product search, debounced. Skipped once a product is chosen and the box
  // still shows its code.
  useEffect(() => {
    if (product && query === product.fp_code) return;
    if (debounce.current) clearTimeout(debounce.current);
    const q = query.trim();
    if (q.length < 2) {
      setSuggestions([]);
      return;
    }
    debounce.current = setTimeout(async () => {
      try {
        const r = await fetch(`/api/yields/lookup?q=${encodeURIComponent(q)}`);
        const j = await r.json();
        if (j.ok) setSuggestions(j.products);
      } catch {
        /* the box keeps working as free text */
      }
    }, 200);
  }, [query, product]);

  // The chosen product's sales-order lines and cost.
  const code = product?.fp_code ?? "";
  useEffect(() => {
    if (!code) {
      setOrders(null);
      return;
    }
    let live = true;
    (async () => {
      try {
        const r = await fetch(`/api/yields/lookup?product=${encodeURIComponent(code)}`);
        const j = await r.json();
        if (!live || !j.ok) return;
        setOrders(j.orders);
        setLastGross(j.last_gross ?? null);
        if (j.product?.name) setProduct((p) => (p && p.fp_code === code && !p.name ? { ...p, name: j.product.name } : p));
        // First open order pre-fills an empty SO box -- the usual case.
        setSoText((cur) => {
          if (cur.trim()) return cur;
          const open = (j.orders as OrderLine[]).find((o) => o.is_open);
          return open ? open.so_number : cur;
        });
      } catch {
        if (live) setOrders([]);
      }
    })();
    return () => {
      live = false;
    };
  }, [code]);

  const soList = useMemo(() => parseSoNumbers(soText), [soText]);
  // The price is read from the first listed SO that has this product on it.
  // A listed SO whose line has no readable unit is kept too, so the form can
  // say WHY there is no price instead of just showing none.
  const priceLine = useMemo(() => {
    const listed = (orders ?? []).filter((o) => soList.includes(o.so_number));
    return listed.find((o) => o.each_price !== null) ?? listed[0] ?? null;
  }, [orders, soList]);
  const fishbowlGross = priceLine?.each_gross ?? null;
  const grossPerUnit = grossMode === "manual" ? toNum(manualGross) : fishbowlGross;

  const fin = toNum(finished) ?? 0;
  const pp = toNum(perPack);
  const singles = singlesFor(fin, multipack, pp);
  const mh = toNum(people) !== null && toNum(hours) !== null ? (toNum(people) as number) * (toNum(hours) as number) : null;
  const grossTotal = grossPerUnit !== null ? fin * grossPerUnit : null;

  function pick(p: Product) {
    setProduct(p);
    setQuery(p.fp_code);
    setShowSuggest(false);
    setSoText("");
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const productNum = product?.fp_code ?? query.trim();
    if (!productNum) {
      setError(t("err_no_product"));
      return;
    }
    startTransition(async () => {
      const res = await saveYieldEntry({
        id: editing?.id ?? null,
        run_date: runDate,
        line_key: line,
        product_num: productNum,
        product_name: product?.name ?? null,
        so_numbers: soText,
        is_multipack: multipack,
        units_per_pack: perPack,
        finished_units: finished || 0,
        people,
        hours,
        note,
        gross_mode: grossMode === "manual" ? (manualGross.trim() ? "manual" : "none") : "fishbowl",
        price_so: priceLine && priceLine.each_price !== null ? priceLine.so_number : null,
        manual_gross: manualGross,
      });
      if (!res.ok) {
        setError(t(res.error as YKey, { detail: res.detail ?? "" }));
        return;
      }
      if (editing) {
        router.push(`?date=${runDate}`);
      } else {
        // Keep date, line, people and hours: the next entry is usually the
        // same crew on the same line. Clear what identifies the run.
        setProduct(null);
        setQuery("");
        setOrders(null);
        setSoText("");
        setFinished("");
        setPerPack("");
        setMultipack(false);
        setNote("");
        setManualGross("");
        setGrossMode("fishbowl");
        if (runDate !== date) router.push(`?date=${runDate}`);
      }
      router.refresh();
    });
  }

  const notInFishbowl = !product && query.trim().length >= 2 && suggestions.length === 0;

  return (
    <form className={s.form} onSubmit={submit} aria-busy={pending}>
      <div className={s.row2}>
        <label className={s.field}>
          <span>{t("fDate")}</span>
          <input type="date" className={s.input} value={runDate} onChange={(e) => setRunDate(e.target.value)} required />
        </label>
        <label className={s.field}>
          <span>{t("fLine")}</span>
          <select className={s.input} value={line} onChange={(e) => setLine(e.target.value)}>
            {LINES.map((l) => (
              <option key={l} value={l}>{t(lineLabelKey(l))}</option>
            ))}
          </select>
        </label>
      </div>

      <label className={`${s.field} ${s.combo}`}>
        <span>{t("fProduct")}</span>
        <input
          className={s.input}
          value={query}
          placeholder={t("fProductPh")}
          onChange={(e) => {
            setQuery(e.target.value);
            setProduct(null);
            setShowSuggest(true);
          }}
          onFocus={() => setShowSuggest(true)}
          onBlur={() => setTimeout(() => setShowSuggest(false), 150)}
          autoComplete="off"
          required
        />
        {product?.name ? <span className={s.hint}>{product.name}</span> : null}
        {notInFishbowl ? <span className={s.hint}>{t("fProductNotFound")}</span> : null}
        {showSuggest && suggestions.length > 0 && !product ? (
          <ul className={s.suggest} role="listbox">
            {suggestions.map((p) => (
              <li key={p.fp_code}>
                <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => pick(p)}>
                  <span className={s.code}>{p.fp_code}</span> {p.name}
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </label>

      <label className={s.field}>
        <span>{t("fSo")}</span>
        <input className={s.input} value={soText} placeholder={t("fSoPh")} onChange={(e) => setSoText(e.target.value)} />
        {orders && orders.length > 0 ? (
          <span className={s.chips}>
            {t("fSoHint")}{" "}
            {orders.slice(0, 8).map((o) => (
              <button
                type="button"
                key={o.so_number}
                className={`${s.chip} ${soList.includes(o.so_number) ? s.chipOn : ""}`}
                onClick={() =>
                  setSoText((cur) => {
                    const list = parseSoNumbers(cur);
                    return (list.includes(o.so_number) ? list.filter((x) => x !== o.so_number) : [...list, o.so_number]).join(", ");
                  })
                }
                title={o.customer_name ?? undefined}
              >
                {o.so_number}
                {o.is_open ? "" : " ✓"}
              </button>
            ))}
          </span>
        ) : orders && product ? (
          <span className={s.hint}>{t("fSoNone")}</span>
        ) : null}
      </label>

      <div className={s.row2}>
        <label className={s.field}>
          <span>{t("fMultipack")}</span>
          <select className={s.input} value={multipack ? "y" : "n"} onChange={(e) => setMultipack(e.target.value === "y")}>
            <option value="n">{t("no")}</option>
            <option value="y">{t("yes")}</option>
          </select>
        </label>
        {multipack ? (
          <label className={s.field}>
            <span>{t("fUnitsPerPack")}</span>
            <input className={s.input} inputMode="decimal" value={perPack} onChange={(e) => setPerPack(e.target.value)} />
          </label>
        ) : <span />}
      </div>

      <div className={s.row3}>
        <label className={s.field}>
          <span>{t("fFinished")}</span>
          <input className={s.input} inputMode="decimal" value={finished} onChange={(e) => setFinished(e.target.value)} required />
          {multipack ? <span className={s.hint}>{t("fSingles")}: {fmtInt(singles, lang)}</span> : null}
        </label>
        <label className={s.field}>
          <span>{t("fPeople")}</span>
          <input className={s.input} inputMode="decimal" value={people} onChange={(e) => setPeople(e.target.value)} />
        </label>
        <label className={s.field}>
          <span>{t("fHours")}</span>
          <input className={s.input} inputMode="decimal" value={hours} onChange={(e) => setHours(e.target.value)} />
        </label>
      </div>

      <fieldset className={s.gross}>
        <legend>{t("grossHeading")}</legend>
        {grossMode === "fishbowl" ? (
          <>
            {priceLine ? (
              <dl className={s.grossDl}>
                <dt>{t("grossPrice")} ({priceLine.so_number})</dt>
                <dd>
                  {priceLine.each_price === null ? (
                    <span className={s.missing}>
                      {priceLine.unit_label
                        ? t("grossUnitUnknown", { price: fmtMoney(priceLine.unit_price, lang, 2), unit: priceLine.unit_label })
                        : t("grossUnitMissing")}
                    </span>
                  ) : priceLine.unit_factor && priceLine.unit_factor !== 1 ? (
                    t("grossPerUnitOf", {
                      price: fmtMoney(priceLine.unit_price, lang, 2),
                      unit: priceLine.unit_label ?? "",
                      each: fmtUnitMoney(priceLine.each_price, lang),
                    })
                  ) : (
                    fmtUnitMoney(priceLine.each_price, lang)
                  )}
                </dd>
                <dt>{t("grossCost")}</dt>
                <dd>
                  {priceLine.each_cost !== null ? (
                    `− ${fmtUnitMoney(priceLine.each_cost, lang)}`
                  ) : isHouseCustomer(priceLine.customer_name) ? (
                    <span className={s.sub}>{t("source_house")}</span>
                  ) : !priceLine.total_cost ? (
                    <span className={s.missing}>{t("grossCostNotShipped")}</span>
                  ) : (
                    <span className={s.missing}>{t("missing")}</span>
                  )}
                </dd>
                <dt className={s.grossStrong}>{t("grossHeading")}</dt>
                <dd className={s.grossStrong}>{fishbowlGross === null ? (isHouseCustomer(priceLine.customer_name) ? t("houseStock") : <span className={s.missing}>{t("missing")}</span>) : fmtUnitMoney(fishbowlGross, lang)}</dd>
              </dl>
            ) : product ? (
              <p className={s.hint}>{t("grossNone")}</p>
            ) : null}
            {fishbowlGross === null && lastGross?.value != null ? (
              <button
                type="button"
                className={s.linkBtn}
                onClick={() => {
                  setManualGross(String(lastGross.value));
                  setGrossMode("manual");
                }}
              >
                {t("grossUseLast", { value: fmtUnitMoney(lastGross.value, lang), date: fmtDate(lastGross.run_date, lang, false) })}
              </button>
            ) : null}
            <button type="button" className={s.linkBtn} onClick={() => setGrossMode("manual")}>{t("grossManual")}</button>
          </>
        ) : (
          <>
            <input
              className={s.input}
              inputMode="decimal"
              placeholder={t("grossManualPh")}
              value={manualGross}
              onChange={(e) => setManualGross(e.target.value)}
            />
            <button type="button" className={s.linkBtn} onClick={() => setGrossMode("fishbowl")}>{t("grossUseFishbowl")}</button>
          </>
        )}
      </fieldset>

      <label className={s.field}>
        <span>{t("fNote")}</span>
        <input className={s.input} value={note} placeholder={t("fNotePh")} onChange={(e) => setNote(e.target.value)} />
      </label>

      <p className={s.preview}>
        {t("colGross")}: <strong>{fmtMoney(grossTotal, lang)}</strong>
        {" · "}
        {t("colManHours")}: <strong>{mh === null ? "—" : mh.toLocaleString(lang === "es" ? "es-US" : "en-US", { maximumFractionDigits: 2 })}</strong>
        {" · "}
        {t("colGrossMh")}: <strong>{fmtMoney(grossTotal !== null && mh ? grossTotal / mh : null, lang)}</strong>
      </p>

      {error ? <p className={s.error} role="alert">{error}</p> : null}

      <div className={s.buttons}>
        <button type="submit" className={s.primary} disabled={pending}>
          {pending ? t("saving") : editing ? t("update") : t("save")}
        </button>
        {editing ? (
          <button type="button" className="btn-chrome" onClick={() => router.push(`?date=${editing.run_date}`)}>
            {t("cancel")}
          </button>
        ) : null}
      </div>
    </form>
  );
}
