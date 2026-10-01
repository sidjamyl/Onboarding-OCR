import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import sharp, { type Sharp } from "sharp";
import { evaluateFrame, measureImage } from "../src/quality/core/quality-core.js";
import { DocumentQualityEngine } from "../src/quality/engine.js";
import { defaultQualityProfile, parseQualityProfile, QualityProfileStore } from "../src/quality/profile.js";

const scene = (extra = "") => `<svg width="2400" height="1600" xmlns="http://www.w3.org/2000/svg">
  <defs><pattern id="wood" width="40" height="40" patternUnits="userSpaceOnUse"><rect width="40" height="40" fill="#6b5846"/>
  <path d="M0 10 H40 M0 30 H40" stroke="#5d4b3b" stroke-width="3"/></pattern></defs>
  <rect width="2400" height="1600" fill="url(#wood)"/>
  <g transform="translate(1200 800) rotate(-6) translate(-800 -505)">
    <rect width="1600" height="1009" rx="50" fill="#eef1ea"/>
    <rect x="60" y="60" width="1480" height="90" fill="#9fc3a8"/>
    <text x="90" y="125" font-family="Arial" font-size="56" font-weight="bold">REPUBLIQUE ALGERIENNE</text>
    <rect x="80" y="220" width="360" height="460" fill="#b8b8b8"/>
    ${Array.from({ length: 9 }, (_, index) => `<text x="500" y="${260 + index * 80}" font-family="Arial" font-size="44">NOM ${index} BENALI AMINE 1990-01-0${index}</text>`).join("")}
    ${extra}
  </g></svg>`;

const engine = new DocumentQualityEngine(
  undefined,
  new QualityProfileStore({ ...defaultQualityProfile, mode: "enforce" }),
);
const photo = (transform: (image: Sharp) => Sharp = (image) => image, extra = "") =>
  transform(sharp(Buffer.from(scene(extra))))
    .jpeg({ quality: 92 })
    .toBuffer();
const failures = async (image: Buffer) =>
  (await engine.analyze(image)).checks.filter((check) => check.status === "fail").map((check) => check.key);

test("a card is localized before quality metrics are measured", async () => {
  const report = await engine.analyze(await photo());
  assert.equal(report.diagnostics?.geometry?.method, "contour");
  assert.equal(report.checks.find((check) => check.key === "document_found")?.passed, true);
  assert.ok(report.checks.some((check) => check.key === "sharpness"));
});

test("each capture defect is reported by its own check", async () => {
  assert.ok(
    (await failures(await photo((image) => image.blur(4)))).some(
      (key) => key === "sharpness" || key === "document_found",
    ),
  );
  assert.ok(
    (
      await failures(await photo((image) => image, `<ellipse cx="900" cy="450" rx="180" ry="90" fill="#fff"/>`))
    ).includes("glare"),
  );
  const shadowFailures = await failures(
    await photo((image) => image, `<rect x="800" width="800" height="1009" fill="#000" opacity="0.9"/>`),
  );
  // A hard shadow can also break contour localization; either way the capture must be rejected.
  assert.ok(shadowFailures.length > 0, JSON.stringify(shadowFailures));
  assert.ok((await failures(await photo((image) => image.linear(0.3, 0)))).includes("exposure"));
  const empty = await sharp({ create: { width: 1600, height: 1000, channels: 3, background: "#6b5846" } })
    .jpeg()
    .toBuffer();
  const report = await engine.analyze(empty);
  assert.equal(report.checks.find((check) => check.key === "document_found")?.passed, false);
  assert.equal(report.passed, false);
});

test("uneven paper illumination is measured independently of contour detection", () => {
  const width = 600;
  const height = 400;
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1)
    for (let x = 0; x < width; x += 1) {
      const value = x < width / 2 ? 40 : 220;
      rgba.set([value, value, value, 255], (y * width + x) * 4);
    }
  assert.ok(measureImage(rgba, width, height).illumination < defaultQualityProfile.image.minIllumination);
});

test("bright chromatic reflections are measured without treating ordinary printed color as glare", () => {
  const width = 400;
  const height = 250;
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1)
    for (let x = 0; x < width; x += 1) {
      const color =
        x < 40 ? [120, 170, 135] : x >= 160 && x < 260 && y >= 60 && y < 180 ? [242, 195, 95] : [225, 225, 220];
      rgba.set([...color, 255], (y * width + x) * 4);
    }
  const image = measureImage(rgba, width, height);
  assert.ok(image.glareRatio < 0.001);
  assert.ok(image.colorGlareRatio > defaultQualityProfile.image.maxColorGlareRatio);
  const check = (profile: typeof defaultQualityProfile) =>
    evaluateFrame({ image }, profile, "capture").checks.find((item) => item.key === "color_glare");
  assert.equal(check(defaultQualityProfile)?.status, "warn");
  const blocking = structuredClone(defaultQualityProfile);
  blocking.severity.color_glare = "block";
  assert.equal(check(blocking)?.status, "fail");
  blocking.image.maxColorGlareRatio = 0.2;
  assert.equal(check(blocking)?.status, "pass");
  assert.equal(
    measureImage(rgba, width, height, { minColorGlareValue: 250, minColorGlareSaturation: 0.25 }).colorGlareRatio,
    0,
  );
  assert.equal(
    measureImage(rgba, width, height, { minColorGlareValue: 220, minColorGlareSaturation: 0.8 }).colorGlareRatio,
    0,
  );

  const printOnly = new Uint8Array(rgba);
  for (let y = 60; y < 180; y += 1)
    for (let x = 160; x < 260; x += 1) printOnly.set([120, 170, 135, 255], (y * width + x) * 4);
  assert.equal(measureImage(printOnly, width, height).colorGlareRatio, 0);
});

