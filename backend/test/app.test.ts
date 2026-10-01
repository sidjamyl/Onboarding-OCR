import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import sharp from "sharp";
import { MemoryCaptureStore, MemorySessionRepository } from "../src/adapters/memory.js";
import { OcrRequestError } from "../src/adapters/ocr-http.js";
import { InlineTaskQueue } from "../src/adapters/queue.js";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { defaultRequiredFields } from "../src/domain/requirements.js";
import type { OnboardingSession, QualityReport } from "../src/domain/types.js";
import type { CaptureStore, OcrGateway, WebhookGateway } from "../src/ports.js";
import { DocumentQualityEngine } from "../src/quality/engine.js";
import { CalibrationHub } from "../src/quality/calibration-hub.js";
import { defaultQualityProfile, QualityProfileStore } from "../src/quality/profile.js";
import { FileTemplateStore } from "../src/quality/template-store.js";
import { ExtractionService } from "../src/services/extraction.js";
import { WebhookDeliveryService } from "../src/services/webhook-delivery.js";

const qualityReport: QualityReport = {
  passed: true,
  mode: "enforce",
  templateMatched: true,
  durationMs: 12.4,
  checks: [{ key: "focus", passed: true, status: "pass", value: 240, threshold: 85, message: "", durationMs: 1.2 }],
};

test("complete API journey creates, captures, confirms and exposes a result", async () => {
  const sessions = new MemorySessionRepository();
  const captures = new MemoryCaptureStore();
  const queue = new InlineTaskQueue();
  const webhooks = new RecordingWebhooks();
  const ocr: OcrGateway = {
    async verify() {
      throw new Error("ORB verification must not run during onboarding");
    },
    async extract() {
      throw new Error("Onboarding must use single-face extraction");
    },
    async extractSingle() {
      return {
        fields: {
          last_name_latin: "BENALI",
          first_name_latin: "AMINE",
          last_name_arabic: "بن علي",
          first_name_arabic: "أمين",
          nin: "100012345678901234",
          document_number: "A123456",
          date_of_birth: "1990-02-12",
          expiry_date: "2030-02-12",
        },
      };
    },
  };
  const extraction = new ExtractionService({ sessions, captures, ocr, queue, requiredFields: defaultRequiredFields });
  const webhookDelivery = new WebhookDeliveryService(sessions, webhooks);
  await queue.start({
    extraction: (task) => extraction.process(task),
    webhook: (task) => webhookDelivery.process(task),
  });
  const config = loadConfig({
    NODE_ENV: "test",
    CLIENT_API_KEYS: "test-key",
    PUBLIC_BASE_URL: "http://localhost:3000",
  });
  const app = await buildApp({
    config,
    ocr,
    sessions,
    captures,
    queue,
    webhooks,
    quality: {
      async analyze() {
        return qualityReport;
      },
    },
  });

  const created = await app.inject({
    method: "POST",
    url: "/v1/sessions",
    headers: { "x-api-key": "test-key", "idempotency-key": "journey-0001" },
    payload: { clientReference: "customer-42", policyId: "two-of-three", locale: "fr" },
  });
  assert.equal(created.statusCode, 201);
  const createBody = created.json();
  const token = new URL(createBody.accessUrl).pathname.split("/").at(-1);
  assert.ok(token);

  const selection = await app.inject({
    method: "POST",
    url: `/public/sessions/${token}/select-documents`,
    headers: { "idempotency-key": "select-0001" },
    payload: { documents: ["dz-id", "dz-passport"] },
  });
  assert.equal(selection.statusCode, 200);

  for (const [kind, sides] of [
    ["dz-id", ["front", "back"]],
    ["dz-passport", ["single"]],
  ] as const) {
    for (const side of sides) {
      const upload = multipart("file", "capture.jpg", "image/jpeg", Buffer.from("valid-image-placeholder"));
      const response: { statusCode: number; body: string } = await app.inject({
        method: "POST",
        url: `/public/sessions/${token}/captures/${kind}/${side}`,
        headers: { ...upload.headers, "idempotency-key": `capture-${kind}-${side}` },
        payload: upload.body,
      });
      assert.equal(response.statusCode, 201, response.body);
      assert.equal(response.body.includes("objectKey"), false, "public responses must not expose storage object keys");
    }
    const confirmation: { statusCode: number; body: string } = await app.inject({
      method: "POST",
      url: `/public/sessions/${token}/documents/${kind}/confirm`,
      headers: { "idempotency-key": `confirm-${kind}` },
    });
    assert.equal(confirmation.statusCode, 200, confirmation.body);
  }

  const summary = await app.inject({ method: "GET", url: `/public/sessions/${token}` });
  assert.equal(summary.json().status, "awaiting_submission");
  assert.equal(summary.json().captureDeviceConnected, false);
  const submitted = await app.inject({
    method: "POST",
    url: `/public/sessions/${token}/submit`,
    headers: { "idempotency-key": "submit-0001" },
  });
  assert.equal(submitted.statusCode, 200, submitted.body);

  const result = await app.inject({
    method: "GET",
    url: `/v1/sessions/${createBody.sessionId}/result`,
    headers: { "x-api-key": "test-key" },
  });
  assert.equal(result.statusCode, 200, result.body);
  assert.equal(result.json().result.fields.nin, "100012345678901234");
  assert.equal(webhooks.sessions.at(-1)?.status, "succeeded");
  await app.close();
});

