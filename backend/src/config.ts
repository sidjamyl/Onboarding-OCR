import { z } from "zod";
import { policies } from "./domain/policies.js";
import { defaultRequiredFields, type RequiredFieldsConfig } from "./domain/requirements.js";
import { loadQualityProfile } from "./quality/profile.js";

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().int().positive().default(8090),
  PUBLIC_BASE_URL: z
    .string()
    .url()
    .transform((value) => value.replace(/\/+$/, ""))
    .default("http://localhost:3000"),
  CLIENT_API_KEYS: z.string().default("local-client-key"),
  CLIENT_APPLICATIONS_JSON: z.string().optional(),
  BETTER_AUTH_SECRET: z.preprocess((value) => (value === "" ? undefined : value), z.string().min(32).optional()),
  STORAGE_DRIVER: z.enum(["memory", "minio"]).default("memory"),
  DATABASE_URL: z.string().default("postgres://onboarding:onboarding@localhost:5432/onboarding"),
  REPOSITORY_DRIVER: z.enum(["memory", "postgres"]).default("memory"),
  QUEUE_DRIVER: z.enum(["inline", "pg-boss"]).default("inline"),
  MINIO_ENDPOINT: z.string().default("localhost"),
  MINIO_PORT: z.coerce.number().default(9000),
  MINIO_USE_SSL: z
    .string()
    .transform((value) => value === "true")
    .default(false),
  MINIO_ACCESS_KEY: z.string().default("onboarding"),
  MINIO_SECRET_KEY: z.string().default("onboarding-secret"),
  MINIO_BUCKET: z.string().default("onboarding-captures"),
  OCR_BASE_URL: z
    .string()
    .url()
    .transform((value) => value.replace(/\/+$/, ""))
    .default("http://127.0.0.1:8080"),
  OCR_BASIC_USERNAME: z.string().default("onboarding"),
  OCR_BASIC_PASSWORD: z.string().default("change-me"),
  OCR_TIMEOUT_MS: z.coerce.number().positive().default(200_000),
  WEBHOOK_URL: z.preprocess((value) => (value === "" ? undefined : value), z.string().url().optional()),
  WEBHOOK_SECRET: z.string().default("local-webhook-secret"),
  REQUIRED_FIELDS_JSON: z.string().optional(),
  QUALITY_LAB_ENABLED: z
    .string()
    .transform((value) => value === "true")
    .default(true),
  QUALITY_MODE: z.enum(["off", "observe", "enforce"]).default("enforce"),
  SERVER_QUALITY_CHECKS_ENABLED: z
    .enum(["true", "false"])
    .default("true")
    .transform((value) => value === "true"),
  QUALITY_PROFILE_JSON: z.string().optional(),
  QUALITY_PROFILE_PATH: z.string().min(1).default(".local/quality-profile.json"),
  ONBOARDING_DEMO_TRACE: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  ONBOARDING_TRACE_DIRECTORY: z.string().min(1).default(".local/traces"),
});

export type AppConfig = ReturnType<typeof loadConfig>;

const clientSchema = z.array(
  z.object({
    id: z.string().min(1),
    apiKey: z.string().min(8),
    allowedPolicies: z.array(z.string()).min(1),
    webhookDestinations: z
      .array(z.object({ id: z.string().min(1), url: z.string().url(), secret: z.string().min(8) }))
      .default([]),
    returnDestinations: z.array(z.object({ id: z.string().min(1), url: z.string().url() })).default([]),
  }),
);
const requiredFieldsSchema = z.object({
  "dz-id": z.array(z.string().min(1)).optional(),
  "dz-driving-licence": z.array(z.string().min(1)).optional(),
  "dz-passport": z.array(z.string().min(1)).optional(),
});

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const values = schema.parse(env);
  let requiredFields: RequiredFieldsConfig = defaultRequiredFields;
  if (values.REQUIRED_FIELDS_JSON) {
    const overrides = requiredFieldsSchema.parse(JSON.parse(values.REQUIRED_FIELDS_JSON));
    requiredFields = {
      "dz-id": overrides["dz-id"] ?? defaultRequiredFields["dz-id"],
      "dz-driving-licence": overrides["dz-driving-licence"] ?? defaultRequiredFields["dz-driving-licence"],
      "dz-passport": overrides["dz-passport"] ?? defaultRequiredFields["dz-passport"],
    };
  }
  const clients = values.CLIENT_APPLICATIONS_JSON
    ? clientSchema.parse(JSON.parse(values.CLIENT_APPLICATIONS_JSON))
    : values.CLIENT_API_KEYS.split(",")
        .map((apiKey, index) => ({
          id: index === 0 ? "default" : `client-${index + 1}`,
          apiKey: apiKey.trim(),
          allowedPolicies: [
            "id-only",
            "passport-only",
            "licence-only",
            "id-and-passport",
            "id-and-licence",
            "licence-and-passport",
            "two-of-three",
            "all-three",
          ],
          webhookDestinations: values.WEBHOOK_URL
            ? [{ id: "default", url: values.WEBHOOK_URL, secret: values.WEBHOOK_SECRET }]
            : [],
          returnDestinations: [],
        }))
        .filter((client) => client.apiKey);
  const qualityProfile = loadQualityProfile(values.QUALITY_PROFILE_JSON, values.QUALITY_MODE);
  validateConfiguration(values, clients, requiredFields);
  requiredFields = Object.fromEntries(Object.entries(requiredFields).map(([kind, fields]) => [
    kind, [...new Set([...defaultRequiredFields[kind as keyof RequiredFieldsConfig], ...fields.filter((field) => ["lastNameArabic", "firstNameArabic"].includes(field))])],
  ])) as RequiredFieldsConfig;
  return {
    ...values,
    clients,
    apiKeys: new Set(clients.map((client) => client.apiKey)),
    clientByApiKey: new Map(clients.map((client) => [client.apiKey, client])),
    requiredFields,
    qualityProfile,
  };
}