test("contour localization uses preview scale while resolution comes from native pixels", async () => {
  const original = await photo();
  const larger = await sharp(original).resize({ width: 4800 }).jpeg().toBuffer();
  const [native, enlarged] = await Promise.all([engine.analyze(original), engine.analyze(larger)]);
  assert.equal(native.checks.find((check) => check.key === "document_found")?.passed, true);
  assert.equal(enlarged.checks.find((check) => check.key === "document_found")?.passed, true);
  const nativeDpi = native.diagnostics?.metrics?.["geometry.dpi"] ?? 0;
  const enlargedDpi = enlarged.diagnostics?.metrics?.["geometry.dpi"] ?? 0;
  assert.ok(nativeDpi > 0);
  assert.ok(Math.abs(enlargedDpi / nativeDpi - 2) < 0.02);
});

test("a passing capture produces a document-only OCR copy", async () => {
  const original = await photo();
  const lenient = structuredClone(defaultQualityProfile);
  lenient.mode = "enforce";
  lenient.image.minSharpness = 0;
  lenient.image.exposureMax = 255;
  lenient.image.maxGlareRatio = 1;
  lenient.image.maxGlareBlob = 1;
  lenient.image.maxHighlightClip = 1;
  lenient.image.minIllumination = 0;
  const evaluator = new DocumentQualityEngine(undefined, new QualityProfileStore(lenient));
  const { report, ocrImage } = await evaluator.assess(original, { documentKind: "dz-id" });
  assert.equal(report.passed, true, JSON.stringify(report.checks.filter((check) => check.status === "fail")));
  assert.ok(ocrImage);
  assert.ok(ocrImage.width < 2400);
  assert.ok(ocrImage.steps.some((step) => step.step === "rectify"));
});

test("noise is estimated from flat areas only", () => {
  const width = 400;
  const height = 250;
  const rgba = new Uint8Array(width * height * 4);
  for (let pixel = 0; pixel < width * height; pixel += 1) {
    const noise = Math.sqrt(-2 * Math.log(Math.random() || 1e-9)) * Math.cos(2 * Math.PI * Math.random()) * 8;
    const ink = Math.floor(pixel / width) % 40 < 4 ? -120 : 0;
    const value = Math.max(0, Math.min(255, 180 + ink + noise));
    rgba.set([value, value, value, 255], pixel * 4);
  }
  const { noise } = measureImage(rgba, width, height);
  assert.ok(noise > 7 && noise < 9, String(noise));
});

test("version 1 profiles migrate to the version 2 defaults and keep their mode", () => {
  const migrated = parseQualityProfile({ version: 1, mode: "enforce", client: {}, server: {} });
  assert.equal(migrated.version, 2);
  assert.equal(migrated.mode, "enforce");
  assert.deepEqual(migrated.image, defaultQualityProfile.image);
});

test("saved version 2 profiles retain calibration when color glare controls are added", () => {
  const saved = structuredClone(defaultQualityProfile) as unknown as Record<string, unknown>;
  const image = saved.image as Record<string, unknown>;
  const severity = saved.severity as Record<string, unknown>;
  image.minSharpness = 73;
  delete image.minColorGlareValue;
  delete image.minColorGlareSaturation;
  delete image.maxColorGlareRatio;
  delete severity.color_glare;
  const parsed = parseQualityProfile(saved);
  assert.equal(parsed.image.minSharpness, 73);
  assert.equal(parsed.image.maxColorGlareRatio, defaultQualityProfile.image.maxColorGlareRatio);
  assert.equal(parsed.severity.color_glare, defaultQualityProfile.severity.color_glare);
});

test("the frontend mirror of the quality core is identical to the backend copy", async () => {
  const [backend, frontend] = await Promise.all([
    readFile(new URL("../../src/quality/core/quality-core.ts", import.meta.url), "utf8"),
    readFile(new URL("../../../frontend/src/lib/quality-core.ts", import.meta.url), "utf8"),
  ]);
  assert.equal(frontend, backend, "Run `npm run sync:quality-core` from the onboarding folder");
});
