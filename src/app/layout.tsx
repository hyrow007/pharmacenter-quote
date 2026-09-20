import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "PharmaCenter — Quote",
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
