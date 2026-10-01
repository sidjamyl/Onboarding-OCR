import assert from "node:assert/strict";
import test from "node:test";
import { CalibrationHub } from "../src/quality/calibration-hub.js";
import { defaultQualityProfile } from "../src/quality/profile.js";

test("calibration hub isolates a draft profile and broadcasts live telemetry", () => {
  const hub = new CalibrationHub();
  const calibration = hub.create(defaultQualityProfile, { templateId: "dz-id-front" });
  const events: string[] = [];
  const unsubscribe = hub.subscribe(calibration.id, (event) => events.push(event.type));
  assert.ok(unsubscribe);

  const draft = structuredClone(defaultQualityProfile);
  draft.capture.samplingIntervalMs = 700;
  const changed = hub.updateProfile(calibration.id, draft);
  assert.equal(changed?.profile.capture.samplingIntervalMs, 700);
  assert.equal(defaultQualityProfile.capture.samplingIntervalMs, 180);

  hub.receive(calibration.id, {
    image: Buffer.from("image"),
    client: { score: 0.82, passed: true, hint: "ready", metrics: { "image.sharpness": 42 } },
  });
  const snapshot = hub.get(calibration.id);
  assert.equal(snapshot?.templateId, "dz-id-front");
  assert.equal(snapshot?.documentKind, "dz-id");
  assert.equal(snapshot?.samples.length, 1);
  assert.equal(snapshot?.latestSample?.client?.score, 0.82);
  assert.ok(hub.command(calibration.id, "capture"));
  assert.deepEqual(
    ["snapshot", "profile", "sample", "phone", "command"].filter((type) => !events.includes(type)),
    [],
  );
  unsubscribe?.();
});

test("calibration hub keeps the last photo and its OCR copy in memory only", () => {
  const hub = new CalibrationHub();
  const calibration = hub.create(defaultQualityProfile);
  const server = { passed: true, mode: "observe" as const, checks: [], templateMatched: false, durationMs: 1 };
  const capture = hub.storeCapture(calibration.id, {
    original: Buffer.from("original"),
    ocrImage: Buffer.from("ocr"),
    capture: { trigger: "remote", server, original: { width: 10, height: 10, bytes: 8 } },
  });
  assert.equal(capture?.trigger, "remote");
  assert.equal(hub.captureImage(calibration.id, "ocr")?.toString(), "ocr");
  hub.replaceOcr(calibration.id, undefined, undefined, server);
  assert.equal(hub.captureImage(calibration.id, "ocr"), null);
  assert.equal(hub.captureImage(calibration.id, "original")?.toString(), "original");
  assert.equal(hub.get(calibration.id)?.captures, 1);
});
