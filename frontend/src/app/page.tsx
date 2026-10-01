"use client";

import { ArrowRight, ShieldCheck } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Logo } from "@/components/logo";
import { journeyCopy } from "@/lib/journey-copy";
import type { Locale } from "@/lib/types";
import { ImageCarousel } from "./s/[token]/desktop-journey";

export default function HomePage() {
  const router = useRouter();
  const [locale, setLocale] = useState<Locale>("fr");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const text = journeyCopy[locale];
  const demoEnabled = process.env.NEXT_PUBLIC_DEMO_MODE_ENABLED === "true";

  const start = async () => {
    setBusy(true);
    setError(false);
    try {
      const response = await fetch("/api/demo/session", {
        method: "POST",
        body: JSON.stringify({ locale, policyId: "id-and-licence" }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.detail ?? payload.error);
      router.push(new URL(payload.accessUrl).pathname);
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="journey" dir={locale === "ar" ? "rtl" : "ltr"}>
      <header className="journey-header">
        <Logo />
        <div className="journey-header-right">
          <span className="journey-secure">
            <ShieldCheck size={15} /> {text.secure}
          </span>
          <nav className="journey-languages" aria-label="Language">
            {(["fr", "ar", "en"] as Locale[]).map((item) => (
              <button
                type="button"
                key={item}
                className={locale === item ? "active" : ""}
                onClick={() => setLocale(item)}
              >
                {item.toUpperCase()}
              </button>
            ))}
          </nav>
        </div>
      </header>
      <section className="journey-entry">
        <div className="journey-entry-copy">
          <h1>{text.startTitle}</h1>
          <p>{text.startDetail}</p>
          {demoEnabled ? (
            <button type="button" className="journey-primary" disabled={busy} onClick={() => void start()}>
              {text.start} <ArrowRight size={18} />
            </button>
          ) : (
            <p className="journey-invitation">{text.invitation}</p>
          )}
          {error && (
            <p role="alert" className="journey-action-error">
              {text.unavailable}
            </p>
          )}
          <span className="journey-entry-note">
            <ShieldCheck size={15} /> {text.secure}
          </span>
        </div>
        <ImageCarousel />
      </section>
    </main>
  );
}
