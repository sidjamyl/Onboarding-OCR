import type { ConsistencyReport } from "./ocr-consistency/consistency.js";

export const documentKinds = ["dz-id", "dz-driving-licence", "dz-passport"] as const;

export type DocumentKind = (typeof documentKinds)[number];
export type DocumentSide = "front" | "back" | "single";
export type Locale = "fr" | "ar" | "en";

export type FinalStatus = "succeeded" | "document_failed" | "consistency_failed" | "technical_failed" | "expired";

export type SessionStatus =
  | "created"
  | "capturing"
  | "processing"
  | "awaiting_confirmation"
  | "awaiting_submission"
  | FinalStatus;

export type QualityCheck = {
  key: string;
  passed: boolean;
  status: "pass" | "warn" | "fail" | "not_applicable";
  value?: number | string;
  threshold?: number | string;
  message: string;
  /** Actionable instruction code shared with the phone guidance. */
  hint?: string;
  durationMs: number;
};

export type QualityReport = {
  passed: boolean;
  mode: "off" | "observe" | "enforce";
  checks: QualityCheck[];
  templateMatched: boolean;
  templateId?: string;
  homography?: number[];
  durationMs: number;
  /** First actionable instruction, in the configured guidance priority. */
  hint?: string;
  score?: number;
  diagnostics?: {
    geometry?: {
      /** Detected document corners normalised to the photo (top-left, top-right, bottom-right, bottom-left). */
      corners: Array<{ x: number; y: number }>;
      coverage: number;
      dpi?: number;
      angleDeviation?: number;
      method?: string;
    };
    metrics?: Record<string, number>;
    photo?: { width: number; height: number };
    selectedTemplateId?: string;
  };
};

export type OcrFields = Record<string, string | null>;

export type ProcessingStage = "photos_received" | "quality_validated" | "ocr_reading" | "field_validation";

export type ProcessingProgress = {
  stage: ProcessingStage;
  state: "active" | "retrying";
  startedAt: string;
  updatedAt: string;
};

export type Capture = {
  id: string;
  side: DocumentSide;
  objectKey: string;
  contentType?: string;
  /** Legacy/laboratory derivative; customer extraction always uses the unchanged guide crop. */
  ocrObjectKey?: string;
  createdAt: string;
  quality: QualityReport;
  timingsMs: Record<string, number>;
};

export type SideExtraction = {
  captureId: string;
  status: "pending" | "processing" | "ready";
  response?: Record<string, unknown>;
  technicalFailures: number;
  queuedAtEpochMs?: number;
  leaseUntil?: number;
  processingToken?: string;
};

export type DocumentState = {
  kind: DocumentKind;
  requiredSides: DocumentSide[];
  captures: Partial<Record<DocumentSide, Capture>>;
  sideResults?: Partial<Record<DocumentSide, SideExtraction>>;
  sideOcrAttempts?: Partial<Record<DocumentSide, number>>;
  joinedCaptureIds?: Partial<Record<DocumentSide, string>>;
  consistency?: ConsistencyReport;
  serverSubmissions: number;
  ocrAttempts: number;
  technicalFailures: number;
  fields?: OcrFields;
  sideFields?: Partial<Record<DocumentSide, OcrFields>>;
  /** Last valid values from a face being retaken; never exposed before identity continuity is checked. */
  retainedSideFields?: Partial<Record<DocumentSide, OcrFields>>;
  retainedSideCaptureIds?: Partial<Record<DocumentSide, string>>;
  reusedFieldKeys?: Partial<Record<DocumentSide, string[]>>;
  retakingSide?: DocumentSide;
  ocrResponse?: Record<string, unknown>;
  timingsMs: Record<string, number>;
  queuedAtEpochMs?: number;
  progress?: ProcessingProgress;
  unreadableFields: string[];
  confirmed: boolean;
  status: "pending" | "capturing" | "processing" | "incomplete" | "ready" | "failed";
  failureCode?: string;
};

export type OnboardingSession = {
  id: string;
  publicToken: string;
  clientReference: string;
  clientApplicationId: string;
  webhookDestinationId?: string;
  returnDestinationId?: string;
  webhookEventId: string;
  webhookQueuedAt?: string;
  webhookDeliveredAt?: string;
  policyId: string;
  /** Immutable rules resolved when this session was created. */
  policy?: Policy;
  returnUrl?: string;
  webhookDestination?: { url: string; secret: string };
  locale: Locale;
  status: SessionStatus;
  reasonCode?: string;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  resumeUntil: string;
  version: number;
  processedMutationKeys: string[];
  captureDeviceConnectedAt?: string;
  documents: Partial<Record<DocumentKind, DocumentState>>;
  consistency?: ConsistencyReport;
  result?: {
    fields: OcrFields;
    documents: Partial<Record<DocumentKind, OcrFields>>;
    completedAt: string;
  };
};

export type Policy = {
  id: string;
  version: number;
  label: string;
  selection: "all" | "minimum" | "exact";
  allowedDocuments: DocumentKind[];
  minimumDocuments: number;
  maximumDocuments?: number;
  requiredDocuments?: DocumentKind[];
};