test("API key and idempotency key protect session creation", async () => {
  const sessions = new MemorySessionRepository();
  const captures = new MemoryCaptureStore();
  const queue = new InlineTaskQueue();
  await queue.start({ extraction: async () => undefined });
  const config = loadConfig({ NODE_ENV: "test", CLIENT_API_KEYS: "secret" });
  const app = await buildApp({
    config,
    sessions,
    captures,
    queue,
    webhooks: new RecordingWebhooks(),
    quality: {
      async analyze() {
        return qualityReport;
      },
    },
  });
  assert.equal((await app.inject({ method: "POST", url: "/v1/sessions", payload: {} })).statusCode, 401);
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/v1/sessions",
        headers: { "x-api-key": "secret" },
        payload: { clientReference: "x", policyId: "id-only", locale: "fr" },
      })
    ).statusCode,
    400,
  );
  await app.close();
});

test("one-use phone transfer remains valid after the HTTP app is recreated", async () => {
  const sessions = new MemorySessionRepository();
  const captures = new MemoryCaptureStore();
  const queue = new InlineTaskQueue();
  await queue.start();
  const dependencies = {
    config: loadConfig({ NODE_ENV: "test", CLIENT_API_KEYS: "test-key" }),
    sessions,
    captures,
    queue,
    webhooks: new RecordingWebhooks(),
    quality: {
      async analyze() {
        return qualityReport;
      },
    },
  };
  const first = await buildApp(dependencies);
  const created = await first.inject({
    method: "POST",
    url: "/v1/sessions",
    headers: { "x-api-key": "test-key", "idempotency-key": "phone-transfer-create" },
    payload: { clientReference: "phone-transfer", policyId: "id-only", locale: "fr" },
  });
  const token = new URL(created.json().accessUrl).pathname.split("/").at(-1);
  const issued = await first.inject({ method: "POST", url: `/public/sessions/${token}/transfer` });
  assert.equal(issued.statusCode, 200);
  await first.close();

  const second = await buildApp(dependencies);
  const url = `/public/transfers/${issued.json().transferToken}/consume`;
  assert.equal((await second.inject({ method: "POST", url })).statusCode, 200);
  assert.equal((await second.inject({ method: "POST", url })).statusCode, 410);
  const state = await second.inject({ method: "GET", url: `/public/sessions/${token}` });
  assert.equal(state.json().captureDeviceConnected, true);
  await second.close();
});

