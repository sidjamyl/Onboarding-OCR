import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "../src/config.js";

const productionEnvironment = {
  NODE_ENV: "production",
  REPOSITORY_DRIVER: "postgres",
  STORAGE_DRIVER: "minio",
  QUEUE_DRIVER: "pg-boss",
  CLIENT_API_KEYS: "client-api-key-123456789",
  MINIO_SECRET_KEY: "minio-secret-123456789",
  OCR_BASIC_PASSWORD: "ocr-password-123456789",
  QUALITY_LAB_ENABLED: "false",
};

test("production configuration rejects development adapters and placeholder secrets", () => {
  assert.throws(
    () => loadConfig({ ...productionEnvironment, SERVER_QUALITY_CHECKS_ENABLED: "false" }),
    /cannot be disabled in production/,
  );
  assert.throws(
    () => loadConfig({ ...productionEnvironment, ONBOARDING_DEMO_TRACE: "true" }),
    /traces must be disabled in production/,
  );
  assert.throws(() => loadConfig({ NODE_ENV: "production" }), /Production requires PostgreSQL/);
  assert.throws(
    () => loadConfig({ ...productionEnvironment, CLIENT_API_KEYS: "replace-with-your-client-key" }),
    /non-placeholder secret/,
  );
});

test("configuration rejects unknown policies and required fields before startup", () => {
  assert.throws(
    () =>
      loadConfig({
        CLIENT_APPLICATIONS_JSON: JSON.stringify([
          { id: "partner", apiKey: "partner-key", allowedPolicies: ["unknown-policy"] },
        ]),
      }),
    /Unknown policies/,
  );
  assert.throws(
    () => loadConfig({ REQUIRED_FIELDS_JSON: JSON.stringify({ "dz-id": ["inventedField"] }) }),
    /Unknown required fields/,
  );
});

test("production configuration accepts explicit durable adapters and secrets", () => {
  const config = loadConfig({ ...productionEnvironment, OCR_BASIC_PASSWORD: "short-real-password" });
  assert.equal(config.REPOSITORY_DRIVER, "postgres");
  assert.equal(config.clients[0]?.id, "default");
});

test("production accepts a short existing OCR credential but rejects a placeholder", () => {
  assert.doesNotThrow(() => loadConfig({ ...productionEnvironment, OCR_BASIC_PASSWORD: "ocr-pass" }));
  assert.throws(
    () => loadConfig({ ...productionEnvironment, OCR_BASIC_PASSWORD: "change-me" }),
    /OCR password must be a non-placeholder credential/,
  );
});

test("public base URLs are normalized before session links are created", () => {
  const config = loadConfig({ NODE_ENV: "test", PUBLIC_BASE_URL: "https://example.test/" });
  assert.equal(config.PUBLIC_BASE_URL, "https://example.test");
});

test("OCR Gateway URL can select local or remote and strips trailing slashes", () => {
  assert.equal(
    loadConfig({ NODE_ENV: "test", OCR_BASE_URL: "http://127.0.0.1:8080/" }).OCR_BASE_URL,
    "http://127.0.0.1:8080",
  );
  assert.equal(
    loadConfig({ NODE_ENV: "test", OCR_BASE_URL: "http://gateway.example:8080///" }).OCR_BASE_URL,
    "http://gateway.example:8080",
  );
  assert.throws(() => loadConfig({ NODE_ENV: "test", OCR_BASE_URL: "not-a-url" }));
});

test("quality profile JSON is validated at startup", () => {
  const base = loadConfig({ NODE_ENV: "test" }).qualityProfile;
  const configured = loadConfig({
    NODE_ENV: "test",
    QUALITY_MODE: "enforce",
    QUALITY_PROFILE_JSON: JSON.stringify({
      ...base,
      image: { ...base.image, minSharpness: 12 },
    }),
  });
  assert.equal(configured.qualityProfile.mode, "enforce");
  assert.equal(configured.qualityProfile.image.minSharpness, 12);
  assert.throws(() =>
    loadConfig({
      NODE_ENV: "test",
      QUALITY_PROFILE_JSON: JSON.stringify({
        ...base,
        image: { ...base.image, exposureMin: 220, exposureMax: 100 },
      }),
    }),
  );
});
