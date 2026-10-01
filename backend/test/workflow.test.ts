import assert from "node:assert/strict";
import test from "node:test";
import {
  confirmDocument,
  createSession,
  expireIfNeeded,
  registerCapture,
  registerOcrResult,
  retakeDocument,
  retakeSide,
  selectDocuments,
  submitSession,
} from "../src/domain/workflow.js";
import type { QualityReport } from "../src/domain/types.js";

const completeFields = {
  lastNameLatin: "BENALI",
  firstNameLatin: "AMINE",
  lastNameArabic: "بن علي",
  firstNameArabic: "أمين",
  nin: "100012345678901234",
  documentNumber: "123456789",
  dateOfBirth: "1990-02-12",
  expiryDate: "2030-02-12",
};

test("two-of-three policy requires two allowed documents", () => {
  const session = createSession({ clientReference: "case-1", policyId: "two-of-three", locale: "fr" });
  assert.throws(() => selectDocuments(session, ["dz-id"]), { name: "Error", code: "invalid_document_selection" });
  selectDocuments(session, ["dz-id", "dz-passport"]);
  assert.deepEqual(Object.keys(session.documents), ["dz-id", "dz-passport"]);
});

test("confirmation succeeds only when NIN and date of birth are consistent", () => {
  const session = createSession({ clientReference: "case-2", policyId: "two-of-three", locale: "fr" });
  selectDocuments(session, ["dz-id", "dz-passport"]);
  registerOcrResult(session, "dz-id", completeFields, []);
  confirmDocument(session, "dz-id");
  registerOcrResult(session, "dz-passport", { ...completeFields, documentNumber: "P123" }, []);
  confirmDocument(session, "dz-passport");
  assert.equal(session.status, "awaiting_submission");
  submitSession(session);
  assert.equal(session.status, "succeeded");
  assert.equal(session.result?.documents["dz-passport"]?.documentNumber, "P123");
});

test("only the requested face is replaced and submission waits for a fresh reading", () => {
  const session = createSession({ clientReference: "side-retake", policyId: "passport-only", locale: "fr" });
  const quality: QualityReport = { passed: true, mode: "enforce", templateMatched: true, durationMs: 1, checks: [] };
  // The same rule also works for a two-sided document.
  const pair = createSession({ clientReference: "pair-retake", policyId: "two-of-three", locale: "fr" });
  selectDocuments(pair, ["dz-id", "dz-passport"]);
  registerCapture(pair, { kind: "dz-id", side: "front", objectKey: "front", quality });
  registerCapture(pair, { kind: "dz-id", side: "back", objectKey: "back", quality });
  registerOcrResult(pair, "dz-id", completeFields, []);
  retakeSide(pair, "dz-id", "back");
  assert.equal(pair.documents["dz-id"]?.captures.front?.objectKey, "front");
  assert.equal(pair.documents["dz-id"]?.captures.back, undefined);
  assert.equal(pair.documents["dz-id"]?.fields, undefined);
  assert.throws(() => submitSession(pair), { code: "session_not_ready" });
  assert.throws(() => retakeSide(session, "dz-passport", "back"), { code: "invalid_side" });
});

test("a date conflict preserves readings until the user chooses one retry", () => {
  const session = createSession({ clientReference: "case-3", policyId: "two-of-three", locale: "fr" });
  selectDocuments(session, ["dz-id", "dz-passport"]);
  registerOcrResult(session, "dz-id", completeFields, []);
  confirmDocument(session, "dz-id");
  registerOcrResult(session, "dz-passport", { ...completeFields, dateOfBirth: "1991-02-12" }, []);
  confirmDocument(session, "dz-passport");
  assert.equal(session.status, "awaiting_confirmation");
  assert.ok(Object.values(session.documents).every((document) => document?.confirmed));
  const conflict = session.consistency?.checks.find(
    (check) => check.field === "dateOfBirth" && check.status === "failed",
  );
  assert.deepEqual(
    conflict?.readings.map((reading) => reading.value),
    ["1990-02-12", "1991-02-12"],
  );
  assert.throws(() => submitSession(session), { code: "session_not_ready" });
  retakeSide(session, "dz-id", "back");
  assert.equal(session.documents["dz-passport"]?.confirmed, true);
  assert.equal(session.documents["dz-passport"]?.fields?.dateOfBirth, "1991-02-12");
  assert.equal(session.consistency?.blocking, false);
  assert.ok(
    session.consistency?.checks.some((check) => check.field === "dateOfBirth" && check.status === "not_checked"),
  );
  registerOcrResult(session, "dz-id", { ...completeFields, dateOfBirth: "1991-02-12" }, []);
  confirmDocument(session, "dz-id");
  assert.equal(session.status, "awaiting_submission");
});

