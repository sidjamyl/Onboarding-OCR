"use client";

import { Download, EyeOff, Focus, RotateCcw, Save, ScanSearch, SlidersHorizontal, Upload } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/button";
import { normalizeApiUrl } from "@/lib/api-url";
import { inspectPhoto } from "@/lib/local-quality";
import type { QualityProfile } from "@/lib/quality-profile";
import {
  captureParameters,
  checkCatalog,
  checkLabels,
  orbParameters,
  type Parameter,
  preprocessParameters,
  readParameter,
  writeParameter,
} from "@/lib/quality-parameters";
import { LiveCalibrationPanel } from "./live-calibration";

const apiUrl = normalizeApiUrl(process.env.NEXT_PUBLIC_ONBOARDING_API_URL ?? "/api/onboarding");

type Region = {
  id?: string;
  label?: string;
  role?: "required" | "optional";
  content?: "arabic" | "latin" | "numeric" | "date" | "mixed";
  x: number;
  y: number;
  width: number;
  height: number;
};

type SavedOrbTemplate = {
  id: string;
  version: number;
  width: number;
  height: number;
  documentKind: string;
  zones: Array<Required<Pick<Region, "id" | "label" | "role" | "content">> & Region>;
  ignoredRegions: Region[];
  orb: {
    keypoints: Array<{ x: number; y: number }>;
    descriptors: number[];
    rows: number;
    cols: number;
  };
  parameters: {
    ratioThreshold: number;
    minimumGoodMatches: number;
    minimumInlierRatio: number;
    ransacThreshold: number;
  };
};

type ReportCheck = {
  key: string;
  passed: boolean;
  status?: string;
  value?: number | string;
  threshold?: number | string;
  durationMs?: number;
};

type LabReport = { passed: boolean; durationMs: number; checks: ReportCheck[] };

type ServerReport = LabReport & {
  mode: string;
  ocrImage?: { dataUrl: string; width: number; height: number; steps: Array<{ step: string; durationMs: number }> };
};

type LocalReport = LabReport & { preview?: string; colorGlarePreview?: string };

const thresholdParameters: Parameter[] = checkCatalog.flatMap((check) => check.parameters);

