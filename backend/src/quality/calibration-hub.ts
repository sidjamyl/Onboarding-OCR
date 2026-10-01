import { randomUUID } from "node:crypto";
import type { QualityReport } from "../domain/types.js";
import { parseQualityProfile, type QualityProfile } from "./profile.js";

/** What the phone measured on one live frame, with the same core as the server. */
export type ClientFrameReport = {
  score: number;
  passed: boolean;
  hint: string;
  quad?: Array<{ x: number; y: number }> | null;
  metrics?: Record<string, number>;
  checks?: Array<{ key: string; status: string; value: number | string; threshold: string }>;
  durationMs?: number;
  stablePasses?: number;
  camera?: { width: number; height: number; label?: string; torch?: boolean; zoom?: number };
};

export type CalibrationSample = { at: string; client?: ClientFrameReport };

export type CalibrationCapture = {
  at: string;
  trigger: "auto" | "manual" | "remote";
  client?: ClientFrameReport;
  server: QualityReport;
  ocr?: { width: number; height: number; steps: Array<{ step: string; durationMs: number; detail?: string }> };
  original: { width: number; height: number; bytes: number };
};

export type CalibrationSnapshot = {
  id: string;
  templateId?: string;
  documentKind: string;
  createdAt: string;
  expiresAt: string;
  profile: QualityProfile;
  latestSample?: CalibrationSample;
  samples: CalibrationSample[];
  latestCapture?: CalibrationCapture;
  captures: number;
  phone: { connectedAt?: string; lastSeenAt?: string; userAgent?: string };
};

type CalibrationSession = CalibrationSnapshot & {
  latestImage?: Buffer;
  captureOriginal?: Buffer;
  captureOcr?: Buffer;
  listeners: Set<(event: CalibrationEvent) => void>;
};

export type CalibrationEvent =
  | { type: "snapshot"; value: CalibrationSnapshot }
  | { type: "profile"; value: QualityProfile }
  | { type: "sample"; value: CalibrationSample }
  | { type: "capture"; value: CalibrationCapture }
  | { type: "command"; value: { command: "capture" | "torch"; at: string } }
  | { type: "phone"; value: CalibrationSnapshot["phone"] };

/**
 * Dev-only coordination between the phone and the calibration workstation. Frames and photos are
 * latest-wins and kept in memory for thirty minutes at most; nothing is persisted.
 */
export class CalibrationHub {
  private readonly sessions = new Map<string, CalibrationSession>();

  create(profile: QualityProfile, options: { templateId?: string; documentKind?: string } = {}): CalibrationSnapshot {
    this.prune();
    const createdAt = new Date();
    const session: CalibrationSession = {
      id: randomUUID().replaceAll("-", ""),
      ...(options.templateId ? { templateId: options.templateId } : {}),
      documentKind: options.documentKind ?? "dz-id",
      createdAt: createdAt.toISOString(),
      expiresAt: new Date(createdAt.getTime() + 30 * 60_000).toISOString(),
      profile: structuredClone(profile),
      samples: [],
      captures: 0,
      phone: {},
      listeners: new Set(),
    };
    this.sessions.set(session.id, session);
    return this.snapshot(session);
  }

  get(id: string): CalibrationSnapshot | null {
    const session = this.live(id);
    return session ? this.snapshot(session) : null;
  }

  updateProfile(id: string, input: unknown): CalibrationSnapshot | null {
    const session = this.live(id);
    if (!session) return null;
    session.profile = parseQualityProfile(input);
    this.emit(session, { type: "profile", value: structuredClone(session.profile) });
    return this.snapshot(session);
  }

  setDocumentKind(id: string, documentKind: string, templateId?: string): CalibrationSnapshot | null {
    const session = this.live(id);
    if (!session) return null;
    session.documentKind = documentKind;
    if (templateId) session.templateId = templateId;
    else delete session.templateId;
    this.emit(session, { type: "snapshot", value: this.snapshot(session) });
    return this.snapshot(session);
  }

