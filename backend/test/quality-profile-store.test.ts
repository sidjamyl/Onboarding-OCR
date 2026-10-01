import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { defaultQualityProfile, QualityProfileStore } from "../src/quality/profile.js";

test("applied quality profile survives reopening the store", async () => {
  const path = join(await mkdtemp(join(tmpdir(), "onboarding-profile-")), "quality-profile.json");
  const store = await QualityProfileStore.open(defaultQualityProfile, path);
  const updated = {
    ...defaultQualityProfile,
    image: {
      ...defaultQualityProfile.image,
      maxGlareBlob: 0.003,
      minColorGlareValue: 210,
      minColorGlareSaturation: 0.2,
      maxColorGlareRatio: 0.02,
    },
    severity: { ...defaultQualityProfile.severity, color_glare: "block" as const },
  };

  await store.save(updated);

  assert.equal((await QualityProfileStore.open(defaultQualityProfile, path)).current().image.maxGlareBlob, 0.003);
  assert.equal(JSON.parse(await readFile(path, "utf8")).image.maxGlareBlob, 0.003);
  const restored = (await QualityProfileStore.open(defaultQualityProfile, path)).current();
  assert.equal(restored.image.minColorGlareValue, 210);
  assert.equal(restored.image.minColorGlareSaturation, 0.2);
  assert.equal(restored.image.maxColorGlareRatio, 0.02);
  assert.equal(restored.severity.color_glare, "block");

  await assert.rejects(store.save({ ...updated, image: { ...updated.image, maxGlareBlob: 2 } }));
  assert.equal((await QualityProfileStore.open(defaultQualityProfile, path)).current().image.maxGlareBlob, 0.003);
});