test("two-versus-one agreement suggests an outlier without resetting any document", () => {
  const session = createSession({ clientReference: "case-4", policyId: "all-three", locale: "fr" });
  registerOcrResult(session, "dz-id", completeFields, []);
  confirmDocument(session, "dz-id");
  registerOcrResult(
    session,
    "dz-driving-licence",
    { ...completeFields, nin: "200012345678901234", documentNumber: "L1" },
    [],
  );
  confirmDocument(session, "dz-driving-licence");
  registerOcrResult(session, "dz-passport", { ...completeFields, documentNumber: "P1" }, []);
  confirmDocument(session, "dz-passport");
  assert.equal(session.status, "awaiting_confirmation");
  assert.ok(Object.values(session.documents).every((document) => document?.confirmed));
  assert.equal(
    session.consistency?.checks.find((check) => check.field === "nin" && check.status === "failed")?.suggestedRetry
      ?.document,
    "driving_licence",
  );
  retakeDocument(session, "dz-id");
  assert.equal(session.documents["dz-passport"]?.confirmed, true);
  assert.equal(session.documents["dz-driving-licence"]?.confirmed, true);
});

test("consistency closes only after every implicated reading exhausts its retries", () => {
  const session = createSession({ clientReference: "limits", policyId: "two-of-three", locale: "fr" });
  selectDocuments(session, ["dz-id", "dz-passport"]);
  registerOcrResult(session, "dz-id", completeFields, []);
  session.documents["dz-id"]!.ocrAttempts = 3;
  confirmDocument(session, "dz-id");
  registerOcrResult(session, "dz-passport", { ...completeFields, dateOfBirth: "1991-02-12" }, []);
  confirmDocument(session, "dz-passport");
  assert.equal(session.status, "awaiting_confirmation");
  assert.throws(() => retakeSide(session, "dz-id", "front"), { code: "ocr_attempts_exhausted" });
  assert.equal(session.status, "awaiting_confirmation");
  retakeSide(session, "dz-passport", "single");
  registerOcrResult(session, "dz-passport", { ...completeFields, dateOfBirth: "1991-02-12" }, []);
  session.documents["dz-passport"]!.ocrAttempts = 3;
  confirmDocument(session, "dz-passport");
  assert.equal(session.status, "consistency_failed");
  assert.equal(session.reasonCode, "consistency_mismatch");
});

test("future documents stay locked until the current document is confirmed", () => {
  const session = createSession({ clientReference: "ordered", policyId: "all-three", locale: "fr" });
  const quality: QualityReport = {
    passed: true,
    mode: "enforce",
    templateMatched: false,
    durationMs: 1,
    checks: [],
  };
  assert.throws(
    () =>
      registerCapture(session, {
        kind: "dz-driving-licence",
        side: "front",
        objectKey: "licence/front.jpg",
        quality,
      }),
    { code: "document_locked" },
  );
});

test("an incomplete OCR result remains visible and cannot be confirmed", () => {
  const session = createSession({ clientReference: "incomplete", policyId: "passport-only", locale: "fr" });
  registerOcrResult(session, "dz-passport", { ...completeFields, nin: null }, ["nin"]);
  assert.equal(session.documents["dz-passport"]?.status, "incomplete");
  assert.equal(session.documents["dz-passport"]?.fields?.documentNumber, completeFields.documentNumber);
  assert.throws(() => confirmDocument(session, "dz-passport"), { code: "document_not_ready" });
});

test("an active OCR treatment does not expire", () => {
  const session = createSession({ clientReference: "processing-expiry", policyId: "passport-only", locale: "fr" });
  session.status = "processing";
  session.expiresAt = new Date(0).toISOString();
  expireIfNeeded(session, new Date());
  assert.equal(session.status, "processing");
});

