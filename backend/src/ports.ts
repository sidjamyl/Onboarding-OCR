import type { DocumentKind, DocumentSide, OnboardingSession, QualityReport } from "./domain/types.js";

export interface SessionRepository {
  create(session: OnboardingSession, idempotencyKey: string): Promise<OnboardingSession>;
  findById(id: string): Promise<OnboardingSession | null>;
  findByPublicToken(token: string): Promise<OnboardingSession | null>;
  mutateByPublicToken<T>(
    token: string,
    mutate: (session: OnboardingSession) => T,
  ): Promise<{ session: OnboardingSession; result: T } | null>;
  findExpiredBefore?(date: Date): Promise<OnboardingSession[]>;
  findPendingWork?(): Promise<OnboardingSession[]>;
  findOlderThan?(date: Date): Promise<OnboardingSession[]>;
  save(session: OnboardingSession): Promise<void>;
  purgeOlderThan?(date: Date): Promise<number>;
  health?(): Promise<boolean>;
}

export interface CaptureStore {
  put(key: string, data: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  remove(key: string): Promise<void>;
  health?(): Promise<boolean>;
}

export type QualityAssessment = {
  report: QualityReport;
  /** Rectified and enhanced copy for the OCR service, when preprocessing produced one. */
  ocrImage?: { image: Buffer; width: number; height: number; steps: Array<{ step: string; durationMs: number }> };
  /** Unenhanced ORB rectification, requested only by the development laboratory. */
  alignmentImage?: { image: Buffer; width: number; height: number };
};

export interface QualityEngine {
  analyze(image: Buffer, templateId?: string): Promise<QualityReport>;
  assess?(
    image: Buffer,
    options: { templateId?: string; documentKind?: string; prepare?: boolean },
  ): Promise<QualityAssessment>;
}

export type OcrInput = { name: string; data: Buffer; contentType: string };
export type ExtractionTask = { sessionId: string; kind: DocumentKind; side?: DocumentSide; captureId?: string };
export interface OcrGateway {
  listDocuments?(): Promise<Array<{ id: string; title: string; version: string }>>;
  verify?(documentType: string, file: OcrInput): Promise<Record<string, unknown> | void>;
  extract(kind: DocumentKind, files: OcrInput[]): Promise<Record<string, unknown>>;
  /** Extract one accepted face immediately; documentType includes its face. */
  extractSingle?(documentType: string, file: OcrInput): Promise<Record<string, unknown>>;
  health?(): Promise<boolean>;
}

export interface TaskQueue {
  enqueueExtraction(input: ExtractionTask): Promise<void>;
  enqueueWebhook(input: { sessionId: string }): Promise<void>;
  start(handlers?: {
    extraction?: (input: ExtractionTask) => Promise<void>;
    webhook?: (input: { sessionId: string }) => Promise<void>;
  }): Promise<void>;
  stop(): Promise<void>;
  health?(): Promise<boolean>;
}

export interface WebhookGateway {
  sendCompleted(session: OnboardingSession): Promise<void>;
  health?(): Promise<boolean>;
}