function validateConfiguration(
  values: z.infer<typeof schema>,
  clients: z.infer<typeof clientSchema>,
  requiredFields: RequiredFieldsConfig,
): void {
  // Legacy configurations may still list optional document metadata.
  const knownFields = new Set([...Object.values(defaultRequiredFields).flat(), "lastNameArabic", "firstNameArabic", "documentNumber", "expiryDate", "sex", "categories", "category_entries", "date_of_expiry_printed"]);
  for (const [kind, fields] of Object.entries(requiredFields)) {
    const unknown = fields.filter((field) => !knownFields.has(field));
    if (unknown.length) throw new Error(`Unknown required fields for ${kind}: ${unknown.join(", ")}`);
  }
  for (const client of clients) {
    const unknownPolicies = client.allowedPolicies.filter((policy) => !policies[policy]);
    if (unknownPolicies.length)
      throw new Error(`Unknown policies for client ${client.id}: ${unknownPolicies.join(", ")}`);
  }
  if (new Set(clients.map((client) => client.id)).size !== clients.length)
    throw new Error("Client application identifiers must be unique");
  if (new Set(clients.map((client) => client.apiKey)).size !== clients.length)
    throw new Error("Client API keys must be unique");
  if (values.NODE_ENV !== "production") return;
  if (values.BETTER_AUTH_SECRET && new URL(values.PUBLIC_BASE_URL).protocol !== "https:")
    throw new Error("Admin authentication requires an HTTPS public URL in production");
  if (values.ONBOARDING_DEMO_TRACE) throw new Error("Local document traces must be disabled in production");
  if (!values.SERVER_QUALITY_CHECKS_ENABLED) throw new Error("Server quality checks cannot be disabled in production");
  if (values.REPOSITORY_DRIVER !== "postgres" || values.STORAGE_DRIVER !== "minio" || values.QUEUE_DRIVER !== "pg-boss")
    throw new Error("Production requires PostgreSQL, MinIO and pg-boss adapters");
  if (values.QUALITY_LAB_ENABLED) throw new Error("The quality laboratory must be disabled in production");
  if (!clients.length && !values.BETTER_AUTH_SECRET)
    throw new Error("At least one client application or administrator authentication is required in production");
  for (const client of clients) {
    assertSecret(`API key for client ${client.id}`, client.apiKey);
    for (const destination of client.webhookDestinations)
      assertSecret(`Webhook secret ${client.id}:${destination.id}`, destination.secret);
  }
  assertSecret("MinIO secret key", values.MINIO_SECRET_KEY);
  assertExternalCredential("OCR password", values.OCR_BASIC_PASSWORD);
  if (values.WEBHOOK_URL) assertSecret("Webhook secret", values.WEBHOOK_SECRET);
}

function assertSecret(label: string, value: string): void {
  if (value.length < 16 || /^(local-|change-me|replace-with)/i.test(value)) {
    throw new Error(`${label} must be a non-placeholder secret containing at least 16 characters`);
  }
}

function assertExternalCredential(label: string, value: string): void {
  if (!value.trim() || /^(local-|change-me|replace-with)/i.test(value)) {
    throw new Error(`${label} must be a non-placeholder credential`);
  }
}
