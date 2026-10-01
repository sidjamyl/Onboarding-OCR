"use client";

import {
  ArrowRight,
  Check,
  Circle,
  FileText,
  LoaderCircle,
  QrCode,
  ShieldCheck,
  Smartphone,
  TriangleAlert,
} from "lucide-react";
import QRCode from "qrcode";
import Image from "next/image";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ConsistencyResult } from "@/components/consistency-result";
import { consistencyCopy } from "@/lib/consistency-copy";
import { DocumentResult } from "@/components/document-result";
import { Logo } from "@/components/logo";
import { projectOnboarding } from "@/lib/flow-projection";
import { documentLabels } from "@/lib/i18n";
import { journeyCopy, journeyError, recaptureReason, sideLabel } from "@/lib/journey-copy";
import { SessionRequestError, usePublicSession } from "@/lib/public-session";
import type { DocumentKind, DocumentSide, Locale, ProcessingStage, PublicSession } from "@/lib/types";

const documentOrder: DocumentKind[] = ["dz-id", "dz-driving-licence", "dz-passport"];
const stages: ProcessingStage[] = ["photos_received", "quality_validated", "ocr_reading", "field_validation"];

export function DesktopJourney({ token }: { token: string }) {
  const { session, error, live, refresh, post } = usePublicSession(token);
  const [locale, setLocale] = useState<Locale>("fr");
  const localeSet = useRef(false);
  const [chosen, setChosen] = useState<DocumentKind[]>([]);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string>();
  const [qr, setQr] = useState<{ image: string; expiresAt: string }>();
  const projection = useMemo(() => (session ? projectOnboarding(session) : undefined), [session]);
  const text = journeyCopy[locale];

  useEffect(() => {
    if (session && !localeSet.current) {
      setLocale(session.locale);
      localeSet.current = true;
    }
  }, [session]);

  const run = useCallback(
    async (task: () => Promise<unknown>) => {
      setBusy(true);
      setActionError(undefined);
      try {
        await task();
      } catch (cause) {
        setActionError(journeyError(locale, cause instanceof SessionRequestError ? cause.payload.error : undefined));
      } finally {
        setBusy(false);
      }
    },
    [locale],
  );

  const issueQr = useCallback(async () => {
    try {
      const payload = (await post("/transfer")) as { transferUrl: string; expiresAt: string };
      const image = await QRCode.toDataURL(payload.transferUrl, { margin: 1, width: 240 });
      setQr({ image, expiresAt: payload.expiresAt });
      setActionError(undefined);
    } catch (cause) {
      setActionError(journeyError(locale, cause instanceof SessionRequestError ? cause.payload.error : undefined));
    }
  }, [post, locale]);

  useEffect(() => {
    if (session?.status !== "created" && projection?.phase === "capture" && !session?.captureDeviceConnected && !qr) void issueQr();
  }, [session?.status, projection?.phase, session?.captureDeviceConnected, qr, issueQr]);

  useEffect(() => {
    if (!qr) return;
    const delay = Math.max(0, new Date(qr.expiresAt).getTime() - Date.now());
    const timer = window.setTimeout(() => setQr(undefined), delay);
    return () => window.clearTimeout(timer);
  }, [qr]);

  const shell = (children: React.ReactNode) => (
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
      {children}
    </main>
  );

  if (!session || !projection)
    return shell(
      <section className="journey-centered" aria-live="polite">
        <LoaderCircle className="journey-spin" size={28} />
        <h1>{error === "session_not_found" ? text.sessionMissing : error ? text.unavailable : text.loading}</h1>
        {error && error !== "session_not_found" && (
          <button type="button" className="journey-secondary" onClick={() => void refresh().catch(() => undefined)}>
            {text.retry}
          </button>
        )}
      </section>,
    );

  if (["document_failed", "consistency_failed", "technical_failed", "expired"].includes(session.status))
    return shell(
      <section className="journey-centered">
        <TriangleAlert size={34} />
        <h1>{text.failed}</h1>
        <p>{text.failedDetail}</p>
        <p className="journey-error-detail">{session.reasonCode}</p>
        {session.returnUrl && (
          <a className="journey-primary" href={session.returnUrl}>
            {text.return}
          </a>
        )}
      </section>,
    );

  if (session.status === "succeeded")
    return shell(
      <section className="journey-centered journey-success">
        <div className="journey-final-icon">
          <Check size={32} />
        </div>
        <h1>{text.submitted}</h1>
        <p>{text.submittedDetail}</p>
        <div className="journey-receipt">
          {projection.documents.map(({ document }) => (
            <span key={document.kind}>
              <Check size={15} /> {documentLabels[locale][document.kind]}
            </span>
          ))}
        </div>
        <a className="journey-primary" href={session.returnUrl ?? "/"}>
          {text.return} <ArrowRight size={16} />
        </a>
      </section>,
    );

  if (!session.documentSelection)
    return shell(
      <section className="journey-centered" role="alert">
        <TriangleAlert size={30} />
        <h1>{text.unavailable}</h1>
        <button type="button" className="journey-secondary" onClick={() => void refresh().catch(() => undefined)}>
          {text.retry}
        </button>
      </section>,
    );

  const fixedSelection = session.documentSelection.mode === "all";
  const allowedKinds = fixedSelection
    ? session.documentSelection.allowedDocuments
    : documentOrder.filter((kind) => session.documentSelection.allowedDocuments.includes(kind));
  const requiredKinds = session.documentSelection.requiredDocuments ?? [];
  const selectedKinds = fixedSelection
    ? allowedKinds
    : allowedKinds.filter((kind) => chosen.includes(kind) || requiredKinds.includes(kind));
  const minimumDocuments = session.documentSelection.minimumDocuments;
  const maximumDocuments = session.documentSelection.maximumDocuments ?? allowedKinds.length;
  const requiredLabel = locale === "fr" ? "Obligatoire" : locale === "ar" ? "إلزامي" : "Required";
  const selectionInstruction = fixedSelection
    ? text.fixedSelectionDetail
    : session.documentSelection.mode === "exact"
      ? locale === "fr"
        ? `Choisissez exactement ${minimumDocuments} documents. Les documents obligatoires sont déjà sélectionnés.`
        : locale === "ar"
          ? `اختر ${minimumDocuments} مستندات بالضبط. المستندات الإلزامية محددة مسبقًا.`
          : `Choose exactly ${minimumDocuments} documents. Mandatory documents are already selected.`
      : text.selectDetail;

  if (session.status === "created")
    return shell(
      <section className="journey-selection">
        <h1>{text.selectTitle}</h1>
        <p>{selectionInstruction}</p>
        <div className="journey-choice-grid">
          {allowedKinds.map((kind) => {
            const selected = selectedKinds.includes(kind);
            return (
              <button
                type="button"
                key={kind}
                className={`journey-choice ${selected ? "selected" : ""}`}
                aria-pressed={selected}
                disabled={
                  fixedSelection ||
                  requiredKinds.includes(kind) ||
                  (!selected && selectedKinds.length >= maximumDocuments)
                }
                onClick={() => setChosen(selected ? chosen.filter((item) => item !== kind) : [...chosen, kind])}
              >
                <FileText size={23} />
                <span>
                  <strong>{documentLabels[locale][kind]}</strong>
                  <small>
                    {kind === "dz-passport" ? text.single : `${text.front} · ${text.back}`}
                    {requiredKinds.includes(kind) && ` · ${requiredLabel}`}
                  </small>
                </span>
                <span className="journey-choice-check">{selected && <Check size={15} />}</span>
              </button>
            );
          })}
        </div>
        <div className="journey-selection-footer">
          <span>
            {selectedKinds.length}/{minimumDocuments} {text.selected}
          </span>
          <button
            type="button"
            className="journey-primary"
            disabled={selectedKinds.length < minimumDocuments || selectedKinds.length > maximumDocuments || busy}
            onClick={() => void run(() => post("/select-documents", { documents: selectedKinds }))}
          >
            {text.selectAction} <ArrowRight size={16} />
          </button>
        </div>
        {actionError && (
          <p role="alert" className="journey-action-error">
            {actionError}
          </p>
        )}
      </section>,
    );

  const current = projection.current;
  const stepIndex = current
    ? projection.documents.findIndex(({ document }) => document.kind === current.kind) + 1
    : projection.documents.length;
  const isSummary = session.status === "awaiting_submission";
  const retake = (kind: DocumentKind, side: DocumentSide) => void run(() => post(`/documents/${kind}/retake/${side}`));
  return shell(
    <div className="journey-workspace">
      <aside className="journey-rail">
        <h2>
          {text.step} {stepIndex} {text.of} {projection.documents.length}
        </h2>
        <ol>
          {projection.documents.map(({ document, state }, index) => (
            <li key={document.kind} className={state}>
              <span className="journey-rail-index">{state === "completed" ? <Check size={15} /> : index + 1}</span>
              <span>
                <strong>{documentLabels[locale][document.kind]}</strong>
                <small>{document.requiredSides.map((side) => sideLabel(locale, side)).join(" · ")}</small>
              </span>
            </li>
          ))}
        </ol>
        <div className="journey-rail-foot">
          <ShieldCheck size={16} /> {text.secure}
        </div>
      </aside>
      <section className="journey-work-main" aria-live="polite">
        {live === false && <div className="journey-connection-note">{text.unavailable}</div>}
        {actionError && (
          <div role="alert" className="journey-action-error">
            {actionError}
          </div>
        )}
        {projection.phase === "consistency" && !current ? (
          <ConsistencyResult
            report={session.consistency}
            documents={session.documents}
            locale={locale}
            busy={busy}
            onRetake={retake}
          />
        ) : isSummary ? (
          <>
            <div className="journey-page-heading">
              <h1>{text.summaryTitle}</h1>
              <p>{text.summaryDetail}</p>
            </div>
            <ConsistencyResult
              report={session.consistency}
              documents={session.documents}
              locale={locale}
              busy={busy}
              onRetake={retake}
            />
            <div className="journey-summary-list">
              {projection.documents.map(({ document }) => (
                <DocumentResult
                  key={document.kind}
                  document={document}
                  locale={locale}
                  busy={busy}
                  onRetake={(side) => void run(() => post(`/documents/${document.kind}/retake/${side}`))}
                />
              ))}
            </div>
            <div className="journey-submit">
              <button
                type="button"
                className="journey-primary"
                disabled={busy || session.consistency?.blocking}
                onClick={() => void run(() => post("/submit"))}
              >
                {busy ? <LoaderCircle size={16} className="journey-spin" /> : <Check size={16} />} {text.submit}
              </button>
            </div>
          </>
        ) : current?.retakingSide ? (
          <>
            <div className="journey-page-heading">
              <h1>{text.reviewTitle}</h1>
              <p>
                {text.retakeInProgress} — {sideLabel(locale, current.retakingSide)}
              </p>
            </div>
            <DocumentResult
              document={current}
              locale={locale}
              pendingSide={current.retakingSide}
              pendingStage={projection.phase === "processing" ? (current.progress?.stage ?? "ocr_reading") : undefined}
            />
            {projection.phase === "capture" && !session.captureDeviceConnected && (
              <div className="journey-inline-reconnect">
                <p>{text.connectDetail}</p>
                {qr?.image && <Image src={qr.image} alt="QR code" width={160} height={160} unoptimized />}
                <button type="button" className="journey-text-button" onClick={() => void issueQr()}>
                  {text.reconnect}
                </button>
              </div>
            )}
          </>
        ) : projection.phase === "capture" && current ? (
          <CaptureHandoff
            locale={locale}
            session={session}
            document={current}
            nextSide={projection.nextSide}
            qr={qr?.image}
            onNewQr={() => void issueQr()}
          />
        ) : projection.phase === "processing" && current ? (
          <ProcessingView locale={locale} document={current} />
        ) : (projection.phase === "review" ||
            projection.phase === "incomplete" ||
            projection.phase === "consistency") &&
          current ? (
          <>
            <div className="journey-page-heading">
              <h1>
                {projection.phase === "consistency"
                  ? consistencyCopy[locale].title
                  : projection.phase === "incomplete"
                    ? text.missingTitle
                    : text.reviewTitle}
              </h1>
              <p>
                {projection.phase === "consistency"
                  ? consistencyCopy[locale].detail
                  : projection.phase === "incomplete"
                    ? text.missingDetail
                    : text.reviewDetail}
              </p>
            </div>
            <DocumentResult
              document={current}
              locale={locale}
              busy={busy}
              onRetake={(side) => void run(() => post(`/documents/${current.kind}/retake/${side}`))}
              onConfirm={
                projection.phase === "review"
                  ? () => void run(() => post(`/documents/${current.kind}/confirm`))
                  : undefined
              }
            />
          </>
        ) : (
          <div className="journey-centered">
            <LoaderCircle className="journey-spin" size={25} /> {text.loading}
          </div>
        )}
      </section>
    </div>,
  );
}