test("the computer stream receives a phone-side session mutation without refreshing", async () => {
  const sessions = new MemorySessionRepository();
  const captures = new MemoryCaptureStore();
  const queue = new InlineTaskQueue();
  await queue.start();
  const app = await buildApp({
    config: loadConfig({ NODE_ENV: "test", CLIENT_API_KEYS: "test-key" }),
    sessions,
    captures,
    queue,
    webhooks: new RecordingWebhooks(),
    quality: {
      async analyze() {
        return qualityReport;
      },
    },
  });
  const created = await app.inject({
    method: "POST",
    url: "/v1/sessions",
    headers: { "x-api-key": "test-key", "idempotency-key": "stream-create" },
    payload: { clientReference: "stream", policyId: "id-only", locale: "fr" },
  });
  const token = new URL(created.json().accessUrl).pathname.split("/").at(-1);
  const origin = await app.listen({ host: "127.0.0.1", port: 0 });
  const stream = await fetch(`${origin}/public/sessions/${token}/events`);
  assert.equal(stream.status, 200);
  const reader = stream.body?.getReader();
  assert.ok(reader);
  const first = await reader.read();
  assert.match(new TextDecoder().decode(first.value), /"status":"created"/);
  const selection = await app.inject({
    method: "POST",
    url: `/public/sessions/${token}/select-documents`,
    headers: { "idempotency-key": "stream-select" },
    payload: { documents: ["dz-id"] },
  });
  assert.equal(selection.statusCode, 200);
  const updated = await Promise.race([
    reader.read(),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Session stream did not update")), 3_000)),
  ]);
  assert.match(new TextDecoder().decode(updated.value), /"status":"capturing"/);
  await reader.cancel();
  await app.close();
});

test("a rejected final photo is not stored or sent to OCR", async () => {
  class RecordingCaptureStore extends MemoryCaptureStore {
    writes = 0;
    override async put(key: string, data: Buffer) {
      this.writes += 1;
      return super.put(key, data);
    }
  }
  const sessions = new MemorySessionRepository();
  const captures = new RecordingCaptureStore();
  const queue = new InlineTaskQueue();
  let ocrCalls = 0;
  await queue.start({
    extraction: async () => {
      ocrCalls += 1;
    },
  });
  const app = await buildApp({
    config: loadConfig({ NODE_ENV: "test", CLIENT_API_KEYS: "secret" }),
    sessions,
    captures,
    queue,
    webhooks: new RecordingWebhooks(),
    quality: {
      async analyze() {
        return {
          ...qualityReport,
          passed: false,
          templateMatched: false,
          checks: [
            {
              key: "glare",
              passed: false,
              status: "fail",
              value: 0.2,
              threshold: 0.01,
              message: "Remove reflection",
              durationMs: 1,
            },
          ],
        };
      },
    },
  });
  const created = await app.inject({
    method: "POST",
    url: "/v1/sessions",
    headers: { "x-api-key": "secret", "idempotency-key": "reject-create" },
    payload: { clientReference: "reject", policyId: "passport-only", locale: "fr" },
  });
  const token = new URL(created.json().accessUrl).pathname.split("/").at(-1);
  const selection = await app.inject({
    method: "POST",
    url: `/public/sessions/${token}/select-documents`,
    headers: { "idempotency-key": "reject-select" },
    payload: { documents: ["dz-passport"] },
  });
  assert.equal(selection.statusCode, 200);
  const upload = multipart("file", "capture.jpg", "image/jpeg", Buffer.from("bad-capture"));
  const response = await app.inject({
    method: "POST",
    url: `/public/sessions/${token}/captures/dz-passport/single`,
    headers: { ...upload.headers, "idempotency-key": "reject-photo" },
    payload: upload.body,
  });
  assert.equal(response.statusCode, 422, response.body);
  assert.equal(response.json().quality.checks[0].key, "glare");
  assert.equal(captures.writes, 0);
  assert.equal(ocrCalls, 0);
  await app.close();
});

test("a failed aggregate save removes the newly stored capture", async () => {
  class FailingSaveRepository extends MemorySessionRepository {
    override async mutateByPublicToken<T>(): Promise<{ session: OnboardingSession; result: T } | null> {
      throw new Error("database unavailable");
    }
  }
  class RecordingCaptureStore implements CaptureStore {
    stored = new Set<string>();
    removed: string[] = [];
    async put(key: string) {
      this.stored.add(key);
    }
    async get() {
      return Buffer.alloc(0);
    }
    async remove(key: string) {
      this.stored.delete(key);
      this.removed.push(key);
    }
  }
  const sessions = new FailingSaveRepository();
  const captures = new RecordingCaptureStore();
  const queue = new InlineTaskQueue();
  await queue.start({ extraction: async () => undefined });
  const app = await buildApp({
    config: loadConfig({ NODE_ENV: "test", CLIENT_API_KEYS: "secret" }),
    sessions,
    captures,
    queue,
    ocr: {
      async verify() {},
      async extract() {
        return {};
      },
    },
    webhooks: new RecordingWebhooks(),
    quality: {
      async analyze() {
        return qualityReport;
      },
    },
  });
  const created = await app.inject({
    method: "POST",
    url: "/v1/sessions",
    headers: { "x-api-key": "secret", "idempotency-key": "cleanup-create" },
    payload: { clientReference: "cleanup", policyId: "passport-only", locale: "fr" },
  });
  const token = new URL(created.json().accessUrl).pathname.split("/").at(-1);
  const upload = multipart("file", "capture.jpg", "image/jpeg", Buffer.from("capture"));
  const response = await app.inject({
    method: "POST",
    url: `/public/sessions/${token}/captures/dz-passport/single`,
    headers: { ...upload.headers, "idempotency-key": "cleanup-capture" },
    payload: upload.body,
  });
  assert.equal(response.statusCode, 500);
  assert.equal(captures.stored.size, 0);
  assert.equal(captures.removed.length, 1);
  await app.close();
});