  receive(
    id: string,
    input: { image?: Buffer; client?: ClientFrameReport; userAgent?: string },
  ): CalibrationSnapshot | null {
    const session = this.live(id);
    if (!session) return null;
    const sample: CalibrationSample = {
      at: new Date().toISOString(),
      ...(input.client ? { client: input.client } : {}),
    };
    if (input.image) session.latestImage = input.image;
    session.samples.push(sample);
    if (session.samples.length > 120) session.samples.shift();
    session.latestSample = sample;
    this.touchPhone(session, input.userAgent);
    this.emit(session, { type: "sample", value: sample });
    return this.snapshot(session);
  }

  storeCapture(
    id: string,
    input: {
      original: Buffer;
      ocrImage?: Buffer;
      capture: Omit<CalibrationCapture, "at">;
      userAgent?: string;
    },
  ): CalibrationCapture | null {
    const session = this.live(id);
    if (!session) return null;
    const capture: CalibrationCapture = { at: new Date().toISOString(), ...input.capture };
    session.captureOriginal = input.original;
    if (input.ocrImage) session.captureOcr = input.ocrImage;
    else delete session.captureOcr;
    session.latestCapture = capture;
    session.captures += 1;
    this.touchPhone(session, input.userAgent);
    this.emit(session, { type: "capture", value: capture });
    return capture;
  }

  replaceOcr(id: string, ocrImage: Buffer | undefined, ocr: CalibrationCapture["ocr"], server: QualityReport) {
    const session = this.live(id);
    if (!session?.latestCapture) return null;
    if (ocrImage) session.captureOcr = ocrImage;
    else delete session.captureOcr;
    const { ocr: _previous, ...rest } = session.latestCapture;
    session.latestCapture = { ...rest, server, ...(ocr ? { ocr } : {}), at: new Date().toISOString() };
    this.emit(session, { type: "capture", value: session.latestCapture });
    return session.latestCapture;
  }

  command(id: string, command: "capture" | "torch"): boolean {
    const session = this.live(id);
    if (!session) return false;
    this.emit(session, { type: "command", value: { command, at: new Date().toISOString() } });
    return true;
  }

  image(id: string): Buffer | null {
    return this.live(id)?.latestImage ?? null;
  }

  captureImage(id: string, variant: "original" | "ocr"): Buffer | null {
    const session = this.live(id);
    return (variant === "original" ? session?.captureOriginal : session?.captureOcr) ?? null;
  }

  subscribe(id: string, listener: (event: CalibrationEvent) => void): (() => void) | null {
    const session = this.live(id);
    if (!session) return null;
    session.listeners.add(listener);
    listener({ type: "snapshot", value: this.snapshot(session) });
    return () => session.listeners.delete(listener);
  }

  private touchPhone(session: CalibrationSession, userAgent?: string) {
    const now = new Date().toISOString();
    const connected = !session.phone.connectedAt;
    session.phone = {
      connectedAt: session.phone.connectedAt ?? now,
      lastSeenAt: now,
      ...(userAgent ? { userAgent } : session.phone.userAgent ? { userAgent: session.phone.userAgent } : {}),
    };
    if (connected) this.emit(session, { type: "phone", value: session.phone });
  }

  private live(id: string) {
    const session = this.sessions.get(id);
    if (!session) return null;
    if (Date.parse(session.expiresAt) <= Date.now()) {
      this.sessions.delete(id);
      return null;
    }
    return session;
  }

  private snapshot(session: CalibrationSession): CalibrationSnapshot {
    const {
      listeners: _listeners,
      latestImage: _image,
      captureOriginal: _original,
      captureOcr: _ocr,
      ...snapshot
    } = session;
    return structuredClone(snapshot);
  }

  private emit(session: CalibrationSession, event: CalibrationEvent) {
    for (const listener of session.listeners) listener(event);
  }

  private prune() {
    for (const [id, session] of this.sessions)
      if (Date.parse(session.expiresAt) <= Date.now()) this.sessions.delete(id);
  }
}
