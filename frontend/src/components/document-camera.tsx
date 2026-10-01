"use client";

import { ArrowLeft, Check, Flashlight, FlashlightOff, LoaderCircle, RotateCcw, TriangleAlert } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  frameCropRegion,
  grabAnalysisFrame,
  grabBurst,
  guideRegion,
  openDocumentCamera,
  setTorch,
  stopStream,
  type PhotoGuide,
} from "@/lib/camera";
import { cameraCopy, hintCopy } from "@/lib/capture-copy";
import { acquireAnalyzer, type CaptureResult, type QualityAnalyzer } from "@/lib/local-quality";
import { type CaptureHint, type FrameAnalysis, formatForDocument, type QualityProfile } from "@/lib/quality-core";
import type { Locale } from "@/lib/types";
import { CalibrationHud } from "./calibration-hud";
import "./document-camera.css";

export type CaptureTrigger = "auto" | "manual" | "remote";
export type DocumentCapture = { photo: Blob; result: CaptureResult; trigger: CaptureTrigger };
export type FrameTelemetry = {
  analysis: FrameAnalysis;
  stablePasses: number;
  video: HTMLVideoElement;
  camera: { width: number; height: number; label: string; torch: boolean };
};

type Phase = "starting" | "live" | "capturing" | "review" | "sending" | "failed";
const MIN_AUTO_CAPTURE_HOLD_MS = 5_000;

type Props = {
  locale: Locale;
  profile: QualityProfile;
  documentKind: string;
  documentLabel: string;
  sideLabel: string;
  attemptsRemaining?: number;
  /** Localised server rejection; shown on the review sheet with a retake action. */
  serverError?: string | null;
  serverRetryable?: boolean;
  variant?: "onboarding" | "calibration";
  /** Calibration keeps the live feed running; captures are explicitly triggered from the workstation. */
  autoCapture?: boolean;
  /** Remote trigger from the calibration workstation; a new `at` value fires it once. */
  command?: { command: "capture" | "torch"; at: string };
  onCapture: (capture: DocumentCapture) => Promise<void>;
  onFrame?: (telemetry: FrameTelemetry) => void;
  onRetake?: () => void;
  onBack?: () => void;
  onSimulate?: () => Promise<void>;
};

/**
 * Full-screen document camera. Every live frame is measured with the shared quality
 * core; the photo is taken automatically once the document stays acceptable for a few frames, and
 * the sharpest frame of a short full-resolution burst is kept. One instruction is shown at a time.
 */