test("local quality laboratory updates the profile used by public capture bootstrap", async () => {
  const sessions = new MemorySessionRepository();
  const captures = new MemoryCaptureStore();
  const queue = new InlineTaskQueue();
  await queue.start({ extraction: async () => undefined });
  const templates = new FileTemplateStore(await mkdtemp(join(tmpdir(), "onboarding-lab-")));
  const qualityProfiles = new QualityProfileStore(defaultQualityProfile);
  const quality = new DocumentQualityEngine(templates, qualityProfiles);
  const app = await buildApp({
    config: loadConfig({ NODE_ENV: "test", CLIENT_API_KEYS: "test-key", QUALITY_LAB_ENABLED: "true" }),
    sessions,
    captures,
    queue,
    webhooks: new RecordingWebhooks(),
    quality,
    templateEngine: quality,
    templates,
    qualityProfiles,
  });

  const configured = {
    ...defaultQualityProfile,
    mode: "enforce" as const,
    image: { ...defaultQualityProfile.image, minSharpness: 14 },
  };
  const update = await app.inject({ method: "PUT", url: "/dev/quality/config", payload: configured });
  assert.equal(update.statusCode, 200, update.body);
  assert.equal(update.json().profile.image.minSharpness, 14);

  const created = await app.inject({
    method: "POST",
    url: "/v1/sessions",
    headers: { "x-api-key": "test-key", "idempotency-key": "lab-bootstrap" },
    payload: { clientReference: "lab", policyId: "id-only", locale: "fr" },
  });
  const token = new URL(created.json().accessUrl).pathname.split("/").at(-1);
  const bootstrap = await app.inject({
    method: "GET",
    url: `/public/sessions/${token}/quality-templates/dz-id-front`,
  });
  assert.equal(bootstrap.statusCode, 200, bootstrap.body);
  assert.deepEqual(bootstrap.json().templates, []);
  assert.equal(bootstrap.json().qualityProfile.mode, "enforce");
  assert.equal(bootstrap.json().qualityProfile.image.minSharpness, 14);

  const simulatedFront = await app.inject({
    method: "POST",
    url: `/dev/sessions/${token}/simulate-scan/dz-id/front`,
    headers: { "idempotency-key": "simulate-id-front" },
  });
  assert.equal(simulatedFront.statusCode, 201, simulatedFront.body);
  assert.equal(simulatedFront.json().session.documents["dz-id"].status, "processing");
  assert.equal(simulatedFront.json().session.documents["dz-id"].ocrAttempts, 0);

  const simulatedBack = await app.inject({
    method: "POST",
    url: `/dev/sessions/${token}/simulate-scan/dz-id/back`,
    headers: { "idempotency-key": "simulate-id-back" },
  });
  assert.equal(simulatedBack.statusCode, 201, simulatedBack.body);
  assert.equal(simulatedBack.json().simulated, true);
  assert.ok(simulatedBack.json().quality.checks.every((check: QualityReport["checks"][number]) => check.passed));
  assert.equal(simulatedBack.json().session.documents["dz-id"].status, "processing");
  assert.equal(simulatedBack.json().session.documents["dz-id"].progress.stage, "quality_validated");
  await new Promise((resolve) => setTimeout(resolve, 2_200));
  const completed = await app.inject({ method: "GET", url: `/public/sessions/${token}` });
  assert.equal(completed.json().documents["dz-id"].status, "ready");
  assert.equal(completed.json().documents["dz-id"].ocrAttempts, 1);
  assert.equal(completed.json().documents["dz-id"].fields.nin, "100012345678901234");
  await app.close();
});

