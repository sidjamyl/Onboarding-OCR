"use client";

import { ChevronDown } from "lucide-react";
import { useState } from "react";
import { flattenMetrics } from "@/lib/calibration";
import { checkCatalog, checkLabels } from "@/lib/quality-parameters";
import type { FrameAnalysis, QualityProfile } from "@/lib/quality-core";

type Props = {
  analysis: FrameAnalysis;
  camera: { width: number; height: number; label: string };
  profile: QualityProfile;
  stablePasses: number;
};

const statusLabels = { pass: "OK", warn: "À améliorer", fail: "Bloquant", not_applicable: "Non évalué" };
const number = (value: number) => (Number.isFinite(value) ? String(Math.round(value * 10_000) / 10_000) : "—");

/** Local diagnostics only: opening or freezing this panel never pauses the camera or its analysis. */
export function CalibrationHud(props: Props) {
  const [snapshot, setSnapshot] = useState<Props>();
  const { analysis, camera, profile, stablePasses } = snapshot ?? props;
  const { evaluation } = analysis;
  const failures = evaluation.checks.filter((check) => check.status === "fail").length;
  const warnings = evaluation.checks.filter((check) => check.status === "warn").length;
  const disabled = checkCatalog.filter((check) => profile.severity[check.key] === "off");

  return (
    <details className="dc-hud">
      <summary className="dc-hud-summary">
        <span>
          <strong>Mesures {snapshot ? "figées" : "en direct"}</strong>
          <small>
            {failures} bloquant{failures !== 1 ? "s" : ""} · {warnings} avertissement{warnings !== 1 ? "s" : ""}
          </small>
        </span>
        <span className="dc-hud-summary-end">
          <span className="dc-hud-score">
            {Math.round(evaluation.score * 100)}
            <small>/100</small>
          </span>
          <ChevronDown size={18} aria-hidden="true" />
        </span>
      </summary>
      <div className="dc-hud-body">
        <div className="dc-hud-toolbar">
          <span>Calculées sur ce téléphone</span>
          <button
            type="button"
            onClick={() => setSnapshot(snapshot ? undefined : props)}
            aria-pressed={Boolean(snapshot)}
          >
            {snapshot ? "Reprendre le direct" : "Figer les mesures"}
          </button>
        </div>
        <p className="dc-hud-note">
          Le score classe les images ; ce n’est pas une probabilité de réussite OCR. Figer les mesures ne coupe pas la
          caméra.
        </p>
        <div className="dc-hud-section-head">
          <h3>Contrôles actifs</h3>
          <span>Valeur / seuil brut</span>
        </div>
        <ul className="dc-hud-checks">
          {evaluation.checks.map((check) => (
            <li key={check.key}>
              <div>
                <strong>{checkLabels[check.key] ?? check.key}</strong>
                <span className={`dc-hud-status ${check.status}`}>{statusLabels[check.status]}</span>
              </div>
              <div className="dc-hud-values">
                <span>{typeof check.value === "number" ? number(check.value) : check.value}</span>
                <span>{check.threshold}</span>
              </div>
            </li>
          ))}
        </ul>
        {evaluation.checks.length === 0 && <p className="dc-hud-note">Aucun contrôle actif sur cette image.</p>}
        {disabled.length > 0 && (
          <p className="dc-hud-note">Désactivés : {disabled.map((check) => check.label).join(", ")}.</p>
        )}
        <details className="dc-hud-raw">
          <summary>
            Toutes les mesures brutes <ChevronDown size={16} aria-hidden="true" />
          </summary>
          <dl>
            {Object.entries(flattenMetrics(analysis.metrics)).map(([key, value]) => (
              <div key={key}>
                <dt>{key}</dt>
                <dd>{number(value)}</dd>
              </div>
            ))}
          </dl>
        </details>
        <h3>Capture et traitement</h3>
        <dl className="dc-hud-settings">
          <div>
            <dt>Caméra</dt>
            <dd>
              {camera.width} × {camera.height} px
            </dd>
          </div>
          <div>
            <dt>Analyse</dt>
            <dd>{number(analysis.durationMs.total)} ms</dd>
          </div>
          <div>
            <dt>Mesure / détection</dt>
            <dd>
              {number(analysis.durationMs.measurement)} / {number(analysis.durationMs.detection)} ms
            </dd>
          </div>
          <div>
            <dt>Images valides consécutives</dt>
            <dd>
              {stablePasses} / {profile.capture.stableFrames}
            </dd>
          </div>
          <div>
            <dt>Pause entre analyses</dt>
            <dd>{profile.capture.samplingIntervalMs} ms</dd>
          </div>
          <div>
            <dt>Taille d’analyse demandée</dt>
            <dd>{profile.capture.analysisSize} px</dd>
          </div>
          <div>
            <dt>Mode qualité</dt>
            <dd>{profile.mode}</dd>
          </div>
          <div>
            <dt>Copie OCR prétraitée</dt>
            <dd>{profile.preprocess.enabled ? "Activée" : "Désactivée"}</dd>
          </div>
        </dl>
        <p className="dc-hud-note">
          Le direct est analysé sur toute l’image de la caméra ; seule la photo finale est découpée au cadre. Les
          réglages se modifient depuis le PC.
        </p>
      </div>
    </details>
  );
}
