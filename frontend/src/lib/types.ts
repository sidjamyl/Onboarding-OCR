export type DocumentKind = "dz-id" | "dz-driving-licence" | "dz-passport";
export type DocumentSide = "front" | "back" | "single";
export type Locale = "fr" | "ar" | "en";
export type ProcessingStage = "photos_received" | "quality_validated" | "ocr_reading" | "field_validation";

export type ConsistencyReading = {
  document: "id" | "driving_licence" | "passport";
  side?: DocumentSide;
  value: unknown;
};
export type ConsistencyCheck = {
  id: string;
  field: string;
  label: string;
  status: "passed" | "warning" | "failed" | "not_checked";
  message: string;
  readings: ConsistencyReading[];
  suggestedRetry?: { document: ConsistencyReading["document"]; side?: DocumentSide };
};
export type ConsistencyReport = {
  checks: ConsistencyCheck[];
  blocking: boolean;
  warnings: number;
  notChecked: number;
};

export type QualityReport = {
  passed: boolean;
  mode: "off" | "observe" | "enforce";
  checks: Array<{
    key: string;
    passed: boolean;
    status: "pass" | "warn" | "fail" | "not_applicable";
    value?: number | string;
    threshold?: number | string;
    message: string;
    hint?: string;
    durationMs: number;
  }>;
  hint?: string;
  score?: number;
  durationMs: number;
  diagnostics?: {
    geometry?: { corners: Array<{ x: number; y: number }>; coverage: number; dpi?: number; method?: string };
    metrics?: Record<string, number>;
    photo?: { width: number; height: number };
  };
};

export type PublicSession = {
  sessionId: string;
  version: number;
  captureDeviceConnected: boolean;
  policyId: string;
  documentSelection: {
    mode: "all" | "minimum" | "exact";
    allowedDocuments: DocumentKind[];
    minimumDocuments: number;
    maximumDocuments?: number;
    requiredDocuments?: DocumentKind[];
  };
  locale: Locale;
  status: string;
  reasonCode: string | null;
  expiresAt: string;
  returnUrl: string | null;
  consistency?: ConsistencyReport;
  documents: Partial<
    Record<
      DocumentKind,
      {
        kind: DocumentKind;
        requiredSides: DocumentSide[];
        captures: Partial<Record<DocumentSide, { id: string; quality: QualityReport }>>;
        serverSubmissions: number;
        ocrAttempts: number;
        sideOcrAttempts?: Partial<Record<DocumentSide, number>>;
        technicalFailures: number;
        queuedAtEpochMs?: number;
        progress?: {
          stage: ProcessingStage;
          state: "active" | "retrying";
          startedAt: string;
          updatedAt: string;
        };
        fields?: Record<string, string | null>;
        sideFields?: Partial<Record<DocumentSide, Record<string, string | null>>>;
        reusedFieldKeys?: Partial<Record<DocumentSide, string[]>>;
        retakingSide?: DocumentSide;
        consistency?: ConsistencyReport;
        unreadableFields: string[];
        confirmed: boolean;
        status: "pending" | "capturing" | "processing" | "incomplete" | "ready" | "failed";
      }
    >
  >;
};
