import type { DocumentSide, DocumentState, OcrFields } from "./types.js";

const strongKeys = ["nin", "document_number", "license_number", "passport_number", "serial_number"];

/** Reuse previous values only after the Gateway accepted that reading. */
export function rememberReadableSide(document: DocumentState, side: DocumentSide): void {
  const values = document.sideFields?.[side];
  if (!values) return;
  const response =
    document.sideResults?.[side]?.response ?? (document.ocrResponse?.[side] as Record<string, unknown> | undefined);
  const validation = response?.validation as Record<string, unknown> | undefined;
  const aggregate = document.ocrResponse?.validation as Record<string, unknown> | undefined;
  const rejected = new Set([
    ...strings(validation?.failedFields),
    ...strings(aggregate?.failedFields),
    ...strings(response?.unreadableFields),
  ]);
  if (
    response?.status === "failed" ||
    validation?.status === "failed" ||
    document.ocrResponse?.status === "failed" ||
    aggregate?.status === "failed"
  ) {
    document.retainedSideFields ??= {};
    document.retainedSideFields[side] = {};
    return;
  }
  const readable = Object.fromEntries(
    Object.entries(values).filter(([key, value]) => value?.trim() && !rejected.has(key)),
  );
  document.retainedSideFields ??= {};
  const previous = document.retainedSideFields[side] ?? {};
  const captureId = document.captures[side]?.id;
  const sameCapture = captureId && captureId === document.retainedSideCaptureIds?.[side];
  const retained = Object.fromEntries(
    Object.entries(sameCapture || sameHolder(previous, values) ? previous : {}).filter(([key]) => !rejected.has(key)),
  );
  document.retainedSideFields[side] = { ...retained, ...readable };
  if (captureId) {
    document.retainedSideCaptureIds ??= {};
    document.retainedSideCaptureIds[side] = captureId;
  }
}

/** Reuse missing values only when the new face still identifies the same document holder. */
export function reconcileSideReadings(
  document: DocumentState,
  fresh: Partial<Record<DocumentSide, OcrFields>>,
): Partial<Record<DocumentSide, OcrFields>> {
  const reused: Partial<Record<DocumentSide, OcrFields>> = {};
  document.reusedFieldKeys = {};
  for (const side of document.requiredSides) {
    const retainedCaptureId = document.retainedSideCaptureIds?.[side];
    const unchangedPhoto = Boolean(retainedCaptureId && retainedCaptureId === document.captures[side]?.id);
    const prior = document.retainedSideFields?.[side] ?? (unchangedPhoto ? document.sideFields?.[side] : undefined);
    const current = fresh[side];
    if (!prior || !current || (!unchangedPhoto && !sameHolder(prior, current))) continue;
    const recovered = Object.fromEntries(
      Object.entries(prior).filter(([key, value]) => value?.trim() && !current[key]?.trim()),
    );
    if (Object.keys(recovered).length === 0) continue;
    fresh[side] = { ...current, ...recovered };
    reused[side] = recovered;
    document.reusedFieldKeys[side] = Object.keys(recovered);
  }
  document.sideFields = fresh;
  delete document.retakingSide;
  return reused;
}

function sameHolder(previous: OcrFields, current: OcrFields): boolean {
  const comparable = strongKeys.filter((key) => previous[key] && current[key]);
  if (comparable.some((key) => normalize(previous[key]) !== normalize(current[key]))) return false;
  if (comparable.length > 0) return true;
  const sameBirth = previous.date_of_birth && current.date_of_birth && previous.date_of_birth === current.date_of_birth;
  const sameName = ["surname_ar", "surname_latin", "given_name_ar", "given_name_latin"].some(
    (key) => previous[key] && current[key] && normalize(previous[key]) === normalize(current[key]),
  );
  return Boolean(sameBirth && sameName);
}

function normalize(value: string | null | undefined): string {
  return (value ?? "").trim().toUpperCase().replace(/\s+/g, "");
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}
