import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {createRequire} from "node:module";
import test from "node:test";
import ts from "typescript";
import * as publicUrls from "../src/lib/public-url.ts";

const require = createRequire(import.meta.url);
const compiled = ts.transpileModule(readFileSync(new URL("../src/app/api/demo/session/route.ts", import.meta.url), "utf8"), {
 compilerOptions: {target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS},
}).outputText;
const routeModule = {exports:{}};
new Function("require","module","exports",compiled)(name => name === "@/lib/public-url" ? publicUrls : require(name),routeModule,routeModule.exports);

function configure(t) {
 const previousFetch = globalThis.fetch;
 const keys = ["DEMO_MODE_ENABLED","ONBOARDING_API_KEY","ONBOARDING_API_URL","PUBLIC_BASE_URL"];
 const previous = Object.fromEntries(keys.map(key => [key,process.env[key]]));
 Object.assign(process.env,{DEMO_MODE_ENABLED:"true",ONBOARDING_API_KEY:"synthetic-test-key",ONBOARDING_API_URL:"http://backend.example.test",PUBLIC_BASE_URL:"https://public.example.test"});
 t.after(() => {
  globalThis.fetch = previousFetch;
  for(const key of keys) previous[key] === undefined ? delete process.env[key] : process.env[key] = previous[key];
 });
}

test("default demo creates the two-document policy without skipping user selection", async t => {
 configure(t);
 const calls=[];
 globalThis.fetch = async (url,options) => {
  calls.push({url,body:JSON.parse(options.body)});
  return Response.json(calls.length === 1 ? {accessUrl:"http://backend.example.test/s/synthetic"} : {}, {status:calls.length === 1 ? 201 : 200});
 };
 const response=await routeModule.exports.POST(new Request("http://localhost:3000/api/demo/session",{method:"POST",body:JSON.stringify({locale:"fr"})}));
 assert.equal(response.status,201);
 assert.equal(calls.length,1,"The selection screen must remain available until the user validates it");
 assert.equal(calls[0].body.policyId,"id-and-licence");
 assert.equal((await response.json()).accessUrl,"https://public.example.test/s/synthetic");
});

test("demo rejects all-three before creating a real onboarding session", async t => {
 configure(t);
 globalThis.fetch = async () => {assert.fail("Rejected demo policies must not reach the backend");};
 const response=await routeModule.exports.POST(new Request("http://localhost:3000/api/demo/session",{method:"POST",body:JSON.stringify({policyId:"all-three"})}));
 assert.equal(response.status,400);
 assert.equal((await response.json()).error,"invalid_test_configuration");
});
