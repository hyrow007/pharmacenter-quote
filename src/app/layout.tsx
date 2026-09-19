import type { Metadata } from "next";
import "./globals.css";

// Browser tab title for the quote host, and the fallback for any route
// in this deployment without its own metadata. One deployment serves
// four identities, so the per-app titles live with their routes:
//   quote.   -> "Quotes"        (here)
//   formula. -> "Formulas"      (src/app/formulas/*)
//   order.   -> "Sales Orders"  (src/app/orders/page.tsx)
// Kept prefix-free to match the Packing app's plain "Packing List" —
// the shared favicon already identifies these as PharmaCenter.
export const metadata: Metadata = {
  title: "Quotes",
  description: "Internal tool for generating customer-facing quotes",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
