import { randomUUID } from "node:crypto";
import { crossDocumentConsistency } from "./ocr-consistency/consistency.js";
import { rememberReadableSide } from "./reading-continuity.js";
import { policies, requiredSides, sessionPolicy } from "./policies.js";
import type {
  DocumentKind,
  DocumentState,
  Locale,
  OcrFields,
  OnboardingSession,
  ProcessingStage,
  QualityReport,
  Policy,
} from "./types.js";

const MAX_OCR_ATTEMPTS = 3;
const MAX_SERVER_SUBMISSIONS = 10;
export const canonicalDocumentOrder: DocumentKind[] = ["dz-id", "dz-driving-licence", "dz-passport"];

export class DomainError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode = 400,
  ) {
    super(message);
  }
}

export function createSession(input: {
  clientReference: string;
  clientApplicationId?: string | undefined;
  webhookDestinationId?: string | undefined;
  returnDestinationId?: string | undefined;
  policyId: string;
  policy?: Policy;
  locale: Locale;
  now?: Date;
}): OnboardingSession {
  const policy = input.policy ?? policies[input.policyId];
  if (!policy) throw new DomainError("unknown_policy", "Unknown onboarding policy");
  const now = input.now ?? new Date();
  const expiresAt = new Date(now.valueOf() + 30 * 60_000);
  const resumeUntil = new Date(now.valueOf() + 30 * 60_000);
  const documents = Object.fromEntries(
    (policy.selection === "all" ? policy.allowedDocuments : []).map((kind) => [kind, newDocument(kind)]),
  );
  return {
    id: randomUUID(),
    publicToken: randomUUID().replaceAll("-", ""),
    clientReference: input.clientReference,
    clientApplicationId: input.clientApplicationId ?? "default",
    ...(input.webhookDestinationId ? { webhookDestinationId: input.webhookDestinationId } : {}),
    ...(input.returnDestinationId ? { returnDestinationId: input.returnDestinationId } : {}),
    webhookEventId: randomUUID(),
    policyId: input.policyId,
    policy: structuredClone(policy),
    locale: input.locale,
    status: "created",
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
    resumeUntil: resumeUntil.toISOString(),
    version: 1,
    processedMutationKeys: [],
    documents,
  };
}

export function selectDocuments(session: OnboardingSession, kinds: DocumentKind[]): void {
  assertActive(session);
  if (
    Object.values(session.documents).some(
      (document) => document && (document.ocrAttempts > 0 || Object.keys(document.captures).length > 0),
    )
  ) {
    throw new DomainError("document_selection_locked", "Document selection is locked after the first OCR attempt", 409);
  }
  const policy = sessionPolicy(session);
  if (!policy) throw new DomainError("invalid_policy_state", "Session policy is unavailable", 500);
  const distinct = [...new Set(kinds)];
  if (distinct.length !== kinds.length)
    throw new DomainError("invalid_document_selection", "Select each document only once");
  if (policy.requiredDocuments?.some((kind) => !distinct.includes(kind)))
    throw new DomainError("invalid_document_selection", "Include every mandatory document");
  if (distinct.length > (policy.maximumDocuments ?? policy.allowedDocuments.length))
    throw new DomainError("invalid_document_selection", "Too many documents selected");
  if (policy.selection === "all") {
    if (
      distinct.length !== policy.allowedDocuments.length ||
      distinct.some((kind) => !policy.allowedDocuments.includes(kind))
    ) {
      throw new DomainError("invalid_document_selection", "This policy requires all configured documents");
    }
  } else if (
    distinct.length < policy.minimumDocuments ||
    distinct.some((kind) => !policy.allowedDocuments.includes(kind))
  ) {
    throw new DomainError("invalid_document_selection", `Choose at least ${policy.minimumDocuments} allowed documents`);
  }
  session.documents = Object.fromEntries(
    (policy.selection === "all" ? policy.allowedDocuments : canonicalDocumentOrder)
      .filter((kind) => distinct.includes(kind))
      .map((kind) => [kind, newDocument(kind)]),
  );
  touch(session, "capturing");
}

