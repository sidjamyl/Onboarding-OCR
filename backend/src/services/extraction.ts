import { randomUUID } from "node:crypto";
import { combineDocumentSides, type SideExtraction } from "../domain/ocr-consistency/consistency.js";
import { normalizeDate, normalizeIdentifier, normalizeOcrFields } from "../domain/normalization.js";
import { missingRequiredFields, type RequiredFieldsConfig } from "../domain/requirements.js";
import { reconcileSideReadings } from "../domain/reading-continuity.js";
import type { DocumentKind, DocumentSide, OnboardingSession, OcrFields } from "../domain/types.js";
import { markProcessingStage, registerOcrResult } from "../domain/workflow.js";
import type { CaptureStore, ExtractionTask, OcrGateway, SessionRepository, TaskQueue } from "../ports.js";
import { DurableTaskDispatcher } from "./durable-tasks.js";
import { OcrRequestError } from "../adapters/ocr-http.js";
import { retakeSide } from "../domain/workflow.js";
import { createDemoTrace, writeTrace } from "./demo-trace.js";

const aliases: Record<string, string[]> = {
  lastNameLatin: ["lastNameLatin", "surname_latin", "last_name_latin", "nom_latin", "surname"],
  firstNameLatin: ["firstNameLatin", "given_name_latin", "first_name_latin", "prenom_latin", "given_names"],
  lastNameArabic: ["lastNameArabic", "surname_ar", "last_name_arabic", "nom_arabe", "nom_ar"],
  firstNameArabic: ["firstNameArabic", "given_name_ar", "first_name_arabic", "prenom_arabe", "prenom_ar"],
  nin: ["nin", "personal_number", "national_identification_number", "numero_identification_national"],
  documentNumber: [
    "documentNumber",
    "document_number",
    "front_document_number",
    "back_document_number",
    "license_number",
    "serial_number",
    "numero_document",
    "passport_number",
  ],
  dateOfBirth: ["dateOfBirth", "date_of_birth", "date_naissance"],
  expiryDate: [
    "expiryDate",
    "date_of_expiry",
    "expiry_date",
    "front_date_of_expiry_printed",
    "back_date_of_expiry_printed",
    "date_expiration",
    "date_fin_validite",
  ],
};

export class ExtractionService {
  private readonly tasks: DurableTaskDispatcher;

  constructor(
    private readonly dependencies: {
      sessions: SessionRepository;
      captures: CaptureStore;
      ocr: OcrGateway;
      queue: TaskQueue;
      requiredFields: RequiredFieldsConfig;
      trace?: { enabled: boolean; directory: string };
    },
  ) {
    this.tasks = new DurableTaskDispatcher(dependencies.sessions, dependencies.queue);
  }

  async process(input: ExtractionTask): Promise<void> {
    const session = await this.dependencies.sessions.findById(input.sessionId);
    if (!session || isClosed(session)) return;
    const document = session.documents[input.kind];
    if (!document) return;
    const sides = input.side ? [input.side] : document.requiredSides;
    await Promise.all(sides.map((side) => this.processSide(session.publicToken, input, side)));
    // Also recovers a persisted pair that was not joined before a worker restart.
    await this.mutate(session.publicToken, (latest) => this.joinLatest(latest, input.kind));
  }