test("quality laboratory sends its last document side to the OCR single-document gateway", async () => {
  const templates = new FileTemplateStore(await mkdtemp(join(tmpdir(), "onboarding-lab-ocr-")));
  const profiles = new QualityProfileStore(defaultQualityProfile);
  const calibrations = new CalibrationHub();
  const quality = new DocumentQualityEngine(templates, profiles);
  const calls: Array<{ documentType: string; file: { name: string; data: Buffer } }> = [];
  let rejectOcr = false;
  const app = await buildApp({
    config: loadConfig({ NODE_ENV: "test", CLIENT_API_KEYS: "test-key", QUALITY_LAB_ENABLED: "true" }),
    sessions: new MemorySessionRepository(),
    captures: new MemoryCaptureStore(),
    queue: new InlineTaskQueue(),
    webhooks: new RecordingWebhooks(),
    quality,
    templateEngine: quality,
    templates,
    qualityProfiles: profiles,
    calibrations,
    ocr: {
      async extract() {
        throw new Error("The calibration lab must use extractSingle");
      },
      async extractSingle(documentType, file) {
        if (rejectOcr) throw new OcrRequestError(400, { error: "bad_image", detail: "image is severely out of focus" });
        calls.push({ documentType, file });
        return { fields: { document_number: "P123456" }, meta: { engine: "test" } };
      },
    },
  });
  const calibration = calibrations.create(profiles.current(), { documentKind: "dz-id" });
  calibrations.storeCapture(calibration.id, {
    original: Buffer.from("passport-photo"),
    ocrImage: Buffer.from("processed-photo"),
    capture: { trigger: "manual", server: qualityReport, original: { width: 100, height: 100, bytes: 14 } },
  });

  const result = await app.inject({
    method: "POST",
    url: `/dev/quality/calibrations/${calibration.id}/ocr-test`,
    payload: { side: "front" },
  });
  assert.equal(result.statusCode, 200, result.body);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.documentType, "dz-id-front");
  assert.equal(calls[0]?.file.name, "file");
  assert.equal(calls[0]?.file.data.toString(), "processed-photo");
  assert.equal(result.json().imageVariant, "ocr");
  assert.equal(result.json().response.fields.document_number, "P123456");

  calibrations.setDocumentKind(calibration.id, "dz-driving-licence");
  const drivingLicence = await app.inject({
    method: "POST",
    url: `/dev/quality/calibrations/${calibration.id}/ocr-test`,
    payload: { side: "back", imageVariant: "original" },
  });
  assert.equal(drivingLicence.statusCode, 200, drivingLicence.body);
  assert.equal(calls[1]?.documentType, "dz-driving-licence-back");
  assert.equal(calls[1]?.file.data.toString(), "passport-photo");
  const invalid = await app.inject({
    method: "POST",
    url: `/dev/quality/calibrations/${calibration.id}/ocr-test`,
    payload: { side: "single" },
  });
  assert.equal(invalid.statusCode, 400);
  assert.equal(calls.length, 2);
  rejectOcr = true;
  const rejected = await app.inject({
    method: "POST",
    url: `/dev/quality/calibrations/${calibration.id}/ocr-test`,
    payload: { side: "front" },
  });
  assert.equal(rejected.statusCode, 502);
  assert.equal(rejected.json().upstreamStatus, 400);
  assert.equal(rejected.json().response.detail, "image is severely out of focus");
  await app.close();
});

