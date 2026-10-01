import assert from "node:assert/strict";
import test from "node:test";
import { defaultRequiredFields, missingRequiredFields } from "../src/domain/requirements.js";
import { loadConfig } from "../src/config.js";

test("every document requires only four identity facts and accepts names in either observed script", () => {
  for (const kind of ["dz-id", "dz-driving-licence", "dz-passport"] as const) {
    const latin = {lastNameLatin:"BEN ALI",firstNameLatin:"AMINE",nin:"100012345678901234",dateOfBirth:"1990-02-12"};
    const arabic = {lastNameArabic:"بن علي",firstNameArabic:"أمين",nin:latin.nin,dateOfBirth:latin.dateOfBirth};
    assert.deepEqual(missingRequiredFields(kind,latin,defaultRequiredFields),[]);
    assert.deepEqual(missingRequiredFields(kind,arabic,defaultRequiredFields),[]);
    assert.deepEqual(missingRequiredFields(kind,{...latin,nin:null},defaultRequiredFields),["nin"]);
    assert.deepEqual(missingRequiredFields(kind,{...latin,lastNameLatin:null},defaultRequiredFields),["lastNameLatin"]);
  }
});
test("legacy optional prerequisites are removed and cannot weaken the four identity requirements", () => {
  const config = loadConfig({REQUIRED_FIELDS_JSON:JSON.stringify({"dz-id":["expiryDate","documentNumber","sex","categories"]})});
  assert.deepEqual(config.requiredFields["dz-id"],["lastNameLatin","firstNameLatin","nin","dateOfBirth"]);
});
