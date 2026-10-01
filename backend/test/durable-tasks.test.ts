import assert from "node:assert/strict";
import test from "node:test";
import { MemorySessionRepository } from "../src/adapters/memory.js";
import { createSession, registerCapture } from "../src/domain/workflow.js";
import type { TaskQueue } from "../src/ports.js";
import { DurableTaskDispatcher } from "../src/services/durable-tasks.js";

test("a final session remains recoverable when its first webhook enqueue fails", async () => {
  const sessions = new MemorySessionRepository();
  const session = createSession({ clientReference: "durable-webhook", policyId: "passport-only", locale: "fr" });
  session.status = "succeeded";
  session.version += 1;
  const delivered: string[] = [];
  let fail = true;
  const queue: TaskQueue = {
    async enqueueExtraction() {},
    async enqueueWebhook({ sessionId }) {
      if (fail) throw new Error("queue unavailable");
      delivered.push(sessionId);
    },
    async start() {},
    async stop() {},
  };
  const tasks = new DurableTaskDispatcher(sessions, queue);
  tasks.prepare(session);
  await sessions.create(session, "durable-webhook-key");

  await assert.rejects(() => tasks.dispatch(session), /queue unavailable/);
  fail = false;
  assert.equal(await tasks.recover(), 1);
  assert.deepEqual(delivered, [session.id]);
});

test("reviewed sessions created before per-face jobs do not reread their captures", async () => {
  const sessions = new MemorySessionRepository();
  const session = createSession({ clientReference: "legacy", policyId: "id-only", locale: "en" });
  registerCapture(session, {
    kind: "dz-id",
    side: "front",
    objectKey: "front",
    quality: {
      passed: true,
      mode: "enforce",
      templateMatched: true,
      checks: [],
      durationMs: 1,
    },
  });
  const document = session.documents["dz-id"];
  assert.ok(document);
  delete document.sideResults;
  document.status = "ready";
  let queued = 0;
  const queue: TaskQueue = {
    async enqueueExtraction() {
      queued++;
    },
    async enqueueWebhook() {},
    async start() {},
    async stop() {},
  };
  await new DurableTaskDispatcher(sessions, queue).dispatch(session);
  assert.equal(queued, 0);
});
