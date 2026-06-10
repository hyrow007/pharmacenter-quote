type SearchParams = { customer?: string };

const SOURCES = [
  { src: "third-party",  name: "Third party",                     desc: "Sourced from an external manufacturer.", base: "/start/bulk/product?form=gummy&source=third-party" },
  { src: "pharmacenter", name: "Manufactured at PharmaCenter",    desc: "Made in our facility.",                  base: "/start/bulk/product?form=gummy&source=pharmacenter" },
  { src: "other",        name: "Other",                           desc: "Hybrid or special arrangement.",         base: "/start/bulk/product?form=gummy&source=other" },
];

function appendCustomer(base: string, customer: string | undefined) {
  if (!customer) return base;
  return `${base}&customer=${encodeURIComponent(customer)}`;
}

export default function GummiesSource({ searchParams }: { searchParams?: SearchParams }) {
  const customer = searchParams?.customer;
  const backHref = customer ? `/start/bulk?customer=${encodeURIComponent(customer)}` : "/start/bulk";

  return (
    <main className="hero">
      <div className="card card--wide">
        <p className="eyebrow">Bulk Quote · Gummies</p>
        <h1>Who&rsquo;s making the gummies?</h1>
        <p className="lede">
          Tell us where the product comes from. This drives lead-time and cost defaults inside the editor.
        </p>
        <div className="options">
          {SOURCES.map((opt) => (
            <a key={opt.src} className="opt" href={appendCustomer(opt.base, customer)}>
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