export function registerCapture(
  session: OnboardingSession,
  input: {
    kind: DocumentKind;
    side: "front" | "back" | "single";
    objectKey: string;
    contentType?: string;
    ocrObjectKey?: string;
    quality: QualityReport;
    timingsMs?: Record<string, number>;
  },
): string {
  assertCaptureAllowed(session, input);
  const document = requireDocument(session, input.kind);
  document.serverSubmissions += 1;
  if (document.serverSubmissions > MAX_SERVER_SUBMISSIONS) {
    failDocument(session, document, "submission_limit_reached");
    throw new DomainError("submission_limit_reached", "Maximum server submissions reached", 422);
  }
  if (!input.quality.passed) {
    const extracting = Object.values(document.sideResults ?? {}).some((result) => result?.status !== "ready");
    document.status = extracting ? "processing" : "capturing";
    touch(session, extracting ? "processing" : "capturing");
    throw new DomainError("quality_rejected", "Capture quality is insufficient", 422);
  }
  const captureId = randomUUID();
  document.captures[input.side] = {
    id: captureId,
    side: input.side,
    objectKey: input.objectKey,
    ...(input.contentType ? { contentType: input.contentType } : {}),
    ...(input.ocrObjectKey ? { ocrObjectKey: input.ocrObjectKey } : {}),
    quality: input.quality,
    timingsMs: input.timingsMs ?? {},
    createdAt: new Date().toISOString(),
  };
  document.sideResults ??= {};
  document.sideResults[input.side] = { captureId, status: "pending", technicalFailures: 0 };
  document.confirmed = false;
  document.status = "processing";
  delete document.consistency;
  delete document.joinedCaptureIds;
  recomputeSessionConsistency(session);
  delete session.reasonCode;
  if (document.status === "processing") {
    const now = new Date().toISOString();
    document.progress = { stage: "quality_validated", state: "active", startedAt: now, updatedAt: now };
  }
  touch(session, document.status === "processing" ? "processing" : "capturing");
  return captureId;
}

/** Preflight before expensive processing; registerCapture rechecks during mutation. */
export function assertCaptureAllowed(
  session: OnboardingSession,
  input: { kind: DocumentKind; side: "front" | "back" | "single" },
): void {
  assertActive(session);
  const document = requireDocument(session, input.kind);
  const currentKind = currentDocumentKind(session);
  if (currentKind && input.kind !== currentKind) {
    throw new DomainError("document_locked", "Complete the current document before capturing the next one", 409);
  }
  if (!document.requiredSides.includes(input.side)) throw new DomainError("invalid_side", "Unexpected document side");
  if (document.captures[input.side] || document.status === "incomplete" || document.status === "ready") {
    throw new DomainError("document_not_capturable", "Retake the document before submitting another capture", 409);
  }
}

export function markProcessingStage(
  session: OnboardingSession,
  kind: DocumentKind,
  stage: ProcessingStage,
  state: "active" | "retrying" = "active",
): void {
  const document = requireDocument(session, kind);
  if (document.status !== "processing") return;
  const now = new Date().toISOString();
  document.progress = {
    stage,
    state,
    startedAt: document.progress?.startedAt ?? now,
    updatedAt: now,
  };
  session.status = "processing";
  session.updatedAt = now;
  session.version += 1;
}

