"use client";

import { ArrowRight, Check, FileText, LoaderCircle } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

export function LocalTest() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  async function start() {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try {
      const response = await fetch("/api/demo/session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ locale: "fr", policyId: "id-and-licence" }),
        signal: AbortSignal.timeout(25_000),
      });
      const session = await response.json();
      if (!response.ok || typeof session.accessUrl !== "string") throw new Error();
      router.push(new URL(session.accessUrl).pathname);
    } catch {
      setError("The test could not start. Check the local backend connection, then try again.");
      setBusy(false);
    }
  }

  return (
    <main className="console-login">
      <div className="console-login-form">
        <a className="console-brand" href="/test">
          <span className="console-mark">
            <FileText size={18} />
          </span>
          OCR Onboarding
        </a>
        <h1>Test your documents.</h1>
        <p>Start a local test of your identity card and driving licence. No account or API key to enter.</p>
        <section className="console-document-list" aria-label="Documents included in this test">
          {["National identity card", "Driving licence"].map((title) => (
            <div className="console-document-row" key={title}>
              <span>
                <strong>{title}</strong>
                <small>Front and back</small>
              </span>
              <Check size={17} aria-hidden="true" />
            </div>
          ))}
        </section>
        <p className="console-login-foot">
          Each start creates a fresh test. Document extraction uses the real OCR gateway.
        </p>
        {error && (
          <p className="console-error" role="alert">
            {error}
          </p>
        )}
        <button type="button" className="console-primary" disabled={busy} onClick={() => void start()} aria-busy={busy}>
          {busy ? <LoaderCircle className="console-spin" size={16} /> : <ArrowRight size={16} />}
          {busy ? "Preparing your test…" : "Start test"}
        </button>
        <div className="console-login-foot">
          The document journey opens in French. You can switch language inside it.
        </div>
        <a className="console-text-link" href="/admin">
          Application settings <ArrowRight size={14} />
        </a>
      </div>
      <aside className="console-login-aside">
        <div>
          <h2>
            Two documents.
            <br />
            The complete journey.
          </h2>
          <p>The test prepares the session and required documents automatically.</p>
          <ol>
            <li>Capture the front and back of each document</li>
            <li>Review the extracted fields and consistency checks</li>
            <li>Return here to start another test</li>
          </ol>
        </div>
      </aside>
    </main>
  );
}
