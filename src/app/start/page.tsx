const OPTIONS = [
  { type: "bulk", name: "Bulk", desc: "Softgels, gummies, tablets, or capsules in bulk packaging.", href: "/start/bulk" },
  { type: "contract-packaging", name: "Contract Packaging", desc: "Customer-supplied bulk, packaged to spec.", href: "/generator.html?type=contract-packaging" },
  { type: "finished-product", name: "Finished Product", desc: "Retail ready product where PharmaCenter provides both the bulk and packaging.", href: "/generator.html?type=finished-product" },
  { type: "other", name: "Other", desc: "Custom scope — describe inside the editor.", href: "/generator.html?type=other" },
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
            <a key={opt.type} className="opt" href={opt.href}>
              <span className="opt__name">{opt.name}</span>
              <span className="opt__desc">{opt.desc}</span>
            </a>
          ))}
        </div>
        <a href="/customer" className="backlink">← Back</a>
      </div>
    </main>
  );
}
