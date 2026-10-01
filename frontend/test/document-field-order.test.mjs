import assert from "node:assert/strict";
import test from "node:test";
import { visibleDocumentFields } from "../src/lib/document-field-order.ts";

test("ID back shows decoded values together and hides raw MRZ lines", () => {
  const fields = { surname_latin: "SID", mrz_line_1: "I<DZA...", date_of_birth: "2006-03-23",
    document_number: "413887785", given_name_latin: "JAMYL RYAD", nationality: "DZA" };
  assert.deepEqual(visibleDocumentFields("dz-id", fields).map(([key]) => key), [
    "document_number", "surname_latin", "given_name_latin", "date_of_birth", "nationality",
  ]);
});

test("all document families keep names adjacent regardless of API object order", () => {
  for (const kind of ["dz-id", "dz-driving-licence", "dz-passport"]) {
    const fields = { given_name_latin: "AMINE", date_of_expiry: "2034-01-01",
      surname_latin: "BENALI", date_of_birth: "2000-01-01" };
    assert.deepEqual(visibleDocumentFields(kind, fields).map(([key]) => key), [
      "surname_latin", "given_name_latin", "date_of_birth", "date_of_expiry",
    ]);
  }
});

test("passport MRZ remains visible in its existing result", () => {
  assert.deepEqual(visibleDocumentFields("dz-passport", { mrz_line_1: "P<DZA..." }).map(([key]) => key), ["mrz_line_1"]);
});
