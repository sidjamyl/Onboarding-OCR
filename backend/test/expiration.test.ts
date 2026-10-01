import assert from "node:assert/strict";
import test from "node:test";
import { MemorySessionRepository } from "../src/adapters/memory.js";
import { InlineTaskQueue } from "../src/adapters/queue.js";
import { createSession } from "../src/domain/workflow.js";
import { ExpirationService } from "../src/services/expiration.js";

test("expiration sweep closes abandoned sessions and queues their final webhook", async () => {
  const sessions = new MemorySessionRepository();
  const queue = new InlineTaskQueue();
  const delivered: string[] = [];
  await queue.start({ webhook: async ({ sessionId }) => void delivered.push(sessionId) });
  const created = createSession({
    clientReference: "expired-case",
    policyId: "passport-only",
    locale: "fr",
    now: new Date("2026-09-25T00:00:00.000Z"),
  });
  await sessions.create(created, "expired-idempotency-key");

  const completed = await new ExpirationService(sessions, queue).process(new Date("2026-09-25T00:31:00.000Z"));
  const expired = await sessions.findById(created.id);

  assert.equal(completed, 1);
  assert.equal(expired?.status, "expired");
  assert.equal(expired?.reasonCode, "session_expired");
  assert.deepEqual(delivered, [created.id]);
});
