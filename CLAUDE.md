# CLAUDE.md — PharmaCenter Quote generator

Customer-facing quote generator for PharmaCenter sales. Architectural twin of the
Packing List generator: editor on the left, live 8.5×11 sheet on the right,
autosave to `localStorage`, Print/Save-PDF button.

## File layout

```
quote/
├─ Quote.html                              # entry — loads vendored React/Babel + jsx + css
├─ quote.css                               # tokens (PharmaCenter brand) + layout + print rules
├─ qg-sheet.jsx                            # data model + Sheet renderer (the printed page)
├─ qg-editor.jsx                           # left-pane editor: controlled inputs only
├─ qg-app.jsx                              # top-level App: load/save, print, sample/blank
├─ assets/
│  ├─ logo.png                             # PharmaCenter wordmark (copied from packing-list)
│  └─ vendor/                              # react.dev, react-dom.dev, babel.min, fonts.css + fonts/
├─ PharmaCenter Quote Generator.html       # single-file standalone for hosting (inlined)
├─ CLAUDE.md                               # this file
└─ README.md
```

## ⚠️  Storage key — DO NOT clobber the user's saved data

The Quote generator uses a **separate** `localStorage` key from the Packing List.
Under no circumstances may any code in this project read, write, or delete the
packing-list key.

| Key                              | Used by         | Touched by Quote app?           |
| -------------------------------- | --------------- | ------------------------------- |
| `pharmacenter-quote`             | Quote (data)    | **yes — primary storage**       |
| `pharmacenter-quote-counter`     | Quote (QT####)  | **yes — sequential doc number** |
| `pharmacenter-quote-users`       | Quote (reps)    | **yes — saved sales reps**      |
| `pharmacenter-packing-list`      | Packing List    | **NEVER — leave it alone**      |
| `pharmacenter-pl-counter`        | Packing List    | **NEVER — leave it alone**      |
| `pharmacenter-pl-users`          | Packing List    | **NEVER — leave it alone**      |

If you add a new persisted setting to the Quote generator, namespace it under
`pharmacenter-quote-…`. Never reuse a `pharmacenter-pl-…` or
`pharmacenter-packing-list…` name, even temporarily during a migration.

## Brand tokens

Defined in `quote.css` `:root` — identical to the Packing List so the two
documents look like one set when printed together.

| Token        | Value      | Notes                                   |
| ------------ | ---------- | --------------------------------------- |
| `--teal-900` | `#0f4a56`  | primary ink (titles, footer band)       |
| `--teal-700` | `#1d6c7b`  | primary accent (rules, labels)          |
| `--sage-500` | `#7fb04f`  | micro-accent (save dot, valid pill)     |
| `--sage-300` | `#bcd596`  | soft accent (valid pill border)         |
| `--paper`    | `#fffdf8`  | sheet background                        |
| `--bg`       | `#e7ddc8`  | stage backdrop (warm)                   |

Letterhead wordmark: `assets/logo.png` rendered at `52px` tall. Headline serif:
Cormorant Garamond. UI sans: Nunito. Monospace for numeric: IBM Plex Mono.

## Data shape

The single object persisted at `pharmacenter-quote`:

```ts
{
  docNo: number,            // 1-indexed; rendered as QT0001, QT0002…
  date: "YYYY-MM-DD",       // issued
  dateTouched: boolean,     // true once user edits, else gets bumped to today on load
  validThrough: "YYYY-MM-DD",

  billTo: string,           // multi-line; first line shown bold
  shipTo: string,
  shipSame: boolean,        // when true, ship-to box says "Same as Bill To"

  customerPo: string,
  preparedBy: string,
  direct: string,
  directExt: string,
  email: string,

  paymentTerms: string,
  shippingTerms: string,

  items: Array<{
    sku: string,
    name: string,
    detail: string,         // optional sub-line shown small under the name
    qty: number,
    unit: string,           // ea, btl, case, …
    price: number           // unit price USD
  }>,

  discountOn: boolean,
  discountIsPct: boolean,   // true = percent, false = flat USD
  discountValue: number,
  taxOn: boolean,
  taxRate: number,          // % applied after discount
  shippingOn: boolean,
  shippingValue: number,    // flat USD

  notes: string             // multi-line; shown at the bottom of the quote
}
```

`qg-sheet.jsx` exports `quoteTotals(data)` which returns
`{ subtotal, discount, tax, shipping, total, itemCount }`. Subtotal = sum of
`qty * price`; discount applies to subtotal; tax applies to
`subtotal - discount`; shipping is a flat add-on.

## Running

Open `Quote.html` directly in a browser (no build step). The single-file
`PharmaCenter Quote Generator.html` is a self-contained standalone for hosting
— same app, same brand, everything inlined.

## Printing

A Print/Save PDF button calls `window.print()`. CSS hides the editor pane and
the stage chrome; only the `.sheet` is visible. `@page { size: letter; margin: 0; }`
matches the on-screen 8.5×11 layout 1-to-1.

## Costing-board feature baseline (applies to EVERY quoting/costing tool)

Any new pricing calculator or costing board built for this app (bottles,
blisters, and whatever comes next — sachets, pouches, kitting…) must ship
with ALL of the following from day one. These were retrofitted between the
bottle and blister boards once; do not make a third board that lacks them:

1. **Drag-and-drop row reordering** on Material Costs — ⋮⋮ handle only
   (never the whole row), teal drop indicator, order persists in the saved
   BOM array. Handle hidden on print (`bc-noprint`).
2. **Comma-formatted number fields** — text input (`inputMode="decimal"`),
   draft-string while focused, `toLocaleString` on blur. Values always show
   thousands separators when blurred.
3. **Part search by product number** — the picker API keeps hyphens so
   "PC-PK-0135" matches fp_code (already in /api/packaging-components).
4. **Typed-in (custom) parts are editable in place** — reopening the picker
   pre-fills the current name, and a rename preserves the manual cost.
5. **Bulk is always a visible row option** — even when customer-supplied
   (shown as an explicit $0), with a doses-per-unit count box and Manual
   pricing (bulk is a product, not a packaging component).
6. **Quantity boxes where counts matter** — safety seals per unit, doses
   per unit, units per inner pack / master box — seeded from the packaging
   spec but always editable on the board.
7. **Real customer + product names** resolved server-side (customers /
   products tables) on the board header and print sheet — never IDs or
   generic placeholders.
8. **Scenario tabs** — pills above Considerations (gummy-Costing-tab UX):
   Base + named scenarios, right-click to rename, hover × to delete,
   "+ Scenario" duplicates the current tab. Each scenario is a COMPLETE
   board snapshot (BOM, speeds, crew, margin — everything), never
   qty-only: edits on one tab must not bleed into another. Base persists
   in the top-level saved fields, scenarios in `scenarios[].state`;
   Save from any tab persists all tabs. Selection is screen-local.
   Strip hidden on print.
9. **Gross margin (materials) readout** with hover explainers (ⓘ) on both
   margin metrics in the Margin & Price card.
