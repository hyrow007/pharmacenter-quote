type SearchParams = { customer?: string };

const FORMS = [
  { form: "softgel",  name: "Softgels",  desc: "Gelatin or veggie shell with a liquid fill.", base: "/start/bulk/product?form=softgel" },
  { form: "gummy",    name: "Gummies",   desc: "Pectin or gelatin chewable.",                  base: "/start/bulk/gummies" },
  { form: "tablet",   name: "Tablets",   desc: "Compressed solid-dose pressing.",              base: "/start/bulk/product?form=tablet" },
  { form: "capsule",  name: "Capsules",  desc: "Two-piece hard-shell encapsulation.",          base: "/start/bulk/product?form=capsule" },
  { form: "other",    name: "Other",     desc: "Powders, liquids, or other custom format.",    base: "/start/bulk/product?form=other" },
];

function appendCustomer(base: string, customer: string | undefined) {
  if (!customer) return base;
  const sep = base.includes("?") ? "&" : "?";
  return `${base}${sep}customer=${encodeURIComponent(customer)}`;
}

export default function BulkForms({ searchParams }: { searchParams?: SearchParams }) {
  const customer = searchParams?.customer;
  const backHref = customer ? `/start?customer=${encodeURIComponent(customer)}` : "/start";

  return (
    <main className="hero">
      <div className="card card--wide">
        <p className="eyebrow">Bulk Quote</p>
        <h1>What&rsquo;s the dosage form?</h1>
        <p className="lede">
          Pick the format we&rsquo;ll be quoting in bulk. We&rsquo;ll ask follow-up questions where the workflow differs.
        </p>
        <div className="options">
          {FORMS.map((opt) => (
            <a key={opt.form} className="opt" href={appendCustomer(opt.base, customer)}>
              <span className="opt__name">{opt.name}</span>
              <span className="opt__desc">{opt.desc}</span>
            </a>
          ))}
        </div>
        <a href={backHref} className="backlink">&larr; Back</a>
      </div>
    </main>
  );
}
