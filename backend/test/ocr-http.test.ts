import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { HttpOcrGateway, OcrRequestError } from "../src/adapters/ocr-http.js";

test("OCR rejection preserves its status and diagnostic instead of becoming an opaque internal error", async (t) => {
  const server = createServer((request, response) => {
    request.resume();
    response.writeHead(400, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "bad_image", detail: "image is severely out of focus" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address();
  assert(address && typeof address !== "string");
  const gateway = new HttpOcrGateway({
    baseUrl: `http://127.0.0.1:${address.port}`,
    username: "test",
    password: "test",
    timeoutMs: 1_000,
  });
  await assert.rejects(
    gateway.extractSingle("dz-id-front", { name: "file", data: Buffer.from("photo"), contentType: "image/jpeg" }),
    (error: unknown) => {
      const failure = error as { upstreamStatus?: number; response?: { error?: string; detail?: string } };
      assert.equal(failure.upstreamStatus, 400);
      assert.equal(failure.response?.error, "bad_image");
      assert.equal(failure.response?.detail, "image is severely out of focus");
      return true;
    },
  );
});

test("verification 422 is a refusal, not an extraction response", async (t) => {
  const server = createServer((request, response) => {
    request.resume();
    response.writeHead(422, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "document_not_verified" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address();
  assert(address && typeof address !== "string");
  const gateway = new HttpOcrGateway({
    baseUrl: `http://127.0.0.1:${address.port}`,
    username: "test",
    password: "test",
    timeoutMs: 1_000,
  });
  await assert.rejects(
    gateway.verify("dz-id-front", { name: "front", data: Buffer.from("crop"), contentType: "image/jpeg" }),
    (error: unknown) =>
      error instanceof OcrRequestError &&
      error.upstreamStatus === 422 &&
      error.response.error === "document_not_verified",
  );
});

test("extraction 422 keeps the Gateway validation report for a blocking retake", async (t) => {
  const server = createServer((request, response) => {
    request.resume();
    response.writeHead(422, { "content-type": "application/json" });
    response.end(JSON.stringify({
      status: "failed",
      fields: { passport_number: "A12345678" },
      validation: { status: "failed", failedFields: ["passport_number"] },
    }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address();
  assert(address && typeof address !== "string");
  const gateway = new HttpOcrGateway({
    baseUrl: `http://127.0.0.1:${address.port}`,
    username: "test", password: "test", timeoutMs: 1_000,
  });
  const result = await gateway.extract("dz-passport", [
    { name: "single", data: Buffer.from("photo"), contentType: "image/jpeg" },
  ]);
  assert.equal(result.status, "failed");
  assert.deepEqual((result.validation as { failedFields: string[] }).failedFields, ["passport_number"]);
});
