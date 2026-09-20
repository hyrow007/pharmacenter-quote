import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/auth/server";
import {
  buildAutoDescription,
  formatQuoteNumber,
  isAdmin,
  resolveDescription,
  type WorkflowRow,
} from "@/lib/workflows";
import AppHeader from "../_components/AppHeader";
import WorkflowTable, { type WorkflowDisplayRow } from "./WorkflowTable";
import { I18nProvider } from "@/lib/i18n/context";
import { getLangFromCookie } from "@/lib/i18n/server";
import { makeT, type DictKey } from "@/lib/i18n/dict";

// Workflow inbox — every quote workflow visible to the signed-in user.
// Server component so the customer/product joins happen on the server in one
// round-trip instead of N debounced fetches in the browser. The live-filter
// search box is delegated to <WorkflowTable/> (client) which receives the
// pre-shaped rows.

// Quote type / dosage form are stored in English in the DB. These map the
// stored value to a dictionary key so the *display* follows the language
// cookie; an unrecognised value falls back to the raw string rather than
// rendering a key name at the user.
const TYPE_KEYS: Record<string, DictKey> = {
  "bulk": "quoteTypeBulk",
  "contract-packaging": "quoteTypeContractPackaging",
  "finished-product": "quoteTypeFinishedProduct",
  "other": "quoteTypeOther",
};
const FORM_KEYS: Record<string, DictKey> = {
  softgel: "formSoftgel",
  gummy: "formGummy",
  tablet: "formTablet",
  capsule: "formCapsule",
  other: "formOther",
};
// state.form is overloaded: a dosage form for bulk/finished-product quotes,
// a packaging type for contract-packaging ones. Two id namespaces in one
// column, disambiguated by state.type -- the same split lib/workflows.ts
// makes between DESCRIPTION_FORM_LABELS and DESCRIPTION_PACKAGING_LABELS.
//
// The old code used the dosage map for both, so a contract-packaging quote
// rendered the raw id: "Contract Packaging · pouches", lowercase and
// unlabelled. That was wrong in English too, not just untranslated.
const PACKAGING_KEYS: Record<string, DictKey> = {
  bottles: "packagingBottles",
  blisters: "packagingBlisters",
  sachets: "packagingSachets",
  pouches: "packagingPouches",
  kitting: "packagingKitting",
  other: "packagingOther",
};

type T = ReturnType<typeof makeT>;

// Computed server-side so the client table needs no date library. Buckets
// match the ones describeFreshness() uses, and reuse the same dictionary
// keys where they overlap.
function relativeTime(iso: string, t: T): string {
  const then = new Date(iso).getTime();
  const now = Date.now();
  const diff = Math.max(0, now - then);
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return t("timeJustNow");
  const min = Math.floor(sec / 60);
  if (min < 60) return t("timeMinAgo", { n: min });
  const hr = Math.floor(min / 60);
  if (hr < 24) return t("timeHrAgo", { n: hr });
  const day = Math.floor(hr / 24);
  if (day < 7) return t("timeDayAgo", { n: day });
  if (day < 30) return t("timeWeekAgo", { n: Math.floor(day / 7) });
  // Spanish needs the singular ("hace 1 mes", not "hace 1 meses"). Caught on
  // the live page, not by the key-resolution test -- both forms resolved.
  if (day < 365) {
    const n = Math.floor(day / 30);
    return t(n === 1 ? "timeMonthAgoOne" : "timeMonthAgo", { n });
  }
  const years = Math.floor(day / 365);
  return t(years === 1 ? "timeYearAgoOne" : "timeYearAgo", { n: years });
}

function localPart(email: string): string {
  const at = email.indexOf("@");
  return at > 0 ? email.slice(0, at) : email;
}

// Title-case a string like "jairo osorno" → "Jairo Osorno".
function titleCase(s: string): string {
  return s
    .split(" ")
    .filter((w) => w.length > 0)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(" ");
}

const usdFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
});

