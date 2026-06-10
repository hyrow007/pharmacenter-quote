type SearchParams = { customer?: string };

const OPTIONS = [
  { type: "bulk",                name: "Bulk",                desc: "Softgels, gummies, tablets, or capsules in bulk packaging.",                              base: "/start/bulk" },
  { type: "contract-packaging",  name: "Contract Packaging",  desc: "Customer-supplied bulk, packaged to spec.",                                                base: "/generator.html?type=contract-packaging" },
  { type: "finished-product",    name: "Finished Product",    desc: "Retail ready product where PharmaCenter provides both the bulk and packaging.",            base: "/generator.html?type=finished-product" },
  { type: "other",               name: "Other",               desc: "Custom scope — describe inside the editor.",                                          base: "/generator.html?type=other" },
];

function appendCustomer(base: string, customer: string | undefined) {
  if (!customer) return base;
  const sep = base.includes("?") ? "&" : "?";
  return `${base}${sep}customer=${encodeURIComponent(customer)}`;
}

export default function Start({ searchParams }: { searchParams?: SearchParams }) {
  const customer = searchParams?.customer;
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
            <a key={opt.type} className="opt" href={appendCustomer(opt.base, customer)}>
              <span className="opt__name">{opt.name}</span>
              <span className="opt__desc">{opt.desc}</span>
            </a>
          ))}
        </div>
        <a href="/customer" className="backlink">&larr; Back</a>
      </div>
    </main>
  );
}
