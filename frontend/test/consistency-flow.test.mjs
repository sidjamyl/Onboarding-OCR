import assert from "node:assert/strict";
import test from "node:test";
import { projectOnboarding } from "../src/lib/flow-projection.ts";
import { comparisonRetryTargets, comparisonValue } from "../src/lib/consistency-guidance.ts";

const capture = { id: "capture", quality: { passed: true, checks: [] } };
const report = { blocking: true, warnings: 0, notChecked: 0, checks: [] };
function document(kind = "dz-id", overrides = {}) {
  return { kind, requiredSides: kind === "dz-passport" ? ["single"] : ["front", "back"], captures: {},
    status: "processing", confirmed: false, unreadableFields: [], ...overrides };
}
function session(documents, overrides = {}) {
  return { documents, documentSelection: { mode: "all", allowedDocuments: Object.keys(documents) }, ...overrides };
}

test("received front is processed while the phone can capture the back", () => {
  const flow = projectOnboarding(session({ "dz-id": document("dz-id", { captures: { front: capture } }) }));
  assert.equal(flow.phase, "capture");
  assert.equal(flow.nextSide, "back");
});

test("both captures wait for OCR and a meaningful face mismatch opens consistency review", () => {
  const state = document("dz-id", { captures: { front: capture, back: capture }, consistency: report });
  assert.equal(projectOnboarding(session({ "dz-id": state })).phase, "processing");
  state.status = "incomplete";
  assert.equal(projectOnboarding(session({ "dz-id": state })).phase, "consistency");
});

test("all confirmed documents with a blocking conflict never project completion", () => {
  const states = { "dz-id": document("dz-id", { confirmed: true }), "dz-passport": document("dz-passport", { confirmed: true }) };
  const flow = projectOnboarding(session(states, { consistency: report }));
  assert.equal(flow.phase, "consistency");
  assert.equal(flow.completedCount, 2);
  assert.equal(flow.current, undefined);
  assert.equal(projectOnboarding(session(states, { consistency: { ...report, blocking: false, notChecked: 2 } })).phase, "complete");
});

test("a selective retry preserves the other document's completion and points to that photo", () => {
  const flow = projectOnboarding(session({
    "dz-id": document("dz-id", { confirmed: true }),
    "dz-driving-licence": document("dz-driving-licence", { captures: { back: capture }, retakingSide: "front", status: "capturing" }),
  }));
  assert.equal(flow.current.kind, "dz-driving-licence");
  assert.equal(flow.nextSide, "front");
  assert.equal(flow.documents[0].state, "completed");
});

test("mismatch retry options use reading sides and shared field aliases, never reset both", () => {
  const states = {
    "dz-id": document("dz-id", { sideFields: { front: { surname_ar: "بن علي" }, back: { surname_latin: "BENALI" } } }),
    "dz-passport": document("dz-passport", { sideFields: { single: { surname_latin: "BEN ALI" } } }),
  };
  assert.deepEqual(comparisonRetryTargets({ field: "lastNameLatin", readings: [
    { document: "id", value: "BENALI" }, { document: "passport", value: "BEN ALI" },
  ] }, states), [{ kind: "dz-id", side: "back" }, { kind: "dz-passport", side: "single" }]);
  assert.deepEqual(comparisonRetryTargets({ field: "dateOfBirth", readings: [
    { document: "id", side: "front", value: "2000-01-01" }, { document: "id", side: "back", value: "2001-01-01" },
  ] }, states), [{ kind: "dz-id", side: "front" }, { kind: "dz-id", side: "back" }]);
});

test("missing readings remain absent and category arrays remain readable", () => {
  assert.equal(comparisonValue(null), undefined);
  assert.equal(comparisonValue(""), undefined);
  assert.equal(comparisonValue(["B", "C"]), "B, C");
  assert.equal(comparisonValue([{ category: "B" }, { category: "C", date_of_issue: "2020-01-01" }]), "B, C");
  assert.equal(comparisonValue({ unexpected: "value" }), undefined);
});
