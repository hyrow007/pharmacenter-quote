/* global React */
// =====================================================================
//  qg-sheet.jsx — data model, totals helpers, and the Sheet renderer
//  for the live printable PharmaCenter customer quote document.
// =====================================================================

// ---------- sample / default data ----------
const QG_SAMPLE = {
  date: "2026-06-05",
  validThrough: "2026-07-05",
  customerPo: "",
  billTo: "Greenfield Apothecary, Inc.\nAttn: Procurement\n2440 Hanover Pike\nFrederick, MD 21703",
  shipTo: "",            // empty = same as bill-to
  shipSame: true,
  preparedBy: "Rosie Gutierrez",
  direct: "(786) 260-7104",
  directExt: "",
  email: "sales@pharmacenter.health",
  paymentTerms: "Net 30 from invoice date",
  shippingTerms: "FOB Origin · LTL Freight (prepaid & add)",
  items: [
    { sku: "1928", name: "NeuroBrocc · 60 Gummies Per Pouch",     detail: "Sulforaphane glucosinolate blend · vegan", qty: 240,  unit: "ea",   price: 14.85 },
    { sku: "1341", name: "SUNVIT Vitamin E 400 IU · 60 ct Bottle", detail: "Mixed tocopherols · gluten-free",          qty: 480,  unit: "ea",   price: 6.20  },
    { sku: "2207", name: "Omega-3 1200 mg · 90 Softgels",          detail: "Wild-caught, IFOS 5★ certified",            qty: 360,  unit: "ea",   price: 9.95  }
  ],
  discountOn: false,
  discountIsPct: true,
  discountValue: 5,        // 5% or $5 depending on mode
  taxOn: false,
  taxRate: 0,              // %
  shippingOn: true,
  shippingValue: 185.00,
  notes:
    "Pricing valid through the date shown above and subject to product availability. " +
    "Lead time is typically 5–7 business days after PO acceptance. " +
    "Acceptance of this quote constitutes acceptance of PharmaCenter standard terms of sale."
};

// ---------- helpers ----------
const n = (v) => (Number(v) || 0);
const money = (v) =>
  n(v).toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2 });
const fmtInt = (v) => n(v).toLocaleString("en-US");

function lineExt(item) { return n(item.qty) * n(item.price); }

function quoteTotals(data) {
  const subtotal = (data.items || []).reduce((s, it) => s + lineExt(it), 0);
  let discount = 0;
  if (data.discountOn) {
    if (data.discountIsPct) discount = subtotal * (n(data.discountValue) / 100);
    else discount = n(data.discountValue);
  }
  const afterDiscount = Math.max(0, subtotal - discount);
  const tax = data.taxOn ? afterDiscount * (n(data.taxRate) / 100) : 0;
  const shipping = data.shippingOn ? n(data.shippingValue) : 0;
  const total = afterDiscount + tax + shipping;
  return { subtotal, discount, tax, shipping, total, itemCount: (data.items || []).length };
}

function formatDate(v) {
  if (!v) return "—";
  const m = String(v).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return m[2] + " / " + m[3] + " / " + m[1];
  return v;
}

// Build "Ship-to" content — if "same as bill-to" is on or shipTo is empty, defer.
function resolveShipTo(data) {
  if (data.shipSame || !(data.shipTo || "").trim()) return null;
  return data.shipTo;
}

// ---------- document sub-components ----------
function Letterhead() {
  return (
    <header className="lh">
      <div className="lh__brand">
        <img className="logo__img" src="assets/logo.png" alt="PharmaCenter — One Solution, One Source" />
      </div>
      <div className="lh__info">
        <div className="lh__co">PharmaCenter&nbsp;LLC</div>
        <div>15851 SW 41st Street, Suite 300</div>
        <div>Davie, FL 33331 · USA</div>
        <div className="lh__contact">
          <span>(954) 384-8728</span>
          <span>sales@pharmacenter.health</span>
          <span>pharmacenter.health</span>
        </div>
      </div>
    </header>
  );
}

