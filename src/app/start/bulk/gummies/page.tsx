const SOURCES = [
  { src: "third-party",  name: "Third party",                  desc: "Sourced from an external manufacturer.", href: "/start/bulk/product?form=gummy&source=third-party" },
  { src: "pharmacenter", name: "Manufactured at PharmaCenter", desc: "Made in our facility.",                  href: "/start/bulk/product?form=gummy&source=pharmacenter" },
  { src: "other",        name: "Other",                        desc: "Hybrid or special arrangement.",         href: "/start/bulk/product?form=gummy&source=other" },
];

export default function GummiesSource() {
  return (
    <main className="hero">
      <div className="card card--wide">
        <p className="eyebrow">Bulk Quote · Gummies</p>
        <h1>Who's making the gummies?</h1>
        <p className="lede">
          Tell us where the product comes from. This drives lead-time and cost defaults inside the editor.
        </p>
        <div className="options">
          {SOURCES.map((opt) => (
            <a key={opt.src} className="opt" href={opt.href}>
              <span className="opt__name">{opt.name}</span>
              <span className="opt__desc">{opt.desc}</span>
            </a>
          ))}
        </div>
        <a href="/start/bulk" className="backlink">← Back</a>
      </div>
    </main>
  );
}
