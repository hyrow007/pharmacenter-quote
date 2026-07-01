/* global React, ReactDOM, Editor, Sheet, QG_SAMPLE */
// =====================================================================
//  qg-app.jsx — top-level Quote generator: holds the data, persists to
//  localStorage under "pharmacenter-quote" (NEVER touch
//  "pharmacenter-packing-list"), renders the editor + live document,
//  and handles print / sample / blank.
// =====================================================================

const STORAGE_KEY  = "pharmacenter-quote";          // never reuse the packing-list key
const COUNTER_KEY  = "pharmacenter-quote-counter";  // sequential QT0001, QT0002…

function loadData() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const d = migrate(JSON.parse(raw));
      if (!d.docNo) d.docNo = nextDocNo();
      if (!d.dateTouched) d.date = todayIso();
      // valid-through defaults: 30 days from today if blank
      if (!d.validThrough) d.validThrough = isoPlusDays(30);
      return d;
    }
  } catch (e) { /* ignore */ }
  const s = JSON.parse(JSON.stringify(QG_SAMPLE));
  s.docNo = nextDocNo();
  s.date = todayIso();
  s.validThrough = isoPlusDays(30);
  s.dateTouched = false;
  return s;
}

function todayIso() {
  const t = new Date();
  return t.getFullYear() + "-" + String(t.getMonth() + 1).padStart(2, "0") + "-" + String(t.getDate()).padStart(2, "0");
}
function isoPlusDays(days) {
  const t = new Date();
  t.setDate(t.getDate() + days);
  return t.getFullYear() + "-" + String(t.getMonth() + 1).padStart(2, "0") + "-" + String(t.getDate()).padStart(2, "0");
}

// Sequential quote document number (QT0001, QT0002…) persisted on its own key
// — independent of any packing-list counter.
function nextDocNo() {
  let n = 0;
  try { n = parseInt(localStorage.getItem(COUNTER_KEY) || "0", 10) || 0; } catch (e) { /* ignore */ }
  n += 1;
  try { localStorage.setItem(COUNTER_KEY, String(n)); } catch (e) { /* ignore */ }
  return n;
}

// Light migration for older saved shapes (forward-compat hook).
function migrate(d) {
  if (!d || typeof d !== "object") return JSON.parse(JSON.stringify(QG_SAMPLE));
  if (!Array.isArray(d.items)) d.items = [];
  // Coerce required adjustment flags so checkboxes show predictable state.
  if (typeof d.discountOn  === "undefined") d.discountOn  = false;
  if (typeof d.discountIsPct === "undefined") d.discountIsPct = true;
  if (typeof d.taxOn       === "undefined") d.taxOn       = false;
  if (typeof d.shippingOn  === "undefined") d.shippingOn  = false;
  if (typeof d.shipSame    === "undefined") d.shipSame    = !d.shipTo;
  return d;
}

function App() {
  const [data, setData] = React.useState(loadData);
  const [collapsed, setCollapsed] = React.useState(false);
  const [scale, setScale] = React.useState(1);
  const previewRef = React.useRef(null);

  React.useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(data)); } catch (e) { /* ignore */ }
  }, [data]);

  // Fit the 8.5in sheet to the available preview width.
  React.useEffect(() => {
    const SHEET = 8.5 * 96; // px
    const fit = () => {
      const el = previewRef.current;
      if (!el) return;
      const avail = el.clientWidth - 56;
      setScale(Math.min(1, Math.max(0.4, avail / SHEET)));
    };
    fit();
    const ro = new ResizeObserver(fit);
    if (previewRef.current) ro.observe(previewRef.current);
    window.addEventListener("resize", fit);
    return () => { ro.disconnect(); window.removeEventListener("resize", fit); };
  }, [collapsed]);

  // If opened in a real (non-sandboxed) tab with ?print=1, auto-open the print dialog.
  React.useEffect(() => {
    if (/[?&]print=1/.test(window.location.search)) {
      const t = setTimeout(() => { try { window.print(); } catch (e) { /* ignore */ } }, 900);
      return () => clearTimeout(t);
    }
  }, []);

  // Print the current quote. In sandboxed preview, window.print() is blocked, so open
  // the live document in a real tab that auto-prints.
  const printDoc = () => {
    if (window.self !== window.top) {
      try {
        const href = window.location.href.split("#")[0];
        const url = href + (href.indexOf("?") >= 0 ? "&" : "?") + "print=1";
        window.open(url, "_blank");
        return;
      } catch (e) { /* fall through */ }
    }
    try { window.print(); } catch (e) { /* ignore */ }
  };

  const sample = () => {
    if (window.confirm("Reset to the sample quote? Your current entries will be cleared.")) {
      const fresh = JSON.parse(JSON.stringify(QG_SAMPLE));
      fresh.docNo = nextDocNo();
      fresh.date = todayIso();
      fresh.validThrough = isoPlusDays(30);
      setData(fresh);
    }
  };
  const blank = () => {
    if (window.confirm("Start a blank quote?")) {
      setData({
        docNo: nextDocNo(),
        date: todayIso(),
        validThrough: isoPlusDays(30),
        dateTouched: false,
        customerPo: "",
        billTo: "Customer Name\nStreet Address\nCity, ST ZIP",
        shipTo: "",
        shipSame: true,
        preparedBy: "",
        direct: "",
        directExt: "",
        email: "",
        paymentTerms: "Net 30 from invoice date",
        shippingTerms: "FOB Origin · LTL Freight",
        items: [{ sku: "", name: "", detail: "", qty: 1, unit: "ea", price: 0 }],
        discountOn: false,
        discountIsPct: true,
        discountValue: 0,
        taxOn: false,
        taxRate: 0,
        shippingOn: false,
        shippingValue: 0,
        notes: ""
      });
    }
  };

  return (
    <div className={"gen" + (collapsed ? " gen--collapsed" : "")}>
      <aside className="gen__editor">
        <div className="gen__bar">
          <div className="gen__title">
            <span className="gen__kicker">PharmaCenter</span>
            <strong>Generate Quote</strong>
          </div>
          <button className="gen__hide" title="Hide panel" onClick={() => setCollapsed(true)}>⟨</button>
        </div>
        <div className="gen__actions">
          <button className="btn btn--primary" onClick={printDoc}>Print / Save PDF</button>
          <button className="btn" onClick={sample}>Sample</button>
          <button className="btn" onClick={blank}>Blank</button>
        </div>
        <p className="gen__autosave">Auto-saves as you type</p>
        <Editor data={data} setData={setData} />
      </aside>

      <button className="gen__show" title="Show editor" onClick={() => setCollapsed(false)}>⟩ Edit</button>

      <main className="gen__preview" ref={previewRef}>
        <div className="stage" id="stage" style={{ zoom: scale }}>
          <Sheet data={data} />
        </div>
      </main>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("app")).render(<App />);
