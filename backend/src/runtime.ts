import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { MemoryCaptureStore, MemorySessionRepository } from "./adapters/memory.js";
import { MinioCaptureStore } from "./adapters/minio.js";
import { HttpOcrGateway } from "./adapters/ocr-http.js";
import { PostgresSessionRepository } from "./adapters/postgres.js";
import { InlineTaskQueue, PgBossTaskQueue } from "./adapters/queue.js";
import { HttpWebhookGateway } from "./adapters/webhook.js";
import { loadConfig } from "./config.js";
import { DocumentQualityEngine } from "./quality/engine.js";
import { CalibrationHub } from "./quality/calibration-hub.js";
import { FileTemplateStore } from "./quality/template-store.js";
import { WorkerThreadQualityEngine } from "./quality/worker-engine.js";
import { QualityProfileStore, qualityProfileSchema } from "./quality/profile.js";
import { ExtractionService } from "./services/extraction.js";
import { DurableTaskDispatcher } from "./services/durable-tasks.js";
import { WebhookDeliveryService } from "./services/webhook-delivery.js";
import { createManagement } from "./management/runtime.js";

export async function createRuntime(options: { consumeJobs?: boolean } = {}) {
  const config = loadConfig();
  const management = await createManagement(config);
  const sessions =
    config.REPOSITORY_DRIVER === "postgres"
      ? new PostgresSessionRepository(config.DATABASE_URL)
      : new MemorySessionRepository();
  if (sessions instanceof PostgresSessionRepository) await sessions.migrate();

  const captures =
    config.STORAGE_DRIVER === "minio"
      ? new MinioCaptureStore({
          endpoint: config.MINIO_ENDPOINT,
          port: config.MINIO_PORT,
          useSSL: config.MINIO_USE_SSL,
          accessKey: config.MINIO_ACCESS_KEY,
          secretKey: config.MINIO_SECRET_KEY,
          bucket: config.MINIO_BUCKET,
        })
      : new MemoryCaptureStore();
  if (captures instanceof MinioCaptureStore) await captures.ensureBucket();

  const queue = config.QUEUE_DRIVER === "pg-boss" ? new PgBossTaskQueue(config.DATABASE_URL) : new InlineTaskQueue();
  const ocr = new HttpOcrGateway({
    baseUrl: config.OCR_BASE_URL,
    username: config.OCR_BASIC_USERNAME,
    password: config.OCR_BASIC_PASSWORD,
    timeoutMs: config.OCR_TIMEOUT_MS,
  });
  const webhooks = new HttpWebhookGateway(
    new Map(
      config.clients.flatMap((client) =>
        client.webhookDestinations.map((destination) => [`${client.id}:${destination.id}`, destination] as const),
      ),
    ),
  );
  const templateDirectory = resolve(process.env.TEMPLATE_DIRECTORY ?? "templates");
  const sourceBundle = fileURLToPath(new URL("../quality-templates/", import.meta.url));
  const bundledTemplateDirectory = existsSync(sourceBundle)
    ? sourceBundle
    : fileURLToPath(new URL("../../quality-templates/", import.meta.url));
  const templates = new FileTemplateStore(templateDirectory, bundledTemplateDirectory);
  const sourceProfile = fileURLToPath(new URL("../config/quality-profile.json", import.meta.url));
  const baselinePath = existsSync(sourceProfile)
    ? sourceProfile
    : fileURLToPath(new URL("../../config/quality-profile.json", import.meta.url));
  const calibratedProfile = config.QUALITY_PROFILE_JSON
    ? config.qualityProfile
    : {
        ...qualityProfileSchema.parse(JSON.parse(await readFile(baselinePath, "utf8"))),
        mode: config.QUALITY_MODE,
      };
  const qualityProfiles = await QualityProfileStore.open(calibratedProfile, resolve(config.QUALITY_PROFILE_PATH));
  const calibrations = new CalibrationHub();
  const templateEngine = new DocumentQualityEngine(templates, qualityProfiles);
  const quality =
    config.NODE_ENV === "production"
      ? new WorkerThreadQualityEngine(templateDirectory, qualityProfiles, 20_000, bundledTemplateDirectory)
      : templateEngine;
  const extraction = new ExtractionService({
    sessions,
    captures,
    ocr,
    queue,
    requiredFields: config.requiredFields,
    trace: { enabled: config.ONBOARDING_DEMO_TRACE, directory: config.ONBOARDING_TRACE_DIRECTORY },
  });
  const webhookDelivery = new WebhookDeliveryService(sessions, webhooks);
  const tasks = new DurableTaskDispatcher(sessions, queue);
  await queue.start(
    options.consumeJobs === false
      ? {}
      : {
          extraction: (task) => extraction.process(task),
          webhook: (task) => webhookDelivery.process(task),
        },
  );

  return {
    ...management,
    config,
    sessions,
    captures,
    queue,
    tasks,
    webhooks,
    ocr,
    quality,
    templateEngine,
    templates,
    qualityProfiles,
    calibrations,
  };
}
