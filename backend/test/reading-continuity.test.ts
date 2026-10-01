import assert from "node:assert/strict";
import test from "node:test";
import { reconcileSideReadings, rememberReadableSide } from "../src/domain/reading-continuity.js";
import type { DocumentState } from "../src/domain/types.js";

function document(prior: Record<string, string>): DocumentState {
  return {
    kind: "dz-id",
    requiredSides: ["front", "back"],
    captures: {},
    ocrAttempts: 0,
    serverSubmissions: 0,
    technicalFailures: 0,
    unreadableFields: [],
    confirmed: false,
    status: "capturing",
    timingsMs: {},
    retainedSideFields: { front: prior },
  };
}

test("does not reuse a previous reading when a document identifier conflicts", () => {
  const current = document({ document_number: "OLD", nin: "111" });
  const reused = reconcileSideReadings(current, { front: { document_number: "NEW", nin: null } });
  assert.deepEqual(reused, {});
  assert.equal(current.sideFields?.front?.nin, null);
});

test("reuses a missing field when an unchanged identifier confirms the same document", () => {
  const current = document({ document_number: "SAME", nin: "111" });
  const reused = reconcileSideReadings(current, { front: { document_number: "SAME", nin: null } });
  assert.deepEqual(reused.front, { nin: "111" });
  assert.equal(current.sideFields?.front?.nin, "111");
});

test("an unchanged opposite photo keeps its accepted fields after a one-side retake", () => {
  const current = document({});
  current.retakingSide = "back";
  current.sideFields = { front: { nin: "100060557007110004", surname_ar: "صيد" } };
  current.retainedSideFields = { front: { nin: "100060557007110004", surname_ar: "صيد" } };
  current.captures.front = {
    id: "unchanged",
    side: "front",
    objectKey: "front",
    createdAt: "2026-09-30",
    quality: { passed: true, mode: "off", templateMatched: false, checks: [], durationMs: 0 },
    timingsMs: {},
  };
  current.retainedSideCaptureIds = { front: "unchanged" };
  const reused = reconcileSideReadings(current, {
    front: { nin: null, surname_ar: null },
    back: { surname_latin: "SID" },
  });
  assert.deepEqual(reused.front, { nin: "100060557007110004", surname_ar: "صيد" });
  assert.equal(current.sideFields.front?.nin, "100060557007110004");
  assert.equal(current.sideFields.back?.surname_latin, "SID");
});

test("a Gateway failure cannot seed later readings with rejected values", () => {
  const current = document({});
  current.sideFields = { front: { nin: "100060557007110004", document_number: "WRONG" } };
  current.ocrResponse = {
    status: "failed",
    validation: { status: "failed", failedFields: ["document_number"], checks: [] },
  };
  rememberReadableSide(current, "front");
  assert.deepEqual(current.retainedSideFields?.front, {});
  current.ocrResponse = {
    status: "failed",
    validation: { status: "failed", failedFields: [], checks: [{ outcome: "failed" }] },
  };
  rememberReadableSide(current, "front");
  assert.deepEqual(current.retainedSideFields?.front, {});
});

test("a failed early face reading cannot seed a retake before the pair exists", () => {
  const current = document({});
  current.sideFields = { front: { nin: "100012345678901234", document_number: "WRONG" } };
  current.sideResults = {
    front: {
      captureId: "early",
      status: "ready",
      technicalFailures: 0,
      response: { status: "failed", validation: { status: "failed", failedFields: ["document_number"] } },
    },
  };
  rememberReadableSide(current, "front");
  assert.deepEqual(current.retainedSideFields?.front, {});
});

test("two selected retakes never treat a replacement photo as the unchanged opposite face", () => {
  const current = document({ document_number: "OLD", nin: "111" });
  current.retakingSide = "back";
  current.retainedSideCaptureIds = { front: "old-front" };
  current.captures.front = {
    id: "new-front",
    side: "front",
    objectKey: "new",
    createdAt: "2026-09-30",
    quality: { passed: true, mode: "off", templateMatched: false, checks: [], durationMs: 0 },
    timingsMs: {},
  };
  const reused = reconcileSideReadings(current, { front: { document_number: "NEW", nin: null }, back: {} });
  assert.deepEqual(reused, {});
  assert.equal(current.sideFields?.front?.nin, null);
});

test("remembering a replacement holder cannot retain missing identity values from the old photo", () => {
  const current = document({ document_number: "OLD", nin: "111" });
  current.retainedSideCaptureIds = { front: "old-front" };
  current.captures.front = {
    id: "new-front",
    side: "front",
    objectKey: "new",
    createdAt: "2026-09-30",
    quality: { passed: true, mode: "off", templateMatched: false, checks: [], durationMs: 0 },
    timingsMs: {},
  };
  current.sideFields = { front: { document_number: "NEW", nin: null } };
  rememberReadableSide(current, "front");
  assert.deepEqual(current.retainedSideFields?.front, { document_number: "NEW" });
});