export function registerOcrResult(
  session: OnboardingSession,
  kind: DocumentKind,
  fields: OcrFields,
  unreadableFields: string[],
  fatalReason?: string,
): void {
  assertActive(session);
  const document = requireDocument(session, kind);
  document.ocrAttempts += 1;
  document.fields = fields;
  recomputeSessionConsistency(session);
  if (fatalReason) {
    failDocument(session, document, fatalReason);
    return;
  }
  if (unreadableFields.length > 0) {
    document.unreadableFields = unreadableFields;
    document.status = document.ocrAttempts >= MAX_OCR_ATTEMPTS ? "failed" : "incomplete";
    if (document.status === "failed") {
      failDocument(session, document, "ocr_attempts_exhausted");
      return;
    }
    touch(session, "awaiting_confirmation");
    return;
  }
  document.fields = fields;
  document.unreadableFields = [];
  document.status = "ready";
  if (document.consistency?.blocking) {
    updateConsistencyConflict(session, document.consistency.checks);
    return;
  }
  touch(session, "awaiting_confirmation");
}

export function confirmDocument(session: OnboardingSession, kind: DocumentKind): void {
  assertActive(session);
  const currentKind = currentDocumentKind(session);
  if (currentKind && kind !== currentKind)
    throw new DomainError("document_locked", "Complete the current document before confirming the next one", 409);
  const document = requireDocument(session, kind);
  if (document.status !== "ready" || !document.fields || document.unreadableFields.length > 0) {
    throw new DomainError("document_not_ready", "Document is not ready for confirmation", 409);
  }
  if (document.consistency?.blocking) {
    throw new DomainError("consistency_conflict", "Resolve the cross-face conflict before confirming", 409);
  }
  document.confirmed = true;
  const documents = Object.values(session.documents).filter(Boolean) as DocumentState[];
  if (!documents.every((item) => item.confirmed)) {
    touch(session, "capturing");
    return;
  }
  recomputeSessionConsistency(session);
  if (session.consistency?.blocking) {
    updateConsistencyConflict(session);
    return;
  }
  const merged: OcrFields = {};
  const byDocument: Partial<Record<DocumentKind, OcrFields>> = {};
  for (const document of documents) {
    const fields = document.fields;
    if (!fields) throw new DomainError("document_not_ready", "Confirmed document has no OCR fields", 409);
    byDocument[document.kind] = fields;
    Object.assign(merged, fields);
  }
  session.result = { fields: merged, documents: byDocument, completedAt: new Date().toISOString() };
  touch(session, "awaiting_submission");
}

/** Final submission is separate from reading confirmation so the user can inspect the full summary. */
export function submitSession(session: OnboardingSession): void {
  assertActive(session);
  if (session.status !== "awaiting_submission" || !session.result)
    throw new DomainError("session_not_ready", "Confirm every document before submitting", 409);
  recomputeSessionConsistency(session);
  if (
    Object.values(session.documents).some((document) => !document?.confirmed || document.consistency?.blocking) ||
    session.consistency?.blocking
  ) {
    delete session.result;
    const faceConflicts = Object.values(session.documents).flatMap((document) =>
      document?.consistency?.blocking ? document.consistency.checks : [],
    );
    if (session.consistency?.blocking || faceConflicts.length) {
      updateConsistencyConflict(session, [...(session.consistency?.checks ?? []), ...faceConflicts]);
    } else {
      touch(session, "awaiting_confirmation");
    }
    throw new DomainError("consistency_conflict", "Resolve all consistency conflicts before submitting", 409);
  }
  session.result.completedAt = new Date().toISOString();
  touch(session, "succeeded");
}

export function retakeDocument(session: OnboardingSession, kind: DocumentKind): void {
  assertActive(session);
  const document = requireDocument(session, kind);
  if (
    document.ocrAttempts >= MAX_OCR_ATTEMPTS ||
    document.requiredSides.some((side) => (document.sideOcrAttempts?.[side] ?? 0) >= MAX_OCR_ATTEMPTS)
  ) {
    exhaustedRetake(session, document);
    return;
  }
  document.captures = {};
  delete document.sideResults;
  delete document.joinedCaptureIds;
  delete document.consistency;
  delete document.fields;
  delete document.sideFields;
  delete document.retainedSideFields;
  delete document.retainedSideCaptureIds;
  delete document.reusedFieldKeys;
  delete document.retakingSide;
  delete document.ocrResponse;
  delete document.failureCode;
  delete document.queuedAtEpochMs;
  delete document.progress;
  document.unreadableFields = [];
  document.confirmed = false;
  document.status = "capturing";
  delete session.result;
  delete session.reasonCode;
  recomputeSessionConsistency(session);
  touch(session, "capturing");
}