function TitleBar({ data }) {
  return (
    <div className="titlebar">
      <div className="titlebar__head">
        <h1>Quote{data.validThrough ? <span className="titlebar__valid">Valid&nbsp;through&nbsp;<b>{formatDate(data.validThrough)}</b></span> : null}</h1>
        <div className="titlebar__sub">
          <span className="titlebar__date">Issued&nbsp;{formatDate(data.date)}</span>
        </div>
      </div>
      <dl className="titlebar__meta">
        <div><dt>Prepared&nbsp;by</dt><dd>{data.preparedBy || "—"}</dd></div>
        <div>
          <dt>Contact</dt>
          <dd className="mono">
            {(data.direct || data.email) ? (
              <React.Fragment>
                {data.direct ? <span style={{ display: "block" }}>{String(data.direct).replace(/ /g, " ")}{data.directExt ? " ext. " + data.directExt : ""}</span> : null}
                {data.email ? <span style={{ display: "block" }}>{data.email}</span> : null}
              </React.Fragment>
            ) : "—"}
          </dd>
        </div>
        <div><dt>Quote&nbsp;No.</dt><dd className="mono">{data.docNo ? "QT" + String(data.docNo).padStart(4, "0") : "—"}</dd></div>
      </dl>
    </div>
  );
}

function PartyBox({ label, body, fallback }) {
  const text = (body || "").trim();
  if (!text) {
    return (
      <div className="party">
        <span className="party__label">{label}</span>
        <div className="party__body"><span className="muted">{fallback || "—"}</span></div>
      </div>
    );
  }
  return (
    <div className="party">
      <span className="party__label">{label}</span>
      <div className="party__body">
        {text.split("\n").map((line, i) =>
          i === 0 ? <strong key={i}>{line}<br /></strong> : <React.Fragment key={i}>{line}<br /></React.Fragment>
        )}
      </div>
    </div>
  );
}

function Parties({ data }) {
  const ship = resolveShipTo(data);
  return (
    <div className="parties">
      <PartyBox label="Bill To" body={data.billTo} fallback="Customer name & address" />
      {ship == null
        ? (
          <div className="party">
            <span className="party__label">Ship To</span>
            <div className="party__body"><span className="muted">Same as Bill&nbsp;To</span></div>
          </div>
        )
        : <PartyBox label="Ship To" body={ship} fallback="Customer name & address" />}
    </div>
  );
}

function Deets({ data }) {
  return (
    <dl className="deets">
      <div className="deet"><dt>Customer PO</dt><dd className="mono">{(data.customerPo || "").trim() || "—"}</dd></div>
      <div className="deet"><dt>Payment Terms</dt><dd>{(data.paymentTerms || "").trim() || "—"}</dd></div>
      <div className="deet"><dt>Shipping Terms</dt><dd>{(data.shippingTerms || "").trim() || "—"}</dd></div>
      <div className="deet"><dt>Currency</dt><dd className="mono">USD</dd></div>
    </dl>
  );
}

function ItemsTable({ items }) {
  return (
    <table className="tbl">
      <thead>
        <tr>
          <th className="c-line">#</th>
          <th className="c-sku">SKU</th>
          <th className="c-desc">Description</th>
          <th className="c-qty">Qty</th>
          <th className="c-price">Unit Price</th>
          <th className="c-ext">Ext. Price</th>
        </tr>
      </thead>
      <tbody>
        {(items || []).map((it, i) => (
          <tr key={i}>
            <td className="c-line"><span className="lineno">{i + 1}</span></td>
            <td className="c-sku mono">{it.sku || "—"}</td>
            <td className="c-desc">
              <span className="item-name">{it.name || "Untitled item"}</span>
              {it.detail ? <span className="item-sub">{it.detail}</span> : null}
            </td>
            <td className="c-qty mono">{fmtInt(it.qty)}{it.unit ? <span style={{ color: "var(--ink-3)", fontWeight: 500 }}>&nbsp;{it.unit}</span> : null}</td>
            <td className="c-price mono">{money(it.price)}</td>
            <td className="c-ext mono">{money(lineExt(it))}</td>
          </tr>
        ))}
        {(!items || items.length === 0) ? (
          <tr><td colSpan="6" style={{ textAlign: "center", color: "var(--ink-3)", padding: "18px 10px" }}>No line items yet — add some on the left.</td></tr>
        ) : null}
      </tbody>
    </table>
  );
}

