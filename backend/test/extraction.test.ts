import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { MemoryCaptureStore, MemorySessionRepository } from "../src/adapters/memory.js";
import { InlineTaskQueue } from "../src/adapters/queue.js";
import { OcrRequestError } from "../src/adapters/ocr-http.js";
import { defaultRequiredFields } from "../src/domain/requirements.js";
import { createSession, registerCapture, retakeSide } from "../src/domain/workflow.js";
import { ExtractionService } from "../src/services/extraction.js";
import { DurableTaskDispatcher } from "../src/services/durable-tasks.js";
import type { DocumentSide } from "../src/domain/types.js";
import type { OcrGateway, OcrInput } from "../src/ports.js";
const quality = { passed: true, mode: "enforce" as const, templateMatched: false, durationMs: 1, checks: [] };
const front = {
  document_number: "1234567890",
  nin: "100012345678901234",
  surname_ar: "\u0628\u0646 \u0639\u0644\u064a",
  given_name_ar: "\u0623\u0645\u064a\u0646",
  date_of_birth: "1990-02-12",
  date_of_expiry: "2030-02-12",
  sex: "M",
};
const back = {
  document_number: "A12345678",
  surname_latin: "BENALI",
  given_name_latin: "AMINE",
  date_of_birth: "1990-02-12",
  date_of_expiry: "2030-02-12",
  sex: "M",
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
test("optional OCR failures and expired dates do not block identity onboarding", async () => {
  const ctx = await setup(async (type) => ({
    fields: { ...(type.endsWith("front") ? front : back), date_of_expiry: "2020-02-12", sex: type.endsWith("front") ? "M" : "F" },
    status: "failed",
    validation: { status: "failed", failedFields: ["date_of_expiry_printed", "category_entries"], checks: [
      { id: "expiry.printed", field: "date_of_expiry_printed", outcome: "failed" },
      { id: "categories", field: "category_entries", outcome: "failed" },
    ] },
  }));
  await ctx.capture("front");
  await ctx.capture("back");
  await ctx.queue.drain();
  const document = (await ctx.sessions.findById(ctx.session.id))?.documents["dz-id"];
  assert.equal(document?.status, "ready");
  assert.deepEqual(document?.unreadableFields, []);
  assert.equal(document?.consistency?.blocking, false);
  assert.ok(document?.consistency?.checks.every((check) => !["sex", "date_of_expiry", "coverage"].includes(check.field)));
});
async function setup(read: (type: string, file: OcrInput) => Promise<Record<string, unknown>>, policyId = "id-only") {
  const sessions = new MemorySessionRepository(),
    captures = new MemoryCaptureStore(),
    queue = new InlineTaskQueue();
  const session = createSession({ clientReference: "face-integration", policyId, locale: "fr" });
  await sessions.create(session, session.id);
  const ocr: OcrGateway = {
    async extract() {
      throw new Error("Pair extraction must not be called");
    },
    extractSingle: read,
  };
  const service = new ExtractionService({ sessions, captures, queue, ocr, requiredFields: defaultRequiredFields });
  await queue.start({ extraction: (task) => service.process(task) });
  const tasks = new DurableTaskDispatcher(sessions, queue);
  async function capture(side: DocumentSide, bytes: string = side, dispatch = true) {
    const key = `${session.id}/${side}-${bytes}.jpg`;
    await captures.put(key, Buffer.from(bytes));
    const saved = await sessions.mutateByPublicToken(session.publicToken, (state) =>
      registerCapture(state, {
        kind: policyId === "passport-only" ? "dz-passport" : "dz-id",
        side,
        objectKey: key,
        ocrObjectKey: `${key}.enhanced`,
        quality,
      }),
    );
    assert.ok(saved);
    if (dispatch) await tasks.dispatch(saved.session);
    return saved.result;
  }
  return { sessions, captures, queue, session, service, tasks, capture };
}
test("first accepted face extracts immediately; admission stays nonblocking and latest faces join once", async () => {
  const entered = deferred<void>(),
    release = deferred<Record<string, unknown>>(),
    calls: string[] = [];
  const ctx = await setup(async (type, file) => {
    calls.push(type);
    assert.equal(file.data.toString(), file.name);
    if (type.endsWith("front")) {
      entered.resolve();
      return release.promise;
    }
    return { fields: back };
  });
  await ctx.capture("front");
  await entered.promise;
  assert.deepEqual(calls, ["dz-id-front"]);
  await ctx.capture("back");
  for (let turn = 0; turn < 10; turn++) await new Promise<void>((done) => setImmediate(done));
  let saved = await ctx.sessions.findById(ctx.session.id);
  assert.equal(saved?.documents["dz-id"]?.sideResults?.back?.status, "ready");
  assert.equal(saved?.documents["dz-id"]?.ocrAttempts, 0);
  assert.equal(saved?.documents["dz-id"]?.sideFields?.back?.surname_latin, "BENALI");
  release.resolve({ fields: front });
  await ctx.queue.drain();
  saved = await ctx.sessions.findById(ctx.session.id);
  assert.equal(saved?.documents["dz-id"]?.status, "ready");
  assert.equal(saved?.documents["dz-id"]?.ocrAttempts, 1);
  assert.equal(saved?.documents["dz-id"]?.fields?.nin, front.nin);
  await ctx.service.process({ sessionId: ctx.session.id, kind: "dz-id" });
  assert.equal(calls.length, 2);
  assert.equal((await ctx.sessions.findById(ctx.session.id))?.documents["dz-id"]?.ocrAttempts, 1);
});
test("selective retake keeps unchanged face and recovers only identity-continuous readable fields", async () => {
  let frontReads = 0,
    backReads = 0;
  const ctx = await setup(async (type) =>
    type.endsWith("back")
      ? (backReads++, { fields: back })
      : { fields: ++frontReads === 1 ? { ...front, given_name_ar: null } : { ...front, nin: null } },
  );
  await ctx.capture("front");
  await ctx.capture("back");
  await ctx.queue.drain();
  assert.equal((await ctx.sessions.findById(ctx.session.id))?.documents["dz-id"]?.status, "ready");
  await ctx.sessions.mutateByPublicToken(ctx.session.publicToken, (state) => retakeSide(state, "dz-id", "front"));
  await ctx.capture("front", "replacement");
  await ctx.queue.drain();
  const saved = await ctx.sessions.findById(ctx.session.id);
  assert.equal(saved?.documents["dz-id"]?.status, "ready");
  assert.equal(saved?.documents["dz-id"]?.fields?.nin, front.nin);
  assert.deepEqual(saved?.documents["dz-id"]?.reusedFieldKeys?.front, ["nin"]);
  assert.equal(backReads, 1);
  assert.equal(frontReads, 2);
});
test("replacement and duplicate workers cannot publish stale results or consume another attempt", async () => {
  const old = deferred<Record<string, unknown>>(),
    entered = deferred<void>();
  let frontReads = 0;
  const ctx = await setup(async (type, file) => {
    if (type.endsWith("back")) return { fields: back };
    frontReads++;
    if (file.data.toString() === "old") {
      entered.resolve();
      return old.promise;
    }
    return { fields: front };
  });
  const oldId = await ctx.capture("front", "old");
  await entered.promise;
  await ctx.service.process({ sessionId: ctx.session.id, kind: "dz-id", side: "front", captureId: oldId });
  assert.equal(frontReads, 1);
  await ctx.sessions.mutateByPublicToken(ctx.session.publicToken, (state) => retakeSide(state, "dz-id", "front"));
  await ctx.capture("front", "new");
  await ctx.capture("back");
  old.resolve({ fields: { ...front, nin: "999999999999999999" } });
  await ctx.queue.drain();
  const saved = await ctx.sessions.findById(ctx.session.id);
  assert.equal(saved?.documents["dz-id"]?.fields?.nin, front.nin);
  assert.equal(saved?.documents["dz-id"]?.ocrAttempts, 1);
  assert.equal(saved?.documents["dz-id"]?.sideOcrAttempts?.front, 1);
  assert.equal(frontReads, 2);
});
test("cross-face conflicts are detailed mismatches, distinct from unreadable values", async () => {
  const ctx = await setup(async (type) => ({
    fields: type.endsWith("front") ? front : { ...back, date_of_birth: "1991-02-12" },
  }));
  await ctx.capture("front");
  await ctx.capture("back");
  await ctx.queue.drain();
  const document = (await ctx.sessions.findById(ctx.session.id))?.documents["dz-id"];
  assert.equal(document?.consistency?.blocking, true);
  const conflict = document?.consistency?.checks.find(
    (check) => check.field === "date_of_birth" && check.status === "failed",
  );
  assert.deepEqual(
    conflict?.readings.map((reading) => [reading.side, reading.value]),
    [
      ["front", "1990-02-12"],
      ["back", "1991-02-12"],
    ],
  );
  assert.deepEqual(document?.unreadableFields, []);
});
test("verification refusal replaces only its face and uses unchanged crops", async () => {
  const ctx = await setup(async (type, file) => {
    assert.equal(file.data.toString(), file.name);
    if (type.endsWith("front")) throw new OcrRequestError(422, { error: "document_not_verified" });
    return { fields: back };
  });
  await ctx.capture("front", "front", false);
  await ctx.capture("back", "back", false);
  await ctx.service.process({ sessionId: ctx.session.id, kind: "dz-id" });
  const saved = await ctx.sessions.findById(ctx.session.id);
  assert.equal(saved?.reasonCode, "document_not_verified");
  assert.equal(saved?.documents["dz-id"]?.captures.front, undefined);
  assert.ok(saved?.documents["dz-id"]?.captures.back);
  assert.equal(saved?.documents["dz-id"]?.sideFields?.back?.surname_latin, "BENALI");
  assert.equal(saved?.documents["dz-id"]?.ocrAttempts, 0);
  assert.equal(saved?.documents["dz-id"]?.technicalFailures, 0);
  await assert.rejects(ctx.captures.get(`${ctx.session.id}/front-front.jpg`));
});
test("technical retries do not consume attempts or reread the completed counterpart", async () => {
  let reads = 0,
    backReads = 0;
  const ctx = await setup(async (type) => {
    if (type.endsWith("back")) {
      backReads++;
      return { fields: back };
    }
    if (++reads < 3) throw new Error("temporary upstream failure");
    return { fields: front };
  });
  await ctx.capture("front");
  await ctx.capture("back");
  await ctx.queue.drain();
  const saved = await ctx.sessions.findById(ctx.session.id);
  assert.equal(saved?.documents["dz-id"]?.status, "ready");
  assert.equal(saved?.documents["dz-id"]?.technicalFailures, 2);
  assert.equal(saved?.documents["dz-id"]?.ocrAttempts, 1);
  assert.equal(saved?.documents["dz-id"]?.sideOcrAttempts?.front, 1);
  assert.equal(backReads, 1);
});
test("recovery resumes expired face lease and persisted unjoined pair without rereading", async () => {
  const calls: string[] = [];
  const ctx = await setup(async (type) => {
    calls.push(type);
    return { fields: type.endsWith("front") ? front : back };
  });
  await ctx.capture("front", "front", false);
  await ctx.capture("back", "back", false);
  await ctx.sessions.mutateByPublicToken(ctx.session.publicToken, (state) => {
    const document = state.documents["dz-id"]!;
    document.sideResults!.front = {
      captureId: document.captures.front!.id,
      status: "processing",
      leaseUntil: 0,
      processingToken: "dead-worker",
      technicalFailures: 0,
    };
    document.sideResults!.back = {
      captureId: document.captures.back!.id,
      status: "ready",
      response: { fields: back },
      technicalFailures: 0,
    };
  });
  assert.equal(await ctx.tasks.recover(), 1);
  await ctx.queue.drain();
  assert.deepEqual(calls, ["dz-id-front"]);
  await ctx.sessions.mutateByPublicToken(ctx.session.publicToken, (state) => {
    const document = state.documents["dz-id"]!;
    delete document.joinedCaptureIds;
    document.status = "processing";
    document.ocrAttempts = 0;
  });
  await ctx.tasks.recover();
  await ctx.queue.drain();
  assert.equal(calls.length, 1);
  assert.equal((await ctx.sessions.findById(ctx.session.id))?.documents["dz-id"]?.ocrAttempts, 1);
});
test("failed passport validation stays visible; technical exhaustion consumes no user OCR attempt", async () => {
  const ctx = await setup(
    async () => ({
      status: "failed",
      fields: { ...front, ...back, personal_number: front.nin, passport_number: "A12345678" },
      validation: { status: "failed", failedFields: ["document_type"] },
    }),
    "passport-only",
  );
  await ctx.capture("single");
  await ctx.queue.drain();
  const passport = (await ctx.sessions.findById(ctx.session.id))?.documents["dz-passport"];
  assert.equal(passport?.status, "incomplete");
  assert.ok(passport?.unreadableFields.includes("documentValidation"));
  const failed = await setup(async () => {
    throw new Error("offline");
  });
  await failed.capture("front");
  await failed.queue.drain();
  const saved = await failed.sessions.findById(failed.session.id);
  assert.equal(saved?.status, "technical_failed");
  assert.equal(saved?.documents["dz-id"]?.ocrAttempts, 0);
  assert.equal(saved?.documents["dz-id"]?.technicalFailures, 3);
});
test("backend comparison mirror stays identical to OCR rules with runtime import extension adaptation", async () => {
  for (const filename of ["result.ts", "text.ts", "cross.ts", "consistency.ts"]) {
    const source = await readFile(new URL(`../../../../OCR/src/core/validation/${filename}`, import.meta.url), "utf8");
    const mirror = await readFile(new URL(`../../src/domain/ocr-consistency/${filename}`, import.meta.url), "utf8");
    assert.equal(mirror, source.replace(/\.ts(["'])/g, ".js$1"), filename);
  }
});

test("an independent face validation failure is not hidden by a separate conflict", async () => {
  const ctx = await setup(async (type) =>
    type.endsWith("front")
      ? {
          fields: { ...front, nin: "WRONG" },
          status: "failed",
          validation: {
            status: "failed",
            failedFields: ["nin"],
            checks: [{ id: "local.number", outcome: "failed", field: "nin", detail: "Invalid" }],
          },
        }
      : { fields: { ...back, date_of_birth: "1991-02-12" } },
  );
  await ctx.capture("front");
  await ctx.capture("back");
  await ctx.queue.drain();
  const document = (await ctx.sessions.findById(ctx.session.id))?.documents["dz-id"];
  assert.equal(document?.consistency?.blocking, true);
  assert.ok(document?.unreadableFields.includes("nin"));
  assert.equal(document?.unreadableFields.includes("documentValidation"), false);
  assert.equal(document?.unreadableFields.includes("dateOfBirth"), false);
});

test("two simultaneous sessions never join each other's observations", async () => {
  const first = await setup(async (type) => ({ fields: type.endsWith("front") ? front : back }));
  const second = await setup(async (type) => ({
    fields: type.endsWith("front") ? { ...front, nin: "200012345678901234" } : back,
  }));
  await Promise.all([first.capture("front"), second.capture("front")]);
  await Promise.all([first.capture("back"), second.capture("back")]);
  await Promise.all([first.queue.drain(), second.queue.drain()]);
  assert.equal((await first.sessions.findById(first.session.id))?.documents["dz-id"]?.fields?.nin, front.nin);
  assert.equal(
    (await second.sessions.findById(second.session.id))?.documents["dz-id"]?.fields?.nin,
    "200012345678901234",
  );
});
