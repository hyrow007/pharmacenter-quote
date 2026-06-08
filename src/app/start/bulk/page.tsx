const FORMS = [
  { form: "softgel",  name: "Softgels",  desc: "Gelatin or veggie shell with a liquid fill.", href: "/start/bulk/product?form=softgel" },
  { form: "gummy",    name: "Gummies",   desc: "Pectin or gelatin chewable.",                  href: "/start/bulk/gummies" },
  { form: "tablet",   name: "Tablets",   desc: "Compressed solid-dose pressing.",              href: "/start/bulk/product?form=tablet" },
  { form: "capsule",  name: "Capsules",  desc: "Two-piece hard-shell encapsulation.",          href: "/start/bulk/product?form=capsule" },
  { form: "other",    name: "Other",     desc: "Powders, liquids, or other custom format.",    href: "/start/bulk/product?form=other" },
];

export default function BulkForms() {
  return (
    <main className="hero">
      <div className="card card--wide">
        <p className="eyebrow">Bulk Quote</p>
        <h1>What's the dosage form?</h1>
        <p className="lede">
          Pick the format we'll be quoting in bulk. We'll ask follow-up questions where the workflow differs.
        </p>
        <div className="options">
          {FORMS.map((opt) => (
            <a key={opt.form} className="opt" href={opt.href}>
              <span className="opt__name">{opt.name}</span>
              <span className="opt__desc">{opt.desc}</span>
            </a>
          ))}
        </div>
        <a href="/start" className="backlink">← Back</a>
      </div>
    </main>
  );
}