function CaptureHandoff({
  locale,
  session,
  document,
  nextSide,
  qr,
  onNewQr,
}: {
  locale: Locale;
  session: PublicSession;
  document: NonNullable<PublicSession["documents"][DocumentKind]>;
  nextSide?: DocumentSide;
  qr?: string;
  onNewQr: () => void;
}) {
  const text = journeyCopy[locale];
  return (
    <div className="journey-handoff">
      <div className="journey-page-heading">
        <span className="journey-live-state">
          <span /> {session.captureDeviceConnected ? text.connected : text.waitingPhone}
        </span>
        <h1>{text.connectTitle}</h1>
        <p>{session.captureDeviceConnected ? text.pairedDetail : text.connectDetail}</p>
      </div>
      {recaptureReason(locale, session.reasonCode) && (
        <div className="journey-alert" role="alert">
          <TriangleAlert size={18} />
          <p>{recaptureReason(locale, session.reasonCode)}</p>
        </div>
      )}
      <div className="journey-handoff-grid">
        <div className="journey-qr-panel">
          {qr ? (
            <Image src={qr} alt="QR code" width={220} height={220} unoptimized />
          ) : (
            <QrCode size={72} aria-hidden="true" />
          )}
          <button type="button" className="journey-text-button" onClick={onNewQr}>
            {text.reconnect}
          </button>
        </div>
        <div className="journey-capture-status">
          <Smartphone size={25} />
          <h2>{documentLabels[locale][document.kind]}</h2>
          <p>
            {text.cameraTask}: {nextSide ? sideLabel(locale, nextSide) : ""}
          </p>
          {document.status === "processing" && nextSide && (
            <p className="journey-background-reading">
              <LoaderCircle size={16} className="journey-spin" aria-hidden="true" />
              {consistencyCopy[locale].background}
            </p>
          )}
          <ol>
            {document.requiredSides.map((side) => (
              <li key={side} className={document.captures[side] ? "done" : side === nextSide ? "active" : "pending"}>
                {document.captures[side] ? <Check size={17} /> : <Circle size={17} />}
                <span>{sideLabel(locale, side)}</span>
                <small>{document.captures[side] ? text.received : text.waiting}</small>
              </li>
            ))}
          </ol>
        </div>
      </div>
      {Object.keys(document.sideFields ?? {}).length > 0 && (
        <div className="journey-progressive-result">
          <DocumentResult document={document} locale={locale} />
        </div>
      )}
    </div>
  );
}

