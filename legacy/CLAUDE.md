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
