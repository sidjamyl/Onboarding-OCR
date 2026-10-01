"use client";

import {
  Aperture,
  Camera,
  Copy,
  Download,
  ExternalLink,
  Flashlight,
  LoaderCircle,
  Radio,
  RotateCcw,
  Save,
  SlidersHorizontal,
  Wand2,
} from "lucide-react";
import QRCode from "qrcode";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/button";
import { normalizeApiUrl } from "@/lib/api-url";
import type { ClientFrameReport } from "@/lib/calibration";
import { hintCopy } from "@/lib/capture-copy";
import { documentLabels } from "@/lib/i18n";
import { type CaptureHint, defaultQualityProfile, type QualityProfile, type Severity } from "@/lib/quality-core";
import {
  type CheckDescriptor,
  captureParameters,
  checkCatalog,
  checkLabels,
  type NumericParameter,
  type Parameter,
  preprocessParameters,
  readParameter,
  writeParameter,
} from "@/lib/quality-parameters";
import type { QualityReport } from "@/lib/types";
import "./cockpit.css";

const apiUrl = normalizeApiUrl(process.env.NEXT_PUBLIC_ONBOARDING_API_URL ?? "/api/onboarding");

type Sample = { at: string; client?: ClientFrameReport };
type Capture = {
  at: string;
  trigger: "auto" | "manual" | "remote";
  client?: ClientFrameReport & {
    burst?: Array<{ score: number; sharpness: number; passed: boolean }>;
    frameIndex?: number;
  };
  server: QualityReport;
  ocr?: { width: number; height: number; steps: Array<{ step: string; durationMs: number; detail?: string }> };
  original: { width: number; height: number; bytes: number };
};
type Calibration = {
  id: string;
  documentKind: string;
  templateId?: string;
  createdAt: string;
  expiresAt: string;
  profile: QualityProfile;
  samples: Sample[];
  latestSample?: Sample;
  latestCapture?: Capture;
  captures: number;
  phone: { connectedAt?: string; lastSeenAt?: string; userAgent?: string };
};
type OcrTest = {
  response?: Record<string, unknown>;
  durationMs?: number;
  documentType?: string;
  imageVariant?: string;
  error?: string;
  detail?: string;
  upstreamStatus?: number;
};
type OrbReport = QualityReport & {
  templateMatched: boolean;
  templateId?: string;
  alignmentImage?: { dataUrl: string; width: number; height: number };
};
type OrbTest = {
  captureAt: string;
  templateId: string;
  report?: OrbReport;
  error?: string;
};
type OcrSide = "front" | "back" | "single";

