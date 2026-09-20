import { redirect } from "next/navigation";
import { createClient } from "@/lib/auth/server";
import { isAdmin as checkIsAdmin } from "@/lib/workflows";
import AppHeader from "../../_components/AppHeader";
import RawMaterialsBoard, { type RawMaterialRow } from "./RawMaterialsBoard";

// /admin/raw-materials — manage the Fishbowl-synced raw material catalogue
// plus any manual one-off entries. Editable: default_cost_per_kg (override
// the Fishbowl sync if needed), default_solids, category, notes, active.
//
// Server-renders the initial list; the client island handles search +
// inline edit + new + deactivate.

export default async function AdminRawMaterialsPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user || !user.email?.endsWith("@pharmacenterusa.com")) {
    redirect("/");
  }
  const admin = await checkIsAdmin(supabase, user.email);
  if (!admin) {
    redirect("/workflows");
  }

  const { data, error } = await supabase
    .from("raw_materials")
    .select(
      "id, fp_code, name, default_unit, default_cost_per_kg, default_solids, category, notes, active, source, synced_at, updated_at",
    )
    .order("category", { ascending: true, nullsFirst: false })
    .order("name", { ascending: true });

  const rows: RawMaterialRow[] = error ? [] : ((data ?? []) as RawMaterialRow[]);

  return (
    <div className="app-shell">
      <AppHeader user={{ email: user.email! }} />
      <main className="page">
        <div className="page__inner--narrow">
          <a
            href="/admin"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              padding: "8px 14px",
              background: "var(--paper, #fffdf8)",
              border: "1px solid var(--line, #e3dcc9)",
              borderRadius: 999,
              fontSize: 13,
              fontWeight: 700,
              color: "var(--teal-900, #0f4a56)",
              textDecoration: "none",
              marginBottom: 16,
              whiteSpace: "nowrap",
            }}
          >
            <span aria-hidden="true">&larr;</span> Back to admin
          </a>
          <div style={{ marginBottom: 18 }}>
            <p className="eyebrow" style={{ marginBottom: 6 }}>
              PharmaCenter · Admin
            </p>
            <h1 className="page-header__title" style={{ marginBottom: 6 }}>
              Raw Materials
            </h1>
            <p className="lede" style={{ marginTop: 4, marginBottom: 0 }}>
              The ingredient catalogue used by the gummy formula calculator.
              Names, units, and the average cost flow in from Fishbowl on
              sync (parts matching <code>-RW-</code>). Solids factor,
              blend category, and notes are overlays the lab team maintains
              here — Fishbowl never overwrites them.
            </p>
          </div>

          <RawMaterialsBoard initialRows={rows} />
        </div>
      </main>
    </div>
  );
}
