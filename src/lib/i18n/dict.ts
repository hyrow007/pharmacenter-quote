// v50: in-app translations for the quote/formula app. Mirrors the
// packing list's i18n pattern (one dictionary, makeT(lang), a language
// cookie readable on both server and client) so the two codebases feel
// like one system. Spanish strings reuse the packing list's vocabulary
// where the same concept appears (navFeedback → "Comentarios", etc.).
//
// Unlike the packing list — whose customer-facing sheet is always
// English — the formula PRINT SHEET here is internal (bench operators),
// so print-sheet labels are translated too (slice 2).

export type Lang = "en" | "es";

// One preference across every PharmaCenter app: the cookie is written
// with domain=.pharmacenter.app (see LangToggle) so quote, formulas,
// and — once its LangToggle writes the same cookie — the packing list
// all flip together.
export const LANG_COOKIE_NAME = "pc-lang";

const en = {
  // ---- Header / nav ----
  navWorkflows: "Workflows",
  navFormulas: "Formulas",
  navLists: "Lists",
  navFeedback: "Feedback",
  navAdmin: "Admin",

  // ---- Formulas catalog ----
  catalogTitle: "Gummy Formula Catalog",
  catalogLede:
    "Every gummy design PharmaCenter has authored, indexed by PC-BK code (or held as TBD until R&D assigns one). Open a formula to view or edit its bench-top recipe, scale-up, and material costing.",
  catalogSearch: "Search customer, product code, name, flavor, or preparer…",
  allShapes: "All shapes",
  newFormula: "+ New formula",
  colFormula: "Formula",
  colProductCode: "Product code",
  colName: "Name",
  colCustomer: "Customer",
  colShape: "Shape",
  colFlavor: "Flavor",
  colVersion: "Version",
  colUpdated: "Updated",
  colActions: "Actions",
  deleteAction: "Delete",
  perPage: "Per page:",
  previous: "← Previous",
  next: "Next →",
  pageXofY: "Page {x} of {y}",
  backToFormulas: "← Back to formulas",
  backToWorkflows: "← Back to workflows",

  // ---- Editor chrome ----
  printPdf: "Print / PDF",
  saved: "Saved",
  tabBenchTop: "Bench top",
  tabScaleUp: "Scale up",
  tabMaterialCosting: "Material costing",
  addIngredient: "+ Add ingredient",
  addSolution: "+ Add solution",
  change: "Change",
};

const es: typeof en = {
  // ---- Header / nav ----
  navWorkflows: "Flujos de trabajo",
  navFormulas: "Fórmulas",
  navLists: "Listas",
  navFeedback: "Comentarios",
  navAdmin: "Admin",

  // ---- Formulas catalog ----
  catalogTitle: "Catálogo de Fórmulas de Gomitas",
  catalogLede:
    "Cada diseño de gomita creado por PharmaCenter, indexado por código PC-BK (o marcado TBD hasta que I+D asigne uno). Abra una fórmula para ver o editar su receta de mesa, escalado y costo de materiales.",
  catalogSearch: "Buscar cliente, código, nombre, sabor o preparador…",
  allShapes: "Todas las formas",
  newFormula: "+ Nueva fórmula",
  colFormula: "Fórmula",
  colProductCode: "Código de producto",
  colName: "Nombre",
  colCustomer: "Cliente",
  colShape: "Forma",
  colFlavor: "Sabor",
  colVersion: "Versión",
  colUpdated: "Actualizada",
  colActions: "Acciones",
  deleteAction: "Eliminar",
  perPage: "Por página:",
  previous: "← Anterior",
  next: "Siguiente →",
  pageXofY: "Página {x} de {y}",
  backToFormulas: "← Volver a fórmulas",
  backToWorkflows: "← Volver a flujos",

  // ---- Editor chrome ----
  printPdf: "Imprimir / PDF",
  saved: "Guardado",
  tabBenchTop: "Mesa de trabajo",
  tabScaleUp: "Escalado",
  tabMaterialCosting: "Costo de materiales",
  addIngredient: "+ Agregar ingrediente",
  addSolution: "+ Agregar solución",
  change: "Cambiar",
};

export type DictKey = keyof typeof en;

export function makeT(lang: Lang) {
  const dict = lang === "es" ? es : en;
  return (key: DictKey, vars?: Record<string, string | number>): string => {
    let out: string = dict[key] ?? en[key] ?? key;
    if (vars) {
      for (const [k, v] of Object.entries(vars)) {
        out = out.replace(`{${k}}`, String(v));
      }
    }
    return out;
  };
}
