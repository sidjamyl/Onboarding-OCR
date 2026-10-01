import { redirect } from "next/navigation";
import { TriangleAlert } from "lucide-react";
import { Logo } from "@/components/logo";

export default async function TransferPage({ params }: { params: Promise<{ transferToken: string }> }) {
  const { transferToken } = await params;
  const backend = process.env.ONBOARDING_API_URL ?? "http://127.0.0.1:8090";
  const response = await fetch(`${backend}/public/transfers/${transferToken}/consume`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
    cache: "no-store",
  });
  if (!response.ok)
    return (
      <main className="journey">
        <header className="journey-header">
          <Logo />
        </header>
        <section className="journey-centered">
          <TriangleAlert size={32} />
          <h1>Ce QR code a expiré</h1>
          <p>Sur l’ordinateur, choisissez « Afficher un nouveau QR code », puis scannez-le avec ce téléphone.</p>
        </section>
      </main>
    );
  const payload = await response.json();
  redirect(new URL(payload.accessUrl).pathname);
}
