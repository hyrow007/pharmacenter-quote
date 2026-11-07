// International customs: PharmaCenter's house list of what goes abroad.
//
// Decided with the user 2026-11-07:
// - Declared value is $1 for the WHOLE shipment by default (editable, never 0).
// - Origin USA. Duties and taxes billed to PharmaCenter. Purpose "Sample".
// - Commercial invoice printed with the label (no ETD until a letterhead and
//   signature image exist).
// - Over $2,500 total is refused: that needs an EEI filing, and the user does
//   not expect it to happen.
//
// Descriptions are deliberately plain but ACCURATE. 2106.90's official name is
// "food preparations not elsewhere specified", so finished supplement samples
// are described that way rather than as "vitamins". Gummies are only declared
// as sugar confectionery when they contain no active ingredients (a base or
// placebo) -- declaring supplement gummies as candy would be a false
// declaration, and the app will not do it.

export const DEFAULT_DECLARED_VALUE_USD = 1;
export const MAX_DECLARED_VALUE_USD = 2500;

/** Destinations FedEx ships from the US without customs paperwork. */
export const NO_CUSTOMS_COUNTRIES = new Set(["US", "PR", "VI", "GU", "AS", "MP"]);

export const CUSTOMS_ITEMS = {
  supplement_finished: {
    hs: "210690",
    en: "Finished samples with active ingredients — capsules, tablets, softgels, gummies, sachets",
    es: "Muestras terminadas con ingredientes activos — cápsulas, tabletas, softgels, gomitas, sachets",
    description: "Food preparation samples, not for sale",
  },
  supplement_powder: {
    hs: "210690",
    en: "Bulk powder blend sample",
    es: "Muestra de polvo a granel",
    description: "Food preparation powder sample, not for sale",
  },
  gummy_base: {
    hs: "170490",
    en: "Gummy base or placebo — NO active ingredients",
    es: "Base de gomita o placebo — SIN ingredientes activos",
    description: "Sugar confectionery samples, not for sale",
  },
  bottles: {
    hs: "392330",
    en: "Plastic bottles or jars",
    es: "Frascos o botellas de plástico",
    description: "Plastic bottles, empty, samples",
  },
  closures: {
    hs: "392350",
    en: "Caps and closures",
    es: "Tapas y cierres",
    description: "Plastic caps and closures, samples",
  },
  film: {
    hs: "392099",
    en: "Sachet or pouch film, printed laminate",
    es: "Película para sachet o pouch, laminado impreso",
    description: "Printed plastic laminate film, sample",
  },
  blister_film: {
    hs: "392043",
    en: "Blister film (PVC / PVDC)",
    es: "Película para blíster (PVC / PVDC)",
    description: "PVC blister film, sample",
  },
  foil: {
    hs: "760720",
    en: "Aluminum foil lidding",
    es: "Aluminio para sellado (lidding)",
    description: "Aluminum foil lidding, sample",
  },
  labels: {
    hs: "482110",
    en: "Printed labels",
    es: "Etiquetas impresas",
    description: "Printed paper labels, samples",
  },
  cartons: {
    hs: "481920",
    en: "Printed cartons",
    es: "Cajas plegadizas impresas",
    description: "Printed folding cartons, samples",
  },
} as const;

export type CustomsItemKey = keyof typeof CUSTOMS_ITEMS;
export const CUSTOMS_ITEM_KEYS = Object.keys(CUSTOMS_ITEMS) as CustomsItemKey[];

export type CustomsLine = { item: CustomsItemKey; quantity: number; note: string | null };

export type Customs = {
  documentsOnly: boolean;
  lines: CustomsLine[];
  /** Total for the whole shipment, USD. */
  declaredValue: number;
  /** Recipient's tax ID, only when the destination asks for one. */
  recipientTaxId: string | null;
};

export function needsCustoms(countryCode: string): boolean {
  return !NO_CUSTOMS_COUNTRIES.has(countryCode);
}

/** Spread the shipment's value across lines in whole cents, summing exactly. */
export function splitValue(total: number, n: number): number[] {
  const cents = Math.round(total * 100);
  const base = Math.floor(cents / n);
  return Array.from({ length: n }, (_, i) => (base + (i < cents - base * n ? 1 : 0)) / 100);
}
