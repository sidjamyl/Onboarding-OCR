import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import * as copy from "../src/lib/capture-copy.ts";
import * as camera from "../src/lib/camera.ts";
import * as quality from "../src/lib/quality-core.ts";

const require = createRequire(import.meta.url);
const dependencies = { "@/lib/capture-copy": copy, "@/lib/camera": camera, "@/lib/quality-core": quality,
  "@/lib/local-quality": {}, "./calibration-hud": {CalibrationHud: () => null}, "./document-camera.css": {} };
const compiled = ts.transpileModule(readFileSync(new URL("../src/components/document-camera.tsx", import.meta.url), "utf8"), {
  compilerOptions: {target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true},
}).outputText;
const componentModule = {exports:{}};
new Function("require","module","exports",compiled)((name) => dependencies[name] ?? require(name),componentModule,componentModule.exports);
const {DocumentCamera} = componentModule.exports;
const props = {locale:"fr",profile:quality.defaultQualityProfile,documentKind:"dz-id",documentLabel:"Carte d’identité",sideLabel:"Recto",attemptsRemaining:2,autoCapture:false,onCapture:async()=>{},onSimulate:async()=>{}};

test("onboarding camera shows a non-interactive progress ring without a shutter, simulation or footer", () => {
  for (const locale of ["fr","en","ar"]) {
    const html = renderToStaticMarkup(React.createElement(DocumentCamera,{...props,locale}));
    assert.equal(html.includes('dc-shutter'),false);
    assert.equal(html.includes('dc-bottom'),false);
    assert.equal(html.includes('<footer'),false);
    assert.equal(html.includes(copy.cameraCopy[locale].manual),false);
    assert.match(html, /<div class="dc-capture-progress" role="progressbar"/);
    assert.ok(html.includes(`aria-label="${copy.cameraCopy[locale].auto}"`));
    assert.ok(html.includes('aria-valuenow="0"'));
    assert.ok(html.includes('class="dc-ring-progress"'));
    assert.equal(html.includes('<button class="dc-capture-progress"'),false);
    assert.ok(html.includes('dc-guide'));
  }
});
test("calibration retains its explicit operator controls", () => {
  const html = renderToStaticMarkup(React.createElement(DocumentCamera,{...props,variant:"calibration"}));
  assert.ok(html.includes('dc-shutter'));
  assert.ok(html.includes('<footer'));
});

test("the non-interactive ring displays the measured stability fraction", () => {
  for (const progress of [0, 0.5, 1]) {
    let stateIndex = 0;
    const stateReact = { ...React, useState: (initial) => {
      const index = stateIndex++;
      return [index === 0 ? "live" : index === 4 ? progress : initial, () => {}];
    } };
    const measuredModule = { exports: {} };
    new Function("require", "module", "exports", compiled)(
      (name) => name === "react" ? stateReact : dependencies[name] ?? require(name),
      measuredModule, measuredModule.exports,
    );
    const html = renderToStaticMarkup(React.createElement(measuredModule.exports.DocumentCamera, props));
    assert.ok(html.includes(`aria-valuenow="${progress * 100}"`));
    assert.ok(html.includes(`style="--progress:${progress}"`));
    assert.equal(html.includes('tabindex='), false);
    assert.equal(html.includes('<button'), false);
  }
});
