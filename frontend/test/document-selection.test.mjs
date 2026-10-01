import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {createRequire} from "node:module";
import test from "node:test";
import ts from "typescript";
import * as projection from "../src/lib/flow-projection.ts";
import * as labels from "../src/lib/i18n.ts";
import * as journey from "../src/lib/journey-copy.ts";
import * as consistency from "../src/lib/consistency-copy.ts";

const require=createRequire(import.meta.url);
const compiled=ts.transpileModule(readFileSync(new URL("../src/app/s/[token]/desktop-journey.tsx",import.meta.url),"utf8"),{
 compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true},
}).outputText;

async function requestedActions(status) {
 const effects=[];
 const actions=[];
 const session={status,locale:"fr",captureDeviceConnected:false,
  documentSelection:{mode:"all",allowedDocuments:["dz-id","dz-driving-licence"],minimumDocuments:2},
  documents:Object.fromEntries(["dz-id","dz-driving-licence"].map(kind=>[kind,{
   kind,requiredSides:["front","back"],captures:{},confirmed:false,status:"pending",ocrAttempts:0,
  }])),
 };
 const dependencies={
  react:{...require("react"),useState:initial=>[initial,()=>{}],useRef:initial=>({current:initial}),useMemo:fn=>fn(),useCallback:fn=>fn,useEffect:fn=>effects.push(fn)},
  qrcode:{toDataURL:async()=>"synthetic-image"},"next/image":()=>null,
  "@/components/consistency-result":{ConsistencyResult:()=>null},
  "@/components/document-result":{DocumentResult:()=>null},"@/components/logo":{Logo:()=>null},
  "@/lib/consistency-copy":consistency,"@/lib/flow-projection":projection,
  "@/lib/i18n":labels,"@/lib/journey-copy":journey,
  "@/lib/public-session":{SessionRequestError:class extends Error {},usePublicSession:()=>({session,post:async path=>{
   actions.push(path);return {transferUrl:"https://public.example.test/transfer/synthetic",expiresAt:new Date(Date.now()+60_000).toISOString()};
  }})},
 };
 const componentModule={exports:{}};
 new Function("require","module","exports",compiled)(name=>dependencies[name]??require(name),componentModule,componentModule.exports);
 componentModule.exports.DesktopJourney({token:"synthetic"});
 for(const effect of effects) effect();
 await Promise.resolve();
 return actions;
}

test("planned documents never issue a phone grant before the selection screen is validated",async()=>{
 assert.deepEqual(await requestedActions("created"),[]);
});

test("validated document selection enables the phone grant",async()=>{
 assert.deepEqual(await requestedActions("capturing"),["/transfer"]);
});