test("requesting a fourth OCR attempt closes the document", () => {
  const session = createSession({ clientReference: "case-5", policyId: "passport-only", locale: "fr" });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    registerOcrResult(session, "dz-passport", completeFields, []);
    retakeDocument(session, "dz-passport");
  }
  assert.equal(session.documents["dz-passport"]?.ocrAttempts, 3);
  assert.equal(session.status, "document_failed");
  assert.equal(session.reasonCode, "ocr_attempts_exhausted");
});

const goodQuality: QualityReport = { passed: true, mode: "enforce", templateMatched: true, durationMs: 1, checks: [] };

test("the first accepted face starts processing while the next remains capturable", () => {
  const session = createSession({ clientReference: "immediate", policyId: "id-only", locale: "fr" });
  const front = registerCapture(session, { kind: "dz-id", side: "front", objectKey: "front", quality: goodQuality });
  const document = session.documents["dz-id"]!;
  assert.equal(session.status, "processing");
  assert.equal(document.status, "processing");
  assert.equal(document.sideResults?.front?.captureId, front);
  assert.equal(document.sideResults?.front?.status, "pending");
  assert.throws(
    () => registerCapture(session, { kind: "dz-id", side: "front", objectKey: "replacement", quality: goodQuality }),
    { code: "document_not_capturable" },
  );
  assert.throws(
    () =>
      registerCapture(session, {
        kind: "dz-id",
        side: "back",
        objectKey: "bad",
        quality: { ...goodQuality, passed: false },
      }),
    { code: "quality_rejected" },
  );
  assert.equal(document.status, "processing");
  registerCapture(session, { kind: "dz-id", side: "back", objectKey: "back", quality: goodQuality });
  assert.equal(document.captures.front?.id, front);
  assert.equal(document.sideResults?.back?.status, "pending");
});

test("cross-face conflicts block confirmation and a selective retry preserves the other OCR result", () => {
  const session = createSession({ clientReference: "face-conflict", policyId: "id-only", locale: "fr" });
  const document = session.documents["dz-id"]!;
  const front = registerCapture(session, { kind: "dz-id", side: "front", objectKey: "front", quality: goodQuality });
  registerCapture(session, { kind: "dz-id", side: "back", objectKey: "back", quality: goodQuality });
  document.sideResults!.front = {
    captureId: front,
    status: "ready",
    technicalFailures: 0,
    response: { fields: completeFields },
  };
  document.consistency = {
    blocking: true,
    warnings: 0,
    notChecked: 0,
    checks: [
      {
        id: "cross.id.date_of_birth",
        field: "date_of_birth",
        label: "Date of birth",
        status: "failed",
        message: "Different dates",
        readings: [
          { document: "id", side: "front", value: "1990-02-12" },
          { document: "id", side: "back", value: "1991-02-12" },
        ],
      },
    ],
  };
  registerOcrResult(session, "dz-id", completeFields, []);
  assert.equal(document.status, "ready");
  assert.equal(document.unreadableFields.length, 0);
  assert.throws(() => confirmDocument(session, "dz-id"), { code: "consistency_conflict" });
  retakeSide(session, "dz-id", "back");
  assert.equal(document.sideResults?.front?.captureId, front);
  assert.equal(document.sideResults?.back, undefined);
  assert.equal(document.consistency, undefined);
});

test("per-face limits also apply before a pair has been joined", () => {
  const session = createSession({ clientReference: "face-limits", policyId: "id-only", locale: "fr" });
  session.documents["dz-id"]!.sideOcrAttempts = { front: 3 };
  retakeSide(session, "dz-id", "front");
  assert.equal(session.status, "document_failed");
  assert.equal(session.reasonCode, "ocr_attempts_exhausted");
});

test("submission rechecks identity fields and blocks a newly unresolved conflict", () => {
  const session = createSession({ clientReference: "final-check", policyId: "two-of-three", locale: "fr" });
  selectDocuments(session, ["dz-id", "dz-passport"]);
  registerOcrResult(session, "dz-id", completeFields, []);
  confirmDocument(session, "dz-id");
  registerOcrResult(session, "dz-passport", { ...completeFields }, []);
  confirmDocument(session, "dz-passport");
  session.documents["dz-passport"]!.fields!.firstNameLatin = "YASSINE";
  assert.throws(() => submitSession(session), { code: "consistency_conflict" });
  assert.equal(session.status, "awaiting_confirmation");
  assert.equal(session.result, undefined);
});