test("quality laboratory manages durable ORB templates", async () => {
  const sessions = new MemorySessionRepository();
  const captures = new MemoryCaptureStore();
  const queue = new InlineTaskQueue();
  await queue.start({ extraction: async () => undefined });
  const templates = new FileTemplateStore(await mkdtemp(join(tmpdir(), "onboarding-template-api-")));
  const qualityProfiles = new QualityProfileStore(defaultQualityProfile);
  const quality = new DocumentQualityEngine(templates, qualityProfiles);
  const app = await buildApp({
    config: loadConfig({ NODE_ENV: "test", CLIENT_API_KEYS: "test-key", QUALITY_LAB_ENABLED: "true" }),
    sessions,
    captures,
    queue,
    webhooks: new RecordingWebhooks(),
    quality,
    templateEngine: quality,
    templates,
    qualityProfiles,
  });
  const image = await sharp(
    Buffer.from(`<svg width="1200" height="760" xmlns="http://www.w3.org/2000/svg">
      <rect width="1200" height="760" fill="#eee"/><rect x="35" y="35" width="1130" height="690" fill="#fff" stroke="#111" stroke-width="9"/>
      <text x="85" y="130" font-family="Arial" font-size="52">CARTE NATIONALE D'IDENTITE</text>
      <path d="M80 220 L1120 220 M80 320 L900 320 M80 420 L1050 420 M80 520 L850 520" stroke="#111" stroke-width="14"/>
      ${Array.from({ length: 35 }, (_, index) => `<circle cx="${730 + (index % 7) * 48}" cy="${570 + Math.floor(index / 7) * 30}" r="8" fill="#111"/>`).join("")}
    </svg>`),
  )
    .jpeg()
    .toBuffer();
  const form = multipartForm(
    {
      id: "dz-id-front",
      name: "Carte nationale - recto",
      documentKind: "dz-id",
      zones: JSON.stringify([
        {
          id: "nin",
          label: "NIN",
          role: "required",
          content: "numeric",
          x: 0.5,
          y: 0.3,
          width: 0.35,
          height: 0.12,
        },
      ]),
      paperIgnoreRegions: JSON.stringify([{ x: 0.08, y: 0.25, width: 0.2, height: 0.3 }]),
      useWolfBinarization: "false",
    },
    { field: "image", filename: "identity.jpg", contentType: "image/jpeg", data: image },
  );
  const created = await app.inject({
    method: "POST",
    url: "/dev/quality/templates",
    headers: form.headers,
    payload: form.body,
  });
  assert.equal(created.statusCode, 201, created.body);
  assert.equal(created.json().name, "Carte nationale - recto");
  assert.ok(created.json().orb.rows > 0);

  const listed = await app.inject({ method: "GET", url: "/dev/quality/templates" });
  assert.equal(listed.statusCode, 200, listed.body);
  assert.equal(listed.json()[0].id, "dz-id-front");
  assert.equal(listed.json()[0].zoneCount, 1);

  const storedImage = await app.inject({ method: "GET", url: "/dev/quality/templates/dz-id-front/image" });
  assert.equal(storedImage.statusCode, 200, storedImage.body);
  assert.equal(storedImage.headers["content-type"], "image/jpeg");
  assert.equal(storedImage.rawPayload.equals(image), true);

  const updated = await app.inject({
    method: "PUT",
    url: "/dev/quality/templates/dz-id-front",
    payload: {
      name: "Carte nationale - recto v2",
      zones: [],
      paperIgnoreRegions: [],
      useWolfBinarization: true,
    },
  });
  assert.equal(updated.statusCode, 200, updated.body);
  assert.equal(updated.json().version, 2);
  assert.equal(updated.json().useWolfBinarization, true);

  const removed = await app.inject({ method: "DELETE", url: "/dev/quality/templates/dz-id-front" });
  assert.equal(removed.statusCode, 200, removed.body);
  assert.deepEqual(removed.json(), { deleted: true });
  assert.deepEqual((await app.inject({ method: "GET", url: "/dev/quality/templates" })).json(), []);
  await app.close();
});

class RecordingWebhooks implements WebhookGateway {
  sessions: OnboardingSession[] = [];
  async sendCompleted(session: OnboardingSession) {
    this.sessions.push(structuredClone(session));
  }
}

function multipart(field: string, filename: string, contentType: string, data: Buffer) {
  const boundary = `----onboarding-${Date.now()}-${Math.random()}`;
  const before = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="${field}"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`,
  );
  const after = Buffer.from(`\r\n--${boundary}--\r\n`);
  return {
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
    body: Buffer.concat([before, data, after]),
  };
}

function multipartForm(
  fields: Record<string, string>,
  file: { field: string; filename: string; contentType: string; data: Buffer },
) {
  const boundary = `----onboarding-${Date.now()}-${Math.random()}`;
  const chunks = Object.entries(fields).map(([name, value]) =>
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`),
  );
  chunks.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${file.field}"; filename="${file.filename}"\r\nContent-Type: ${file.contentType}\r\n\r\n`,
    ),
    Buffer.from(file.data),
    Buffer.from(`\r\n--${boundary}--\r\n`),
  );
  return {
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
    body: Buffer.concat(chunks),
  };
}