export function DocumentCamera({
  locale,
  profile,
  documentKind,
  documentLabel,
  sideLabel,
  attemptsRemaining,
  serverError,
  serverRetryable = false,
  variant = "onboarding",
  autoCapture,
  command,
  onCapture,
  onFrame,
  onRetake,
  onBack,
  onSimulate,
}: Props) {
  const text = cameraCopy[locale];
  const video = useRef<HTMLVideoElement>(null);
  const guide = useRef<HTMLDivElement>(null);
  const track = useRef<MediaStreamTrack | undefined>(undefined);
  const analyzer = useRef<QualityAnalyzer | undefined>(undefined);
  const stablePasses = useRef(0);
  const stableSince = useRef<number | undefined>(undefined);
  const phaseRef = useRef<Phase>("starting");
  const profileRef = useRef(profile);
  const onFrameRef = useRef(onFrame);
  const pendingHint = useRef<{ hint: CaptureHint; count: number }>({ hint: "find_document", count: 0 });
  const [phase, setPhaseState] = useState<Phase>("starting");
  const [cameraRevision, setCameraRevision] = useState(0);
  const [hint, setHint] = useState<CaptureHint>("find_document");
  const [passing, setPassing] = useState(false);
  const [progress, setProgress] = useState(0);
  const [failure, setFailure] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [analyzerDown, setAnalyzerDown] = useState(false);
  const [torchAvailable, setTorchAvailable] = useState(false);
  const [torchOn, setTorchOn] = useState(false);
  const [camera, setCamera] = useState({ width: 0, height: 0, label: "" });
  const [review, setReview] = useState<{ capture: DocumentCapture; previewUrl: string }>();
  const [flash, setFlash] = useState(0);
  const [debug, setDebug] = useState<FrameAnalysis>();
  const analysisFailures = useRef(0);
  const format = useMemo(() => formatForDocument(documentKind), [documentKind]);

  profileRef.current = profile;
  onFrameRef.current = onFrame;
  const setPhase = useCallback((next: Phase) => {
    phaseRef.current = next;
    setPhaseState(next);
  }, []);

  // Camera and analyser lifetime.
  useEffect(() => {
    void cameraRevision;
    let alive = true;
    const { analyzer: worker, release } = acquireAnalyzer();
    analyzer.current = worker;
    worker.ready.catch((error) => {
      if (!alive) return;
      console.warn("Quality analyser failed to start", error);
      setAnalyzerDown(true);
    });
    openDocumentCamera(profileRef.current.capture.idealVideoWidth)
      .then(async (session) => {
        if (!alive) return stopStream(session.stream);
        track.current = session.track;
        setTorchAvailable(session.torch);
        const element = video.current;
        if (!element) return stopStream(session.stream);
        element.srcObject = session.stream;
        await element.play().catch(() => undefined);
        setCamera({ width: element.videoWidth, height: element.videoHeight, label: session.label });
        await worker.ready.catch(() => undefined);
        if (alive) setPhase("live");
      })
      .catch((error: unknown) => {
        if (!alive) return;
        const denied = error instanceof DOMException && ["NotAllowedError", "SecurityError"].includes(error.name);
        setFailure(denied ? text.cameraDenied : text.cameraFailed);
        setPhase("failed");
      });
    return () => {
      alive = false;
      stopStream(video.current?.srcObject as MediaStream | null);
      release();
    };
  }, [cameraRevision, setPhase, text.cameraDenied, text.cameraFailed]);

  const capture = useCallback(
    async (trigger: CaptureTrigger) => {
      if (variant === "onboarding" && (trigger !== "auto" || analyzerDown)) return;
      const element = video.current;
      const frame = guide.current;
      const worker = analyzer.current;
      if (!element || !frame || !worker || phaseRef.current !== "live") return;
      setPhase("capturing");
      setFlash((value) => value + 1);
      navigator.vibrate?.(25);
      const current = profileRef.current;
      try {
        const crop = guideRegion(element, frame);
        const photoGuide: PhotoGuide = {
          guide: crop,
          viewportWidth: element.clientWidth || element.videoWidth,
          viewportHeight: element.clientHeight || element.videoHeight,
        };
        const frames = await grabBurst(element, track.current, {
          frames: current.capture.burstFrames,
          stillCapture: current.capture.stillCapture,
          guide: crop,
          deferCrop: true,
        });
        let result: CaptureResult;
        try {
          result = analyzerDown
            ? await fallbackCapture(frames, current.capture.jpegQuality, photoGuide)
            : await worker.analyzeCapture(frames, { profile: current, format, photoGuide });
        } catch (error) {
          // A failed local analyser must not strand the user; the server remains authoritative.
          console.warn("Final photo analysis unavailable", error);
          setAnalyzerDown(true);
          if (variant === "onboarding") {
            setPhase("live");
            return;
          }
          const fallbackFrames = await grabBurst(element, track.current, {
            frames: 1,
            stillCapture: false,
            guide: crop,
          });
          result = await fallbackCapture(fallbackFrames, current.capture.jpegQuality);
        }
        const next: DocumentCapture = { photo: result.photo, result, trigger };
        if (variant === "calibration") {
          setPhase("sending");
          await onCapture(next);
          setNotice(text.sent);
          stablePasses.current = 0;
          stableSince.current = undefined;
          setProgress(0);
          setPhase("live");
          return;
        }
        setReview({ capture: next, previewUrl: URL.createObjectURL(result.preview ?? result.photo) });
        stopStream(element.srcObject as MediaStream | null);
        element.srcObject = null;
        track.current = undefined;
        setTorchOn(false);
        setTorchAvailable(false);
        if ((variant === "onboarding" || current.mode === "enforce") && !analyzerDown && !result.analysis.evaluation.passed) {
          setPhase("review");
          return;
        }
        setPhase("sending");
        try {
          await onCapture(next);
        } catch {
          setNotice(text.cameraFailed);
        } finally {
          if ((phaseRef.current as Phase) === "sending") setPhase("review");
        }
      } catch (error) {
        console.warn("Document capture failed", error);
        setNotice(
          variant === "calibration"
            ? error instanceof Error && error.message.startsWith("Envoi de la photo")
              ? error.message
              : "Photo non capturée. Réessayez et vérifiez que la caméra reste active."
            : text.cameraFailed,
        );
        stablePasses.current = 0;
        stableSince.current = undefined;
        setPhase("live");
      }
    },
    [analyzerDown, format, onCapture, setPhase, text.cameraFailed, text.sent, variant],
  );

  // Live analysis loop: the next frame is scheduled only after the previous one is measured.
  useEffect(() => {
    if (phase !== "live" || analyzerDown) return;
    let alive = true;
    let timer: number | undefined;
    const tick = async () => {
      const element = video.current;
      const worker = analyzer.current;
      if (!alive || !element || !worker || element.videoWidth === 0) {
        timer = window.setTimeout(tick, 120);
        return;
      }
      const current = profileRef.current;
      try {
        const frame = grabAnalysisFrame(element, current.capture.analysisSize);
        const analysis = await worker.analyzeFrame(frame.image, {
          profile: current,
          format,
          sourceScale: frame.sourceScale,
        });
        if (!alive || phaseRef.current !== "live") return;
        const ok = analysis.evaluation.passed;
        stablePasses.current = ok ? stablePasses.current + 1 : 0;
        stableSince.current = ok ? (stableSince.current ?? performance.now()) : undefined;
        const stableMs = stableSince.current === undefined ? 0 : performance.now() - stableSince.current;
        const holdMs = variant === "onboarding" ? MIN_AUTO_CAPTURE_HOLD_MS : 0;
        setPassing(ok);
        setProgress(Math.min(1, holdMs ? stableMs / holdMs : stablePasses.current / current.capture.stableFrames));
        // A new instruction must hold for two frames before replacing the visible one.
        const next = analysis.evaluation.hint;
        pendingHint.current =
          pendingHint.current.hint === next
            ? { hint: next, count: pendingHint.current.count + 1 }
            : { hint: next, count: 1 };
        if (pendingHint.current.count >= 2 || next === "ready") setHint(next);
        if (variant === "calibration") setDebug(analysis);
        onFrameRef.current?.({
          analysis,
          stablePasses: stablePasses.current,
          video: element,
          camera: {
            width: element.videoWidth,
            height: element.videoHeight,
            label: track.current?.label ?? "",
            torch: torchOn,
          },
        });
        analysisFailures.current = 0;
        if (
          ok &&
          (variant === "onboarding" || (autoCapture ?? current.capture.autoCapture)) &&
          stablePasses.current >= current.capture.stableFrames &&
          stableMs >= holdMs
        ) {
          void capture("auto");
          return;
        }
      } catch (error) {
        // Stop automatic capture if quality cannot be measured.
        console.warn("Live quality analysis unavailable", error);
        analysisFailures.current += 1;
        if (analysisFailures.current >= 3) {
          if (alive) setAnalyzerDown(true);
          return;
        }
      }
      if (alive) timer = window.setTimeout(tick, current.capture.samplingIntervalMs);
    };
    void tick();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [analyzerDown, autoCapture, capture, format, phase, torchOn, variant]);

  useEffect(() => {
    if (!notice) return;
    const timeout = window.setTimeout(() => setNotice(undefined), variant === "calibration" ? 6_000 : 2_400);
    return () => clearTimeout(timeout);
  }, [notice, variant]);

  const toggleTorch = useCallback(async () => {
    if (!track.current) return;
    try {
      await setTorch(track.current, !torchOn);
      setTorchOn(!torchOn);
    } catch {
      setTorchAvailable(false);
    }
  }, [torchOn]);

  const lastCommand = useRef<string | undefined>(command?.at);
  useEffect(() => {
    if (!command || command.at === lastCommand.current) return;
    lastCommand.current = command.at;
    if (command.command === "capture" && variant !== "onboarding") void capture("remote");
    else if (command.command === "torch") void toggleTorch();
  }, [capture, command, toggleTorch, variant]);

  useEffect(() => () => review && URL.revokeObjectURL(review.previewUrl), [review]);

  const retake = () => {
    if (review) URL.revokeObjectURL(review.previewUrl);
    setReview(undefined);
    setAnalyzerDown(false);
    analysisFailures.current = 0;
    stablePasses.current = 0;
    stableSince.current = undefined;
    setProgress(0);
    onRetake?.();
    setPhase("starting");
    setCameraRevision((value) => value + 1);
  };

  const send = async () => {
    if (!review) return;
    setPhase("sending");
    try {
      await onCapture(review.capture);
    } finally {
      if (phaseRef.current === "sending") setPhase("review");
    }
  };

  const state = passing ? "ready" : "adjusting";
  const guidance = analyzerDown ? text.analyzerFailed : hintCopy[locale][hint];
  const reviewEvaluation = review?.capture.result.analysis.evaluation;
  const reviewAdmissible = variant === "onboarding" ? Boolean(reviewEvaluation?.passed) : profile.mode !== "enforce" || analyzerDown || Boolean(reviewEvaluation?.passed);
  const reviewPassed = reviewEvaluation?.flawless ?? false;
  // A usable photo with a non-blocking warning names the one thing that would improve it.
  const reviewMessage =
    serverError ??
    (reviewPassed || !reviewEvaluation || reviewEvaluation.hint === "ready"
      ? text.reviewReady
      : hintCopy[locale][reviewEvaluation.hint]);

  return (
    <section
      className={`dc dc-${variant} dc-${state} ${format.id === "id-3" ? "dc-passport" : ""} ${phase === "review" || phase === "sending" ? "dc-reviewing" : ""}`}
      style={{ "--ratio": format.aspectRatio } as React.CSSProperties}
      dir={locale === "ar" ? "rtl" : "ltr"}
      aria-label={`${documentLabel} · ${sideLabel}`}
    >
      <div className="dc-viewport">
        <video ref={video} autoPlay playsInline muted />
        <div ref={guide} className="dc-guide" aria-hidden="true">
          <i />
          <i />
          <i />
          <i />
          {format.id === "id-3" && <span className="dc-passport-mrz" />}
        </div>
        {flash > 0 && <div key={flash} className="dc-flash" aria-hidden="true" />}

        <header className="dc-top">
          {onBack ? (
            <button type="button" className="dc-icon-button" onClick={onBack} aria-label={text.back}>
              <ArrowLeft size={20} className="dc-flip-rtl" />
            </button>
          ) : (
            <span />
          )}
          <div className="dc-title">
            <strong>{documentLabel}</strong>
            <span>{sideLabel}</span>
          </div>
          {torchAvailable ? (
            <button
              type="button"
              className={`dc-icon-button ${torchOn ? "active" : ""}`}
              onClick={toggleTorch}
              aria-pressed={torchOn}
              aria-label={text.torch}
            >
              {torchOn ? <Flashlight size={19} /> : <FlashlightOff size={19} />}
            </button>
          ) : (
            <span />
          )}
        </header>

        {phase !== "failed" && phase !== "review" && phase !== "sending" && (
          <output className="dc-guidance" aria-live="polite">
            <span className="dc-guidance-pill">
              {phase === "starting" || phase === "capturing" ? (
                <LoaderCircle size={16} className="spin-icon" />
              ) : state === "ready" ? (
                <Check size={16} />
              ) : null}
              {phase === "starting" ? text.starting : phase === "capturing" ? text.checking : guidance}
            </span>
            {notice && <span className="dc-notice">{notice}</span>}
          </output>
        )}

        {variant === "calibration" && debug && phase === "live" && (
          <CalibrationHud analysis={debug} camera={camera} profile={profile} stablePasses={stablePasses.current} />
        )}

        {variant === "onboarding" && !analyzerDown && ["starting", "live", "capturing"].includes(phase) && (
          <div
            className="dc-capture-progress"
            role="progressbar"
            aria-label={text.auto}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(progress * 100)}
            style={{ "--progress": progress } as React.CSSProperties}
          >
            <svg viewBox="0 0 80 80" aria-hidden="true">
              <circle className="dc-ring-track" cx="40" cy="40" r="37" />
              <circle className="dc-ring-progress" cx="40" cy="40" r="37" pathLength="1" />
            </svg>
            <span />
          </div>
        )}

        {variant !== "onboarding" && <footer className="dc-bottom">
          <div className="dc-bottom-side">
            {attemptsRemaining !== undefined && <small>{text.attempts(attemptsRemaining)}</small>}
          </div>
          <button
            type="button"
            className="dc-shutter"
            onClick={() => capture("manual")}
            disabled={phase !== "live"}
            aria-label={text.manual}
            style={{ "--progress": progress } as React.CSSProperties}
          >
            <svg viewBox="0 0 80 80" aria-hidden="true">
              <circle className="dc-ring-track" cx="40" cy="40" r="37" />
              <circle className="dc-ring-progress" cx="40" cy="40" r="37" pathLength="1" />
            </svg>
            <span />
          </button>
          <div className="dc-bottom-side end">
            {(autoCapture ?? profile.capture.autoCapture) && <small>{text.auto}</small>}
            {onSimulate && (
              <button type="button" className="dc-link" onClick={() => void onSimulate()}>
                {text.simulate}
              </button>
            )}
          </div>
        </footer>}
        {variant === "onboarding" && analyzerDown && phase === "live" && (
          <div className="dc-bottom">
            <button type="button" className="button button-secondary" onClick={retake}>
              <RotateCcw size={16} /> {text.retake}
            </button>
          </div>
        )}

        {phase === "failed" && (
          <div className="dc-failure" role="alert">
            <TriangleAlert size={28} />
            <p>{failure}</p>
            <button type="button" className="button button-secondary" onClick={() => window.location.reload()}>
              <RotateCcw size={16} /> {text.retake}
            </button>
          </div>
        )}
      </div>

      {review && (phase === "review" || phase === "sending") && (
        <div className="dc-review" role="dialog" aria-modal="true" aria-label={text.reviewTitle}>
          <div className="dc-review-card">
            <span className={`dc-review-status ${serverError ? "error" : reviewPassed ? "ok" : "warn"}`}>
              {serverError ? (
                <TriangleAlert size={15} />
              ) : reviewPassed ? (
                <Check size={15} />
              ) : (
                <TriangleAlert size={15} />
              )}
              {phase === "sending" ? text.checking : reviewMessage}
            </span>
            {/* biome-ignore lint/performance/noImgElement: object URL of the rectified capture. */}
            <img src={review.previewUrl} alt={text.reviewTitle} />
            <div className="dc-review-meta">
              <strong>{documentLabel}</strong>
              <span>{sideLabel}</span>
            </div>
            <div className="dc-review-actions">
              <button type="button" className="button button-secondary" onClick={retake} disabled={phase === "sending"}>
                <RotateCcw size={16} /> {text.retake}
              </button>
              {(!serverError || serverRetryable) && reviewAdmissible && (
                <button type="button" className="button button-primary" onClick={send} disabled={phase === "sending"}>
                  {phase === "sending" ? <LoaderCircle size={16} className="spin-icon" /> : <Check size={16} />}
                  {phase === "sending" ? text.sending : text.usePhoto}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

/** Without the analyser, the burst's last frame is sent as-is and the server decides. */
async function fallbackCapture(
  frames: ImageBitmap[],
  quality: number,
  photoGuide?: PhotoGuide,
): Promise<CaptureResult> {
  const frame = frames.at(-1);
  if (!frame) throw new Error("No frame captured");
  const canvas = document.createElement("canvas");
  const region = photoGuide
    ? frameCropRegion(frame.width, frame.height, photoGuide.viewportWidth, photoGuide.viewportHeight, photoGuide.guide)
    : { x: 0, y: 0, width: frame.width, height: frame.height };
  canvas.width = region.width;
  canvas.height = region.height;
  canvas
    .getContext("2d")
    ?.drawImage(frame, region.x, region.y, region.width, region.height, 0, 0, region.width, region.height);
  for (const item of frames) item.close();
  const photo = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("Capture failed"))), "image/jpeg", quality),
  );
  return {
    photo,
    width: canvas.width,
    height: canvas.height,
    frameIndex: frames.length - 1,
    candidates: [],
    analysis: {
      quad: null,
      metrics: {},
      evaluation: { passed: true, flawless: false, checks: [], hint: "ready", score: 0 },
      durationMs: { detection: 0, measurement: 0, total: 0 },
    },
  };
}