function Summary({ data, tot }) {
  return (
    <div className="summary">
      <div className="summary__row">
        <dt>Subtotal</dt>
        <dd className="mono">{money(tot.subtotal)}</dd>
      </div>
      {data.discountOn ? (
        <div className="summary__row is-discount">
          <dt>Discount{data.discountIsPct ? " (" + n(data.discountValue) + "%)" : ""}</dt>
          <dd className="mono">− {money(tot.discount)}</dd>
        </div>
      ) : null}
      {data.taxOn ? (
        <div className="summary__row">
          <dt>Tax ({n(data.taxRate)}%)</dt>
          <dd className="mono">{money(tot.tax)}</dd>
        </div>
      ) : null}
      {data.shippingOn ? (
        <div className="summary__row">
          <dt>Shipping</dt>
          <dd className="mono">{money(tot.shipping)}</dd>
        </div>
      ) : null}
      <div className="summary__grand">
        <dt>Total Due</dt>
        <dd className="mono">{money(tot.total)}</dd>
      </div>
    </div>
  );
}

function TermsBlock({ data }) {
  const hasTerms = (data.paymentTerms || "").trim() || (data.shippingTerms || "").trim();
  if (!hasTerms) {
    return (
      <div className="terms">
        <span className="terms__label">Terms</span>
        <span style={{ color: "var(--ink-3)" }}>Terms applied per Customer Master Agreement.</span>
      </div>
    );
  }
  return (
    <div className="terms">
      <span className="terms__label">Terms</span>
      {data.paymentTerms ? <div><b>Payment:</b> {data.paymentTerms}</div> : null}
      {data.shippingTerms ? <div style={{ marginTop: 3 }}><b>Shipping:</b> {data.shippingTerms}</div> : null}
    </div>
  );
}

function NotesBlock({ data }) {
  if (!(data.notes || "").trim()) return null;
  return (
    <div className="notes">
      <span className="notes__label">Notes</span>
      <p>{data.notes}</p>
    </div>
  );
}

function SignBox({ data }) {
  return (
    <div className="signbox">
      <div className="signbox__col">
        <span className="signbox__label">Accepted by (Customer)</span>
        <span className="signbox__line"></span>
        <span className="signbox__hint">Signature · Printed Name · Title</span>
        <span className="signbox__line" style={{ marginTop: 8, height: 22 }}></span>
        <span className="signbox__hint">Date</span>
      </div>
      <div className="signbox__col">
        <span className="signbox__label">For PharmaCenter LLC</span>
        <span className="signbox__line"></span>
        <span className="signbox__hint">{data.preparedBy ? data.preparedBy : "Authorized Representative"}</span>
        <span className="signbox__line" style={{ marginTop: 8, height: 22 }}></span>
        <span className="signbox__hint">Date</span>
      </div>
    </div>
  );
}

function Footer({ data }) {
  const docNo = data.docNo ? "QT" + String(data.docNo).padStart(4, "0") : "";
  return (
    <footer className="ft">
      <span className="ft__msg">Thank you for considering PharmaCenter — One Solution, One Source.</span>
      <span className="ft__meta mono">{docNo ? "Doc No: " + docNo : ""}</span>
    </footer>
  );
}

// ---------- the page ----------
function Sheet({ data }) {
  const tot = quoteTotals(data);
  return (
    <section className="sheet" data-screen-label={"Quote " + (data.docNo ? "QT" + String(data.docNo).padStart(4, "0") : "")}>
      <Letterhead />
      <TitleBar data={data} />
      <Parties data={data} />
      <Deets data={data} />

      <div className="block">
        <div className="block__head">
          <h2>Items Quoted</h2>
          <span className="block__note">{tot.itemCount === 1 ? "1 line item" : tot.itemCount + " line items"} · prices in USD</span>
        </div>
        <ItemsTable items={data.items} />
      </div>

      <div className="totalsrow">
        <TermsBlock data={data} />
        <Summary data={data} tot={tot} />
      </div>

      <NotesBlock data={data} />
      <SignBox data={data} />
      <Footer data={data} />
    </section>
  );
}

Object.assign(window, { QG_SAMPLE, Sheet, quoteTotals, lineExt, qgMoney: money, qgFmtInt: fmtInt, formatDate });