export function LiveCalibrationPanel({ onApply }: { onApply: (profile: QualityProfile) => Promise<boolean> }) {
  const [calibration, setCalibration] = useState<Calibration>();
  const [profile, setProfile] = useState<QualityProfile>();
  const [baseUrl, setBaseUrl] = useState("");
  const [qrCode, setQrCode] = useState("");
  const [ocrTest, setOcrTest] = useState<OcrTest>();
  const [orbTest, setOrbTest] = useState<OrbTest>();
  const [ocrSide, setOcrSide] = useState<OcrSide>("front");
  const [status, setStatus] = useState("Créez une session pour relier le téléphone.");
  const [busy, setBusy] = useState<"apply" | "reprocess" | "capture" | "ocr" | "orb">();
  const [now, setNow] = useState(Date.now());
  const pushTimer = useRef<number | undefined>(undefined);
  const reprocessTimer = useRef<number | undefined>(undefined);
  const orbRun = useRef(0);

  useEffect(() => {
    if (window.location.protocol === "https:") setBaseUrl(window.location.origin);
    const clock = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(clock);
  }, []);

  const calibrationId = calibration?.id;
  useEffect(() => {
    if (!calibrationId) return;
    const stream = new EventSource(`${apiUrl}/dev/quality/calibrations/${calibrationId}/events`);
    const merge = (patch: Partial<Calibration>) =>
      setCalibration((current) => (current ? { ...current, ...patch } : current));
    stream.addEventListener("snapshot", (event) => merge(JSON.parse(event.data)));
    stream.addEventListener("phone", (event) => merge({ phone: JSON.parse(event.data) }));
    stream.addEventListener("capture", (event) => {
      const capture = JSON.parse(event.data) as Capture;
      orbRun.current += 1;
      setOrbTest(undefined);
      setCalibration((current) => (current ? { ...current, latestCapture: capture } : current));
      setBusy((value) => (value === "capture" || value === "reprocess" ? undefined : value));
      setOcrTest(undefined);
      setStatus(`Photo analysée par le serveur en ${Math.round(capture.server.durationMs)} ms`);
    });
    stream.addEventListener("sample", (event) => {
      const sample = JSON.parse(event.data) as Sample;
      setCalibration((current) =>
        current
          ? {
              ...current,
              samples: [...current.samples, sample].slice(-120),
              latestSample: sample,
              phone: { ...current.phone, lastSeenAt: sample.at },
            }
          : current,
      );
    });
    stream.onerror = () => setStatus("Connexion temps réel en cours de reprise…");
    return () => stream.close();
  }, [calibrationId]);

  const shareableBaseUrl = /^https:\/\/[^/]+$/i.test(baseUrl) ? baseUrl : "";
  const phoneUrl = useMemo(
    () => (calibrationId && shareableBaseUrl ? `${shareableBaseUrl}/dev/quality-lab/capture/${calibrationId}` : ""),
    [calibrationId, shareableBaseUrl],
  );
  useEffect(() => {
    if (!phoneUrl) return setQrCode("");
    void QRCode.toDataURL(phoneUrl, { margin: 1, width: 240, color: { dark: "#111114", light: "#ffffff" } }).then(
      setQrCode,
    );
  }, [phoneUrl]);

  const create = async (documentKind = "dz-id") => {
    setStatus("Création de la session…");
    const response = await fetch(`${apiUrl}/dev/quality/calibrations`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        documentKind,
        templateId: documentKind === "dz-passport" ? documentKind : `${documentKind}-front`,
      }),
    });
    const payload = await response.json();
    if (!response.ok) return setStatus(payload.error ?? "La session n’a pas pu être créée.");
    setCalibration(payload.calibration);
    setProfile(payload.calibration.profile);
    setStatus("Session prête. Scannez le QR code avec le téléphone.");
  };

  /** Every edit reaches the phone within a quarter of a second; no “send” button to forget. */
  const edit = (next: QualityProfile, options: { reprocess?: boolean } = {}) => {
    setProfile(next);
    orbRun.current += 1;
    setOrbTest(undefined);
    if (!calibrationId) return;
    window.clearTimeout(pushTimer.current);
    pushTimer.current = window.setTimeout(async () => {
      const response = await fetch(`${apiUrl}/dev/quality/calibrations/${calibrationId}/profile`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(next),
      });
      setStatus(response.ok ? "Réglages appliqués en direct sur le téléphone" : "Réglage refusé par le serveur");
    }, 250);
    if (options.reprocess && calibration?.latestCapture) {
      window.clearTimeout(reprocessTimer.current);
      reprocessTimer.current = window.setTimeout(() => reprocess(next), 450);
    }
  };

  const reprocess = async (next = profile) => {
    if (!calibrationId || !next) return;
    setBusy("reprocess");
    const response = await fetch(`${apiUrl}/dev/quality/calibrations/${calibrationId}/reprocess`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(next),
    });
    if (!response.ok) {
      setBusy(undefined);
      setStatus("Aucune photo à re-traiter");
    }
  };

  const testOcr = async (imageVariant: "ocr" | "original") => {
    if (!calibrationId || busy === "ocr") return;
    setBusy("ocr");
    setOcrTest(undefined);
    try {
      const response = await fetch(`${apiUrl}/dev/quality/calibrations/${calibrationId}/ocr-test`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ side: ocrSide, imageVariant }),
        signal: AbortSignal.timeout(240_000),
      });
      const payload = await response.json();
      setOcrTest(payload);
      if (!response.ok) {
        setStatus(`Test OCR impossible : ${payload.error ?? response.status}`);
        return;
      }
      setStatus(`OCR terminé en ${Math.round(payload.durationMs)} ms`);
    } catch {
      setOcrTest({
        error: "ocr_unreachable",
        detail: "Impossible de joindre le service OCR. Vérifiez la connexion puis relancez le test.",
      });
      setStatus("Le service OCR ne répond pas.");
    } finally {
      setBusy(undefined);
    }
  };

  const testOrb = async () => {
    const capture = calibration?.latestCapture;
    const templateId = calibration?.templateId;
    if (!calibrationId || !capture || !templateId || !profile || busy) return;
    const run = ++orbRun.current;
    setBusy("orb");
    setOrbTest(undefined);
    setStatus("Alignement ORB en cours sur la dernière photo…");
    try {
      const photo = await fetch(
        `${apiUrl}/dev/quality/calibrations/${calibrationId}/capture/original?v=${Date.parse(capture.at)}`,
      );
      if (!photo.ok) throw new Error("La dernière photo n’est plus disponible.");
      const body = new FormData();
      body.set("file", await photo.blob(), "capture.jpg");
      body.set("profile", JSON.stringify(profile));
      body.set("documentKind", calibration.documentKind);
      body.set("templateId", templateId);
      body.set("prepare", "false");
      body.set("previewAlignment", "true");
      const response = await fetch(`${apiUrl}/dev/quality/analyze`, { method: "POST", body });
      if (!response.ok) throw new Error(`Analyse refusée par le serveur (${response.status}).`);
      const report = (await response.json()) as OrbReport;
      if (run !== orbRun.current) return;
      setOrbTest({ captureAt: capture.at, templateId, report });
      setStatus(
        report.templateMatched
          ? "ORB : gabarit aligné sur la photo."
          : "ORB : aucun alignement fiable avec ce gabarit.",
      );
    } catch (error) {
      if (run !== orbRun.current) return;
      const message = error instanceof Error ? error.message : "Test ORB impossible.";
      setOrbTest({ captureAt: capture.at, templateId, error: message });
      setStatus(message);
    } finally {
      setBusy((value) => (value === "orb" ? undefined : value));
    }
  };

  const sendCommand = async (command: "capture" | "torch") => {
    if (!calibrationId) return;
    if (command === "capture") setBusy("capture");
    await fetch(`${apiUrl}/dev/quality/calibrations/${calibrationId}/commands`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ command }),
    });
    setStatus(command === "capture" ? "Photo demandée au téléphone…" : "Torche basculée sur le téléphone");
    if (command === "capture")
      window.setTimeout(() => setBusy((value) => (value === "capture" ? undefined : value)), 8_000);
  };

  const changeDocument = async (
    documentKind: string,
    templateId = documentKind === "dz-passport" ? documentKind : `${documentKind}-front`,
  ) => {
    if (!calibrationId) return;
    orbRun.current += 1;
    setOrbTest(undefined);
    setOcrSide(documentKind === "dz-passport" ? "single" : "front");
    await fetch(`${apiUrl}/dev/quality/calibrations/${calibrationId}/document`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ documentKind, templateId }),
    });
  };

  const apply = async () => {
    if (!profile) return;
    setBusy("apply");
    try {
      const applied = await onApply(profile);
      setStatus(
        applied ? "Profil appliqué au parcours client : les prochaines sessions l’utilisent." : "Profil non appliqué",
      );
    } finally {
      setBusy(undefined);
    }
  };

  const client = calibration?.latestSample?.client;
  const lastSeen = calibration?.phone.lastSeenAt
    ? now - Date.parse(calibration.phone.lastSeenAt)
    : Number.POSITIVE_INFINITY;
  const phoneLive = lastSeen < 5_000;

  return (
    <section className="cockpit" aria-label="Calibration en direct">
      <header className="cockpit-header">
        <div>
          <span className="cockpit-eyebrow">
            <Radio size={13} /> Calibration en direct
          </span>
          <h2>Réglez la qualité photo avec le vrai téléphone</h2>
          <p>
            Le téléphone exécute le même moteur que le parcours client et que le serveur. Chaque seuil modifié ici
            s’applique immédiatement sur le téléphone.
          </p>
        </div>
        {!calibration ? (
          <Button onClick={() => create()}>
            <Radio size={16} /> Démarrer une session
          </Button>
        ) : (
          <div className="cockpit-toolbar">
            <label className="cockpit-select">
              <span>Document</span>
              <select
                value={calibration.documentKind}
                disabled={busy === "ocr"}
                onChange={(event) => changeDocument(event.target.value)}
              >
                {Object.entries(documentLabels.fr).map(([kind, label]) => (
                  <option key={kind} value={kind}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <label className="cockpit-select">
              <span>Face</span>
              <select
                value={calibration.templateId ?? ""}
                onChange={(event) => changeDocument(calibration.documentKind, event.target.value)}
              >
                <option value="">Sans gabarit</option>
                {calibration.documentKind === "dz-passport" ? (
                  <option value="dz-passport">Passeport</option>
                ) : (
                  <>
                    <option value={`${calibration.documentKind}-front`}>Recto</option>
                    <option value={`${calibration.documentKind}-back`}>Verso</option>
                  </>
                )}
              </select>
            </label>
            <a
              className="button button-secondary button-compact"
              href={`${apiUrl}/dev/quality/calibrations/${calibration.id}/phone-diagnostics`}
              target="_blank"
              rel="noreferrer"
            >
              Signaux bruts
            </a>
            <span className={`cockpit-phone ${phoneLive ? "live" : calibration.phone.connectedAt ? "idle" : ""}`}>
              <i />
              {phoneLive
                ? "Téléphone en direct"
                : calibration.phone.connectedAt
                  ? "Téléphone inactif"
                  : "En attente du téléphone"}
            </span>
            <Button size="compact" variant="secondary" onClick={() => sendCommand("torch")} disabled={!phoneLive}>
              <Flashlight size={15} /> Torche
            </Button>
            <Button
              size="compact"
              onClick={() => sendCommand("capture")}
              disabled={!phoneLive || busy === "capture" || busy === "ocr"}
            >
              {busy === "capture" ? <LoaderCircle size={15} className="spin-icon" /> : <Aperture size={15} />} Prendre
              une photo
            </Button>
          </div>
        )}
      </header>

      {calibration && profile && (
        <div className="cockpit-grid">
          <div className="cockpit-column">
            {!calibration.phone.connectedAt && (
              <PhoneLink baseUrl={baseUrl} setBaseUrl={setBaseUrl} phoneUrl={phoneUrl} qrCode={qrCode} />
            )}
            <LiveView calibrationId={calibration.id} sample={calibration.latestSample} profile={profile} />
            <Timeline samples={calibration.samples} profile={profile} />
            <ParameterGroup
              title="Capture automatique"
              description="Rythme d’analyse, déclenchement et rafale finale."
              parameters={captureParameters}
              profile={profile}
              onChange={(next) => edit(next)}
            />
          </div>

          <div className="cockpit-column">
            <section className="cockpit-card">
              <div className="cockpit-card-head">
                <div>
                  <h3>Contrôles et seuils</h3>
                  <p>
                    Valeur mesurée en direct face au seuil. « Bloque » empêche la capture, « Alerte » l’affiche
                    seulement.
                  </p>
                </div>
                <div className="cockpit-mode">
                  {(
                    [
                      ["off", "Désactivé"],
                      ["observe", "Observer"],
                      ["enforce", "Bloquer"],
                    ] as const
                  ).map(([mode, label]) => (
                    <button
                      type="button"
                      key={mode}
                      className={profile.mode === mode ? "active" : ""}
                      onClick={() => edit({ ...profile, mode })}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
              <div className="cockpit-checks">
                {checkCatalog.map((check) => (
                  <CheckRow
                    key={check.key}
                    check={check}
                    profile={profile}
                    client={client}
                    server={calibration.latestCapture?.server}
                    onChange={(next) => edit(next)}
                  />
                ))}
              </div>
              <div className="cockpit-card-foot">
                <Button size="compact" variant="secondary" onClick={() => edit(structuredClone(defaultQualityProfile))}>
                  <RotateCcw size={14} /> Valeurs par défaut
                </Button>
                <Button
                  size="compact"
                  variant="secondary"
                  onClick={() => downloadJson("quality-profile.json", profile)}
                >
                  <Download size={14} /> Exporter
                </Button>
                <Button size="compact" onClick={apply} disabled={busy === "apply"}>
                  <Save size={14} /> Appliquer au parcours
                </Button>
              </div>
            </section>
          </div>

          <div className="cockpit-column">
            <CapturePanel
              calibrationId={calibration.id}
              capture={calibration.latestCapture}
              templateId={calibration.templateId}
              orbTest={orbTest}
              testingOrb={busy === "orb"}
              onTestOrb={testOrb}
              reprocessing={busy === "reprocess"}
              onReprocess={() => reprocess()}
              testingOcr={busy === "ocr"}
              documentKind={calibration.documentKind}
              ocrSide={ocrSide}
              onOcrSideChange={setOcrSide}
              ocrTest={ocrTest}
              onTestOcr={testOcr}
            />
            <ParameterGroup
              title="Pré-traitement OCR"
              description="Appliqué à la photo validée ; le cadre capturé sans retouche est conservé. Chaque réglage re-traite la dernière photo."
              parameters={preprocessParameters}
              profile={profile}
              onChange={(next) => edit(next, { reprocess: true })}
            />
          </div>
        </div>
      )}
      <output className="cockpit-status" aria-live="polite">
        {status}
      </output>
    </section>
  );
}

function PhoneLink({
  baseUrl,
  setBaseUrl,
  phoneUrl,
  qrCode,
}: {
  baseUrl: string;
  setBaseUrl: (value: string) => void;
  phoneUrl: string;
  qrCode: string;
}) {
  return (
    <section className="cockpit-card cockpit-link">
      <div className="cockpit-qr">
        {qrCode ? (
          // biome-ignore lint/performance/noImgElement: generated QR data URL.
          <img src={qrCode} alt="QR code de la session de calibration" />
        ) : (
          <Camera size={64} strokeWidth={1.2} />
        )}
      </div>
      <div className="cockpit-link-body">
        <h3>Relier le téléphone</h3>
        <p>Scannez le QR code. La caméra exige une adresse HTTPS atteignable depuis le téléphone.</p>
        <label>
          Adresse HTTPS
          <input
            value={baseUrl}
            onChange={(event) => setBaseUrl(event.target.value.replace(/\/$/, ""))}
            placeholder="https://onboarding.votre-domaine"
          />
        </label>
        <div className="cockpit-link-actions">
          <Button
            size="compact"
            variant="secondary"
            disabled={!phoneUrl}
            onClick={() => navigator.clipboard.writeText(phoneUrl)}
          >
            <Copy size={14} /> Copier le lien
          </Button>
          {phoneUrl && (
            <a className="button button-secondary button-compact" href={phoneUrl} target="_blank" rel="noreferrer">
              <ExternalLink size={14} /> Ouvrir
            </a>
          )}
        </div>
      </div>
    </section>
  );
}

function LiveView({
  calibrationId,
  sample,
  profile,
}: {
  calibrationId: string;
  sample?: Sample;
  profile: QualityProfile;
}) {
  const client = sample?.client;
  const [frameUrl, setFrameUrl] = useState<string>();
  const lastFetch = useRef(0);
  useEffect(() => {
    if (!sample || Date.now() - lastFetch.current < 500) return;
    lastFetch.current = Date.now();
    setFrameUrl(`${apiUrl}/dev/quality/calibrations/${calibrationId}/frame?at=${Date.parse(sample.at)}`);
  }, [calibrationId, sample]);
  const progress =
    client?.stablePasses !== undefined ? Math.min(1, client.stablePasses / profile.capture.stableFrames) : 0;
  return (
    <section className="cockpit-card cockpit-live">
      <div className="cockpit-live-frame">
        {frameUrl ? (
          <>
            {/* biome-ignore lint/performance/noImgElement: live frame streamed from the calibration phone. */}
            <img src={frameUrl} alt="Aperçu en direct du téléphone" />
          </>
        ) : (
          <div className="cockpit-empty">
            <Camera size={28} />
            <span>L’image du téléphone apparaîtra ici</span>
          </div>
        )}
        {client && (
          <span className={`cockpit-hint ${client.passed ? "pass" : ""}`}>
            {hintCopy.fr[client.hint as CaptureHint] ?? client.hint}
          </span>
        )}
      </div>
      <dl className="cockpit-kpis">
        <div>
          <dt>Score</dt>
          <dd>{client ? Math.round(client.score * 100) : "—"}</dd>
        </div>
        <div>
          <dt>Stabilité</dt>
          <dd>
            <span className="cockpit-meter">
              <i style={{ width: `${progress * 100}%` }} />
            </span>
          </dd>
        </div>
        <div>
          <dt>Analyse</dt>
          <dd>{client ? `${Math.round(client.durationMs)} ms` : "—"}</dd>
        </div>
        <div>
          <dt>Caméra</dt>
          <dd>{client?.camera ? `${client.camera.width}×${client.camera.height}` : "—"}</dd>
        </div>
      </dl>
    </section>
  );
}

function Timeline({ samples, profile }: { samples: Sample[]; profile: QualityProfile }) {
  const recent = samples.slice(-60);
  const sharpness = recent.map((sample) => sample.client?.metrics?.["image.sharpness"] ?? 0);
  const max = Math.max(profile.image.minSharpnessLive * 3, ...sharpness, 1);
  const line = (values: number[], scale: number) =>
    values
      .map((value, index) => `${(index / Math.max(1, values.length - 1)) * 100},${100 - (value / scale) * 100}`)
      .join(" ");
  const threshold = 100 - (profile.image.minSharpnessLive / max) * 100;
  return (
    <section className="cockpit-card cockpit-timeline">
      <div className="cockpit-card-head">
        <div>
          <h3>Dernières analyses</h3>
          <p>
            <span className="legend score" /> Score · <span className="legend sharp" /> Netteté ·{" "}
            <span className="legend limit" /> Seuil de netteté
          </p>
        </div>
      </div>
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" role="img" aria-label="Évolution du score et de la netteté">
        <line x1="0" x2="100" y1={threshold} y2={threshold} className="limit" />
        <polyline className="sharp" points={line(sharpness, max)} />
        <polyline
          className="score"
          points={line(
            recent.map((sample) => sample.client?.score ?? 0),
            1,
          )}
        />
      </svg>
    </section>
  );
}

function CheckRow({
  check,
  profile,
  client,
  server,
  onChange,
}: {
  check: CheckDescriptor;
  profile: QualityProfile;
  client?: ClientFrameReport;
  server?: QualityReport;
  onChange: (profile: QualityProfile) => void;
}) {
  const severity = profile.severity[check.key];
  const live = client?.checks.find((item) => item.key === check.key);
  const photo = server?.checks.find((item) => item.key === check.key);
  const value = check.metric ? client?.metrics[check.metric] : undefined;
  const photoValue = check.metric ? server?.diagnostics?.metrics?.[check.metric] : undefined;
  const format = (input?: number) => (input === undefined ? "—" : check.format ? check.format(input) : String(input));
  return (
    <div className={`cockpit-check ${severity === "off" ? "disabled" : ""}`}>
      <div className="cockpit-check-head">
        <span className={`cockpit-dot ${live?.status ?? "none"}`} />
        <div>
          <strong>{check.label}</strong>
          <small>{check.description}</small>
        </div>
        <div className="cockpit-values">
          <span title="Téléphone, en direct">{format(value)}</span>
          <span title="Serveur, dernière photo" className={photo?.status ?? ""}>
            {format(photoValue)}
          </span>
        </div>
        <div className="cockpit-severity" role="radiogroup" aria-label={`Sévérité : ${check.label}`}>
          {(
            [
              ["block", "Bloque"],
              ["warn", "Alerte"],
              ["off", "Off"],
            ] as Array<[Severity, string]>
          ).map(([level, label]) => (
            // biome-ignore lint/a11y/useSemanticElements: compact segmented control styled as buttons.
            <button
              type="button"
              role="radio"
              aria-checked={severity === level}
              key={level}
              className={severity === level ? `active ${level}` : ""}
              onClick={() => onChange({ ...profile, severity: { ...profile.severity, [check.key]: level } })}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      {check.parameters.length > 0 && severity !== "off" && (
        <div className="cockpit-sliders">
          {check.parameters.map((parameter) => (
            <Slider key={parameter.key} parameter={parameter} profile={profile} onChange={onChange} />
          ))}
        </div>
      )}
    </div>
  );
}

function Slider({
  parameter,
  profile,
  onChange,
}: {
  parameter: NumericParameter;
  profile: QualityProfile;
  onChange: (profile: QualityProfile) => void;
}) {
  const value = Number(readParameter(profile, parameter));
  return (
    <label className="cockpit-slider">
      <span>
        {parameter.label}
        <input
          type="number"
          value={value}
          step={parameter.step}
          onChange={(event) =>
            Number.isFinite(event.currentTarget.valueAsNumber) &&
            onChange(writeParameter(profile, parameter, event.currentTarget.valueAsNumber))
          }
        />
      </span>
      <input
        type="range"
        min={parameter.min}
        max={parameter.max}
        step={parameter.step}
        value={value}
        onChange={(event) => onChange(writeParameter(profile, parameter, event.currentTarget.valueAsNumber))}
      />
      <small>{parameter.hint}</small>
    </label>
  );
}

function ParameterGroup({
  title,
  description,
  parameters,
  profile,
  onChange,
}: {
  title: string;
  description: string;
  parameters: Parameter[];
  profile: QualityProfile;
  onChange: (profile: QualityProfile) => void;
}) {
  return (
    <section className="cockpit-card">
      <div className="cockpit-card-head">
        <div>
          <h3>
            <SlidersHorizontal size={15} /> {title}
          </h3>
          <p>{description}</p>
        </div>
      </div>
      <div className="cockpit-parameters">
        {parameters.map((parameter) =>
          "toggle" in parameter ? (
            <label className="cockpit-toggle" key={parameter.key}>
              <input
                type="checkbox"
                checked={Boolean(readParameter(profile, parameter))}
                onChange={(event) => onChange(writeParameter(profile, parameter, event.currentTarget.checked))}
              />
              <span>
                <strong>{parameter.label}</strong>
                <small>{parameter.hint}</small>
              </span>
            </label>
          ) : (
            <Slider key={parameter.key} parameter={parameter} profile={profile} onChange={onChange} />
          ),
        )}
      </div>
    </section>
  );
}

function CapturePanel({
  calibrationId,
  capture,
  templateId,
  orbTest,
  testingOrb,
  onTestOrb,
  reprocessing,
  onReprocess,
  testingOcr,
  documentKind,
  ocrSide,
  onOcrSideChange,
  ocrTest,
  onTestOcr,
}: {
  calibrationId: string;
  capture?: Capture;
  templateId?: string;
  orbTest?: OrbTest;
  testingOrb: boolean;
  onTestOrb: () => void;
  reprocessing: boolean;
  onReprocess: () => void;
  testingOcr: boolean;
  documentKind: string;
  ocrSide: OcrSide;
  onOcrSideChange: (side: OcrSide) => void;
  ocrTest?: OcrTest;
  onTestOcr: (imageVariant: "ocr" | "original") => void;
}) {
  const [view, setView] = useState<"ocr" | "original">("ocr");
  const resultRef = useRef<HTMLElement>(null);
  const orbResultRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (ocrTest) resultRef.current?.scrollIntoView({ behavior: "auto", block: "nearest" });
  }, [ocrTest]);
  useEffect(() => {
    if (orbTest) orbResultRef.current?.scrollIntoView({ behavior: "auto", block: "nearest" });
  }, [orbTest]);
  const rawFields = ocrTest?.response?.fields;
  const fields =
    rawFields && typeof rawFields === "object" && !Array.isArray(rawFields) ? Object.entries(rawFields) : [];
  const version = capture ? Date.parse(capture.at) : 0;
  const failed = capture?.server.checks.filter((check) => check.status === "fail") ?? [];
  const warned = capture?.server.checks.filter((check) => check.status === "warn") ?? [];
  const serverPassed = capture ? capture.server.checks.every((check) => check.status !== "fail") : false;
  const imageUrl = useCallback(
    (variant: "ocr" | "original") =>
      `${apiUrl}/dev/quality/calibrations/${calibrationId}/capture/${variant}?v=${version}`,
    [calibrationId, version],
  );
  const currentOrb =
    orbTest && orbTest.captureAt === capture?.at && orbTest.templateId === templateId ? orbTest : undefined;
  const orbReport = currentOrb?.report;
  const orbCorners =
    orbReport?.templateMatched && orbReport.diagnostics?.geometry?.method === "orb"
      ? orbReport.diagnostics.geometry.corners
      : undefined;
  const orbChecks =
    orbReport?.checks.filter((check) =>
      ["template_alignment", "orb_spatial_coverage", "orb_reprojection", "orb_geometry"].includes(check.key),
    ) ?? [];
  if (!capture)
    return (
      <section className="cockpit-card cockpit-capture">
        <div className="cockpit-empty tall">
          <Aperture size={28} />
          <span>
            Prenez une photo depuis le téléphone ou avec « Prendre une photo » : le serveur l’analysera en pleine
            résolution.
          </span>
        </div>
      </section>
    );
  const shown = view === "ocr" && capture.ocr ? "ocr" : "original";
  return (
    <section className="cockpit-card cockpit-capture">
      <div className="cockpit-card-head">
        <div>
          <h3>Dernière photo</h3>
          <p>
            {capture.original.width}×{capture.original.height} · {Math.round(capture.original.bytes / 1024)} Ko ·
            déclenchement {{ auto: "automatique", manual: "manuel", remote: "à distance" }[capture.trigger]}
          </p>
        </div>
        <span className={`cockpit-verdict ${serverPassed ? "pass" : "fail"}`}>
          {serverPassed ? "Admissible" : "À reprendre"}
        </span>
      </div>
      <div className="cockpit-segment">
        <button
          type="button"
          className={shown === "ocr" ? "active" : ""}
          disabled={!capture.ocr}
          onClick={() => setView("ocr")}
        >
          Copie OCR
        </button>
        <button type="button" className={shown === "original" ? "active" : ""} onClick={() => setView("original")}>
          Cadre capturé
        </button>
      </div>
      <div className={`cockpit-photo ${shown}`}>
        {/* biome-ignore lint/performance/noImgElement: calibration photo served by the local backend. */}
        <img
          src={imageUrl(shown)}
          alt={shown === "ocr" ? "Copie pré-traitée pour l’OCR" : "Photo limitée au cadre de capture"}
        />
        {shown === "original" && orbCorners && (
          <svg
            viewBox="0 0 100 100"
            preserveAspectRatio="none"
            role="img"
            aria-label="Contour du gabarit projeté par ORB sur la photo"
          >
            <polygon points={orbCorners.map(({ x, y }) => `${x * 100},${y * 100}`).join(" ")} />
          </svg>
        )}
      </div>
      {shown === "original" && orbCorners && (
        <p className="cockpit-ocr-source">Contour vert : position du gabarit calculée par ORB sur la photo.</p>
      )}
      {(failed.length > 0 || warned.length > 0) && (
        <ul className="cockpit-issues">
          {[...failed, ...warned].map((check) => (
            <li key={check.key} className={check.status}>
              <b>{checkLabels[check.key] ?? check.key}</b>
              <span>
                {String(check.value)} · seuil {String(check.threshold)}
              </span>
            </li>
          ))}
        </ul>
      )}
      {capture.client?.burst && capture.client.burst.length > 1 && (
        <p className="cockpit-burst">
          Rafale : {capture.client.burst.map((frame) => Math.round(frame.sharpness)).join(" · ")} (netteté) — image{" "}
          {(capture.client.frameIndex ?? 0) + 1} retenue
        </p>
      )}
      {capture.ocr && (
        <ol className="cockpit-steps">
          {capture.ocr.steps.map((step) => (
            <li key={step.step}>
              <span>{stepLabel[step.step] ?? step.step}</span>
              <small>{step.detail}</small>
              <b>{Math.round(step.durationMs)} ms</b>
            </li>
          ))}
        </ol>
      )}
      <Button
        size="compact"
        variant="secondary"
        onClick={onReprocess}
        disabled={reprocessing || testingOcr || testingOrb}
      >
        {reprocessing ? <LoaderCircle size={14} className="spin-icon" /> : <Wand2 size={14} />} Re-traiter avec les
        réglages actuels
      </Button>
      <Button
        size="compact"
        variant="secondary"
        onClick={() => {
          setView("original");
          onTestOrb();
        }}
        disabled={!templateId || testingOrb || testingOcr || reprocessing}
      >
        {testingOrb ? <LoaderCircle size={14} className="spin-icon" /> : <Wand2 size={14} />} Tester l’ORB
      </Button>
      {!templateId && <p className="cockpit-ocr-source">Sélectionnez une face avec un gabarit pour tester ORB.</p>}
      {(testingOrb || currentOrb) && (
        <section ref={orbResultRef} className="cockpit-ocr-result" aria-label="Résultat du test ORB">
          <h3>Alignement ORB</h3>
          {testingOrb ? (
            <output>Comparaison avec le gabarit en cours…</output>
          ) : currentOrb?.error ? (
            <p role="alert" className="cockpit-ocr-error">
              {currentOrb.error}
            </p>
          ) : (
            orbReport && (
              <>
                <span className={`cockpit-verdict ${orbReport.templateMatched ? "pass" : "fail"}`}>
                  {orbReport.templateMatched ? "Gabarit aligné" : "Aucun alignement fiable"}
                </span>
                <p>
                  Gabarit : {orbReport.templateId ?? templateId} · {Math.round(orbReport.durationMs)} ms
                </p>
                <dl className="cockpit-orb-checks">
                  {orbChecks.map((check) => (
                    <div key={check.key}>
                      <dt>{checkLabels[check.key] ?? check.key}</dt>
                      <dd className={check.status}>
                        {check.value == null ? "—" : String(check.value)}{" "}
                        <small>/ {check.threshold == null ? "—" : String(check.threshold)}</small>
                      </dd>
                    </div>
                  ))}
                </dl>
                {orbReport.templateMatched && orbReport.alignmentImage ? (
                  <figure className="cockpit-orb-preview">
                    {/* biome-ignore lint/performance/noImgElement: image produced by the local quality analyzer. */}
                    <img
                      src={orbReport.alignmentImage.dataUrl}
                      alt="Document redressé selon l’alignement ORB, sans prétraitement OCR"
                    />
                    <figcaption>
                      Document redressé par ORB, sans retouche OCR · {orbReport.alignmentImage.width}×
                      {orbReport.alignmentImage.height} px
                    </figcaption>
                  </figure>
                ) : (
                  <p>
                    {orbReport.templateMatched
                      ? "Alignement trouvé, mais aucune image redressée n’est disponible."
                      : "Aucun contour ORB fiable à superposer ; vérifiez la face et le cadrage."}
                  </p>
                )}
              </>
            )
          )}
        </section>
      )}
      {documentKind !== "dz-passport" && (
        <label className="cockpit-select">
          <span>Face OCR</span>
          <select
            value={ocrSide}
            disabled={testingOcr || testingOrb}
            onChange={(event) => onOcrSideChange(event.target.value as OcrSide)}
          >
            <option value="front">Recto</option>
            <option value="back">Verso</option>
          </select>
        </label>
      )}
      <Button
        size="compact"
        onClick={() => onTestOcr(shown)}
        disabled={!capture || testingOcr || testingOrb || reprocessing}
      >
        {testingOcr ? <LoaderCircle size={14} className="spin-icon" /> : <Aperture size={14} />} Tester l’OCR réel
      </Button>
      <p className="cockpit-ocr-source">
        Le test envoie l’image affichée : {shown === "ocr" ? "copie prétraitée" : "cadre capturé"}.
      </p>
      {(testingOcr || ocrTest) && (
        <section ref={resultRef} className="cockpit-ocr-result" aria-label="Résultat du test OCR">
          <h3>Résultat du test OCR</h3>
          {testingOcr ? (
            <output>Lecture par le service OCR en cours…</output>
          ) : (
            ocrTest && (
              <>
                <p>
                  {ocrTest.documentType ?? "Service OCR"}
                  {ocrTest.durationMs !== undefined ? ` · ${Math.round(ocrTest.durationMs)} ms` : ""}
                  {ocrTest.imageVariant
                    ? ` · ${ocrTest.imageVariant === "ocr" ? "copie prétraitée" : "cadre capturé"}`
                    : ""}
                </p>
                {ocrTest.error ? (
                  <div role="alert" className="cockpit-ocr-error">
                    <strong>
                      Le test OCR a échoué{ocrTest.upstreamStatus ? ` (HTTP ${ocrTest.upstreamStatus})` : ""}
                    </strong>
                    <p>
                      {String(ocrTest.response?.detail ?? ocrTest.detail ?? ocrTest.response?.error ?? ocrTest.error)}
                    </p>
                    <span>Corrigez la cause puis utilisez « Tester l’OCR réel » pour réessayer.</span>
                  </div>
                ) : (
                  <>
                    <p>Validation : {String(ocrTest.response?.status ?? "réponse reçue")}</p>
                    {fields.length > 0 ? (
                      <dl className="cockpit-ocr-fields">
                        {fields.map(([key, value]) => (
                          <div key={key}>
                            <dt>{key}</dt>
                            <dd dir="auto">
                              {value == null || value === ""
                                ? "Non lu"
                                : typeof value === "object"
                                  ? JSON.stringify(value)
                                  : String(value)}
                            </dd>
                          </div>
                        ))}
                      </dl>
                    ) : (
                      <p>Aucun champ extrait. Consultez la réponse complète ci-dessous.</p>
                    )}
                  </>
                )}
                <details>
                  <summary>Réponse complète JSON</summary>
                  <pre>{JSON.stringify(ocrTest.response ?? ocrTest, null, 2)}</pre>
                </details>
              </>
            )
          )}
        </section>
      )}
    </section>
  );
}

const stepLabel: Record<string, string> = {
  rectify: "Redressement",
  white_balance: "Balance des blancs",
  illumination: "Correction d’éclairage",
  clahe: "Contraste local",
  denoise: "Débruitage",
  sharpen: "Accentuation",
  encode: "Encodage",
};

function downloadJson(name: string, value: unknown) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}