export function QualityLab() {
  const templateIdInput = useId();
  const documentKindInput = useId();
  const colorGlareSeverityInput = useId();
  const canvas = useRef<HTMLCanvasElement>(null);
  const image = useRef<HTMLImageElement | null>(null);
  const drag = useRef<{ x: number; y: number } | null>(null);
  const [file, setFile] = useState<File>();
  const [profile, setProfile] = useState<QualityProfile>();
  const [defaults, setDefaults] = useState<QualityProfile>();
  const [localReport, setLocalReport] = useState<LocalReport>();
  const [serverReport, setServerReport] = useState<ServerReport>();
  const [templateId, setTemplateId] = useState("dz-id-front");
  const [documentKind, setDocumentKind] = useState("dz-id-front");
  const [generatedTemplate, setGeneratedTemplate] = useState<SavedOrbTemplate>();
  const [drawingMode, setDrawingMode] = useState<"zone" | "ignore">("zone");
  const [zones, setZones] = useState<Region[]>([]);
  const [ignored, setIgnored] = useState<Region[]>([]);
  const [status, setStatus] = useState("Chargement des réglages…");
  const [error, setError] = useState<string>();
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    requestJson<{ profile: QualityProfile; defaults: QualityProfile }>(`${apiUrl}/dev/quality/config`)
      .then((payload) => {
        setProfile(payload.profile);
        setDefaults(payload.defaults);
        setStatus("Profil actif chargé");
      })
      .catch((cause) => setError(messageOf(cause)));
  }, []);

  useEffect(
    () => () => {
      if (localReport?.preview) URL.revokeObjectURL(localReport.preview);
      if (localReport?.colorGlarePreview) URL.revokeObjectURL(localReport.colorGlarePreview);
    },
    [localReport],
  );

  const loadFile = (next: File) => {
    const source = URL.createObjectURL(next);
    const nextImage = new Image();
    nextImage.onload = () => {
      image.current = nextImage;
      setFile(next);
      setZones([]);
      setIgnored([]);
      setGeneratedTemplate(undefined);
      setLocalReport(undefined);
      setServerReport(undefined);
      setStatus("Photo prête à analyser");
      URL.revokeObjectURL(source);
    };
    nextImage.onerror = () => {
      URL.revokeObjectURL(source);
      setError("Cette image ne peut pas être affichée.");
    };
    nextImage.src = source;
  };

  const draw = useCallback(() => {
    const target = canvas.current;
    const source = image.current;
    if (!target || !source) return;
    const maxWidth = Math.min(960, target.parentElement?.clientWidth ?? 960);
    const scale = Math.min(maxWidth / source.naturalWidth, 680 / source.naturalHeight, 1);
    target.width = Math.round(source.naturalWidth * scale);
    target.height = Math.round(source.naturalHeight * scale);
    const context = target.getContext("2d");
    if (!context) return;
    context.drawImage(source, 0, 0, target.width, target.height);
    for (const [regions, color] of [
      [zones, "#5df0ad"],
      [ignored, "#ff8b75"],
    ] as const)
      for (const region of regions) {
        context.strokeStyle = color;
        context.lineWidth = 2;
        context.setLineDash(regions === ignored ? [7, 5] : []);
        context.strokeRect(
          region.x * target.width,
          region.y * target.height,
          region.width * target.width,
          region.height * target.height,
        );
        context.fillStyle = color;
        context.font = "12px Inter";
        context.fillText(
          region.label ?? (regions === ignored ? "ignored" : "zone"),
          region.x * target.width + 5,
          region.y * target.height + 15,
        );
      }
  }, [ignored, zones]);

  useEffect(() => draw(), [draw]);

  const position = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    return { x: (event.clientX - bounds.left) / bounds.width, y: (event.clientY - bounds.top) / bounds.height };
  };

  const start = (event: React.PointerEvent<HTMLCanvasElement>) => {
    drag.current = position(event);
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const end = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drag.current) return;
    const finish = position(event);
    const startPoint = drag.current;
    drag.current = null;
    const region = {
      x: Math.min(startPoint.x, finish.x),
      y: Math.min(startPoint.y, finish.y),
      width: Math.abs(finish.x - startPoint.x),
      height: Math.abs(finish.y - startPoint.y),
    };
    if (region.width < 0.01 || region.height < 0.01) return;
    if (drawingMode === "zone")
      setZones((current) => [
        ...current,
        {
          ...region,
          id: `field-${current.length + 1}`,
          label: `Field ${current.length + 1}`,
          role: "required",
          content: "mixed",
        },
      ]);
    else setIgnored((current) => [...current, region]);
  };

  const setParameter = (parameter: Parameter, value: number | boolean) => {
    if (!profile || (typeof value === "number" && !Number.isFinite(value))) return;
    setProfile(writeParameter(profile, parameter, value));
    setDirty(true);
  };

  const setMode = (mode: QualityProfile["mode"]) => {
    if (!profile) return;
    setProfile({ ...profile, mode });
    setDirty(true);
  };

  const analyze = async () => {
    if (!file || !profile) return;
    setError(undefined);
    setStatus("Analyse téléphone et serveur…");
    try {
      const body = new FormData();
      body.set("file", file);
      body.set("profile", JSON.stringify(profile));
      body.set("documentKind", documentKind);
      body.set("templateId", templateId);
      body.set("prepare", "true");
      const [local, server] = await Promise.all([
        inspectPhoto(file, profile, documentKind),
        requestJson<ServerReport>(`${apiUrl}/dev/quality/analyze`, { method: "POST", body }),
      ]);
      setLocalReport({
        passed: local.analysis.evaluation.passed,
        durationMs: local.durationMs,
        checks: local.analysis.evaluation.checks,
        ...(local.preview ? { preview: URL.createObjectURL(local.preview) } : {}),
        ...(local.colorGlarePreview ? { colorGlarePreview: URL.createObjectURL(local.colorGlarePreview) } : {}),
      });
      setServerReport(server);
      setStatus(`Analyse terminée · téléphone ${local.durationMs} ms · serveur ${server.durationMs} ms`);
    } catch (cause) {
      setError(messageOf(cause));
      setStatus("Analyse interrompue");
    }
  };

  const applyProfile = async (next: QualityProfile): Promise<boolean> => {
    setError(undefined);
    setStatus("Application du profil…");
    try {
      const payload = await requestJson<{ profile: QualityProfile }>(`${apiUrl}/dev/quality/config`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(next),
      });
      setProfile(payload.profile);
      setDirty(false);
      setStatus("Profil appliqué aux nouvelles captures");
      return true;
    } catch (cause) {
      setError(messageOf(cause));
      setStatus("Profil non appliqué");
      return false;
    }
  };

  const saveTemplate = async () => {
    if (!file) return;
    setError(undefined);
    setStatus("Génération des descripteurs ORB…");
    try {
      const body = new FormData();
      body.set("file", file);
      body.set("id", templateId);
      body.set("name", templateId);
      body.set("documentKind", documentKind.replace(/-(front|back)$/, ""));
      body.set("zones", JSON.stringify(zones));
      body.set("ignoredRegions", JSON.stringify(ignored));
      const template = await requestJson<SavedOrbTemplate>(`${apiUrl}/dev/quality/templates`, {
        method: "POST",
        body,
      });
      setGeneratedTemplate(template);
      setStatus(`Gabarit généré · ${template.orb.rows} points stables · prêt à exporter pour OCR Gateway`);
    } catch (cause) {
      setError(messageOf(cause));
      setStatus("Gabarit non généré");
    }
  };

  if (!profile || !defaults)
    return (
      <main className="lab-page lab-loading">
        <div className="spinner" />
        <p>{error ?? status}</p>
      </main>
    );

  return (
    <main className="lab-page">
      <div className="lab-shell">
        <header className="lab-header">
          <div>
            <div className="lab-title-row">
              <h1>Laboratoire de capture</h1>
              <span className="lab-local-badge">Local uniquement</span>
            </div>
            <p>Mesurez une photo, ajustez les seuils, puis appliquez le profil sans redémarrer.</p>
          </div>
          <div className="lab-header-actions">
            <label className="button button-secondary button-compact">
              <Upload size={15} /> Tester une photo
              <input
                hidden
                type="file"
                accept="image/*"
                capture="environment"
                onChange={(event) => event.target.files?.[0] && loadFile(event.target.files[0])}
              />
            </label>
            <Button size="compact" onClick={() => profile && void applyProfile(profile)} disabled={!dirty}>
              <Save size={15} /> Appliquer
            </Button>
          </div>
        </header>

        <output className="lab-status" aria-live="polite">
          <span className={dirty ? "lab-dot pending" : "lab-dot"} />
          <span>{status}</span>
          {error && <strong>{error}</strong>}
        </output>

        <LiveCalibrationPanel onApply={applyProfile} />

        <section className="lab-mode" aria-label="Mode de contrôle">
          <div>
            <h2>Comportement du parcours</h2>
            <p>Observer mesure sans bloquer. Bloquer refuse les photos hors seuils.</p>
          </div>
          <div className="lab-segmented">
            {(
              [
                ["off", "Désactivé"],
                ["observe", "Observer"],
                ["enforce", "Bloquer"],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                className={profile.mode === value ? "active" : ""}
                onClick={() => setMode(value)}
              >
                {label}
              </button>
            ))}
          </div>
        </section>

        <div className="lab-grid">
          <section className="lab-preview-column">
            <div className="lab-canvas">
              {file ? (
                <canvas ref={canvas} onPointerDown={start} onPointerUp={end} />
              ) : (
                <div className="lab-empty">
                  <ScanSearch size={38} />
                  <h2>Chargez une vraie capture</h2>
                  <p>Utilisez de préférence une photo prise avec le téléphone cible.</p>
                </div>
              )}
            </div>
            <Button onClick={analyze} disabled={!file}>
              <Focus size={16} /> Analyser avec ces réglages
            </Button>
            {(localReport || serverReport) && (
              <div className="lab-results">
                <ReportPanel title="Téléphone" subtitle="Décision avant envoi" report={localReport} />
                <ReportPanel title="Serveur" subtitle="Décision autoritaire" report={serverReport} />
              </div>
            )}
            {(serverReport?.ocrImage || localReport?.preview || localReport?.colorGlarePreview) && (
              <div className="lab-derived">
                {localReport?.colorGlarePreview && (
                  <figure>
                    {/* biome-ignore lint/performance/noImgElement: local diagnostic mask from the quality worker. */}
                    <img src={localReport.colorGlarePreview} alt="Reflets colorés potentiels surlignés en rose" />
                    <figcaption>
                      En rose : pixels comptés par « Reflets colorés ». Réanalysez après chaque réglage.
                    </figcaption>
                  </figure>
                )}
                {localReport?.preview && (
                  <figure>
                    {/* biome-ignore lint/performance/noImgElement: object URL of the locally rectified document. */}
                    <img src={localReport.preview} alt="Document redressé sur le téléphone" />
                    <figcaption>Redressé par le téléphone (mesures)</figcaption>
                  </figure>
                )}
                {serverReport?.ocrImage && (
                  <figure>
                    {/* biome-ignore lint/performance/noImgElement: data URL returned by the local laboratory. */}
                    <img src={serverReport.ocrImage.dataUrl} alt="Copie pré-traitée envoyée à l’OCR" />
                    <figcaption>
                      Copie OCR · {serverReport.ocrImage.width}×{serverReport.ocrImage.height} ·{" "}
                      {serverReport.ocrImage.steps.map((step) => step.step).join(" → ")}
                    </figcaption>
                  </figure>
                )}
              </div>
            )}
          </section>

          <aside className="lab-settings">
            <section>
              <div className="lab-section-heading">
                <div>
                  <h2>Seuils de qualité</h2>
                  <p>Identiques sur le téléphone et le serveur.</p>
                </div>
                <SlidersHorizontal size={18} />
              </div>
              <ParameterGrid profile={profile} parameters={thresholdParameters} onChange={setParameter} />
              <div className="lab-field">
                <label htmlFor={colorGlareSeverityInput}>Comportement des reflets colorés</label>
                <select
                  id={colorGlareSeverityInput}
                  value={profile.severity.color_glare}
                  onChange={(event) => {
                    setProfile({
                      ...profile,
                      severity: {
                        ...profile.severity,
                        color_glare: event.target.value as QualityProfile["severity"]["color_glare"],
                      },
                    });
                    setDirty(true);
                  }}
                >
                  <option value="warn">Alerte · calibration</option>
                  <option value="block">Bloquer la capture</option>
                  <option value="off">Désactivé</option>
                </select>
              </div>
            </section>

            <details>
              <summary>Capture automatique</summary>
              <p className="lab-detail-copy">Rythme d’analyse, stabilité et rafale finale.</p>
              <ParameterGrid profile={profile} parameters={captureParameters} onChange={setParameter} />
            </details>

            <details>
              <summary>Pré-traitement OCR</summary>
              <p className="lab-detail-copy">Copie redressée et améliorée envoyée à l’OCR ; l’original est conservé.</p>
              <ParameterGrid profile={profile} parameters={preprocessParameters} onChange={setParameter} />
            </details>

            <details>
              <summary>Alignement ORB</summary>
              <p className="lab-detail-copy">Correspondances, homographie et géométrie du gabarit.</p>
              <ParameterGrid profile={profile} parameters={orbParameters} onChange={setParameter} />
            </details>

            <div className="lab-profile-actions">
              <Button
                size="compact"
                variant="secondary"
                onClick={() => {
                  setProfile(structuredClone(defaults));
                  setDirty(true);
                }}
              >
                <RotateCcw size={14} /> Valeurs par défaut
              </Button>
              <Button size="compact" variant="secondary" onClick={() => downloadJson("quality-profile.json", profile)}>
                <Download size={14} /> Exporter le profil
              </Button>
              <label className="button button-secondary button-compact">
                <Upload size={14} /> Importer
                <input
                  hidden
                  type="file"
                  accept="application/json"
                  onChange={async (event) => {
                    const selected = event.target.files?.[0];
                    if (!selected) return;
                    try {
                      const imported: unknown = JSON.parse(await selected.text());
                      if (!isQualityProfile(imported)) throw new Error("invalid profile");
                      setProfile({
                        ...imported,
                        image: { ...defaults.image, ...imported.image },
                        severity: { ...defaults.severity, ...imported.severity },
                      });
                      setDirty(true);
                      setStatus("Profil importé, vérifiez puis appliquez");
                    } catch {
                      setError("Le fichier JSON est invalide.");
                    }
                  }}
                />
              </label>
            </div>

            <details>
              <summary>Éditeur de gabarit</summary>
              <p className="lab-detail-copy">Dessinez les zones directement sur la photo chargée.</p>
              <div className="lab-field">
                <label htmlFor={templateIdInput}>Identifiant</label>
                <input
                  id={templateIdInput}
                  value={templateId}
                  onChange={(event) => setTemplateId(event.target.value)}
                />
              </div>
              <div className="lab-field">
                <label htmlFor={documentKindInput}>Type de document</label>
                <select
                  id={documentKindInput}
                  value={documentKind}
                  onChange={(event) => setDocumentKind(event.target.value)}
                >
                  <option value="dz-id-front">Carte d’identité · recto</option>
                  <option value="dz-id-back">Carte d’identité · verso</option>
                  <option value="dz-driving-licence-front">Permis · recto</option>
                  <option value="dz-driving-licence-back">Permis · verso</option>
                  <option value="dz-passport">Passeport</option>
                  <option value="dz-residence-certificate">Certificat de résidence</option>
                  <option value="dz-birth-certificate">Acte de naissance</option>
                </select>
              </div>
              <div className="lab-drawing-tools">
                <Button
                  size="compact"
                  variant={drawingMode === "zone" ? "primary" : "secondary"}
                  onClick={() => setDrawingMode("zone")}
                >
                  <Focus size={14} /> Zone OCR
                </Button>
                <Button
                  size="compact"
                  variant={drawingMode === "ignore" ? "primary" : "secondary"}
                  onClick={() => setDrawingMode("ignore")}
                >
                  <EyeOff size={14} /> Ignorer
                </Button>
              </div>
              {zones.length > 0 && (
                <div className="lab-region-list">
                  {zones.map((zone, index) => (
                    <div className="lab-region" key={zone.id}>
                      <input
                        aria-label={`Nom de la zone ${index + 1}`}
                        value={zone.label}
                        onChange={(event) =>
                          setZones((current) =>
                            current.map((item, itemIndex) =>
                              itemIndex === index
                                ? { ...item, id: event.target.value || `field-${index + 1}`, label: event.target.value }
                                : item,
                            ),
                          )
                        }
                      />
                      <select
                        aria-label={`Rôle de la zone ${index + 1}`}
                        value={zone.role}
                        onChange={(event) =>
                          setZones((current) =>
                            current.map((item, itemIndex) =>
                              itemIndex === index ? { ...item, role: event.target.value as Region["role"] } : item,
                            ),
                          )
                        }
                      >
                        <option value="required">Obligatoire</option>
                        <option value="optional">Optionnel</option>
                      </select>
                      <select
                        aria-label={`Contenu de la zone ${index + 1}`}
                        value={zone.content}
                        onChange={(event) =>
                          setZones((current) =>
                            current.map((item, itemIndex) =>
                              itemIndex === index
                                ? { ...item, content: event.target.value as Region["content"] }
                                : item,
                            ),
                          )
                        }
                      >
                        <option value="arabic">Arabe</option>
                        <option value="latin">Latin</option>
                        <option value="numeric">Numérique</option>
                        <option value="date">Date</option>
                        <option value="mixed">Mixte</option>
                      </select>
                      <button
                        type="button"
                        className="lab-region-remove"
                        aria-label={`Supprimer la zone ${index + 1}`}
                        onClick={() => setZones((current) => current.filter((_, itemIndex) => itemIndex !== index))}
                      >
                        ×
                      </button>
                    </div>
                  ))}
                </div>
              )}
              <div className="lab-template-footer">
                <span>
                  {zones.length} zones · {ignored.length} régions ignorées
                </span>
                <Button size="compact" onClick={saveTemplate} disabled={!file}>
                  Générer le gabarit
                </Button>
                <Button
                  size="compact"
                  variant="secondary"
                  disabled={!generatedTemplate}
                  onClick={() => {
                    if (!generatedTemplate) return;
                    const gatewayTemplate = toGatewayTemplate(generatedTemplate);
                    downloadJson(`${gatewayTemplate.id}.json`, gatewayTemplate);
                    setStatus(
                      `JSON exporté · placez-le dans OCR/templates/${gatewayTemplate.document}/${gatewayTemplate.id}.json`,
                    );
                  }}
                >
                  <Download size={14} /> Exporter pour OCR Gateway
                </Button>
              </div>
            </details>
          </aside>
        </div>
      </div>
    </main>
  );
}

