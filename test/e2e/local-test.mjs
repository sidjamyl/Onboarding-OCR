import assert from "node:assert/strict";

const base = process.env.TEST_BASE_URL ?? "http://localhost:3000";
const publicOrigin = new URL(process.env.PUBLIC_BASE_URL ?? base).origin;
assert.equal((await fetch(`${base}/test`)).status, 200);

async function start(policyId) {
  const response = await fetch(`${base}/api/demo/session`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: base },
    body: JSON.stringify({ locale: "fr", ...(policyId ? { policyId } : {}) }),
  });
  assert.equal(response.status, 201, "The local test must start without a user session or API key");
  const session = await response.json();
  assert.equal(new URL(session.accessUrl).origin, publicOrigin);
  const token = new URL(session.accessUrl).pathname.split("/").at(-1);
  const publicSession = await (await fetch(`${base}/api/onboarding/public/sessions/${token}`)).json();
  assert.equal(publicSession.status, "created", "New demos must open the document selection screen");
  assert.equal(publicSession.policyId, "id-and-licence");
  assert.deepEqual(Object.keys(publicSession.documents).sort(), ["dz-driving-licence", "dz-id"]);
  assert.deepEqual([...publicSession.documentSelection.allowedDocuments].sort(), ["dz-driving-licence", "dz-id"]);
  assert.equal(publicSession.documentSelection.mode, "all");
  assert.equal(publicSession.documentSelection.minimumDocuments, 2);
  const unchanged = await (await fetch(`${base}/api/onboarding/public/sessions/${token}`)).json();
  assert.equal(unchanged.status, "created", "Refreshing must not skip document selection");
  const selection = await fetch(`${base}/api/onboarding/public/sessions/${token}/select-documents`, {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
    body: JSON.stringify({ documents: ["dz-id", "dz-driving-licence"] }),
  });
  assert.equal(selection.status, 200);
  const selected = await selection.json();
  assert.equal(selected.status, "capturing", "Phone pairing starts only after document selection is validated");
  assert.deepEqual(Object.keys(selected.documents).sort(), ["dz-driving-licence", "dz-id"]);
  return session.sessionId;
}

assert.notEqual(await start(), await start("id-and-licence"), "Every start must create a fresh session");
assert.equal((await fetch(`${base}/api/demo/session`, {
  method: "POST", headers: { origin: "https://unrelated.example", "content-type": "application/json" },
  body: JSON.stringify({ policyId: "id-and-licence" }),
})).status, 403);
for (const body of ["{", "null", '{"policyId":"unknown"}', '{"policyId":"all-three"}', '{"locale":"unknown"}']) {
  assert.equal((await fetch(`${base}/api/demo/session`, {
    method: "POST", headers: { origin: base, "content-type": "application/json" }, body,
  })).status, 400);
}
console.log("Local test passed: selection before phone pairing, both required documents, fresh sessions and request validation.");
