import assert from "node:assert/strict";
import test from "node:test";
import { normalizeApiUrl } from "../src/lib/api-url.ts";
import { defaultQualityProfile, evaluateFrame } from "../src/lib/quality-core.ts";
import { projectOnboarding } from "../src/lib/flow-projection.ts";

const sharpCardGeometry = {
  fill: 0.8,
  margin: 0.05,
  aspectRatio: 1.586,
  aspectError: 0,
  angleDeviation: 1,
  sideRatio: 1.01,
  documentWidthPx: 1000,
  dpi: 297,
};
const blurryImage = {
  width: 1000,
  height: 630,
  mean: 180,
  paper: 225,
  p2: 30,
  p98: 240,
  highlightClip: 0,
  shadowClip: 0,
  contrast: 0.8,
  sharpness: 12,
  tenengrad: 900,
  motionIsotropy: 0.7,
  focusUniformity: 0.8,
  glareRatio: 0,
  glareBlob: 0,
  colorGlareRatio: 0,
  illumination: 0.95,
  noise: 1,
};

test("removes trailing slashes from the API base URL", () => {
  assert.equal(normalizeApiUrl("https://example.test/"), "https://example.test");
  assert.equal(normalizeApiUrl("https://example.test///"), "https://example.test");
  assert.equal(normalizeApiUrl("https://example.test"), "https://example.test");
});

test("a blurry live frame blocks auto-capture and asks to hold still for focus", () => {
  const evaluation = evaluateFrame(
    { geometry: sharpCardGeometry, image: blurryImage, cornerMotion: 0 },
    defaultQualityProfile,
    "live",
  );
  assert.equal(evaluation.passed, false);
  assert.equal(evaluation.hint, "focus");
  assert.equal(evaluation.checks.find((check) => check.key === "sharpness")?.status, "fail");
});

test("a check downgraded to a warning no longer blocks the capture", () => {
  const profile = { ...defaultQualityProfile, severity: { ...defaultQualityProfile.severity, sharpness: "warn" } };
  const evaluation = evaluateFrame({ geometry: sharpCardGeometry, image: blurryImage, cornerMotion: 0 }, profile, "live");
  assert.equal(evaluation.passed, true);
  assert.equal(evaluation.flawless, false);
  assert.equal(evaluation.checks.find((check) => check.key === "sharpness")?.status, "warn");
});

test("projects exactly one current document in canonical order", () => {
  const document = (kind, confirmed = false) => ({
    kind,
    requiredSides: kind === "dz-passport" ? ["single"] : ["front", "back"],
    captures: {},
    serverSubmissions: 0,
    ocrAttempts: 0,
    technicalFailures: 0,
    unreadableFields: [],
    confirmed,
    status: confirmed ? "ready" : "pending",
  });
  const projection = projectOnboarding({
    sessionId: "session",
    policyId: "all-three",
    documentSelection: { mode: "all", allowedDocuments: ["dz-id", "dz-driving-licence", "dz-passport"], minimumDocuments: 3 },
    locale: "fr",
    status: "capturing",
    reasonCode: null,
    expiresAt: new Date().toISOString(),
    returnUrl: null,
    documents: {
      "dz-passport": document("dz-passport"),
      "dz-driving-licence": document("dz-driving-licence"),
      "dz-id": document("dz-id", true),
    },
  });
  assert.deepEqual(
    projection.documents.map(({ document: item, state }) => [item.kind, state]),
    [
      ["dz-id", "completed"],
      ["dz-driving-licence", "current"],
      ["dz-passport", "upcoming"],
    ],
  );
  assert.equal(projection.current?.kind, "dz-driving-licence");
  assert.equal(projection.phase, "capture");
});

test("an incomplete result is projected for review before retake", () => {
  const projection = projectOnboarding({
    sessionId: "session",
    policyId: "passport-only",
    documentSelection: { mode: "all", allowedDocuments: ["dz-passport"], minimumDocuments: 1 },
    locale: "fr",
    status: "awaiting_confirmation",
    reasonCode: null,
    expiresAt: new Date().toISOString(),
    returnUrl: null,
    documents: {
      "dz-passport": {
        kind: "dz-passport",
        requiredSides: ["single"],
        captures: { single: { id: "capture", quality: { passed: true, mode: "enforce", checks: [], durationMs: 1 } } },
        serverSubmissions: 1,
        ocrAttempts: 1,
        technicalFailures: 0,
        fields: { documentNumber: "P123", nin: null },
        unreadableFields: ["nin"],
        confirmed: false,
        status: "incomplete",
      },
    },
  });
  assert.equal(projection.phase, "incomplete");
  assert.equal(projection.nextSide, undefined);
});