function ParameterGrid({
  profile,
  parameters,
  onChange,
}: {
  profile: QualityProfile;
  parameters: Parameter[];
  onChange: (parameter: Parameter, value: number | boolean) => void;
}) {
  return (
    <div className="lab-parameter-grid">
      {parameters.map((parameter) => (
        // biome-ignore lint/a11y/noLabelWithoutControl: the input is rendered conditionally inside the label.
        <label className="lab-parameter" key={`${parameter.section}.${parameter.key}`}>
          <span>{parameter.label}</span>
          <small>{parameter.hint}</small>
          {"toggle" in parameter ? (
            <input
              type="checkbox"
              checked={Boolean(readParameter(profile, parameter))}
              onChange={(event) => onChange(parameter, event.currentTarget.checked)}
            />
          ) : (
            <input
              type="number"
              min={parameter.min}
              max={parameter.max}
              step={parameter.step}
              value={Number(readParameter(profile, parameter))}
              onChange={(event) => onChange(parameter, event.currentTarget.valueAsNumber)}
            />
          )}
        </label>
      ))}
    </div>
  );
}

function ReportPanel({ title, subtitle, report }: { title: string; subtitle: string; report?: LabReport }) {
  if (!report)
    return (
      <section className="lab-report muted">
        <h2>{title}</h2>
        <p>{subtitle}</p>
        <span>En attente</span>
      </section>
    );
  const theoreticalPassed = report.checks.every((check) => check.status !== "fail");
  return (
    <section className="lab-report">
      <div className="lab-report-heading">
        <div>
          <h2>{title}</h2>
          <p>{subtitle}</p>
        </div>
        <strong className={theoreticalPassed ? "pass" : "fail"}>{theoreticalPassed ? "Valide" : "À reprendre"}</strong>
      </div>
      <div className="lab-checks">
        {report.checks.map((check) => (
          <div className="check-row" key={check.key}>
            <span>
              {checkLabel(check.key)}
              <small>{check.durationMs !== undefined ? `${check.durationMs} ms` : "téléphone"}</small>
            </span>
            <span className="lab-measure">
              <b>{String(check.value ?? "—")}</b>
              <small>{String(check.threshold ?? "—")}</small>
            </span>
            <strong className={check.passed ? "pass" : check.status === "warn" ? "warn" : "fail"}>
              {check.passed ? "OK" : check.status === "warn" ? "Alerte" : "Échec"}
            </strong>
          </div>
        ))}
      </div>
    </section>
  );
}