export default async function WorkflowsPage() {
  const lang = await getLangFromCookie();
  const t = makeT(lang);
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user || !user.email?.endsWith("@pharmacenterusa.com")) {
    redirect("/");
  }

  // Admin lookup is cheap (single-row SELECT on a small table) and lets us
  // pre-decide per-row whether to render the inline delete button. RLS still
  // enforces ownership on the DELETE itself, so this is purely a UI signal.
  const admin = await isAdmin(supabase, user.email);

  const { data: rawRows } = await supabase
    .from("workflows")
    .select(
      "id, quote_number, created_by_email, created_at, updated_at, state, status, sales_orders, description_override, monday_item_id, monday_item_url, monday_last_pushed_at",
    )
    .order("updated_at", { ascending: false });

  const rows: WorkflowRow[] = (rawRows ?? []) as WorkflowRow[];

  // Resolve customer names (+ ship-to subtitle) in one query.
  const customerIds = Array.from(
    new Set(
      rows
        .map((r) => (r.state?.customerMode === "existing" ? r.state.customerId : null))
        .filter((id): id is string => !!id),
    ),
  );
  const customerInfo: Record<string, { name: string; ship: string | null }> = {};
  if (customerIds.length > 0) {
    const { data } = await supabase
      .from("customers")
      .select("id, name, default_ship_to")
      .in("id", customerIds);
    for (const c of (data ?? []) as Array<{ id: string; name: string; default_ship_to: string | null }>) {
      customerInfo[c.id] = { name: c.name, ship: c.default_ship_to };
    }
  }

  // Resolve submitter display names. The user_directory view (SQL migration)
  // exposes the Google SSO full_name from auth.users for any signed-in user.
  // Fallback to a title-cased local-part of the email if the view doesn't
  // have an entry yet (e.g. a service account or an email that's never signed in).
  const submitterEmails = Array.from(new Set(rows.map((r) => r.created_by_email)));
  const submitterNames: Record<string, string> = {};
  if (submitterEmails.length > 0) {
    const { data: directoryRows } = await supabase
      .from("user_directory")
      .select("email, display_name")
      .in("email", submitterEmails);
    for (const d of (directoryRows ?? []) as Array<{ email: string; display_name: string | null }>) {
      if (d.display_name) submitterNames[d.email] = d.display_name;
    }
  }

  // Resolve product names (for single-product label "Name (CODE)").
  // `?? []` on products: a malformed row (a state saved without its products
  // array) must degrade to one odd-looking line in the table, not a 500 that
  // takes the whole inbox down for everyone. That exact failure happened on
  // 2026-08-29 when a partial-state save wiped Q0016's products.
  const productIds = Array.from(
    new Set(
      rows.flatMap((r) =>
        (r.state?.products ?? [])
          .map((p) => p.productId)
          .filter((pid): pid is string => !!pid && pid !== "new"),
      ),
    ),
  );
  const productInfo: Record<string, { name: string; code: string | null }> = {};
  if (productIds.length > 0) {
    const { data } = await supabase
      .from("products")
      .select("id, name, fp_code")
      .in("id", productIds);
    for (const p of (data ?? []) as Array<{ id: string; name: string; fp_code: string | null }>) {
      productInfo[p.id] = { name: p.name, code: p.fp_code };
    }
  }

  const display: WorkflowDisplayRow[] = rows.map((row) => {
    const state = row.state;
    const customerName =
      state.customerMode === "new"
        ? state.newCustomer?.name || t("newCustomerPlaceholder")
        : (state.customerId && customerInfo[state.customerId]?.name) || t("unknownCustomer");
    const customerSub =
      state.customerMode === "new"
        ? state.newCustomer?.contact || ""
        : (state.customerId && customerInfo[state.customerId]?.ship) || "";
    const formKeys =
      state.type === "contract-packaging" ? PACKAGING_KEYS : FORM_KEYS;
    const typeLabel = [
      state.type ? (TYPE_KEYS[state.type] ? t(TYPE_KEYS[state.type]) : state.type) : null,
      state.form ? (formKeys[state.form] ? t(formKeys[state.form]) : state.form) : null,
    ]
      .filter(Boolean)
      .join(" · ");
    const products = state.products ?? [];
    // Auto-computed one-line description ("Omega 3 + Vitamin D3 Softgels").
    // The inline editor on /workflows uses the override directly as the input
    // value (empty string = "no override") and falls back to the auto label
    // as placeholder, so we pass both fields through separately. The
    // descriptionLabel is kept around as a read-only fallback for search.
    const productNameMap: Record<string, string> = {};
    for (const [pid, info] of Object.entries(productInfo)) {
      productNameMap[pid] = info.name;
    }
    const autoDescription = buildAutoDescription(state, productNameMap);
    const resolvedDescription = resolveDescription(row.description_override, autoDescription);
    const descriptionLabel = resolvedDescription.length > 0 ? resolvedDescription : "—";
    const descriptionOverride = (row.description_override ?? "").trim();
    // The search blob still includes the code so users can find a workflow
    // by typing the Fishbowl SKU even though the visible cell doesn't show it.
    const productSearchBlob = products
      .map((p) => {
        if (p.mode === "new") return p.newProduct?.name_desc || "";
        if (p.productId && productInfo[p.productId]) {
          const info = productInfo[p.productId];
          return `${info.name} ${info.code || ""}`;
        }
        return "";
      })
      .join(" ");

    // Precompute the won-total dollar label on the server so the client
    // table doesn't need any extra deps to format currency. Only meaningful
    // when status is won; empty string otherwise.
    const status = row.status ?? "in_progress";
    const sos = Array.isArray(row.sales_orders) ? row.sales_orders : [];
    const total = sos.reduce((sum, so) => sum + (Number(so.value) || 0), 0);
    const salesOrdersTotalLabel =
      status === "won" && sos.length > 0 ? usdFormatter.format(total) : "";

    return {
      id: row.id,
      quoteNumberLabel: formatQuoteNumber(row.quote_number),
      customerName,
      customerSub,
      typeLabel,
      descriptionLabel,
      autoDescription,
      descriptionOverride,
      // RLS rule: owner OR member of admins table. Mirror that here so the
      // trash button only appears for rows the user can actually delete.
      canDelete: admin || row.created_by_email === user.email,
      productSearchBlob,
      submitterFull: row.created_by_email,
      submitterShort: submitterNames[row.created_by_email] || titleCase(localPart(row.created_by_email)),
      updatedRelative: relativeTime(row.updated_at, t),
      updatedSort: new Date(row.updated_at).getTime(),
      pushed: !!row.monday_item_id,
      status,
      salesOrdersTotalLabel,
    };
  });

  return (
    <div className="app-shell">
      <AppHeader user={{ email: user.email! }} />
      <main className="page">
        <div className="page__inner">
          <div className="page-header">
            <div>
              <h1 className="page-header__title">{t("workflowsTitle")}</h1>
              <p className="page-header__subtitle">{t("workflowsLede")}</p>
            </div>
            <div className="page-header__action">
              <Link href="/start?fresh=1" className="button-primary">
                {t("newWorkflow")}
              </Link>
            </div>
          </div>

          <I18nProvider lang={lang}>
            <WorkflowTable rows={display} />
          </I18nProvider>
        </div>
      </main>
    </div>
  );
}
