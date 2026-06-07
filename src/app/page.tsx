export default function Home() {
  return (
    <main className="hero">
      <div className="card">
        <p className="eyebrow">PharmaCenter</p>
        <h1>Quote</h1>
        <p className="lede">
          Tool to internally manage quoting work flows and generate customer
          facing quote documents. Phase 1 deploy verified — auth, database,
          and editor land in the next releases.
        </p>
        <a className="cta" href="/generator.html">Start a Quote →</a>
        <p className="meta">v0.1 · {new Date().toLocaleDateString("en-US", {
          year: "numeric", month: "long", day: "numeric",
        })}</p>
      </div>
    </main>
  );
}
