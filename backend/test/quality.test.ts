import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import sharp from "sharp";
import { DocumentQualityEngine } from "../src/quality/engine.js";
import { defaultQualityProfile, QualityProfileStore } from "../src/quality/profile.js";
import { FileTemplateStore } from "../src/quality/template-store.js";
import { WorkerThreadQualityEngine } from "../src/quality/worker-engine.js";

test("ORB template generation and alignment use stable regions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "onboarding-template-"));
  const profiles = new QualityProfileStore({ ...defaultQualityProfile, mode: "enforce" });
  const store = new FileTemplateStore(directory);
  const engine = new DocumentQualityEngine(store, profiles);
  const image = await sharp(
    Buffer.from(`<svg width="1400" height="900" xmlns="http://www.w3.org/2000/svg">
    <rect width="1400" height="900" fill="#e7e0d4"/><rect x="40" y="40" width="1320" height="820" rx="36" fill="#fff" stroke="#111" stroke-width="10"/>
    <text x="90" y="130" font-family="Arial" font-size="54" font-weight="bold">REPUBLIQUE ALGERIENNE</text>
    <circle cx="220" cy="400" r="110" fill="#bbb" stroke="#111" stroke-width="8"/>
    <path d="M90 650 L1310 650 M90 700 L980 700 M90 750 L1180 750" stroke="#222" stroke-width="16"/>
    <text x="420" y="300" font-family="Arial" font-size="56">BENALI AMINE</text><text x="420" y="390" font-family="Arial" font-size="42">100012345678901234</text>
    <g fill="#111">${Array.from({ length: 24 }, (_, index) => `<rect x="${920 + (index % 8) * 42}" y="${470 + Math.floor(index / 8) * 42}" width="18" height="18"/>`).join("")}</g>
  </svg>`),
  )
    .jpeg()
    .toBuffer();

  const template = await engine.createTemplate({
    id: "test-id-front",
    name: "Test identity card front",
    documentKind: "dz-id",
    image,
    mimeType: "image/jpeg",
    zones: [],
    ignoredRegions: [{ x: 0.08, y: 0.27, width: 0.18, height: 0.28 }],
  });
  assert.ok(template.orb.rows > 18);
  assert.equal((await store.getImage(template.id))?.data.equals(image), true);
  assert.equal((await store.list())[0]?.name, "Test identity card front");
  const report = await engine.analyze(image, "test-id-front");
  assert.equal(report.templateMatched, true, JSON.stringify(report));
  assert.ok(report.checks.every((check) => check.durationMs >= 0));
  assert.ok(report.durationMs > 0);
  const preview = await engine.assess(image, {
    templateId: "test-id-front",
    documentKind: "dz-id",
    prepare: false,
    previewAlignment: true,
  });
  assert.equal(preview.report.templateMatched, true);
  assert.equal(preview.report.diagnostics?.geometry?.method, "orb");
  assert.ok(preview.alignmentImage?.image.length);
  assert.ok((preview.alignmentImage?.width ?? 0) > 0);
  const workerReport = await new WorkerThreadQualityEngine(directory, profiles).analyze(image, "test-id-front");
  assert.equal(workerReport.templateMatched, true);
});

test("a ready OCR-lab template is loaded without regenerating its ORB descriptors", async () => {
  const store = new FileTemplateStore("quality-templates");
  const template = await store.get("dz-id-front-24b430d57956");
  assert.ok(template);
  assert.equal(template.documentKind, "dz-id");
  assert.equal(template.width, 720);
  assert.equal(template.height, 453);
  assert.equal(template.orb.rows, 2650);
  assert.equal(template.orb.descriptors.length, template.orb.rows * template.orb.cols);
  assert.deepEqual(template.parameters, {
    ratioThreshold: 0.75,
    minimumGoodMatches: 20,
    minimumInlierRatio: 0.35,
    ransacThreshold: 4,
  });
  assert.equal((await store.findVariants("dz-id-front"))[0]?.id, template.id);
  const writable = await mkdtemp(join(tmpdir(), "onboarding-overrides-"));
  assert.equal(
    (await new FileTemplateStore(writable, "quality-templates").findVariants("dz-id-front"))[0]?.id,
    template.id,
  );
});

test("quality profile changes are validated and immediately visible", () => {
  const profiles = new QualityProfileStore(defaultQualityProfile);
  const updated = profiles.replace({
    ...defaultQualityProfile,
    mode: "enforce",
    image: { ...defaultQualityProfile.image, minSharpness: 12 },
  });
  assert.equal(updated.mode, "enforce");
  assert.equal(profiles.current().image.minSharpness, 12);
  assert.throws(() =>
    profiles.replace({
      ...defaultQualityProfile,
      image: { ...defaultQualityProfile.image, exposureMin: 220, exposureMax: 100 },
    }),
  );
});
