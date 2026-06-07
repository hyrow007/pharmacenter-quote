const OPTIONS = [
  { type: "bulk", name: "Bulk", desc: "Raw ingredient or material in bulk packaging." },
  { type: "contract-packaging", name: "Contract Packaging", desc: "Customer-supplied product, packaged to spec." },
  { type: "finished-product", name: "Finished Product", desc: "Ready-to-sell SKU from the PharmaCenter catalog." },
  { type: "other", name: "Other", desc: "Custom scope — describe inside the editor." },
];

export default function Start() {
  return (
    <main className="hero">
      <div className="card card--wide">
        <p className="eyebrow">PharmaCenter</p>
        <h1>What are we quoting?</h1>
        <p className="lede">
          Pick a type to start. You can change every line-item detail inside the editor.
        </p>
        <div className="options">
          {OPTIONS.map((opt) => (
            <a key={opt.type} className="opt" href={`/generator.html?type=${opt.type}`}>
              <span className="opt__name">{opt.name}</span>
              <span className="opt__desc">{opt.desc}</span>
            </a>
          ))}
        </div>
        <a href="/" className="backlink">← Back</a>
      </div>
    </main>
  );
}
