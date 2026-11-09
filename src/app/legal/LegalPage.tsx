import type { ReactNode } from "react";

// Shared shell for /legal/* — public pages (no sign-in), required by Intuit
// for the "PharmaCenter Overhead" QuickBooks app. English first, Spanish
// directly beneath, full width (house convention for bilingual documents).

export function LegalPage({ title, updated, en, es }: { title: string; updated: string; en: ReactNode; es: ReactNode }) {
  return (
    <main style={{ maxWidth: 760, margin: "0 auto", padding: "40px 16px 60px", lineHeight: 1.6, fontSize: 15 }}>
      <p style={{ fontSize: 12, letterSpacing: "0.08em", textTransform: "uppercase", color: "#6b7478", margin: 0 }}>PharmaCenter</p>
      <h1 style={{ margin: "4px 0 4px", fontSize: 28 }}>{title}</h1>
      <p style={{ color: "#6b7478", margin: "0 0 28px", fontSize: 13 }}>{updated}</p>
      <section lang="en">{en}</section>
      <hr style={{ margin: "36px 0", border: 0, borderTop: "1px solid #e3dcc9" }} />
      <section lang="es">{es}</section>
    </main>
  );
}
