import assert from "node:assert/strict";
import test from "node:test";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { MemoryCaptureStore, MemorySessionRepository } from "../src/adapters/memory.js";
import { InlineTaskQueue } from "../src/adapters/queue.js";
import { createSession } from "../src/domain/workflow.js";

for (const serverChecks of [true, false]) {
  test(`capture uses quality without ORB verification (server quality ${serverChecks})`, async (t) => {
    const sessions = new MemorySessionRepository();
    class Store extends MemoryCaptureStore {
      writes = 0;
      override async put(key: string, bytes: Buffer) {
        this.writes++;
        return super.put(key, bytes);
      }
    }
    const captures = new Store();
    const session = createSession({ clientReference: "test", policyId: "id-only", locale: "fr" });
    await sessions.create(session, `verify-${serverChecks}`);
    const queue = new InlineTaskQueue();
    let extractions = 0,
      verifications = 0;
    await queue.start({
      extraction: async () => {
        extractions++;
      },
    });
    const app = await buildApp({
      config: loadConfig({
        NODE_ENV: "test",
        CLIENT_API_KEYS: "test",
        SERVER_QUALITY_CHECKS_ENABLED: String(serverChecks),
      }),
      sessions,
      captures,
      queue,
      webhooks: { async sendCompleted() {} },
      quality: {
        async analyze() {
          throw new Error("Use shared assessment");
        },
        async assess(_image, options) {
          assert.equal(serverChecks, true, "disabled server quality must not run the analyser");
          assert.equal(options.templateId, undefined, "ORB verification is disabled for onboarding");
          assert.equal(options.prepare, false, "do not create an enhanced OCR copy");
          return { report: { passed: true, mode: "enforce", templateMatched: false, durationMs: 1, checks: [] } };
        },
      },
      ocr: {
        async verify() {
          verifications++;
          throw new Error("ORB verification must not run");
        },
        async extract() {
          extractions++;
          return {};
        },
      },
    });
    t.after(() => app.close());
    const response = await app.inject({
      method: "POST",
      url: `/public/sessions/${session.publicToken}/captures/dz-id/front`,
      headers: { "idempotency-key": "photo-0001", "content-type": "multipart/form-data; boundary=capture-test" },
      payload: Buffer.from(
        '--capture-test\r\nContent-Disposition: form-data; name="file"; filename="photo.jpg"\r\nContent-Type: image/jpeg\r\n\r\nguide-crop\r\n--capture-test--\r\n',
      ),
    });
    assert.equal(response.statusCode, 201, response.body);
    if (!serverChecks) assert.equal(response.json().quality.mode, "off");
    assert.equal(verifications, 0);
    assert.equal(captures.writes, 1);
    await queue.drain();
    assert.equal(extractions, 1, "front starts its extraction immediately");
    const saved = await sessions.findById(session.id);
    assert.equal(saved?.documents["dz-id"]?.ocrAttempts, 0);
    assert.ok(saved?.documents["dz-id"]?.captures.front);
  });
}