test("exhausted cross-face conflicts are reported separately from unreadable fields", () => {
  const session = createSession({ clientReference: "face-exhausted", policyId: "id-only", locale: "fr" });
  const document = session.documents["dz-id"]!;
  document.ocrAttempts = 2;
  document.consistency = {
    blocking: true,
    warnings: 0,
    notChecked: 0,
    checks: [
      {
        id: "cross.id.date_of_birth",
        field: "date_of_birth",
        label: "Date of birth",
        status: "failed",
        message: "Different dates",
        readings: [
          { document: "id", side: "front", value: "1990-02-12" },
          { document: "id", side: "back", value: "1991-02-12" },
        ],
      },
    ],
  };
  registerOcrResult(session, "dz-id", { ...completeFields }, []);
  assert.equal(session.status, "consistency_failed");
  assert.equal(document.status, "ready");
  assert.deepEqual(document.unreadableFields, []);
});

test("cross-document readings name the accepted source face rather than a rejected raw observation", () => {
  const session = createSession({ clientReference: "provenance", policyId: "id-and-passport", locale: "fr" });
  const id = session.documents["dz-id"]!;
  id.sideFields = { front: { nin: "BAD FRONT READING" }, back: { nin: completeFields.nin } };
  id.ocrResponse = { mergedFields: { nin: completeFields.nin }, mergedFieldSources: { nin: "back" } };
  registerOcrResult(session, "dz-id", { ...completeFields }, []);
  confirmDocument(session, "dz-id");
  registerOcrResult(session, "dz-passport", { ...completeFields, nin: "200012345678901234" }, []);
  const check = session.consistency?.checks.find((item) => item.field === "nin");
  assert.equal(check?.readings[0]?.side, "back");
  assert.equal(check?.readings[1]?.side, "single");
});

test("an earlier retake does not discard a valid later document extraction still in flight", () => {
  const session = createSession({ clientReference: "concurrent-documents", policyId: "all-three", locale: "fr" });
  registerOcrResult(session, "dz-id", { ...completeFields }, []);
  confirmDocument(session, "dz-id");
  registerCapture(session, {
    kind: "dz-driving-licence",
    side: "front",
    objectKey: "licence-front",
    quality: goodQuality,
  });
  registerCapture(session, {
    kind: "dz-driving-licence",
    side: "back",
    objectKey: "licence-back",
    quality: goodQuality,
  });
  retakeSide(session, "dz-id", "front");
  registerOcrResult(session, "dz-driving-licence", { ...completeFields, documentNumber: "LICENCE" }, []);
  const licence = session.documents["dz-driving-licence"]!;
  assert.equal(licence.status, "ready");
  assert.equal(licence.fields?.documentNumber, "LICENCE");
  assert.throws(() => confirmDocument(session, "dz-driving-licence"), { code: "document_locked" });
  registerOcrResult(session, "dz-id", { ...completeFields }, []);
  confirmDocument(session, "dz-id");
  confirmDocument(session, "dz-driving-licence");
  assert.equal(licence.confirmed, true);
  assert.equal(licence.ocrAttempts, 1);
});

test("selective retake reuses an accepted legacy pair face without scheduling another reading", () => {
  const session = createSession({ clientReference: "legacy-retake", policyId: "id-only", locale: "en" });
  registerCapture(session, { kind: "dz-id", side: "front", objectKey: "front", quality: goodQuality });
  registerCapture(session, { kind: "dz-id", side: "back", objectKey: "back", quality: goodQuality });
  const document = session.documents["dz-id"];
  assert.ok(document);
  delete document.sideResults;
  document.ocrResponse = { back: { fields: { surname_latin: "BENALI" } } };
  document.sideFields = { back: { surname_latin: "BENALI" } };
  retakeSide(session, "dz-id", "front");
  assert.equal(session.documents["dz-id"]?.sideResults?.back?.status, "ready");
  assert.equal(session.documents["dz-id"]?.sideResults?.back?.captureId, document.captures.back?.id);
});
