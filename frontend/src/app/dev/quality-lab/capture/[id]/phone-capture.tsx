"use client";

import { Camera } from "lucide-react";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { type DocumentCapture, DocumentCamera, type FrameTelemetry } from "@/components/document-camera";
import { normalizeApiUrl } from "@/lib/api-url";
import { visibleRegion } from "@/lib/camera";
import { calibrationSummary } from "@/lib/calibration";
import { documentLabels } from "@/lib/i18n";
import type { QualityProfile } from "@/lib/quality-core";

const apiUrl = normalizeApiUrl(process.env.NEXT_PUBLIC_ONBOARDING_API_URL ?? "/api/onboarding");
const thumbnailEveryMs = 600;

/**
 * Phone side of the live calibration: the very same camera as the customer journey, streaming its
 * measurements to the workstation and applying the thresholds it pushes back in real time.
 */
export function CalibrationCapture() {
  const { id } = useParams<{ id: string }>();
  const [profile, setProfile] = useState<QualityProfile>();
  const [documentKind, setDocumentKind] = useState("dz-id");
  const [command, setCommand] = useState<{ command: "capture" | "torch"; at: string }>();
  const [error, setError] = useState<string>();
  const inFlight = useRef(false);
  const lastThumbnail = useRef(0);

  useEffect(() => {
    let alive = true;
    fetch(`${apiUrl}/dev/quality/calibrations/${id}`)
      .then(async (response) => {
        const payload = await response.json();
        if (!response.ok || !payload.calibration?.profile) throw new Error("invalid_calibration");
        if (!alive) return;
        setProfile(payload.calibration.profile);
        setDocumentKind(payload.calibration.documentKind ?? "dz-id");
      })
      .catch(() => alive && setError("Cette session de calibration n’est plus disponible."));
    const events = new EventSource(`${apiUrl}/dev/quality/calibrations/${id}/events`);
    events.addEventListener("profile", (event) => alive && setProfile(JSON.parse((event as MessageEvent).data)));
    events.addEventListener("snapshot", (event) => {
      const snapshot = JSON.parse((event as MessageEvent).data);
      if (!alive) return;
      setProfile(snapshot.profile);
      setDocumentKind(snapshot.documentKind ?? "dz-id");
    });
    events.addEventListener("command", (event) => alive && setCommand(JSON.parse((event as MessageEvent).data)));
    return () => {
      alive = false;
      events.close();
    };
  }, [id]);

  const onFrame = useCallback(
    async (telemetry: FrameTelemetry) => {
      if (inFlight.current) return;
      inFlight.current = true;
      try {
        const body = new FormData();
        body.set("client", JSON.stringify(calibrationSummary(telemetry.analysis, telemetry)));
        if (Date.now() - lastThumbnail.current > thumbnailEveryMs) {
          lastThumbnail.current = Date.now();
          const thumbnail = await videoThumbnail(telemetry.video, 720);
          if (thumbnail) body.set("file", thumbnail, "frame.jpg");
        }
        await fetch(`${apiUrl}/dev/quality/calibrations/${id}/frames`, {
          method: "POST",
          body,
          signal: AbortSignal.timeout(3_000),
        });
      } catch {
        // Telemetry is best effort; the camera keeps running.
      } finally {
        inFlight.current = false;
      }
    },
    [id],
  );

  const onCapture = useCallback(
    async ({ photo, result, trigger }: DocumentCapture) => {
      const body = new FormData();
      body.set("trigger", trigger);
      body.set(
        "client",
        JSON.stringify({
          ...calibrationSummary(result.analysis),
          burst: result.candidates,
          frameIndex: result.frameIndex,
        }),
      );
      body.set("file", photo, "capture.jpg");
      const response = await fetch(`${apiUrl}/dev/quality/calibrations/${id}/captures`, { method: "POST", body });
      if (!response.ok) throw new Error(`Envoi de la photo refusé par le serveur (${response.status}). Réessayez.`);
    },
    [id],
  );

  if (error)
    return (
      <main className="calibration-phone-state">
        <Camera size={28} />
        <strong>{error}</strong>
        <a className="button button-secondary" href="/dev/quality-lab">
          Retour au laboratoire
        </a>
      </main>
    );
  if (!profile)
    return (
      <main className="calibration-phone-state">
        <div className="spinner" />
      </main>
    );
  return (
    <main className="calibration-phone">
      <DocumentCamera
        key={documentKind}
        variant="calibration"
        locale="fr"
        profile={profile}
        documentKind={documentKind}
        documentLabel={documentLabels.fr[documentKind] ?? documentKind}
        sideLabel="Calibration en direct"
        autoCapture={false}
        command={command}
        onFrame={onFrame}
        onCapture={onCapture}
      />
    </main>
  );
}

/** Keep the workstation's live preview as the full camera view, not the final cropped photo. */
function videoThumbnail(video: HTMLVideoElement, maxSide: number) {
  const region = visibleRegion(video);
  const scale = Math.min(1, maxSide / Math.max(region.width, region.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(region.width * scale);
  canvas.height = Math.round(region.height * scale);
  canvas
    .getContext("2d")
    ?.drawImage(video, region.x, region.y, region.width, region.height, 0, 0, canvas.width, canvas.height);
  return new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.7));
}