  private async processSide(token: string, input: ExtractionTask, side: DocumentSide): Promise<void> {
    const processingToken = randomUUID();
    const claim = await this.mutate(token, (session) => {
      const document = session.documents[input.kind];
      const capture = document?.captures[side];
      if (isClosed(session) || !document || !capture || (input.captureId && input.captureId !== capture.id)) return;
      document.sideResults ??= {};
      const previous = document.sideResults[side];
      if (
        previous?.captureId === capture.id &&
        (previous.status === "ready" || (previous.status === "processing" && (previous.leaseUntil ?? 0) > Date.now()))
      )
        return;
      document.sideResults[side] = {
        captureId: capture.id,
        status: "processing",
        processingToken,
        leaseUntil: Date.now() + 240_000,
        technicalFailures: previous?.captureId === capture.id ? previous.technicalFailures : 0,
        queuedAtEpochMs: previous?.queuedAtEpochMs ?? Date.now(),
      };
      session.version += 1;
      session.updatedAt = new Date().toISOString();
      markProcessingStage(session, input.kind, "ocr_reading");
      return { capture: structuredClone(capture), captureId: capture.id };
    });
    if (!claim?.result) return;
    const { capture, captureId } = claim.result;
    const started = performance.now();
    const trace = await createDemoTrace(
      this.dependencies.trace?.enabled ?? false,
      this.dependencies.trace?.directory ?? ".local/traces",
      `${input.sessionId}-${input.kind}-${side}-extraction`,
    );
    try {
      // Admission's guide crop is the only input; never substitute an enhanced derivative.
      const data = await this.dependencies.captures.get(capture.objectKey);
      const storageRead = round(performance.now() - started);
      await writeTrace(trace, `${side}.jpg`, data);
      const ocrStarted = performance.now();
      const file = { name: side, data, contentType: capture.contentType ?? "image/jpeg" };
      const type = side === "single" ? input.kind : `${input.kind}-${side}`;
      if (!this.dependencies.ocr.extractSingle && side !== "single")
        throw new Error("OCR gateway does not support face extraction");
      const response = this.dependencies.ocr.extractSingle
        ? await this.dependencies.ocr.extractSingle(type, file)
        : await this.dependencies.ocr.extract(input.kind, [file]);
      const ocrMs = round(performance.now() - ocrStarted);
      const saved = await this.mutate(token, (session) => {
        const document = session.documents[input.kind];
        const result = document?.sideResults?.[side];
        if (
          isClosed(session) ||
          !document ||
          document.captures[side]?.id !== captureId ||
          result?.processingToken !== processingToken
        )
          return false;
        result.status = "ready";
        result.response = response;
        delete result.processingToken;
        delete result.leaseUntil;
        document.sideOcrAttempts ??= {};
        document.sideOcrAttempts[side] = (document.sideOcrAttempts[side] ?? 0) + 1;
        document.sideFields ??= {};
        document.sideFields[side] = displayFields(findFields(response));
        document.timingsMs[`storageRead.${side}`] = storageRead;
        document.timingsMs[`ocr.${side}`] = ocrMs;
        document.timingsMs[`totalProcessing.${side}`] = round(performance.now() - started);
        session.version += 1;
        session.updatedAt = new Date().toISOString();
        this.joinLatest(session, input.kind);
        if (
          document.requiredSides.some((required) => !document.captures[required]) &&
          Object.values(document.sideResults ?? {}).every((reading) => reading?.status === "ready")
        ) {
          document.status = "capturing";
          if (session.status === "processing") session.status = "capturing";
        }
        return true;
      });
      if (saved?.result)
        await writeTrace(trace, "result.json", {
          status: saved.session.documents[input.kind]?.status,
          fieldNames: Object.keys(saved.session.documents[input.kind]?.sideFields?.[side] ?? {}),
          timingsMs: saved.session.documents[input.kind]?.timingsMs,
        });
    } catch (error) {
      const refused = error instanceof OcrRequestError && error.response.error === "document_not_verified";
      const mutation = await this.mutate(token, (session) => {
        const document = session.documents[input.kind];
        const result = document?.sideResults?.[side];
        if (
          isClosed(session) ||
          !document ||
          document.captures[side]?.id !== captureId ||
          result?.processingToken !== processingToken
        )
          return false;
        if (refused) {
          retakeSide(session, input.kind, side);
          session.reasonCode = "document_not_verified";
          return true;
        }
        result.technicalFailures += 1;
        document.technicalFailures += 1;
        delete result.processingToken;
        delete result.leaseUntil;
        result.status = "pending";
        if (result.technicalFailures >= 3) {
          document.status = "failed";
          document.failureCode = "ocr_unavailable";
          session.status = "technical_failed";
          session.reasonCode = "ocr_unavailable";
          session.version += 1;
          session.updatedAt = new Date().toISOString();
        } else {
          session.version += 1;
          session.updatedAt = new Date().toISOString();
          markProcessingStage(session, input.kind, "ocr_reading", "retrying");
        }
        return true;
      });
      await writeTrace(trace, "error.json", { error: refused ? "document_not_verified" : "extraction_failed" });
      if (!mutation?.result) return; // A replaced capture cannot fail its replacement.
      if (refused) {
        await Promise.all(
          [capture.objectKey, ...(capture.ocrObjectKey ? [capture.ocrObjectKey] : [])].map((key) =>
            this.dependencies.captures.remove(key).catch(() => undefined),
          ),
        );
        return;
      }
      if (!isClosed(mutation.session)) throw error;
    }
  }