/** Keep the opposite face; only the selected capture and its derived OCR result become invalid. */
export function retakeSide(
  session: OnboardingSession,
  kind: DocumentKind,
  side: DocumentState["requiredSides"][number],
): void {
  assertActive(session);
  const document = requireDocument(session, kind);
  if (!document.requiredSides.includes(side)) throw new DomainError("invalid_side", "Unexpected document side");
  if (document.ocrAttempts >= MAX_OCR_ATTEMPTS || (document.sideOcrAttempts?.[side] ?? 0) >= MAX_OCR_ATTEMPTS) {
    exhaustedRetake(session, document);
    return;
  }
  for (const capturedSide of document.requiredSides) {
    rememberReadableSide(document, capturedSide);
    const capture = document.captures[capturedSide];
    const response = document.ocrResponse?.[capturedSide];
    if (
      capturedSide !== side &&
      capture &&
      !document.sideResults?.[capturedSide] &&
      response &&
      typeof response === "object" &&
      "fields" in response
    ) {
      document.sideResults ??= {};
      document.sideResults[capturedSide] = {
        captureId: capture.id,
        status: "ready",
        technicalFailures: 0,
        response: response as Record<string, unknown>,
      };
    }
  }
  delete document.captures[side];
  if (document.sideResults) delete document.sideResults[side];
  delete document.joinedCaptureIds;
  delete document.consistency;
  delete document.fields;
  if (document.sideFields) delete document.sideFields[side];
  if (document.reusedFieldKeys) delete document.reusedFieldKeys[side];
  document.retakingSide = side;
  delete document.ocrResponse;
  delete document.failureCode;
  delete document.queuedAtEpochMs;
  delete document.progress;
  delete session.result;
  document.unreadableFields = [];
  document.confirmed = false;
  document.status = "capturing";
  delete session.reasonCode;
  recomputeSessionConsistency(session);
  touch(session, "capturing");
}

export function expireIfNeeded(session: OnboardingSession, now = new Date()): void {
  if (
    session.status !== "processing" &&
    !isFinal(session.status) &&
    now.valueOf() >= new Date(session.expiresAt).valueOf()
  ) {
    touch(session, "expired");
    session.reasonCode = "session_expired";
  }
}

function newDocument(kind: DocumentKind): DocumentState {
  return {
    kind,
    requiredSides: requiredSides(kind),
    captures: {},
    serverSubmissions: 0,
    ocrAttempts: 0,
    technicalFailures: 0,
    unreadableFields: [],
    timingsMs: {},
    confirmed: false,
    status: "pending",
  };
}

function requireDocument(session: OnboardingSession, kind: DocumentKind): DocumentState {
  const document = session.documents[kind];
  if (!document) throw new DomainError("document_not_selected", "Document is not part of this session", 404);
  return document;
}

function currentDocumentKind(session: OnboardingSession): DocumentKind | undefined {
  const policy = sessionPolicy(session);
  const order = policy?.selection === "all" ? policy.allowedDocuments : canonicalDocumentOrder;
  return order.find((kind) => {
    const document = session.documents[kind];
    return document && !document.confirmed;
  });
}

function assertActive(session: OnboardingSession): void {
  expireIfNeeded(session);
  if (isFinal(session.status)) throw new DomainError("session_closed", "Session is already closed", 409);
}

function failDocument(session: OnboardingSession, document: DocumentState, reasonCode: string): void {
  document.status = "failed";
  document.failureCode = reasonCode;
  session.reasonCode = reasonCode;
  touch(session, "document_failed");
}

