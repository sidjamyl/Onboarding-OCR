import assert from "node:assert/strict";
import test from "node:test";
import { sideForMissingFields } from "../src/lib/retake-guidance.ts";

const id = {
  kind: "dz-id",
  requiredSides: ["front", "back"],
  sideFields: {
    front: { nin: null, surname_ar: "بن علي" },
    back: { surname_latin: "BENALI", given_name_latin: "AMINE" },
  },
};

test("missing NIN directs the user to the front", () => {
  assert.equal(sideForMissingFields({ ...id, unreadableFields: ["nin"] }), "front");
});

test("missing Latin name directs the user to the ID back when neither side read it", () => {
  assert.equal(sideForMissingFields({ ...id, sideFields: {}, unreadableFields: ["lastNameLatin"] }), "back");
});

test("single-page passports never recommend an unavailable side", () => {
  assert.equal(sideForMissingFields({ kind: "dz-passport", requiredSides: ["single"], unreadableFields: ["nin"] }), "single");
});
