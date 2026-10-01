import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import * as copy from "../src/lib/consistency-copy.ts";
import * as guidance from "../src/lib/consistency-guidance.ts";
import * as labels from "../src/lib/i18n.ts";
import * as journey from "../src/lib/journey-copy.ts";

const require = createRequire(import.meta.url);
const dependencies = { "@/lib/consistency-copy": copy, "@/lib/consistency-guidance": guidance,
  "@/lib/i18n": labels, "@/lib/journey-copy": journey };
const compiled = ts.transpileModule(readFileSync(new URL("../src/components/consistency-result.tsx", import.meta.url), "utf8"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
}).outputText;
const componentModule = { exports: {} };
new Function("require", "module", "exports", compiled)((name) => dependencies[name] ?? require(name), componentModule, componentModule.exports);
const { ConsistencyResult } = componentModule.exports;
const checks = [
  { id: "conflict", field: "dateOfBirth", status: "failed", readings: [
    { document: "id", side: "front", value: "2000-01-01" }, { document: "passport", side: "single", value: "2001-01-01" },
  ], suggestedRetry: { document: "passport", side: "single" } },
  { id: "missing", field: "firstNameArabic", status: "not_checked", readings: [
    { document: "id", side: "front", value: "أحمد" }, { document: "passport", value: null },
  ] },
  { id: "cross.coverage", field: "coverage", status: "warning", readings: [] },
];
const documents = {
  "dz-id": { requiredSides: ["front", "back"], ocrAttempts: 1, sideOcrAttempts: { front: 3, back: 0 } },
  "dz-passport": { requiredSides: ["single"], ocrAttempts: 1 },
};
const props = { report: { checks, blocking: true, warnings: 1, notChecked: 1 }, documents, locale: "en", onRetake: () => {} };
const render = (options = {}) => renderToStaticMarkup(React.createElement(ConsistencyResult, { ...props, ...options }));

test("conflict UI shows relevant readings without diagnostic coverage or unavailable rows", () => {
  const html = render();
  for (const text of ["Date of birth", "2000-01-01", "2001-01-01", "Identity card", "Identity page"])
    assert.ok(html.includes(text), text);
  for (const text of ["Not checked", "Not read", "Check coverage", "أحمد"])
    assert.equal(html.includes(text), false, text);
  assert.equal((html.match(/<button/g) ?? []).length, 1);
  assert.equal((html.match(/disabled=""/g) ?? []).length, 1);
  assert.ok(html.includes('role="alert"'));
});

test("only the user-selected implicated face is retried", () => {
  const calls = [];
  const tree = ConsistencyResult({ ...props, onRetake: (...args) => calls.push(args) });
  const forms = [];
  const visit = (node) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) return node.forEach(visit);
    if (node.type === "form") forms.push(node);
    visit(node.props?.children);
  };
  visit(tree);
  forms[0].props.onSubmit({ preventDefault() {}, currentTarget: { elements: { namedItem: () => ({ value: "dz-passport/single" }) } } });
  assert.deepEqual(calls, [["dz-passport", "single"]]);
});

test("Arabic, French and busy states keep source text and disable duplicate actions", () => {
  for (const locale of ["ar", "fr", "en"]) {
    const html = render({ locale, busy: true });
    assert.equal((html.match(/disabled=""/g) ?? []).length, 3);
    assert.ok(html.includes("<bdi>2000-01-01</bdi>"));
  }
});

if (process.env.CONSISTENCY_PREVIEW_PATH) {
  const styles = readFileSync(new URL("../src/app/journey.css", import.meta.url), "utf8");
  const panels = ["en", "fr", "ar"].map((locale) => `<main class="journey" dir="${locale === "ar" ? "rtl" : "ltr"}" style="padding:24px;max-width:960px;margin:auto">${render({ locale })}</main>`).join("");
  writeFileSync(process.env.CONSISTENCY_PREVIEW_PATH, `<!doctype html><html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>body{margin:0;font-family:Arial,sans-serif}*{box-sizing:border-box}button{font:inherit} ${styles}</style>${panels}</html>`);
}


test("document and face attempt limits independently disable implicated retries", () => {
  const html = render({ documents: {
    "dz-id": { ...documents["dz-id"], ocrAttempts: 3, sideOcrAttempts: { front: 1 } },
    "dz-passport": { ...documents["dz-passport"], ocrAttempts: 1, sideOcrAttempts: { single: 3 } },
  } });
  assert.equal((html.match(/<button/g) ?? []).length, 0);
  assert.ok(html.includes("reading limit"));
});