const consistencyNames = {
  "dz-id": "id",
  "dz-driving-licence": "driving_licence",
  "dz-passport": "passport",
} as const;

const fieldAliases: Record<string, string[]> = {
  lastNameLatin: ["surname_latin", "last_name_latin"],
  firstNameLatin: ["given_name_latin", "first_name_latin"],
  lastNameArabic: ["surname_ar", "last_name_ar"],
  firstNameArabic: ["given_name_ar", "first_name_ar"],
  nin: ["nin", "personal_number"],
  dateOfBirth: ["date_of_birth", "birth_date"],
  sex: ["sex", "gender"],
};

/** Recalculate from the selected documents; an unavailable reading remains an unchecked comparison. */
export function recomputeSessionConsistency(session: OnboardingSession): void {
  session.consistency = crossDocumentConsistency(
    (Object.values(session.documents).filter(Boolean) as DocumentState[]).map((document) => {
      const fieldSides: Record<string, DocumentState["requiredSides"][number]> = {};
      const merged = document.ocrResponse?.mergedFields as Record<string, unknown> | undefined;
      const sources = document.ocrResponse?.mergedFieldSources as Record<string, unknown> | undefined;
      for (const [field, aliases] of Object.entries(fieldAliases)) {
        const selectedKey = [field, ...aliases]
          .flatMap((key) => [key, `front_${key}`, `back_${key}`])
          .find((key) => merged?.[key] != null && merged[key] !== "");
        const source = selectedKey ? sources?.[selectedKey] : undefined;
        const side =
          source === "front" || source === "back"
            ? source
            : source
              ? undefined
              : document.kind === "dz-passport"
                ? "single"
                : document.requiredSides.find((candidate) =>
                    [field, ...aliases].some((key) => document.sideFields?.[candidate]?.[key]?.trim()),
                  );
        if (side) fieldSides[field] = side;
      }
      return { document: consistencyNames[document.kind], fields: document.fields ?? {}, fieldSides };
    }),
      { scope: "onboarding" },
  );
}

function updateConsistencyConflict(session: OnboardingSession, checks = session.consistency?.checks ?? []): void {
  const conflicts = checks.filter((check) => check.status === "failed");
  const retryable = conflicts.some((check) =>
    check.readings.some((reading) => {
      const kind = canonicalDocumentOrder.find((candidate) => consistencyNames[candidate] === reading.document);
      const document = kind ? session.documents[kind] : undefined;
      if (!document || document.ocrAttempts >= MAX_OCR_ATTEMPTS) return false;
      return reading.side
        ? (document.sideOcrAttempts?.[reading.side] ?? 0) < MAX_OCR_ATTEMPTS
        : document.requiredSides.some((side) => (document.sideOcrAttempts?.[side] ?? 0) < MAX_OCR_ATTEMPTS);
    }),
  );
  delete session.result;
  session.reasonCode = "consistency_mismatch";
  touch(session, retryable ? "awaiting_confirmation" : "consistency_failed");
}

function exhaustedRetake(session: OnboardingSession, document: DocumentState): void {
  if (session.consistency?.blocking || document.consistency?.blocking) {
    throw new DomainError(
      "ocr_attempts_exhausted",
      "Choose another implicated reading; this document has exhausted its attempts",
      422,
    );
  }
  failDocument(session, document, "ocr_attempts_exhausted");
}

function touch(session: OnboardingSession, status: OnboardingSession["status"]): void {
  const now = new Date();
  session.status = status;
  session.updatedAt = now.toISOString();
  session.expiresAt = new Date(now.valueOf() + 30 * 60_000).toISOString();
  session.resumeUntil = session.expiresAt;
  session.version += 1;
}

function isFinal(status: OnboardingSession["status"]): status is import("./types.js").FinalStatus {
  return ["succeeded", "document_failed", "consistency_failed", "technical_failed", "expired"].includes(status);
}
