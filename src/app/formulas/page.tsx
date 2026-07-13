import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { createClient } from "@/lib/auth/server";
import { isAdmin } from "@/lib/workflows";
import AppHeader from "../_components/AppHeader";
import FormulasCatalog from "./FormulasCatalog";
import { I18nProvider } from "@/lib/i18n/context";
import { getLangFromCookie } from "@/lib/i18n/server";
import { makeT } from "@/lib/i18n/dict";
import { recordFromRow, type GummyFormulaRecord } from "@/lib/formulas";

// /formulas — top-level gummy formula catalog.
//
// Anyone signed in can browse, search, and create formulas. Individual
// formulas open at /formulas/[id] into the three-tab editor. Workflows
// picking a formula for their quote use the same list via the picker
// on /workflow/[id]/gummy-formula.
//
// Server-renders the initial list; the client island (FormulasCatalog)
// owns search + shape filter + "+ New formula" and refetches on demand.

// v51.5: formula pages carry their own tab title — the root layout's
// "PharmaCenter — Quote" was showing on the formula subdomain.
export const metadata = { title: "PharmaCenter — Formulas" };

export default async function FormulasPage() {
  const lang = await getLangFromCookie();
  const t = makeT(lang);
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user || !user.email?.endsWith("@pharmacenterusa.com")) {
    // On the formula.pharmacenter.app subdomain the middleware rewrites
    // "/" → "/formulas". A naive redirect("/") from here would land
    // back on this same rewrite, creating an infinite loop with stale
    // cookies. The "showSignIn=1" query flag tells the middleware to
    // pass through this request untouched so the sign-in card renders.
    const hostHeader = (await headers()).get("host") ?? "";
    const isFormulaHost = hostHeader.startsWith("formula.");
    redirect(isFormulaHost ? "/?showSignIn=1" : "/");
  }

  // Admin flag drives the Delete affordance on each catalog row.
  const admin = await isAdmin(supabase, user.email);

  // Initial list — active rows only, most-recently-touched first. The
  // client can flip an "includeInactive" toggle to see soft-deleted rows
  // when needed.
  const { data, error } = await supabase
    .from("gummy_formulas")
    .select(
      "id, formula_number, pc_bk_code, name, shape, flavor, customer_id, active, latest_version_num, created_at, updated_at, created_by_email, updated_by_email",
    )
    .eq("active", true)
    .order("updated_at", { ascending: false });

  const initialFormulas: GummyFormulaRecord[] = error
    ? []
    : (data ?? []).map(recordFromRow);

  // Resolve customer names for the catalog's Customer column. We fetch
  // in a second query rather than a join so we can share the customers
  // lookup with any future callers on this page. Keyed by id → name so
  // the client can render the pill without another round trip.
  const customerIds = Array.from(
    new Set(
      initialFormulas
        .map((f) => f.customerId)
        .filter((id): id is string => !!id),
    ),
  );
  const customersById: Record<string, string> = {};
  if (customerIds.length > 0) {
    const { data: customerRows } = await supabase
      .from("customers")
      .select("id, name")
      .in("id", customerIds);
    (customerRows ?? []).forEach((row) => {
      if (row.id && row.name) customersById[row.id] = row.name;
    });
  }

  return (
    <div className="app-shell">
      <AppHeader user={{ email: user.email! }} />
      <main className="page">
        <div className="page__inner--narrow">
          <a
            href="/workflows"
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
            <span aria-hidden="true">&larr;</span> {t("backToWorkflows").replace("← ", "")}
          </a>
          <div style={{ marginBottom: 18 }}>
            <p className="eyebrow" style={{ marginBottom: 6 }}>
              PharmaCenter · Formulas
            </p>
            <h1 className="page-header__title" style={{ marginBottom: 6 }}>
              {t("catalogTitle")}
            </h1>
            <p className="lede" style={{ marginTop: 4, marginBottom: 0 }}>
              {t("catalogLede")}
            </p>
          </div>

          <I18nProvider lang={lang}>
            <FormulasCatalog
              initialFormulas={initialFormulas}
              customersById={customersById}
              isAdmin={admin}
            />
          </I18nProvider>
        </div>
      </main>
    </div>
  );
}
