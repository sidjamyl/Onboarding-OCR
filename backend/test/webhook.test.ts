import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { HttpWebhookGateway } from "../src/adapters/webhook.js";
import { createSession } from "../src/domain/workflow.js";

test("completion webhook is signed, stable and contains no client reference or OCR data", async () => {
  const secret = "webhook-test-secret";
  const session = createSession({
    clientReference: "customer-email@example.test",
    clientApplicationId: "partner",
    webhookDestinationId: "main",
    policyId: "passport-only",
    locale: "fr",
  });
  session.status = "succeeded";
  session.result = {
    fields: { nin: "100012345678901234" },
    documents: { "dz-passport": { nin: "100012345678901234" } },
    completedAt: "2026-09-25T00:00:00.000Z",
  };

  let body = "";
  let signature = "";
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_input, init) => {
    body = String(init?.body ?? "");
    signature = new Headers(init?.headers).get("x-onboarding-signature") ?? "";
    return new Response(null, { status: 204 });
  };
  try {
    const gateway = new HttpWebhookGateway(
      new Map([["partner:main", { url: "https://webhook.example.test/onboarding", secret }]]),
    );
    await gateway.sendCompleted(session);
  } finally {
    globalThis.fetch = originalFetch;
  }

  const payload = JSON.parse(body) as Record<string, unknown>;
  assert.equal(payload.eventId, session.webhookEventId);
  assert.equal(payload.sessionId, session.id);
  assert.equal("clientReference" in payload, false);
  assert.equal("fields" in payload, false);
  assert.equal(signature, `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`);
});
