// v50.1: English-literal → Spanish lookup for the formula editor.
//
// The editor funnels most user-visible text through a handful of shared
// subcomponents (Field, SummaryRow, ParamBlock, BTh). Rather than thread
// t(key) through hundreds of call sites in a 9,500-line file, those
// chokepoints translate their string props through tr(): exact English
// literals map to Spanish; anything not in the map (names, values,
// codes) passes through untouched. Direct JSX text uses tr() inline.
//
// Keys must match the code literals EXACTLY (many render uppercase via
// CSS text-transform — map the source casing, not the on-screen one).

import type { Lang } from "./dict";

const es: Record<string, string> = {
  // ---- Batch setup / key indicators ----
  "Bench top batch size": "Tamaño de lote de mesa",
  "Bench top batch size (Cooked)": "Tamaño de lote de mesa (cocido)",
  "Batch size (pre-cook blend)": "Tamaño de lote (mezcla de precocción)",
  "CFA Batch Size": "Tamaño de lote CFA",
  "Target Yield": "Rendimiento objetivo",
  "Finished piece weight (Dry)": "Peso de pieza terminada (seco)",
  "Finished piece weight (dry)": "Peso de pieza terminada (seco)",
  "Cast weight (wet)": "Peso de vaciado (húmedo)",
  "Theoretical Yield": "Rendimiento teórico",
  "Primary Blend (cooked)": "Mezcla primaria (cocida)",
  "Secondary Blend": "Mezcla secundaria",
  "Final Blend": "Mezcla final",
  "Total (Sum of all blends)": "Total (suma de mezclas)",
  "Total (sum of all blends)": "Total (suma de mezclas)",
  "% of bench batch": "% del lote de mesa",
  "Residual Moisture Total": "Humedad residual total",
  "Sugar (dry)": "Azúcar (seca)",
  "Syrup (dry)": "Jarabe (seco)",
  "Batch Setup": "Configuración de lote",
  "Place Holder": "Marcador de posición",
  "Gummies / batch (Cooked Primary Blend)":
    "Gomitas / lote (mezcla primaria cocida)",
  "Key Indicators": "Indicadores clave",

  // ---- Product details ----
  "Product Details": "Detalles del producto",
  "Product Code": "Código de producto",
  "Name / description": "Nombre / descripción",
  Shape: "Forma",
  Flavor: "Sabor",
  Customer: "Cliente",
  Change: "Cambiar",

  // ---- Blend cards ----
  "Pre-cook blend": "Mezcla de precocción",
  "Cooked blend": "Mezcla cocida",
  "Ingredients weighed in before being cooked.":
    "Ingredientes pesados antes de la cocción.",
  "What remains after cooking. Water boils off — cook to the target weight before folding in secondary and final blends.":
    "Lo que queda después de la cocción. El agua se evapora — cocine hasta el peso objetivo antes de incorporar las mezclas secundaria y final.",
  "Primary Blend": "Mezcla primaria",
  "Primary Blend Carry Over": "Arrastre de mezcla primaria",
  "From the pre-cook blend — carried over into the pot.":
    "De la mezcla de precocción — trasladada a la olla.",

  // ---- Table headers ----
  Ingredient: "Ingrediente",
  Grams: "Gramos",
  "Overage %": "% de exceso",
  "Moisture loss": "Pérdida de humedad",
  "Residual Moisture %": "% humedad residual",
  "Residual moisture %": "% humedad residual",

  // ---- Totals ----
  "Total primary blend": "Total mezcla primaria",
  "Total primary blend carry over": "Total arrastre mezcla primaria",
  "Transferred Cooked Primary Blend to CFA Tank":
    "Mezcla primaria cocida transferida al tanque CFA",
  "CFA Batch": "Lote CFA",
  "Grand Total CFA Batch": "Gran total de lote CFA",
  "Scaled to the CFA Batch Size — the transferred cooked primary blend plus the secondary and final additions.":
    "Escalado al tamaño de lote CFA — la mezcla primaria cocida transferida más las adiciones secundarias y finales.",
  "Total transferred to CFA tank": "Total transferido al tanque CFA",
  "Total secondary blend": "Total mezcla secundaria",
  "Total final blend": "Total mezcla final",
  "Grand Total Cooked Blend": "Gran total de mezcla cocida",

  // ---- Scale up / material costing params ----
  "Batch size": "Tamaño de lote",
  "Batches / day": "Lotes / día",
  "Fixed loss / day": "Pérdida fija / día",
  "Piece weight": "Peso de pieza",
  "Process yield": "Rendimiento del proceso",
  "Total daily kg": "Kg diarios totales",
  "Effective daily yield": "Rendimiento diario efectivo",
  "Gummies / batch": "Gomitas / lote",
  "$ / gummy (raw)": "$ / gomita (bruto)",
  "$ / gummy (w/ daily loss)": "$ / gomita (c/ pérdida diaria)",
  "Daily material $": "$ diario de materiales",

  // ---- Print sheet ----
  "Gummy Formula Sheet": "Hoja de Fórmula de Gomitas",
  "Bench top batch": "Lote de mesa",
  Formula: "Fórmula",
  Version: "Versión",
  Name: "Nombre",
  "Updated on:": "Actualizada el:",

  // ---- Label claims ----
  "Label claims": "Declaraciones de etiqueta",
  "(active ingredients only)": "(solo ingredientes activos)",

  // ---- Buttons / chrome ----
  "+ Add ingredient": "+ Agregar ingrediente",
  "+ Add solution": "+ Agregar solución",
  "+ Add component": "+ Agregar componente",
  "+ Add Ingredient": "+ Agregar ingrediente",
  Saved: "Guardado",
  "Preparing…": "Preparando…",
  "Bench top": "Mesa de trabajo",
  "Print / PDF": "Imprimir / PDF",
  // BLEND_PHASE_LABELS / HINTS (lib/formulas.ts casings)
  "Secondary blend": "Mezcla secundaria",
  "Final blend": "Mezcla final",
  Cooking: "Cocción",
  "Cook the pre-cook blend down to target solids before folding in the secondary blend.":
    "Cocine la mezcla de precocción hasta los sólidos objetivo antes de incorporar la mezcla secundaria.",
  "Added after cooking is complete.": "Se agrega al terminar la cocción.",
  "Colors, flavors, and any last-step masking agents.":
    "Colores, sabores y agentes enmascarantes de último paso.",
  // Totals composed as `Total ${label.toLowerCase()}`
  "Total pre-cook blend": "Total mezcla de precocción",
  "Total cooked blend": "Total mezcla cocida",
  // Label claims
  "Per-gummy amount as printed on the finished label.":
    "Cantidad por gomita según la etiqueta del producto terminado.",
  "Values are for one (1) gummy.": "Los valores son para una (1) gomita.",
  Claim: "Declaración",
  Unit: "Unidad",
  Input: "Entrada",
  "Scale up": "Escalado",
  "Material costing": "Costo de materiales",

  // ---- Formulas catalog ----
  Updated: "Actualizada",
  Actions: "Acciones",
  Delete: "Eliminar",
  "All shapes": "Todas las formas",
  "+ New formula": "+ Nueva fórmula",
  "Creating…": "Creando…",
  "Search customer, product code, name, flavor, or preparer…":
    "Buscar cliente, código, nombre, sabor o preparador…",
  "No formulas yet. Click + New formula to author the first one.":
    "Aún no hay fórmulas. Haga clic en + Nueva fórmula para crear la primera.",
  "Per page:": "Por página:",
  Previous: "Anterior",
  Next: "Siguiente",
  "Sugar to Syrup Ratio": "Proporción azúcar a jarabe",
  "Updated ": "Actualizada ",
  "by ": "por ",
  // ---- Straggler pass (mixed-language report) ----
  Existing: "Existente",
  Milligrams: "Miligramos",
  Micrograms: "Microgramos",
  "Saved to library": "Guardada en biblioteca",
  "Save to library": "Guardar en biblioteca",
  Composition: "Composición",
  empty: "vacía",
  "Total: ": "Total: ",
  gummies: "gomitas",
  Solution: "Solución",
  component: "componente",
  components: "componentes",
  "from label claim": "de declaración de etiqueta",
  // material source tags — categories come from raw_materials.category
  primary: "primaria",
  secondary: "secundaria",
  final: "final",
  "pre-cook": "precocción",
  cooked: "cocida",
  "Moisture Loss": "Pérdida de humedad",
  "Claim Baseline: ": "Base de declaración: ",
  Kilograms: "Kilogramos",
  "% of finished product": "% de producto terminado",
  "Mirrors the bench-top formula. Production values to be defined.":
    "Refleja la fórmula de mesa. Los valores de producción están por definirse.",
  "Pre-cook blend scales from the bench top: batch size ÷ total primary blend. Remaining values to be defined.":
    "La mezcla de precocción se escala desde la mesa: tamaño de lote ÷ total de mezcla primaria. Los demás valores están por definirse.",
  "Pre-cook blend scales by batch size ÷ total primary blend; Secondary and Final blends by CFA batch size ÷ total primary blend carry over.":
    "La mezcla de precocción se escala por tamaño de lote ÷ total de mezcla primaria; las mezclas secundaria y final por tamaño de lote CFA ÷ total de arrastre de mezcla primaria.",
  // ---- Derived scale-up table (v51) ----
  "Kg / batch": "Kg / lote",
  "Total weighed input": "Total de entrada pesada",
  "Derived from the bench-top formula — batch size equals Total Primary Blend.":
    "Derivada de la fórmula de mesa — el tamaño de lote equivale al total de la mezcla primaria.",
};

export function makeTr(lang: Lang) {
  if (lang !== "es") return (s: string) => s;
  return (s: string) => es[s] ?? s;
}
