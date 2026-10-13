"use client";

import Link from "next/link";
import { useTransition } from "react";
import { useRouter } from "next/navigation";
import type { Lang } from "@/lib/i18n/dict";
import { makeYT, type YKey } from "../_lib/i18n";
import { deleteYieldEntry } from "../actions";
import s from "../yields.module.css";

export default function RowActions({ id, date, lang }: { id: string; date: string; lang: Lang }) {
  const t = makeYT(lang);
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  return (
    <span className={s.rowActions}>
      <Link href={`?date=${date}&edit=${id}`} className={s.linkBtn}>{t("edit")}</Link>
      <button
        type="button"
        className={s.linkBtn}
        disabled={pending}
        onClick={() => {
          // window.confirm, not a custom dialog: one destructive action, and the
          // browser's own prompt is the one every user already recognises.
          if (!window.confirm(t("confirmDelete"))) return;
          startTransition(async () => {
            const res = await deleteYieldEntry(id);
            if (!res.ok) window.alert(t(res.error as YKey, { detail: res.detail ?? "" }));
            router.refresh();
          });
        }}
      >
        {t("delete")}
      </button>
    </span>
  );
}
