"use client";

import { Check, LoaderCircle, ShieldCheck, Smartphone, TriangleAlert } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { consistencyCopy } from "@/lib/consistency-copy";
import { CaptureStep } from "@/components/capture-step";
import { Logo } from "@/components/logo";
import { normalizeApiUrl } from "@/lib/api-url";
import { projectOnboarding } from "@/lib/flow-projection";
import { documentLabels } from "@/lib/i18n";
import { journeyCopy, recaptureReason, sideLabel } from "@/lib/journey-copy";
import { SessionRequestError, usePublicSession } from "@/lib/public-session";
import type { Locale, QualityReport } from "@/lib/types";

const apiUrl = normalizeApiUrl(process.env.NEXT_PUBLIC_ONBOARDING_API_URL ?? "/api/onboarding");

export function PhoneCapture({ token }: { token: string }) {
  const { session, error, post, refresh } = usePublicSession(token);
  const [locale, setLocale] = useState<Locale>("fr");
  const localeSet = useRef(false);
  const [cameraOpen, setCameraOpen] = useState(false);
  const [serverError, setServerError] = useState<QualityReport | { error: string } | null>(null);
  const lastPhoto = useRef<{ photo: Blob; key: string } | undefined>(undefined);
  const projection = useMemo(() => (session ? projectOnboarding(session) : undefined), [session]);
  const target =
    projection?.current && projection.nextSide ? `${projection.current.kind}-${projection.nextSide}` : undefined;
  const previousTarget = useRef(target);
  const text = journeyCopy[locale];

  useEffect(() => {
    if (session && !localeSet.current) {
      setLocale(session.locale);
      localeSet.current = true;
    }
  }, [session]);
  useEffect(() => {
    if (previousTarget.current === target) return;
    previousTarget.current = target;
    setCameraOpen(false);
    setServerError(null);
  }, [target]);

  if (cameraOpen && projection?.current && projection.nextSide) {
    const document = projection.current;
    const side = projection.nextSide;
    return (
      <CaptureStep
        key={target}
        locale={locale}
        documentKind={document.kind}
        documentLabel={documentLabels[locale][document.kind]}
        sideLabel={sideLabel(locale, side)}
        attemptsRemaining={Math.max(0, 3 - document.ocrAttempts)}
        profileUrl={`${apiUrl}/public/sessions/${token}/quality-templates/${document.kind}-${side}`}
        serverError={serverError}
        onRetake={() => setServerError(null)}
        onBack={() => setCameraOpen(false)}
        onCapture={async ({ photo }) => {
          if (lastPhoto.current?.photo !== photo) lastPhoto.current = { photo, key: crypto.randomUUID() };
          const form = new FormData();
          form.set("file", photo, "capture.jpg");
          const accepted = async () => {
            const latest = await refresh();
            return Boolean(latest.documents[document.kind]?.captures[side]);
          };
          try {
            await post(`/captures/${document.kind}/${side}`, form, lastPhoto.current.key);
            setServerError(null);
            setCameraOpen(false);
          } catch (cause) {
            // A dev tunnel may lose the response after the server accepted the photo.
            // Reconcile the session before calling a successful ORB check a failure.
            if (await accepted().catch(() => false)) {
              setServerError(null);
              setCameraOpen(false);
              return;
            }
            const retryable =
              !(cause instanceof SessionRequestError) ||
              ["backend_unavailable", "verification_unavailable"].includes(String(cause.payload.error));
            if (retryable) {
              try {
                await post(`/captures/${document.kind}/${side}`, form, lastPhoto.current.key);
                setServerError(null);
                setCameraOpen(false);
                return;
              } catch (retryCause) {
                if (await accepted().catch(() => false)) {
                  setServerError(null);
                  setCameraOpen(false);
                  return;
                }
                cause = retryCause;
              }
            }
            if (cause instanceof SessionRequestError) {
              const payload = cause.payload;
              setServerError(
                (payload.quality as QualityReport | undefined) ?? {
                  error: String(payload.error ?? "verification_unavailable"),
                },
              );
            } else setServerError({ error: "network_error" });
            throw cause;
          }
        }}
      />
    );
  }

  return (
    <main className="journey journey-phone" dir={locale === "ar" ? "rtl" : "ltr"}>
      <header className="journey-header">
        <Logo />
        <ShieldCheck size={17} aria-label={text.secure} />
      </header>
      <section className="journey-phone-body">
        {!session || !projection ? (
          <>
            <LoaderCircle size={29} className="journey-spin" />
            <h1>{error === "session_not_found" ? text.sessionMissing : error ? text.unavailable : text.loading}</h1>
            {error && error !== "session_not_found" && (
              <button type="button" className="journey-secondary" onClick={() => void refresh().catch(() => undefined)}>
                {text.retry}
              </button>
            )}
          </>
        ) : ["document_failed", "consistency_failed", "technical_failed", "expired"].includes(session.status) ? (
          <>
            <TriangleAlert size={35} />
            <h1>{text.failed}</h1>
            <p>{text.failedDetail}</p>
          </>
        ) : projection.phase === "capture" && projection.current && projection.nextSide ? (
          <>
            <div className="journey-phone-symbol">
              <Smartphone size={31} />
            </div>
            <span className="journey-phone-step">
              {text.cameraTask} · {sideLabel(locale, projection.nextSide)}
            </span>
            <h1>{documentLabels[locale][projection.current.kind]}</h1>
            <p>{text.cameraReadyDetail}</p>
            {projection.current.status === "processing" && (
              <p className="journey-background-reading">{consistencyCopy[locale].background}</p>
            )}
            {recaptureReason(locale, session.reasonCode) && (
              <div className="journey-alert" role="alert">
                <TriangleAlert size={18} />
                <p>{recaptureReason(locale, session.reasonCode)}</p>
              </div>
            )}
            <div className="journey-phone-sequence">
              {projection.current.requiredSides.map((side) => (
                <span
                  key={side}
                  className={projection.current?.captures[side] ? "done" : side === projection.nextSide ? "active" : ""}
                >
                  {projection.current?.captures[side] ? <Check size={15} /> : null}
                  {sideLabel(locale, side)}
                </span>
              ))}
            </div>
            <button type="button" className="journey-primary" onClick={() => setCameraOpen(true)}>
              {text.openCamera}
            </button>
          </>
        ) : projection.phase === "consistency" ? (
          <>
            <TriangleAlert size={31} aria-hidden="true" />
            <h1>{consistencyCopy[locale].phoneConflict}</h1>
            <p>{consistencyCopy[locale].phoneDetail}</p>
          </>
        ) : (
          <>
            <div className="journey-phone-symbol">
              <Check size={31} />
            </div>
            <h1>
              {session.status === "succeeded" || session.status === "awaiting_submission"
                ? text.phoneFinished
                : text.phoneDone}
            </h1>
            <p>{projection.phase === "processing" ? text.phoneWaitDetail : text.phoneDoneDetail}</p>
            {projection.phase === "processing" && (
              <div className="journey-phone-status">
                <LoaderCircle size={17} className="journey-spin" />{" "}
                {text.stage[projection.current?.progress?.stage ?? "ocr_reading"]}
              </div>
            )}
            {projection.phase === "review" || projection.phase === "incomplete" ? (
              <div className="journey-phone-status">{text.phoneWait}</div>
            ) : null}
          </>
        )}
      </section>
    </main>
  );
}
