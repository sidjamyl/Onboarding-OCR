import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { memoryAdapter } from "better-auth/adapters/memory";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { MemoryCaptureStore, MemorySessionRepository } from "../src/adapters/memory.js";
import { InlineTaskQueue } from "../src/adapters/queue.js";
import { createAdminAuth, emptyAuthTables, provisionAdministrator } from "../src/management/auth.js";
import { documentRulesSchema, policyForApplication, type ClientApplication } from "../src/management/model.js";
import { MemoryApplicationStore, issueKey } from "../src/management/store.js";
import { createSession, selectDocuments } from "../src/domain/workflow.js";

function application(rules: ClientApplication["rules"]): ClientApplication {
  return {
    id: "client-a",
    name: "Client A",
    enabled: true,
    version: 1,
    rules,
    webhookUrl: "https://client.example/webhooks",
    webhookSecret: "test-signing-secret",
    returnUrl: "https://client.example/return",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

test("all four document rules enforce mandatory documents and exact totals", () => {
  const documents = ["dz-id", "dz-driving-licence", "dz-passport"] as const;
  const cases: Array<{
    rules: ClientApplication["rules"];
    accepted: Array<(typeof documents)[number]>;
    rejected: Array<(typeof documents)[number]>;
  }> = [
    {
      rules: { mode: "all", documents: [...documents], requiredDocuments: [] },
      accepted: [...documents],
      rejected: ["dz-id"],
    },
    {
      rules: { mode: "optional", documents: [...documents], requiredDocuments: ["dz-id"] },
      accepted: ["dz-id"],
      rejected: ["dz-passport"],
    },
    {
      rules: { mode: "exact", documents: [...documents], requiredDocuments: [], count: 2 },
      accepted: ["dz-driving-licence", "dz-passport"],
      rejected: [...documents],
    },
    {
      rules: { mode: "exact", documents: [...documents], requiredDocuments: ["dz-id"], count: 2 },
      accepted: ["dz-id", "dz-passport"],
      rejected: ["dz-driving-licence", "dz-passport"],
    },
  ];
  for (const { rules, accepted, rejected } of cases) {
    const policy = policyForApplication(application(documentRulesSchema.parse(rules)));
    const session = createSession({ clientReference: "customer", policyId: policy.id, policy, locale: "fr" });
    assert.throws(() => selectDocuments(session, rejected), /documents|document/);
    selectDocuments(session, accepted);
    assert.deepEqual(Object.keys(session.documents).sort(), accepted.sort());
  }
  assert.equal(
    documentRulesSchema.safeParse({ mode: "exact", documents: ["dz-id"], requiredDocuments: ["dz-id"], count: 2 })
      .success,
    false,
  );
  assert.equal(
    documentRulesSchema.safeParse({ mode: "optional", documents: ["dz-id"], requiredDocuments: ["dz-passport"] })
      .success,
    false,
  );
});

test("administrator login, guarded management, key scope, revocation and frozen session rules", async () => {
  const config = loadConfig({
    NODE_ENV: "test",
    PUBLIC_BASE_URL: "http://localhost:3010",
    BETTER_AUTH_SECRET: randomBytes(32).toString("base64url"),
  });
  const auth = createAdminAuth(config, memoryAdapter(emptyAuthTables()));
  const password = "a-test-only-password-123";
  await provisionAdministrator(auth, "admin@example.test", password);
  const applications = new MemoryApplicationStore();
  const sessions = new MemorySessionRepository();
  const app = await buildApp({
    config,
    applications,
    auth,
    sessions,
    captures: new MemoryCaptureStore(),
    queue: new InlineTaskQueue(),
    webhooks: { async sendCompleted() {} },
    quality: {
      async analyze() {
        throw new Error("Not used by this test");
      },
    },
    ocr: {
      async extract() {
        return {};
      },
      async listDocuments() {
        return [
          "dz-id-front",
          "dz-id-back",
          "dz-driving-licence-front",
          "dz-driving-licence-back",
          "dz-passport",
          "dz-birth-certificate",
        ].map((id) => ({ id, title: id, version: "1" }));
      },
    },
  });
  try {
    assert.equal((await app.inject({ url: "/admin/applications" })).statusCode, 401);
    assert.equal((await app.inject({ url: "/openapi.json" })).statusCode, 200);
    assert.equal((await app.inject({ url: "/docs" })).statusCode, 302);
    const signup = await app.inject({
      method: "POST",
      url: "/api/auth/sign-up/email",
      headers: { origin: config.PUBLIC_BASE_URL },
      payload: { name: "Stranger", email: "other@example.test", password },
    });
    assert.ok(signup.statusCode >= 400);
    const login = await app.inject({
      method: "POST",
      url: "/api/auth/sign-in/email",
      headers: { origin: config.PUBLIC_BASE_URL },
      payload: { email: "admin@example.test", password },
    });
    assert.equal(login.statusCode, 200, login.body);
    const cookie = login.cookies.map(({ name, value }) => `${name}=${value}`).join("; ");
    assert.ok(cookie);
    const headers = { cookie, origin: config.PUBLIC_BASE_URL };
    const catalog = await app.inject({ url: "/admin/catalog", headers });
    assert.equal(catalog.json().documents.length, 3);
    assert.equal(catalog.json().unsupportedDocuments.length, 1);
    const body = {
      name: "Customer portal",
      rules: { mode: "exact", documents: ["dz-id", "dz-passport"], requiredDocuments: ["dz-id"], count: 2 },
      webhookUrl: "https://client.example/webhook",
      returnUrl: "https://client.example/return",
    };
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/admin/applications",
          headers: { cookie, origin: "https://attacker.example" },
          payload: body,
        })
      ).statusCode,
      403,
    );
    const createdApp = await app.inject({ method: "POST", url: "/admin/applications", headers, payload: body });
    assert.equal(createdApp.statusCode, 201, createdApp.body);
    const id = createdApp.json().application.id as string;
    const keyResponse = await app.inject({
      method: "POST",
      url: `/admin/applications/${id}/keys`,
      headers,
      payload: { name: "Production" },
    });
    assert.equal(keyResponse.statusCode, 201);
    const key = keyResponse.json().key as string;
    const apiHeaders = { "x-api-key": key, "idempotency-key": "create-customer-123" };
    const create = await app.inject({
      method: "POST",
      url: "/v1/sessions",
      headers: apiHeaders,
      payload: { clientReference: "customer-123" },
    });
    assert.equal(create.statusCode, 201, create.body);
    const sessionId = create.json().sessionId as string;
    const session = await sessions.findById(sessionId);
    assert.ok(session);
    assert.equal(session.webhookDestination?.url, body.webhookUrl);
    assert.equal(session.returnUrl, body.returnUrl);
    assert.equal(session.policy?.maximumDocuments, 2);
    const publicSession = await app.inject({ url: `/public/sessions/${session.publicToken}` });
    assert.equal(publicSession.body.includes("webhookSecret"), false);
    assert.ok(session.webhookDestination);
    assert.equal(publicSession.body.includes(session.webhookDestination.secret), false);
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/v1/sessions",
          headers: { ...apiHeaders, "idempotency-key": "override-policy-123" },
          payload: { clientReference: "customer", policyId: "passport-only" },
        })
      ).statusCode,
      403,
    );
    const updated = await app.inject({
      method: "PUT",
      url: `/admin/applications/${id}`,
      headers,
      payload: { ...body, version: 1, rules: { mode: "all", documents: ["dz-passport"], requiredDocuments: [] } },
    });
    assert.equal(updated.statusCode, 200, updated.body);
    assert.equal(
      (await app.inject({ method: "PUT", url: `/admin/applications/${id}`, headers, payload: { ...body, version: 1 } }))
        .statusCode,
      409,
    );
    assert.equal((await sessions.findById(sessionId))?.policy?.maximumDocuments, 2);
    const retry = await app.inject({
      method: "POST",
      url: "/v1/sessions",
      headers: apiHeaders,
      payload: { clientReference: "customer-123" },
    });
    assert.equal(retry.json().sessionId, sessionId);
    const other = application({ mode: "all", documents: ["dz-id"], requiredDocuments: [] });
    await applications.save(other);
    const otherKey = await issueKey(applications, other.id, "Other client");
    assert.equal(
      (await app.inject({ url: `/v1/sessions/${sessionId}/status`, headers: { "x-api-key": otherKey.key } }))
        .statusCode,
      404,
    );
    const listed = await app.inject({ url: `/admin/applications/${id}/keys`, headers });
    assert.equal(listed.body.includes(key), false);
    assert.equal(
      (await app.inject({ method: "DELETE", url: `/admin/applications/${id}/keys/${keyResponse.json().id}`, headers }))
        .statusCode,
      200,
    );
    assert.equal((await app.inject({ url: `/v1/sessions/${sessionId}/status`, headers: apiHeaders })).statusCode, 401);
    assert.equal(
      (await app.inject({ method: "POST", url: "/api/auth/sign-out", headers, payload: {} })).statusCode,
      200,
    );
    assert.equal((await app.inject({ url: "/admin/applications", headers })).statusCode, 401);
  } finally {
    await app.close();
  }
});