function checkLabel(key: string) {
  return checkLabels[key] ?? key;
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: "no-store", ...init });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.detail ?? payload.message ?? payload.error ?? `HTTP ${response.status}`);
  return payload;
}

function downloadJson(name: string, value: unknown) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}

function toGatewayTemplate(template: SavedOrbTemplate) {
  return {
    formatVersion: 1 as const,
    id: `${template.id}-v${template.version}`,
    document: template.documentKind,
    variant: "default",
    version: template.version,
    width: template.width,
    height: template.height,
    zones: template.zones.map((zone) => ({
      id: zone.id,
      field: zone.id,
      role: zone.role,
      content: zone.content,
      x: zone.x,
      y: zone.y,
      width: zone.width,
      height: zone.height,
    })),
    ignoredRegions: template.ignoredRegions.map(({ x, y, width, height }) => ({ x, y, width, height })),
    orb: {
      ...template.orb,
      parameters: template.parameters,
    },
  };
}

function messageOf(cause: unknown) {
  return cause instanceof Error ? cause.message : String(cause);
}

function isQualityProfile(value: unknown): value is QualityProfile {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  if (candidate.version !== 2 || !["off", "observe", "enforce"].includes(String(candidate.mode))) return false;
  return (["capture", "document", "image", "severity", "preprocess", "orb"] as const).every(
    (section) => candidate[section] !== null && typeof candidate[section] === "object",
  );
}