  private joinLatest(session: OnboardingSession, kind: DocumentKind): void {
    const document = session.documents[kind];
    if (isClosed(session) || !document) return;
    const ids: Partial<Record<DocumentSide, string>> = {};
    for (const side of document.requiredSides) {
      const capture = document.captures[side];
      const result = document.sideResults?.[side];
      if (!capture || result?.captureId !== capture.id || result.status !== "ready" || !result.response) return;
      ids[side] = capture.id;
    }
    if (document.requiredSides.every((side) => document.joinedCaptureIds?.[side] === ids[side])) return;
    const responses = Object.fromEntries(
      document.requiredSides.map((side) => [side, document.sideResults![side]!.response!]),
    );
    const fresh = Object.fromEntries(
      document.requiredSides.map((side) => [side, displayFields(findFields(responses[side]!))]),
    );
    const reused = reconcileSideReadings(document, fresh);
    let response: Record<string, unknown>;
    if (kind === "dz-passport") {
      response = { ...responses.single, single: responses.single };
      document.consistency = { checks: [], blocking: false, warnings: 0, notChecked: 0 };
    } else {
      const observed = (side: "front" | "back"): SideExtraction => {
        const part = responses[side]!;
        return {
          fields: { ...findFields(part), ...(reused[side] ?? {}) },
          ...(part.validation ? { validation: part.validation as SideExtraction["validation"] } : {}),
          unreadableFields: readStringArray(part.unreadableFields ?? part.unreadable_fields),
        } as SideExtraction;
      };
      const combined = combineDocumentSides(kind, observed("front"), observed("back"), undefined, { scope: "onboarding" });
      response = { ...combined, front: responses.front, back: responses.back };
      const checks = combined.consistencyChecks;
      document.consistency = {
        checks,
        blocking: checks.some((check) => check.status === "failed"),
        warnings: checks.filter((check) => check.status === "warning").length,
        notChecked: checks.filter((check) => check.status === "not_checked").length,
      };
    }
    document.ocrResponse = response;
    markProcessingStage(session, kind, "field_validation");
    const fields = canonicalFields(findFields(response));
    fillMissingFromPrior(fields, reused, response);
    // Cross-face mismatches have their own actionable report, separate from unreadable values.
    const unreadable = new Set<string>([
      ...missingRequiredFields(kind, fields, this.dependencies.requiredFields),
      ...invalidFields(fields),
    ]);
    const independentlyRejected = new Set<string>();
    for (const side of document.requiredSides) {
      const part = responses[side]!;
      const validation = part.validation as Record<string, unknown> | undefined;
      for (const field of [
        ...readStringArray(part.unreadableFields ?? part.unreadable_fields),
        ...readStringArray(validation?.failedFields ?? validation?.failed_fields),
      ]) {
        const canonical = identityField(field);
        if (canonical && canonical !== "documentNumber" && canonical !== "expiryDate") {
          unreadable.add(canonical);
          independentlyRejected.add(canonical);
        }
      }
      if (hasDocumentFailure(part, validation)) unreadable.add("documentValidation");
    }
    // A withheld conflict value is not an unreadable transcription.
    for (const check of (document.consistency?.checks ?? []).filter((check) => check.status === "failed")) {
      if (!independentlyRejected.has(check.field)) unreadable.delete(check.field);
      for (const [canonical, names] of Object.entries(aliases)) {
        if (
          (names.includes(check.field) || canonical === check.field) &&
          ![canonical, ...names].some((name) => independentlyRejected.has(name))
        )
          unreadable.delete(canonical);
      }
    }
    document.joinedCaptureIds = ids;
    registerOcrResult(
      session,
      kind,
      fields,
      [...unreadable],
    );
  }

  private async mutate<T>(token: string, change: (session: OnboardingSession) => T) {
    const mutation = await this.dependencies.sessions.mutateByPublicToken(token, (session) => {
      const result = change(session);
      this.tasks.prepare(session);
      return result;
    });
    // Webhooks only here: queued face work is already durable and recovered by the dispatcher.
    if (mutation && isClosed(mutation.session)) await this.tasks.dispatch(mutation.session);
    return mutation;
  }
}

function isClosed(session: OnboardingSession): boolean {
  return ["succeeded", "document_failed", "consistency_failed", "technical_failed", "expired"].includes(session.status);
}

function invalidFields(fields: OcrFields): string[] {
  const invalid: string[] = [];
  if (fields.nin && !/^\d{18}$/.test(fields.nin)) invalid.push("nin");
  if (fields.dateOfBirth) {
    const date = new Date(`${fields.dateOfBirth}T00:00:00Z`);
    if (!normalizeDate(fields.dateOfBirth) || Number.isNaN(date.valueOf()) || date > new Date())
      invalid.push("dateOfBirth");
  }
  return invalid;
}

