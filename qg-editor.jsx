/* global React */
// =====================================================================
//  qg-editor.jsx — the data-entry panel for the Quote generator.
//  Pure controlled inputs that call back to the app via setData.
// =====================================================================

function Field({ label, value, onChange, type, placeholder, mono, full }) {
  return (
    <label className={"f" + (full ? " f--full" : "")}>
      <span>{label}</span>
      <input
        type={type || "text"}
        className={mono ? "mono" : ""}
        value={value == null ? "" : value}
        placeholder={placeholder || ""}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}

function NumField({ label, value, onChange, placeholder, full, step }) {
  return (
    <label className={"f" + (full ? " f--full" : "")}>
      <span>{label}</span>
      <input
        type="number"
        className="mono"
        step={step == null ? "any" : step}
        value={value == null ? "" : value}
        placeholder={placeholder || ""}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}

function DateField({ label, value, onChange }) {
  return (
    <label className="f">
      <span>{label}</span>
      <span className="datewrap">
        <input
          type="date"
          className="mono datein"
          value={value || ""}
          onChange={(e) => onChange(e.target.value)}
          onClick={(e) => { try { e.target.showPicker(); } catch (err) { /* not supported */ } }}
        />
      </span>
    </label>
  );
}

function Area({ label, value, onChange, rows, full, placeholder }) {
  return (
    <label className={"f" + (full ? " f--full" : "")}>
      <span>{label}</span>
      <textarea rows={rows || 3} value={value || ""} placeholder={placeholder || ""} onChange={(e) => onChange(e.target.value)} />
    </label>
  );
}

function ItemCard({ it, index, onChange, onRemove }) {
  const set = (k) => (v) => onChange(Object.assign({}, it, { [k]: v }));
  const ext = window.lineExt(it);
  return (
    <div className="card">
      <div className="card__top">
        <span className="card__no">{index + 1}</span>
        <input
          className="card__name"
          value={it.sku || ""}
          placeholder="SKU"
          onChange={(e) => set("sku")(e.target.value)}
        />
        <button className="iconbtn iconbtn--del" title="Remove item" onClick={onRemove}>×</button>
      </div>

      <div className="ed__field">
        <Field label="Description" value={it.name} placeholder="Product name" onChange={set("name")} />
      </div>
      <div className="ed__field">
        <Field label="Detail / sub-line" value={it.detail} placeholder="optional — shown small under the name" onChange={set("detail")} />
      </div>

      <div className="grid3">
        <NumField label="Qty" value={it.qty} placeholder="0" onChange={set("qty")} />
        <Field label="Unit" value={it.unit} placeholder="ea, btl, case" onChange={set("unit")} />
        <NumField label="Unit price (USD)" value={it.price} placeholder="0.00" step="0.01" onChange={set("price")} />
      </div>

      <div className="card__ext">
        <span className="card__extlab">Ext. Price</span>
        <span className="card__extval">{window.qgMoney(ext)}</span>
      </div>
    </div>
  );
}

function UserProfiles({ data, setData }) {
  const KEY = "pharmacenter-quote-users";
  const [users, setUsers] = React.useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(KEY) || "null");
      if (Array.isArray(saved) && saved.length) return saved;
    } catch (e) { /* ignore */ }
    if (data.preparedBy) return [{ name: data.preparedBy, phone: data.direct || "", ext: data.directExt || "", email: data.email || "" }];
    return [];
  });
  const [adding, setAdding] = React.useState(false);
  const [editIndex, setEditIndex] = React.useState(-1);
  const [draft, setDraft] = React.useState({ name: "", phone: "", ext: "", email: "" });

  React.useEffect(() => { try { localStorage.setItem(KEY, JSON.stringify(users)); } catch (e) { /* ignore */ } }, [users]);

  const apply = (u) => setData(Object.assign({}, data, { preparedBy: u.name, direct: u.phone || "", directExt: u.ext || "", email: u.email || "" }));
  const onSelect = (e) => {
    const v = e.target.value;
    if (v === "__add") { setEditIndex(-1); setDraft({ name: "", phone: "", ext: "", email: "" }); setAdding(true); return; }
    const u = users.find((x) => x.name === v);
    if (u) apply(u);
  };
  const setD = (k) => (v) => setDraft(Object.assign({}, draft, { [k]: v }));
  const startEdit = () => {
    const idx = users.findIndex((u) => u.name === data.preparedBy);
    if (idx < 0) return;
    setEditIndex(idx);
    setDraft(Object.assign({ name: "", phone: "", ext: "", email: "" }, users[idx]));
    setAdding(true);
  };
  const saveDraft = () => {
    if (!draft.name.trim()) return;
    let list;
    if (editIndex >= 0) { list = users.slice(); list[editIndex] = Object.assign({}, draft); }
    else { list = users.concat([Object.assign({}, draft)]); }
    setUsers(list);
    apply(draft);
    setDraft({ name: "", phone: "", ext: "", email: "" });
    setAdding(false); setEditIndex(-1);
  };
  const cancelDraft = () => { setAdding(false); setEditIndex(-1); setDraft({ name: "", phone: "", ext: "", email: "" }); };
  const removeCurrent = () => {
    if (!data.preparedBy) return;
    setUsers(users.filter((u) => u.name !== data.preparedBy));
  };
  const current = users.find((u) => u.name === data.preparedBy) ? data.preparedBy : "";

  return (
    <div className="prof">
      <label className="f">
        <span>Sales rep / preparer</span>
        <select className="prof__sel" value={current} onChange={onSelect}>
          <option value="">Select preparer…</option>
          {users.slice().sort((a, b) => (a.name || "").localeCompare(b.name || "", undefined, { sensitivity: "base" })).map((u, i) => <option key={i} value={u.name}>{u.name}</option>)}
          <option value="__add">+ Add new user…</option>
        </select>
      </label>
      {current ? (
        <div className="prof__links">
          <button className="prof__rm" onClick={startEdit}>Edit “{current}”</button>
          <button className="prof__rm" onClick={removeCurrent}>Remove</button>
        </div>
      ) : null}

      {adding ? (
        <div className="prof__add">
          <div className="prof__addhead">{editIndex >= 0 ? "Edit user" : "New user"}</div>
          <div className="grid2">
            <Field label="Name" value={draft.name} onChange={setD("name")} />
            <Field label="Phone" value={draft.phone} mono onChange={setD("phone")} />
            <Field label="Ext" value={draft.ext} mono placeholder="optional" onChange={setD("ext")} />
            <Field label="Email" value={draft.email} mono onChange={setD("email")} />
          </div>
          <div className="prof__actions">
            <button className="btn btn--primary" onClick={saveDraft}>{editIndex >= 0 ? "Update user" : "Save user"}</button>
            <button className="btn" onClick={cancelDraft}>Cancel</button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function Editor({ data, setData }) {
  const set = (k) => (v) => setData(Object.assign({}, data, { [k]: v }));

  const setItem = (i, ni) => {
    const items = (data.items || []).slice();
    items[i] = ni;
    setData(Object.assign({}, data, { items }));
  };
  const addItem = () =>
    setData(Object.assign({}, data, {
      items: (data.items || []).concat([{ sku: "", name: "", detail: "", qty: 1, unit: "ea", price: 0 }])
    }));
  const removeItem = (i) =>
    setData(Object.assign({}, data, { items: (data.items || []).filter((_, j) => j !== i) }));

  return (
    <div className="ed">
      <div className="ed__sec">
        <h4 className="ed__h">Quote Dates</h4>
        <div className="grid2">
          <DateField label="Issued" value={data.date} onChange={(v) => setData(Object.assign({}, data, { date: v, dateTouched: true }))} />
          <DateField label="Valid through" value={data.validThrough} onChange={set("validThrough")} />
        </div>
      </div>

      <div className="ed__sec">
        <h4 className="ed__h">Sales Rep</h4>
        <UserProfiles data={data} setData={setData} />
      </div>

      <div className="ed__sec">
        <h4 className="ed__h">Bill To</h4>
        <Area label="Customer (first line shown bold)" value={data.billTo} rows={4} full onChange={set("billTo")} />
      </div>

      <div className="ed__sec">
        <h4 className="ed__h">Ship To</h4>
        <label className="exptog" style={{ marginBottom: 8 }}>
          <input type="checkbox" checked={!!data.shipSame} onChange={(e) => set("shipSame")(e.target.checked)} />
          Same as Bill&nbsp;To
        </label>
        {!data.shipSame ? (
          <Area label="Ship-to address" value={data.shipTo} rows={4} full placeholder="Customer / receiving address" onChange={set("shipTo")} />
        ) : null}
      </div>

      <div className="ed__sec">
        <h4 className="ed__h">Order Details</h4>
        <div className="ed__field">
          <Field label="Customer PO" value={data.customerPo} mono placeholder="optional" onChange={set("customerPo")} />
        </div>
        <div className="ed__field">
          <Field label="Payment terms" value={data.paymentTerms} placeholder="Net 30 from invoice date" onChange={set("paymentTerms")} />
        </div>
        <div className="ed__field">
          <Field label="Shipping terms" value={data.shippingTerms} placeholder="FOB Origin · LTL Freight" onChange={set("shippingTerms")} />
        </div>
      </div>

      <div className="ed__sec">
        <h4 className="ed__h">Line Items</h4>
        {(data.items || []).map((it, i) => (
          <ItemCard
            key={i}
            it={it}
            index={i}
            onChange={(ni) => setItem(i, ni)}
            onRemove={() => removeItem(i)}
          />
        ))}
        <button className="addbtn" onClick={addItem}>+ Add line item</button>
      </div>

      <div className="ed__sec">
        <h4 className="ed__h">Adjustments</h4>
        <div className="adjs">
          {/* Discount */}
          <div className="adj">
            <div className="adj__head">
              <span className="adj__title">Discount</span>
              <label className="exptog">
                <input type="checkbox" checked={!!data.discountOn} onChange={(e) => set("discountOn")(e.target.checked)} />
                Apply
              </label>
            </div>
            {data.discountOn ? (
              <React.Fragment>
                <label className="f">
                  <span>Mode</span>
                  <select value={data.discountIsPct ? "pct" : "amt"} onChange={(e) => set("discountIsPct")(e.target.value === "pct")}>
                    <option value="pct">Percent</option>
                    <option value="amt">Flat amount (USD)</option>
                  </select>
                </label>
                <NumField label={data.discountIsPct ? "%" : "USD"} value={data.discountValue} step="0.01" onChange={set("discountValue")} />
              </React.Fragment>
            ) : null}
          </div>

          {/* Tax */}
          <div className="adj">
            <div className="adj__head">
              <span className="adj__title">Sales tax</span>
              <label className="exptog">
                <input type="checkbox" checked={!!data.taxOn} onChange={(e) => set("taxOn")(e.target.checked)} />
                Apply
              </label>
            </div>
            {data.taxOn ? (
              <NumField label="Rate (%)" value={data.taxRate} step="0.001" full onChange={set("taxRate")} />
            ) : null}
          </div>

          {/* Shipping */}
          <div className="adj">
            <div className="adj__head">
              <span className="adj__title">Shipping</span>
              <label className="exptog">
                <input type="checkbox" checked={!!data.shippingOn} onChange={(e) => set("shippingOn")(e.target.checked)} />
                Apply
              </label>
            </div>
            {data.shippingOn ? (
              <NumField label="Amount (USD)" value={data.shippingValue} step="0.01" full onChange={set("shippingValue")} />
            ) : null}
          </div>
        </div>
      </div>

      <div className="ed__sec">
        <h4 className="ed__h">Notes / Terms &amp; Conditions</h4>
        <Area label="Shown at the bottom of the quote" value={data.notes} rows={5} full placeholder="e.g. pricing validity, lead time, standard terms…" onChange={set("notes")} />
      </div>
    </div>
  );
}

Object.assign(window, { Editor });
