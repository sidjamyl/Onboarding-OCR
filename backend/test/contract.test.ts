import assert from "node:assert/strict";
import test from "node:test";
import { MemoryCaptureStore, MemorySessionRepository } from "../src/adapters/memory.js";
import { InlineTaskQueue } from "../src/adapters/queue.js";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";

test("OpenAPI exposes the authenticated creation, status and result contracts", async () => {
  const queue = new InlineTaskQueue();
  await queue.start({ extraction: async () => undefined });
  const app = await buildApp({
    config: loadConfig({ NODE_ENV: "test", CLIENT_API_KEYS: "contract-key" }),
    sessions: new MemorySessionRepository(),
    captures: new MemoryCaptureStore(),
    queue,
    quality: {
      async analyze() {
        throw new Error("not used");
      },
    },
    webhooks: { async sendCompleted() {} },
  });
  await app.ready();
  const specification = app.swagger() as {
    components?: { securitySchemes?: Record<string, unknown> };
    paths?: Record<string, Record<string, { requestBody?: unknown; responses?: Record<string, unknown> }>>;
  };
  assert.ok(specification.components?.securitySchemes?.ApiKeyAuth);
  assert.ok(specification.paths?.["/v1/sessions"]?.post?.requestBody);
  assert.ok(specification.paths?.["/v1/sessions/{id}/status"]?.get?.responses?.["200"]);
  assert.ok(specification.paths?.["/v1/sessions/{id}/result"]?.get?.responses?.["200"]);
  await app.close();
});