function hasDocumentFailure(part: Record<string, unknown>, validation?: Record<string, unknown>): boolean {
  if (part.status !== "failed" && validation?.status !== "failed") return false;
  const failures = Array.isArray(validation?.checks)
    ? validation.checks.filter((check): check is Record<string, unknown> => Boolean(check && typeof check === "object" && (check as Record<string, unknown>).outcome === "failed"))
    : [];
  const fields = readStringArray(validation?.failedFields ?? validation?.failed_fields);
  // Document admission and unclassified integrity failures stay blocking. A failed
  // report caused solely by known field checks is handled by identity prerequisites.
  if (!failures.length) return fields.length === 0 || fields.some((field) => !identityField(field) && !optionalField(field));
  return failures.some((check) => typeof check.field !== "string" || (!identityField(check.field) && !optionalField(check.field)));
}

function identityField(field: string): string | undefined {
  const key = field.replace(/^(front|back)_/, "");
  return Object.entries(aliases).find(([canonical, names]) => canonical !== "documentNumber" && canonical !== "expiryDate" && (canonical === key || names.includes(key)))?.[0];
}

function optionalField(field: string): boolean {
  const key = field.replace(/^(front|back)_/, "");
  return ["documentNumber", "expiryDate", ...aliases.documentNumber!, ...aliases.expiryDate!].includes(key) ||
    /^(?:date_of_(?:issue|expiry)(?:_printed)?|date_of_birth_printed|sex|gender|nationality|blood_group|place_of_birth_(?:ar|latin)|issuing_authority_(?:ar|latin)|categories|category_entries|restrictions)(?:\.|$)/.test(key);
}

function round(value: number) {
  return Math.round(value * 100) / 100;
}

function findFields(payload: Record<string, unknown>): Record<string, unknown> {
  for (const candidate of [
    payload.mergedFields,
    payload.merged_fields,
    payload.fields,
    (payload.result as Record<string, unknown> | undefined)?.fields,
  ]) {
    if (candidate && typeof candidate === "object" && !Array.isArray(candidate))
      return candidate as Record<string, unknown>;
  }
  return {};
}

function canonicalFields(raw: Record<string, unknown>): OcrFields {
  const normalized = normalizeOcrFields(raw);
  const output: OcrFields = { ...normalized };
  for (const [canonical, names] of Object.entries(aliases)) {
    const value =
      names
        .flatMap((name) => [normalized[name], normalized[`front_${name}`], normalized[`back_${name}`]])
        .find((value) => value) ?? null;
    output[canonical] =
      canonical === "nin"
        ? normalizeIdentifier(value)
        : canonical === "dateOfBirth" || canonical === "expiryDate"
          ? (normalizeDate(value) ?? value)
          : value;
  }
  return output;
}

function fillMissingFromPrior(
  fields: OcrFields,
  reused: Partial<Record<"front" | "back" | "single", OcrFields>>,
  response: Record<string, unknown>,
): void {
  const sources = (response.mergedFieldSources ?? {}) as Record<string, unknown>;
  for (const [canonical, names] of Object.entries(aliases)) {
    if (fields[canonical]) continue;
    if (
      names.some(
        (name) =>
          sources[name] === "conflict" ||
          sources[`front_${name}`] === "conflict" ||
          sources[`back_${name}`] === "conflict",
      )
    )
      continue;
    const candidates = Object.values(reused).flatMap((side) => names.map((name) => side?.[name]).filter(Boolean));
    if (candidates.length > 0 && candidates.every((value) => value === candidates[0]))
      fields[canonical] = candidates[0] ?? null;
  }
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function displayFields(raw: Record<string, unknown>): OcrFields {
  return Object.fromEntries(
    Object.entries(raw).map(([key, value]) => {
      const unwrapped =
        value && typeof value === "object" && "value" in value ? (value as { value: unknown }).value : value;
      if (unwrapped == null) return [key, null];
      if (Array.isArray(unwrapped)) {
        if (key === "category_entries")
          return [
            key,
            unwrapped
              .map((entry) => {
                if (!entry || typeof entry !== "object") return String(entry);
                const row = entry as Record<string, unknown>;
                return [
                  row.category,
                  row.date_of_issue_printed ?? row.date_of_issue,
                  row.date_of_expiry_printed ?? row.date_of_expiry,
                  row.restrictions,
                ]
                  .filter(Boolean)
                  .join(" · ");
              })
              .join("\n") || null,
          ];
        return [key, unwrapped.join(", ") || null];
      }
      return [key, String(unwrapped).trim() || null];
    }),
  );
}
