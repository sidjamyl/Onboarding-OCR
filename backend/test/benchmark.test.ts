import assert from "node:assert/strict";
import test from "node:test";
import { summarizeBenchmark } from "../src/quality/benchmark.js";

test("benchmark reports false accepts and OCR-copy comparison without field values", () => {
  const summary = summarizeBenchmark([
    { id: "bad", expected: "reject", passed: true, failedChecks: [], qualityMs: 10, ocrCopy: true },
    { id: "good", expected: "accept", passed: false, failedChecks: ["glare"], qualityMs: 20, ocrCopy: false },
    {
      id: "measured",
      expected: "accept",
      passed: true,
      failedChecks: [],
      qualityMs: 30,
      ocrCopy: true,
      originalOcr: { correct: 2, total: 3, durationMs: 100, error: false },
      preparedOcr: { correct: 3, total: 3, durationMs: 80, error: false },
    },
  ]);
  assert.equal(summary.badAccepted, 1);
  assert.equal(summary.goodRejected, 1);
  assert.equal(summary.meanQualityMs, 20);
  assert.deepEqual(summary.preparedOcr, { documents: 1, errors: 0, correctFields: 3, labeledFields: 3, meanMs: 80 });
});
