import type { Metadata } from "next";
import "./globals.css";
import "./journey.css";

export const metadata: Metadata = { title: "OCR Onboarding", description: "Secure document onboarding" };

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="fr">
      <body>{children}</body>
    </html>
  );
}
