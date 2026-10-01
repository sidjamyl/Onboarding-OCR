import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const api = process.env.E2E_API_URL ?? "http://127.0.0.1:8390";
const apiKey = "e2e-client-key-123456789";
const run = `${Date.now()}-${Math.random().toString(36).slice(2)}`;

async function request(path, init = {}) {
  const response = await fetch(`${api}${path}`, init);
  const payload = await response.json();
  if (!response.ok) throw new Error(`${init.method ?? "GET"} ${path} returned ${response.status}: ${JSON.stringify(payload)}`);
  return payload;
}

const ready = await request("/readyz");
assert.equal(ready.status, "ready");
const created = await request("/v1/sessions", {
  method: "POST",
  headers: { "content-type": "application/json", "x-api-key": apiKey, "idempotency-key": `create-${run}` },
  body: JSON.stringify({ clientReference: `e2e-${run}`, policyId: "two-of-three", locale: "fr" }),
});
const token = new URL(created.accessUrl).pathname.split("/").at(-1);
assert.ok(token);
await request(`/public/sessions/${token}/select-documents`, {
  method: "POST",
  headers: { "content-type": "application/json", "idempotency-key": `select-${run}` },
  body: JSON.stringify({ documents: ["dz-id", "dz-passport"] }),
});
const sample = await readFile(new URL("./sample.svg", import.meta.url));
for (const kind of ["dz-id", "dz-passport"]) {
  for (const side of kind === "dz-id" ? ["front", "back"] : ["single"]) {
    const body = new FormData();
    body.append("file", new Blob([sample], { type: "image/svg+xml" }), "sample.svg");
    const capture = await request(`/public/sessions/${token}/captures/${kind}/${side}`, {
      method: "POST",
      headers: { "idempotency-key": `capture-${kind}-${side}-${run}` },
      body,
    });
    assert.ok(capture.captureId);
    assert.equal(JSON.stringify(capture).includes("objectKey"), false);
  }
  const deadline = Date.now() + 45_000;
  let publicSession;
  while (Date.now() < deadline) {
    publicSession = await request(`/public/sessions/${token}`);
    if (publicSession.documents[kind].status === "ready") break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  assert.equal(publicSession?.documents[kind].status, "ready");
  await request(`/public/sessions/${token}/documents/${kind}/confirm`, {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": `confirm-${kind}-${run}` },
    body: "{}",
  });
}
const beforeSubmit = await request(`/public/sessions/${token}`);
assert.equal(beforeSubmit.status, "awaiting_submission");
await request(`/public/sessions/${token}/submit`, {
  method: "POST",
  headers: { "content-type": "application/json", "idempotency-key": `submit-${run}` },
  body: "{}",
});
const result = await request(`/v1/sessions/${created.sessionId}/result`, { headers: { "x-api-key": apiKey } });
assert.equal(result.status, "succeeded");
assert.equal(result.result.fields.nin, "100012345678901234");
assert.equal(result.documents["dz-id"].ocrAttempts, 1);
console.log(JSON.stringify({ ready: ready.status, status: result.status, ocrAttempts: 1 }));