function ProcessingView({
  locale,
  document,
}: {
  locale: Locale;
  document: NonNullable<PublicSession["documents"][DocumentKind]>;
}) {
  const text = journeyCopy[locale];
  const active = stages.indexOf(document.progress?.stage ?? "ocr_reading");
  return (
    <div className="journey-processing">
      <div className="journey-page-heading">
        <h1>{text.processingTitle}</h1>
        <p>{text.processingDetail}</p>
      </div>
      <h2>{documentLabels[locale][document.kind]}</h2>
      <ol className="journey-process-steps">
        {stages.map((stage, index) => (
          <li key={stage} className={index < active ? "done" : index === active ? "active" : "pending"}>
            {index < active ? (
              <Check size={18} />
            ) : index === active ? (
              <LoaderCircle size={18} className="journey-spin" />
            ) : (
              <Circle size={18} />
            )}
            <span>
              {text.stage[stage]}
              {index === active && document.progress?.state === "retrying" && <small>{text.retrying}</small>}
            </span>
          </li>
        ))}
      </ol>
      {Object.keys(document.sideFields ?? {}).length > 0 && (
        <div className="journey-progressive-result">
          <DocumentResult document={document} locale={locale} />
        </div>
      )}
    </div>
  );
}

const images = [
  "user-scene-1-cutout.png",
  "user-scene-2-cutout.png",
  "user-scene-3-cutout.png",
  "user-scene-4-cutout.png",
  "user-scene-5-cutout.png",
];

export function ImageCarousel() {
  const [index, setIndex] = useState(0);
  const [reducedMotion, setReducedMotion] = useState(false);
  useEffect(() => {
    const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReducedMotion(preference.matches);
    update();
    preference.addEventListener("change", update);
    return () => preference.removeEventListener("change", update);
  }, []);
  useEffect(() => {
    if (reducedMotion) return;
    const timer = window.setInterval(() => setIndex((current) => (current + 1) % images.length), 5_000);
    return () => window.clearInterval(timer);
  }, [reducedMotion]);
  return (
    <div className="journey-carousel">
      {images.map((name, item) => (
        <Image
          key={name}
          src={`/journey/${name}`}
          alt=""
          fill
          sizes="(max-width: 880px) 100vw, 60vw"
          loading={item === 0 ? "eager" : "lazy"}
          className={index === item ? "active" : ""}
          aria-hidden={index !== item}
        />
      ))}
    </div>
  );
}
