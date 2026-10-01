import { randomBytes } from "node:crypto";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import swagger from "@fastify/swagger";
import Fastify, { type FastifyReply, type FastifyRequest, LogController } from "fastify";
import { z } from "zod";
import type { AppConfig } from "./config.js";
import { OcrRequestError } from "./adapters/ocr-http.js";
import { policies, sessionPolicy } from "./domain/policies.js";
import type { Policy } from "./domain/types.js";
import type { ApplicationStore } from "./management/store.js";
import type { AdminAuth } from "./management/auth.js";
import { policyForApplication } from "./management/model.js";
import { registerAdministration } from "./management/routes.js";
import { type DocumentKind, documentKinds, type OnboardingSession, type QualityReport } from "./domain/types.js";
import {
  createSessionInput,
  createSessionRouteSchema,
  documentSelectionInput,
  sessionResultRouteSchema,
  sessionStatusRouteSchema,
} from "./http-contract.js";
import {
  confirmDocument,
  assertCaptureAllowed,
  createSession,
  DomainError,
  expireIfNeeded,
  markProcessingStage,
  registerCapture,
  registerOcrResult,
  retakeDocument,
  retakeSide,
  selectDocuments,
  submitSession,
} from "./domain/workflow.js";
import type { CaptureStore, OcrGateway, QualityEngine, SessionRepository, TaskQueue, WebhookGateway } from "./ports.js";
import { DocumentQualityEngine } from "./quality/engine.js";
import type { CalibrationHub } from "./quality/calibration-hub.js";
import { phoneDiagnosticsPage } from "./quality/phone-diagnostics.js";
import { defaultQualityProfile, QualityProfileStore } from "./quality/profile.js";
import { simulatedOcrFields, simulatedPassingQualityReport } from "./quality/simulation.js";
import type { FileTemplateStore } from "./quality/template-store.js";
import type { NormalizedRegion, OrbTemplate } from "./quality/types.js";
import { DurableTaskDispatcher } from "./services/durable-tasks.js";
import { createDemoTrace, writeTrace } from "./services/demo-trace.js";

export type AppDependencies = {
  config: AppConfig;
  sessions: SessionRepository;
  captures: CaptureStore;
  quality: QualityEngine;
  queue: TaskQueue;
  ocr?: OcrGateway;
  webhooks: WebhookGateway;
  templateEngine?: DocumentQualityEngine;
  templates?: FileTemplateStore;
  qualityProfiles?: QualityProfileStore;
  calibrations?: CalibrationHub;
  applications?: ApplicationStore;
  auth?: AdminAuth;
  closeManagement?: () => Promise<void>;
};

type CaptureMutationResult = { duplicate: true } | { captureId: string } | { error: DomainError };

export async function buildApp(dependencies: AppDependencies) {
  const app = Fastify({
    logger: dependencies.config.NODE_ENV !== "test",
    logController: new LogController({ disableRequestLogging: true }),
    bodyLimit: 13 * 1024 * 1024,
  });
  const tasks = new DurableTaskDispatcher(dependencies.sessions, dependencies.queue);
  type Client = {
    id: string;
    allowedPolicies: string[];
    policy?: Policy;
    webhookDestinations: Array<{ id: string; url: string; secret: string }>;
    returnDestinations: Array<{ id: string; url: string }>;
  };
  const requestClients = new WeakMap<FastifyRequest, Client>();
  const clientGuard = async (request: FastifyRequest, reply: FastifyReply) => {
    const key = request.headers["x-api-key"];
    if (typeof key !== "string" || key.length > 512) return reply.code(401).send({ error: "unauthorized" });
    let client: Client | undefined;
    if (dependencies.applications) {
      const application = await dependencies.applications.authenticate(key);
      if (application) {
        const policy = policyForApplication(application);
        client = application.legacy
          ? { id: application.id, ...application.legacy }
          : {
              id: application.id,
              allowedPolicies: [policy.id],
              policy,
              webhookDestinations:
                application.webhookUrl && application.webhookSecret
                  ? [{ id: "main", url: application.webhookUrl, secret: application.webhookSecret }]
                  : [],
              returnDestinations: application.returnUrl ? [{ id: "main", url: application.returnUrl }] : [],
            };
      }
    } else client = dependencies.config.clientByApiKey.get(key);
    if (!client) return reply.code(401).send({ error: "unauthorized" });
    requestClients.set(request, client);
  };
  if (dependencies.closeManagement) app.addHook("onClose", dependencies.closeManagement);

  app.addHook("onResponse", async (request, reply) => {
    request.log.info(
      {
        method: request.method,
        route: request.routeOptions.url ?? "unmatched",
        statusCode: reply.statusCode,
        responseTimeMs: Math.round(reply.elapsedTime * 100) / 100,
      },
      "request completed",
    );
  });

  await app.register(cors, {
    origin: dependencies.config.NODE_ENV === "production" ? dependencies.config.PUBLIC_BASE_URL : true,
  });
  await app.register(multipart, { limits: { files: 1, fileSize: 12 * 1024 * 1024, fields: 8 } });
  await app.register(swagger, {
    openapi: {
      info: { title: "OCR Algeria Onboarding API", version: "1.0.0" },
      components: { securitySchemes: { ApiKeyAuth: { type: "apiKey", in: "header", name: "x-api-key" } } },
    },
  });
  app.get("/openapi.json", async () => app.swagger());
  app.get("/docs", async (_request, reply) => reply.redirect(`${dependencies.config.PUBLIC_BASE_URL}/docs`));
  if (dependencies.auth && dependencies.applications)
    await registerAdministration(app, {
      config: dependencies.config,
      auth: dependencies.auth,
      applications: dependencies.applications,
      ...(dependencies.ocr ? { ocr: dependencies.ocr } : {}),
    });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof DomainError)
      return reply.code(error.statusCode).send({ error: error.code, detail: error.message });
    if (error instanceof z.ZodError)
      return reply.code(400).send({ error: "invalid_request", detail: z.prettifyError(error) });
    if (isHttpError(error) && error.statusCode >= 400 && error.statusCode < 500) {
      return reply.code(error.statusCode).send({ error: error.code ?? "invalid_request", detail: error.message });
    }
    app.log.error(error);
    return reply.code(500).send({ error: "internal_error", detail: "An unexpected error occurred" });
  });

  app.get("/healthz", async () => ({ status: "ok" }));
  app.get("/readyz", async (_request, reply) => {
    const checks = await subsystemHealth(dependencies);
    const ready = Object.values(checks).every(Boolean);
    return reply.code(ready ? 200 : 503).send({ status: ready ? "ready" : "not_ready", checks });
  });
  app.get("/v1/status", { onRequest: clientGuard }, async () => ({
    status: "ok",
    checks: await subsystemHealth(dependencies),
  }));
  app.get(
    "/v1/config",
    {
      onRequest: clientGuard,
      schema: {
        summary: "Read the document rules assigned to this application",
        security: [{ ApiKeyAuth: [] }],
        response: { 200: { type: "object", additionalProperties: true } },
      },
    },
    async (request) => {
      const client = requestClients.get(request);
      if (!client) throw new DomainError("unauthorized", "Authentication is required", 401);
      return {
        applicationId: client.id,
        policy:
          client.policy ??
          policies[
            client.allowedPolicies.includes("two-of-three")
              ? "two-of-three"
              : (client.allowedPolicies[0] ?? "two-of-three")
          ],
        webhookConfigured: client.webhookDestinations.length > 0,
        returnConfigured: client.returnDestinations.length > 0,
      };
    },
  );
  app.get("/metrics", async (_request, reply) => {
    const checks = await subsystemHealth(dependencies);
    const lines = [
      "# HELP onboarding_up Service availability",
      "# TYPE onboarding_up gauge",
      "onboarding_up 1",
      "# HELP onboarding_dependency_up Dependency availability",
      "# TYPE onboarding_dependency_up gauge",
      ...Object.entries(checks).map(
        ([name, ready]) => `onboarding_dependency_up{dependency="${name}"} ${ready ? 1 : 0}`,
      ),
      "# HELP onboarding_process_uptime_seconds Process uptime",
      "# TYPE onboarding_process_uptime_seconds gauge",
      `onboarding_process_uptime_seconds ${Math.round(process.uptime())}`,
    ];
    return reply.type("text/plain; version=0.0.4").send(`${lines.join("\n")}\n`);
  });

  app.post("/v1/sessions", { onRequest: clientGuard, schema: createSessionRouteSchema }, async (request, reply) => {
    const idempotencyKey = request.headers["idempotency-key"];
    if (typeof idempotencyKey !== "string" || idempotencyKey.length < 8) {
      return reply
        .code(400)
        .send({ error: "missing_idempotency_key", detail: "Idempotency-Key must contain at least 8 characters" });
    }
    const input = createSessionInput.parse(request.body);
    const client = requestClients.get(request);
    if (!client) return reply.code(401).send({ error: "unauthorized" });
    const policyId =
      input.policyId ??
      client.policy?.id ??
      (client.allowedPolicies.includes("two-of-three")
        ? "two-of-three"
        : (client.allowedPolicies[0] ?? "two-of-three"));
    if (!client.allowedPolicies.includes(policyId)) return reply.code(403).send({ error: "policy_not_allowed" });
    if (
      input.webhookDestinationId &&
      !client.webhookDestinations.some((item) => item.id === input.webhookDestinationId)
    )
      return reply.code(400).send({ error: "unknown_webhook_destination" });
    if (input.returnDestinationId && !client.returnDestinations.some((item) => item.id === input.returnDestinationId))
      return reply.code(400).send({ error: "unknown_return_destination" });
    const webhook = client.webhookDestinations.find(
      (item) => item.id === (input.webhookDestinationId ?? (client.policy ? "main" : undefined)),
    );
    const returnDestination = client.returnDestinations.find(
      (item) => item.id === (input.returnDestinationId ?? (client.policy ? "main" : undefined)),
    );
    const pending = createSession({
      ...input,
      policyId,
      ...(client.policy ? { policy: client.policy } : {}),
      clientApplicationId: client.id,
    });
    if (webhook) {
      pending.webhookDestination = { url: webhook.url, secret: webhook.secret };
      pending.webhookDestinationId = webhook.id;
    }
    if (returnDestination) {
      pending.returnUrl = returnDestination.url;
      pending.returnDestinationId = returnDestination.id;
    }
    const session = await dependencies.sessions.create(pending, `${client.id}:${idempotencyKey}`);
    return reply.code(201).send({
      sessionId: session.id,
      status: session.status,
      accessUrl: `${dependencies.config.PUBLIC_BASE_URL}/s/${session.publicToken}`,
      expiresAt: session.expiresAt,
    });
  });

  app.get<{ Params: { id: string } }>(
    "/v1/sessions/:id/status",
    { onRequest: clientGuard, schema: sessionStatusRouteSchema },
    async (request, reply) => {
      const session = await findSession(dependencies.sessions, request.params.id, reply);
      if (!session) return;
      if (requestClients.get(request)?.id !== session.clientApplicationId)
        return reply.code(404).send({ error: "session_not_found" });
      const previousVersion = session.version;
      expireIfNeeded(session);
      if (session.version !== previousVersion) await dependencies.sessions.save(session);
      return statusView(session);
    },
  );

  app.get<{ Params: { id: string } }>(
    "/v1/sessions/:id/result",
    { onRequest: clientGuard, schema: sessionResultRouteSchema },
    async (request, reply) => {
      const session = await findSession(dependencies.sessions, request.params.id, reply);
      if (!session) return;
      if (requestClients.get(request)?.id !== session.clientApplicationId)
        return reply.code(404).send({ error: "session_not_found" });
      if (!isFinalStatus(session.status))
        return reply
          .code(409)
          .send({ error: "result_not_ready", status: session.status, reasonCode: session.reasonCode ?? null });
      const policy = sessionPolicy(session);
      if (!policy) return reply.code(500).send({ error: "invalid_policy_state" });
      return {
        sessionId: session.id,
        clientReference: session.clientReference,
        status: session.status,
        policy: { id: policy.id, version: policy.version },
        reasonCode: session.reasonCode ?? null,
        result: session.result ?? null,
        documents: Object.fromEntries(
          Object.entries(session.documents).map(([kind, document]) => [
            kind,
            document
              ? {
                  fields: document.fields,
                  originalOcrResponse: document.ocrResponse,
                  confirmed: document.confirmed,
                  unreadableFields: document.unreadableFields,
                  ocrAttempts: document.ocrAttempts,
                  timingsMs: document.timingsMs,
                }
              : null,
          ]),
        ),
        consistency: {
          ...session.consistency,
          nin: identityCheckStatus(session, "nin"),
          dateOfBirth: identityCheckStatus(session, "dateOfBirth"),
        },
      };
    },
  );

  app.get<{ Params: { token: string } }>("/public/sessions/:token", async (request, reply) => {
    const session = await findPublicSession(dependencies.sessions, request.params.token, reply);
    if (!session) return;
    const previousVersion = session.version;
    expireIfNeeded(session);
    if (session.version !== previousVersion) await dependencies.sessions.save(session);
    return publicView(session, dependencies.config);
  });

  // The worker runs in a different process. Watching persisted versions keeps both devices in sync.
  app.get<{ Params: { token: string } }>("/public/sessions/:token/events", async (request, reply) => {
    const initial = await dependencies.sessions.findByPublicToken(request.params.token);
    if (!initial) return reply.code(404).send({ error: "session_not_found" });
    reply.hijack();
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    let version = initial.version;
    let checking = false;
    const send = (session: OnboardingSession) =>
      reply.raw.write(`event: session\ndata: ${JSON.stringify(publicView(session, dependencies.config))}\n\n`);
    send(initial);
    const timer = setInterval(async () => {
      if (checking || reply.raw.destroyed) return;
      checking = true;
      try {
        const session = await dependencies.sessions.findByPublicToken(request.params.token);
        if (!session) {
          reply.raw.end();
          return;
        }
        if (session.version !== version) {
          version = session.version;
          send(session);
        }
      } catch (error) {
        request.log.warn({ error }, "session stream interrupted");
        reply.raw.end();
      } finally {
        checking = false;
      }
    }, 750);
    const heartbeat = setInterval(() => reply.raw.write(": keepalive\n\n"), 15_000);
    reply.raw.on("close", () => {
      clearInterval(timer);
      clearInterval(heartbeat);
    });
  });

  app.get<{ Params: { token: string; templateId: string } }>(
    "/public/sessions/:token/quality-templates/:templateId",
    async (request, reply) => {
      const session = await findPublicSession(dependencies.sessions, request.params.token, reply);
      if (!session) return;
      const templates = (await dependencies.templates?.findVariants(request.params.templateId)) ?? [];
      return {
        templates,
        qualityProfile: dependencies.qualityProfiles?.current() ?? dependencies.config.qualityProfile,
      };
    },
  );

  app.post<{ Params: { token: string } }>("/public/sessions/:token/select-documents", async (request, reply) => {
    const mutationKey = requireMutationKey(request);
    const input = documentSelectionInput.parse(request.body);
    const mutation = await dependencies.sessions.mutateByPublicToken(request.params.token, (session) => {
      if (session.processedMutationKeys.includes(mutationKey)) return;
      selectDocuments(session, input.documents);
      session.processedMutationKeys.push(mutationKey);
    });
    if (!mutation) return reply.code(404).send({ error: "session_not_found" });
    return publicView(mutation.session, dependencies.config);
  });

  app.post<{ Params: { token: string; kind: DocumentKind; side: "front" | "back" | "single" } }>(
    "/public/sessions/:token/captures/:kind/:side",
    async (request, reply) => {
      const initialSession = await findPublicSession(dependencies.sessions, request.params.token, reply);
      if (!initialSession) return;
      const mutationKey = requireMutationKey(request);
      if (initialSession.processedMutationKeys.includes(mutationKey)) {
        return reply.code(200).send({ duplicate: true, session: publicView(initialSession, dependencies.config) });
      }
      if (!documentKinds.includes(request.params.kind)) return reply.code(404).send({ error: "unknown_document" });
      const beforePreflight = initialSession.version;
      try {
        assertCaptureAllowed(initialSession, request.params);
      } finally {
        if (initialSession.version !== beforePreflight) await dependencies.sessions.save(initialSession);
      }
      const file = await request.file();
      if (!file) return reply.code(400).send({ error: "missing_capture" });
      if (!file.mimetype.startsWith("image/")) return reply.code(415).send({ error: "unsupported_media_type" });
      const uploadStarted = performance.now();
      const image = await file.toBuffer();
      const trace = await createDemoTrace(
        dependencies.config.ONBOARDING_DEMO_TRACE,
        dependencies.config.ONBOARDING_TRACE_DIRECTORY,
        `${initialSession.id}-${request.params.kind}-${request.params.side}-capture`,
      );
      await writeTrace(trace, "capture.jpg", image);
      const uploadMs = Math.round((performance.now() - uploadStarted) * 100) / 100;
      const assessment = !dependencies.config.SERVER_QUALITY_CHECKS_ENABLED
        ? {
            report: {
              passed: true,
              mode: "off",
              checks: [],
              templateMatched: false,
              durationMs: 0,
            } satisfies QualityReport,
          }
        : dependencies.quality.assess
          ? await dependencies.quality.assess(image, { documentKind: request.params.kind, prepare: false })
          : { report: await dependencies.quality.analyze(image) };
      const quality = assessment.report;
      await writeTrace(trace, "quality.json", quality);
      const objectKey = `${initialSession.id}/${request.params.kind}/${request.params.side}-${Date.now()}.jpg`;
      const ocrObjectKey = assessment.ocrImage ? objectKey.replace(/\.jpg$/, ".ocr.jpg") : undefined;
      let stored = false;
      let storageMs = 0;
      const storageStarted = performance.now();
      if (quality.passed) {
        await dependencies.captures.put(objectKey, image, file.mimetype);
        stored = true;
        if (ocrObjectKey && assessment.ocrImage)
          await dependencies.captures.put(ocrObjectKey, assessment.ocrImage.image, "image/jpeg");
        storageMs = Math.round((performance.now() - storageStarted) * 100) / 100;
      }
      const removeStored = async () => {
        if (!stored) return;
        await dependencies.captures.remove(objectKey).catch(() => undefined);
        if (ocrObjectKey) await dependencies.captures.remove(ocrObjectKey).catch(() => undefined);
      };
      let mutation: { session: OnboardingSession; result: CaptureMutationResult } | null;
      try {
        mutation = await dependencies.sessions.mutateByPublicToken(request.params.token, (session) => {
          if (session.processedMutationKeys.includes(mutationKey)) return { duplicate: true } as const;
          try {
            const captureId = registerCapture(session, {
              ...request.params,
              objectKey,
              contentType: file.mimetype,
              ...(stored && ocrObjectKey ? { ocrObjectKey } : {}),
              quality,
              timingsMs: { upload: uploadMs, quality: quality.durationMs, storage: storageMs },
            });
            session.processedMutationKeys.push(mutationKey);
            const document = session.documents[request.params.kind];
            if (document?.status === "processing") document.queuedAtEpochMs = Date.now();
            tasks.prepare(session);
            return { captureId } as const;
          } catch (error) {
            if (!(error instanceof DomainError)) throw error;
            tasks.prepare(session);
            return { error } as const;
          }
        });
      } catch (error) {
        await removeStored();
        throw error;
      }
      if (!mutation) {
        await removeStored();
        return reply.code(404).send({ error: "session_not_found" });
      }
      if ("duplicate" in mutation.result) {
        await removeStored();
        await tasks.dispatch(mutation.session);
        return reply.code(200).send({ duplicate: true, session: publicView(mutation.session, dependencies.config) });
      }
      if ("error" in mutation.result) {
        await removeStored();
        await tasks.dispatch(mutation.session);
        if (mutation.result.error.code === "quality_rejected")
          return reply.code(422).send({
            error: mutation.result.error.code,
            detail: mutation.result.error.message,
            quality,
            session: publicView(mutation.session, dependencies.config),
          });
        throw mutation.result.error;
      }
      await tasks.dispatch(mutation.session);
      const refreshed = await dependencies.sessions.findById(mutation.session.id);
      return reply.code(201).send({
        captureId: mutation.result.captureId,
        quality,
        session: publicView(refreshed ?? mutation.session, dependencies.config),
      });
    },
  );

  app.post<{ Params: { token: string; kind: DocumentKind } }>(
    "/public/sessions/:token/documents/:kind/confirm",
    async (request, reply) => {
      const mutationKey = requireMutationKey(request);
      const mutation = await dependencies.sessions.mutateByPublicToken(request.params.token, (session) => {
        if (session.processedMutationKeys.includes(mutationKey)) return;
        confirmDocument(session, request.params.kind);
        session.processedMutationKeys.push(mutationKey);
        tasks.prepare(session);
      });
      if (!mutation) return reply.code(404).send({ error: "session_not_found" });
      await tasks.dispatch(mutation.session);
      return publicView(mutation.session, dependencies.config);
    },
  );

  app.post<{ Params: { token: string; kind: DocumentKind } }>(
    "/public/sessions/:token/documents/:kind/retake",
    async (request, reply) => {
      const mutationKey = requireMutationKey(request);
      const mutation = await dependencies.sessions.mutateByPublicToken(request.params.token, (session) => {
        if (session.processedMutationKeys.includes(mutationKey)) return { replacedObjectKeys: [] };
        const document = session.documents[request.params.kind];
        const replacedObjectKeys = document
          ? Object.values(document.captures).flatMap((capture) =>
              capture ? [capture.objectKey, ...(capture.ocrObjectKey ? [capture.ocrObjectKey] : [])] : [],
            )
          : [];
        retakeDocument(session, request.params.kind);
        session.processedMutationKeys.push(mutationKey);
        tasks.prepare(session);
        return { replacedObjectKeys };
      });
      if (!mutation) return reply.code(404).send({ error: "session_not_found" });
      await tasks.dispatch(mutation.session);
      await Promise.allSettled(mutation.result.replacedObjectKeys.map((key) => dependencies.captures.remove(key)));
      return publicView(mutation.session, dependencies.config);
    },
  );

  app.post<{ Params: { token: string; kind: DocumentKind; side: "front" | "back" | "single" } }>(
    "/public/sessions/:token/documents/:kind/retake/:side",
    async (request, reply) => {
      const mutationKey = requireMutationKey(request);
      const mutation = await dependencies.sessions.mutateByPublicToken(request.params.token, (session) => {
        if (session.processedMutationKeys.includes(mutationKey)) return { replacedObjectKeys: [] };
        const capture = session.documents[request.params.kind]?.captures[request.params.side];
        const replacedObjectKeys = capture
          ? [capture.objectKey, ...(capture.ocrObjectKey ? [capture.ocrObjectKey] : [])]
          : [];
        retakeSide(session, request.params.kind, request.params.side);
        session.processedMutationKeys.push(mutationKey);
        tasks.prepare(session);
        return { replacedObjectKeys };
      });
      if (!mutation) return reply.code(404).send({ error: "session_not_found" });
      await tasks.dispatch(mutation.session);
      await Promise.allSettled(mutation.result.replacedObjectKeys.map((key) => dependencies.captures.remove(key)));
      return publicView(mutation.session, dependencies.config);
    },
  );

  app.post<{ Params: { token: string } }>("/public/sessions/:token/submit", async (request, reply) => {
    const mutationKey = requireMutationKey(request);
    const mutation = await dependencies.sessions.mutateByPublicToken(request.params.token, (session) => {
      if (session.processedMutationKeys.includes(mutationKey)) return;
      submitSession(session);
      session.processedMutationKeys.push(mutationKey);
      tasks.prepare(session);
    });
    if (!mutation) return reply.code(404).send({ error: "session_not_found" });
    await tasks.dispatch(mutation.session);
    return publicView(mutation.session, dependencies.config);
  });

  app.post<{ Params: { token: string } }>("/public/sessions/:token/transfer", async (request, reply) => {
    const nonce = randomBytes(24).toString("base64url");
    const expiresAt = Date.now() + 5 * 60_000;
    const mutation = await dependencies.sessions.mutateByPublicToken(request.params.token, (session) => {
      expireIfNeeded(session);
      if (
        ["succeeded", "document_failed", "consistency_failed", "technical_failed", "expired"].includes(session.status)
      )
        throw new DomainError("session_closed", "Session is already closed", 409);
      session.processedMutationKeys.push(`transfer:${nonce}:${expiresAt}`);
    });
    if (!mutation) return reply.code(404).send({ error: "session_not_found" });
    const transferToken = `${request.params.token}.${nonce}.${expiresAt}`;
    return {
      transferToken,
      transferUrl: `${dependencies.config.PUBLIC_BASE_URL}/transfer/${transferToken}`,
      expiresAt: new Date(expiresAt).toISOString(),
    };
  });

  app.post<{ Params: { transferToken: string } }>(
    "/public/transfers/:transferToken/consume",
    async (request, reply) => {
      const [publicToken, nonce, expiry] = request.params.transferToken.split(".");
      const expiresAt = Number(expiry);
      if (!publicToken || !nonce || !Number.isSafeInteger(expiresAt) || expiresAt <= Date.now())
        return reply.code(410).send({ error: "transfer_expired" });
      const marker = `transfer:${nonce}:${expiresAt}`;
      const mutation = await dependencies.sessions.mutateByPublicToken(publicToken, (session) => {
        const index = session.processedMutationKeys.indexOf(marker);
        if (index < 0) return false;
        session.processedMutationKeys.splice(index, 1);
        session.captureDeviceConnectedAt = new Date().toISOString();
        session.updatedAt = session.captureDeviceConnectedAt;
        session.version += 1;
        return true;
      });
      if (!mutation?.result) return reply.code(410).send({ error: "transfer_expired" });
      return { accessUrl: `${dependencies.config.PUBLIC_BASE_URL}/capture/${publicToken}` };
    },
  );

  if (
    dependencies.config.NODE_ENV !== "production" &&
    dependencies.config.QUALITY_LAB_ENABLED &&
    dependencies.templateEngine &&
    dependencies.qualityProfiles
  ) {
    app.get("/dev/quality/config", async () => ({
      profile: dependencies.qualityProfiles?.current(),
      defaults: defaultQualityProfile,
      serverQualityChecksEnabled: dependencies.config.SERVER_QUALITY_CHECKS_ENABLED,
    }));

    app.put("/dev/quality/config", async (request) => ({
      profile: await dependencies.qualityProfiles?.save(request.body),
    }));

    app.post("/dev/quality/analyze", async (request, reply) => {
      const form = await readCalibrationForm(request);
      if (!form.image) return reply.code(400).send({ error: "missing_image" });
      const profiles = form.fields.profile
        ? new QualityProfileStore(JSON.parse(form.fields.profile))
        : dependencies.qualityProfiles;
      const assessment = await new DocumentQualityEngine(dependencies.templates, profiles).assess(form.image, {
        ...(form.fields.documentKind ? { documentKind: form.fields.documentKind } : {}),
        ...(form.fields.templateId ? { templateId: templateIdSchema.parse(form.fields.templateId) } : {}),
        prepare: form.fields.prepare === "true",
        previewAlignment: form.fields.previewAlignment === "true",
      });
      return {
        ...assessment.report,
        ...(assessment.alignmentImage
          ? {
              alignmentImage: {
                dataUrl: `data:image/jpeg;base64,${assessment.alignmentImage.image.toString("base64")}`,
                width: assessment.alignmentImage.width,
                height: assessment.alignmentImage.height,
              },
            }
          : {}),
        ...(assessment.ocrImage
          ? {
              ocrImage: {
                dataUrl: `data:image/jpeg;base64,${assessment.ocrImage.image.toString("base64")}`,
                width: assessment.ocrImage.width,
                height: assessment.ocrImage.height,
                steps: assessment.ocrImage.steps,
              },
            }
          : {}),
      };
    });

    if (dependencies.calibrations) {
      const calibrations = dependencies.calibrations;
      const notFound = (reply: FastifyReply) => reply.code(404).send({ error: "calibration_not_found" });
      const assessCapture = (profile: unknown, image: Buffer, documentKind: string, templateId?: string) =>
        new DocumentQualityEngine(dependencies.templates, new QualityProfileStore(profile)).assess(image, {
          documentKind,
          ...(templateId ? { templateId } : {}),
          prepare: true,
        });

      app.post<{ Body: { templateId?: string; documentKind?: string } }>(
        "/dev/quality/calibrations",
        async (request) => ({
          calibration: calibrations.create(dependencies.qualityProfiles?.current() ?? defaultQualityProfile, {
            ...(request.body?.templateId ? { templateId: request.body.templateId } : {}),
            ...(request.body?.documentKind ? { documentKind: request.body.documentKind } : {}),
          }),
        }),
      );

      app.get<{ Params: { id: string } }>("/dev/quality/calibrations/:id", async (request, reply) => {
        const calibration = calibrations.get(request.params.id);
        return calibration ? { calibration } : notFound(reply);
      });

      app.get<{ Params: { id: string } }>("/dev/quality/calibrations/:id/phone-diagnostics", async (request, reply) => {
        if (!calibrations.get(request.params.id)) return notFound(reply);
        return reply
          .type("text/html; charset=utf-8")
          .header("cache-control", "no-store")
          .send(phoneDiagnosticsPage(request.params.id));
      });

      app.get<{ Params: { id: string } }>("/dev/quality/calibrations/:id/events", async (request, reply) => {
        if (!calibrations.get(request.params.id)) return notFound(reply);
        reply.hijack();
        reply.raw.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache, no-transform",
          connection: "keep-alive",
          "x-accel-buffering": "no",
        });
        const unsubscribe = calibrations.subscribe(request.params.id, (event) => {
          reply.raw.write(`event: ${event.type}\ndata: ${JSON.stringify(event.value)}\n\n`);
        });
        if (!unsubscribe) return reply.raw.end();
        const keepAlive = setInterval(() => reply.raw.write(": keep-alive\n\n"), 15_000);
        request.raw.on("close", () => {
          clearInterval(keepAlive);
          unsubscribe();
        });
      });

      app.put<{ Params: { id: string } }>("/dev/quality/calibrations/:id/profile", async (request, reply) => {
        const calibration = calibrations.updateProfile(request.params.id, request.body);
        return calibration ? { calibration } : notFound(reply);
      });

      app.put<{ Params: { id: string }; Body: { documentKind: string; templateId?: string } }>(
        "/dev/quality/calibrations/:id/document",
        async (request, reply) => {
          const kind = z.enum(documentKinds).parse(request.body?.documentKind);
          const calibration = calibrations.setDocumentKind(request.params.id, kind, request.body?.templateId);
          return calibration ? { calibration } : notFound(reply);
        },
      );

      app.post<{ Params: { id: string }; Body: { command: "capture" | "torch" } }>(
        "/dev/quality/calibrations/:id/commands",
        async (request, reply) => {
          const command = z.enum(["capture", "torch"]).parse(request.body?.command);
          return calibrations.command(request.params.id, command) ? { sent: command } : notFound(reply);
        },
      );

      app.get<{ Params: { id: string } }>("/dev/quality/calibrations/:id/frame", async (request, reply) => {
        const image = calibrations.image(request.params.id);
        if (!image) return reply.code(404).send({ error: "frame_not_found" });
        return reply.type("image/jpeg").header("cache-control", "no-store").send(image);
      });

      app.get<{ Params: { id: string; variant: "original" | "ocr" } }>(
        "/dev/quality/calibrations/:id/capture/:variant",
        async (request, reply) => {
          const variant = request.params.variant === "ocr" ? "ocr" : "original";
          const image = calibrations.captureImage(request.params.id, variant);
          if (!image) return reply.code(404).send({ error: "capture_not_found" });
          return reply.type("image/jpeg").header("cache-control", "no-store").send(image);
        },
      );

      /** Live frames only carry the phone's own measurements; the server analyses real photos. */
      app.post<{ Params: { id: string } }>("/dev/quality/calibrations/:id/frames", async (request, reply) => {
        if (!calibrations.get(request.params.id)) return notFound(reply);
        const form = await readCalibrationForm(request);
        const calibration = calibrations.receive(request.params.id, {
          ...(form.image ? { image: form.image } : {}),
          ...(form.fields.client ? { client: JSON.parse(form.fields.client) } : {}),
          ...(request.headers["user-agent"] ? { userAgent: request.headers["user-agent"] } : {}),
        });
        return { ok: Boolean(calibration) };
      });

      app.post<{ Params: { id: string } }>("/dev/quality/calibrations/:id/captures", async (request, reply) => {
        const current = calibrations.get(request.params.id);
        if (!current) return notFound(reply);
        const form = await readCalibrationForm(request);
        if (!form.image) return reply.code(400).send({ error: "missing_image" });
        const assessment = await assessCapture(current.profile, form.image, current.documentKind, current.templateId);
        const photo = assessment.report.diagnostics?.photo ?? { width: 0, height: 0 };
        const trigger = z.enum(["auto", "manual", "remote"]).catch("manual").parse(form.fields.trigger);
        const capture = calibrations.storeCapture(request.params.id, {
          original: form.image,
          ...(assessment.ocrImage ? { ocrImage: assessment.ocrImage.image } : {}),
          capture: {
            trigger,
            ...(form.fields.client ? { client: JSON.parse(form.fields.client) } : {}),
            server: assessment.report,
            ...(assessment.ocrImage
              ? {
                  ocr: {
                    width: assessment.ocrImage.width,
                    height: assessment.ocrImage.height,
                    steps: assessment.ocrImage.steps,
                  },
                }
              : {}),
            original: { ...photo, bytes: form.image.length },
          },
          ...(request.headers["user-agent"] ? { userAgent: request.headers["user-agent"] } : {}),
        });
        return { capture };
      });

      /** Re-runs the full server check and preprocessing on the last photo with the current settings. */
      app.post<{ Params: { id: string } }>("/dev/quality/calibrations/:id/reprocess", async (request, reply) => {
        const current = calibrations.get(request.params.id);
        const original = calibrations.captureImage(request.params.id, "original");
        if (!current || !original) return reply.code(404).send({ error: "capture_not_found" });
        const assessment = await assessCapture(
          request.body ?? current.profile,
          original,
          current.documentKind,
          current.templateId,
        );
        const capture = calibrations.replaceOcr(
          request.params.id,
          assessment.ocrImage?.image,
          assessment.ocrImage
            ? { width: assessment.ocrImage.width, height: assessment.ocrImage.height, steps: assessment.ocrImage.steps }
            : undefined,
          assessment.report,
        );
        return { capture };
      });

      /** Dev-only, synchronous proof that the captured image reaches the same OCR gateway as production. */
      app.post<{
        Params: { id: string };
        Body: { side?: "front" | "back" | "single"; imageVariant?: "original" | "ocr" };
      }>("/dev/quality/calibrations/:id/ocr-test", async (request, reply) => {
        const current = calibrations.get(request.params.id);
        const original = calibrations.captureImage(request.params.id, "original");
        if (!current || !original)
          return reply
            .code(404)
            .send({ error: "capture_not_found", detail: "Prenez d’abord une photo dans cette session." });
        if (!dependencies.ocr?.extractSingle) return reply.code(503).send({ error: "ocr_unavailable" });
        const side = current.documentKind === "dz-passport" ? "single" : request.body?.side;
        if (current.documentKind !== "dz-passport" && side !== "front" && side !== "back")
          return reply.code(400).send({ error: "invalid_document_side" });
        const requestedVariant = request.body?.imageVariant ?? "ocr";
        if (requestedVariant !== "ocr" && requestedVariant !== "original")
          return reply.code(400).send({ error: "invalid_image_variant" });
        const processed = requestedVariant === "ocr" ? calibrations.captureImage(request.params.id, "ocr") : null;
        const imageVariant = processed ? "ocr" : "original";
        const documentType =
          current.documentKind === "dz-passport" ? current.documentKind : `${current.documentKind}-${side}`;
        const started = performance.now();
        const metadata = () => ({
          documentType,
          imageVariant,
          durationMs: Math.round((performance.now() - started) * 100) / 100,
        });
        try {
          const response = await dependencies.ocr.extractSingle(documentType, {
            name: "file",
            data: processed ?? original,
            contentType: "image/jpeg",
          });
          return { ...metadata(), response };
        } catch (error) {
          if (error instanceof OcrRequestError)
            return reply.code(502).send({
              ...metadata(),
              error: "ocr_request_failed",
              upstreamStatus: error.upstreamStatus,
              response: error.response,
            });
          return reply.code(502).send({
            ...metadata(),
            error: "ocr_unreachable",
            detail: "Le service OCR est inaccessible ou son délai de réponse est dépassé.",
          });
        }
      });
    }

    app.post<{ Params: { token: string; kind: DocumentKind; side: "front" | "back" | "single" } }>(
      "/dev/sessions/:token/simulate-scan/:kind/:side",
      async (request, reply) => {
        if (!documentKinds.includes(request.params.kind)) return reply.code(404).send({ error: "unknown_document" });
        const mutationKey = requireMutationKey(request);
        const quality = simulatedPassingQualityReport(
          dependencies.qualityProfiles?.current() ?? dependencies.config.qualityProfile,
        );
        const mutation = await dependencies.sessions.mutateByPublicToken(request.params.token, (session) => {
          if (session.processedMutationKeys.includes(mutationKey)) return { duplicate: true } as const;
          const captureId = registerCapture(session, {
            ...request.params,
            objectKey: `dev-simulation/${session.id}/${request.params.kind}/${request.params.side}`,
            quality,
            timingsMs: { upload: 0, quality: 0, storage: 0 },
          });
          session.processedMutationKeys.push(mutationKey);
          return { captureId };
        });
        if (!mutation) return reply.code(404).send({ error: "session_not_found" });
        const simulatedDocument = mutation.session.documents[request.params.kind];
        if (
          !("duplicate" in mutation.result) &&
          simulatedDocument?.status === "processing" &&
          simulatedDocument.requiredSides.every((side) => simulatedDocument.captures[side])
        ) {
          void runSimulatedExtraction(dependencies.sessions, request.params.token, request.params.kind);
        }
        return reply.code(201).send({
          session: publicView(mutation.session, dependencies.config),
          captureId: "duplicate" in mutation.result ? null : mutation.result.captureId,
          quality,
          simulated: true,
        });
      },
    );

    app.get("/dev/quality/templates", async () => dependencies.templates?.list() ?? []);

    app.get<{ Params: { id: string } }>("/dev/quality/templates/:id", async (request, reply) => {
      const template = await dependencies.templates?.get(templateIdSchema.parse(request.params.id));
      if (!template) return reply.code(404).send({ error: "template_not_found" });
      return template;
    });

    app.get<{ Params: { id: string } }>("/dev/quality/templates/:id/image", async (request, reply) => {
      const image = await dependencies.templates?.getImage(templateIdSchema.parse(request.params.id));
      if (!image) return reply.code(404).send({ error: "template_not_found" });
      return reply.type(image.mimeType).send(image.data);
    });

    app.post("/dev/quality/templates", async (request, reply) => {
      const parts = request.parts();
      let image: Buffer | undefined;
      let mimeType: OrbTemplate["image"]["mimeType"] | undefined;
      const fields: Record<string, string> = {};
      for await (const part of parts) {
        if (part.type === "file") {
          if (image) throw new DomainError("invalid_template", "Only one template image is allowed");
          if (part.mimetype !== "image/jpeg" && part.mimetype !== "image/png")
            throw new DomainError("unsupported_media_type", "Only JPEG and PNG template images are supported", 415);
          image = await part.toBuffer();
          mimeType = part.mimetype;
        } else fields[part.fieldname] = String(part.value);
      }
      if (!image) return reply.code(400).send({ error: "missing_image" });
      if (!mimeType) return reply.code(415).send({ error: "unsupported_media_type" });
      const input = createTemplateFieldsSchema.parse({
        ...fields,
        ignoredRegions: fields.ignoredRegions ?? fields.paperIgnoreRegions ?? "[]",
      });
      if (await dependencies.templates?.get(input.id))
        return reply.code(409).send({ error: "template_already_exists" });
      const template = await dependencies.templateEngine?.createTemplate({
        id: input.id,
        name: input.name,
        documentKind: input.documentKind,
        image,
        mimeType,
        zones: parseTemplateZones(input.zones),
        ignoredRegions: parseIgnoredRegions(input.ignoredRegions),
        useWolfBinarization: input.useWolfBinarization,
      });
      return reply.code(201).send(template);
    });

    app.put<{ Params: { id: string } }>("/dev/quality/templates/:id", async (request, reply) => {
      const id = templateIdSchema.parse(request.params.id);
      const body = request.body as Record<string, unknown>;
      const input = updateTemplateSchema.parse({
        ...body,
        ignoredRegions: body.ignoredRegions ?? body.paperIgnoreRegions ?? [],
      });
      const template = await dependencies.templateEngine?.updateTemplate({ id, ...input });
      if (!template) return reply.code(404).send({ error: "template_not_found" });
      return template;
    });

    app.delete<{ Params: { id: string } }>("/dev/quality/templates/:id", async (request, reply) => {
      const deleted = await dependencies.templates?.delete(templateIdSchema.parse(request.params.id));
      if (!deleted) return reply.code(404).send({ error: "template_not_found" });
      return { deleted: true };
    });
  }

  return app;
}

const templateIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{1,100}$/i);
const normalizedRegionShape = {
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  width: z.number().positive().max(1),
  height: z.number().positive().max(1),
};
const normalizedRegionSchema = z
  .object(normalizedRegionShape)
  .refine((region) => region.x + region.width <= 1 && region.y + region.height <= 1, {
    message: "Region must stay inside the template image",
  });
const templateZoneSchema = z
  .object({
    ...normalizedRegionShape,
    id: z.string().trim().min(1).max(80),
    label: z.string().trim().min(1).max(120),
    role: z.enum(["required", "optional"]),
    content: z.enum(["arabic", "latin", "numeric", "date", "mixed"]),
  })
  .refine((region) => region.x + region.width <= 1 && region.y + region.height <= 1, {
    message: "Zone must stay inside the template image",
  });
const templateZonesSchema = z.array(templateZoneSchema).superRefine((zones, context) => {
  for (const property of ["id", "label"] as const) {
    const values = zones.map((zone) => zone[property]);
    if (new Set(values).size !== values.length)
      context.addIssue({ code: "custom", message: `Template zone ${property}s must be unique` });
  }
});
const ignoredRegionsSchema = z.array(normalizedRegionSchema);
const createTemplateFieldsSchema = z.object({
  id: templateIdSchema,
  name: z.string().trim().min(1).max(120),
  documentKind: z.enum(documentKinds),
  zones: z.string().default("[]"),
  ignoredRegions: z.string().default("[]"),
  useWolfBinarization: z
    .string()
    .optional()
    .transform((value) => value === "true"),
});
const updateTemplateSchema = z.object({
  name: z.string().trim().min(1).max(120),
  zones: templateZonesSchema.default([]),
  ignoredRegions: ignoredRegionsSchema.default([]),
  useWolfBinarization: z.boolean().default(false),
});

function parseTemplateZones(serialized: string): OrbTemplate["zones"] {
  return templateZonesSchema.parse(parseTemplateJson(serialized, "zones"));
}

function parseIgnoredRegions(serialized: string): NormalizedRegion[] {
  return ignoredRegionsSchema.parse(parseTemplateJson(serialized, "ignoredRegions"));
}

function parseTemplateJson(serialized: string, field: string): unknown {
  try {
    return JSON.parse(serialized);
  } catch {
    throw new DomainError("invalid_template", `${field} must be valid JSON`);
  }
}

function requireMutationKey(request: FastifyRequest): string {
  const key = request.headers["idempotency-key"];
  if (typeof key !== "string" || key.length < 8)
    throw new DomainError("missing_idempotency_key", "Idempotency-Key must contain at least 8 characters");
  return key;
}

async function findSession(repository: SessionRepository, id: string, reply: FastifyReply) {
  const session = await repository.findById(id);
  if (!session) {
    await reply.code(404).send({ error: "session_not_found" });
    return null;
  }
  return session;
}

async function findPublicSession(repository: SessionRepository, token: string, reply: FastifyReply) {
  const session = await repository.findByPublicToken(token);
  if (!session) {
    await reply.code(404).send({ error: "session_not_found" });
    return null;
  }
  return session;
}

function statusView(session: OnboardingSession) {
  return {
    sessionId: session.id,
    clientReference: session.clientReference,
    status: session.status,
    reasonCode: session.reasonCode ?? null,
    updatedAt: session.updatedAt,
  };
}

function identityCheckStatus(session: OnboardingSession, field: string): "matched" | "mismatched" | "unknown" {
  const checks = session.consistency?.checks.filter((check) => check.field === field) ?? [];
  if (checks.some((check) => check.status === "failed")) return "mismatched";
  return checks.length > 0 && checks.every((check) => check.status === "passed") ? "matched" : "unknown";
}

function publicView(session: OnboardingSession, config: AppConfig) {
  const client = config.clients.find((candidate) => candidate.id === session.clientApplicationId);
  const returnUrl =
    session.returnUrl ??
    (session.returnDestinationId
      ? (client?.returnDestinations.find((destination) => destination.id === session.returnDestinationId)?.url ?? null)
      : null);
  return {
    sessionId: session.id,
    version: session.version,
    captureDeviceConnected: Boolean(session.captureDeviceConnectedAt),
    policyId: session.policyId,
    documentSelection: {
      mode: sessionPolicy(session)?.selection,
      allowedDocuments: sessionPolicy(session)?.allowedDocuments,
      minimumDocuments: sessionPolicy(session)?.minimumDocuments,
      maximumDocuments: sessionPolicy(session)?.maximumDocuments ?? sessionPolicy(session)?.allowedDocuments.length,
      requiredDocuments: sessionPolicy(session)?.requiredDocuments ?? [],
    },
    locale: session.locale,
    status: session.status,
    reasonCode: session.reasonCode ?? null,
    expiresAt: session.expiresAt,
    consistency: session.consistency,
    returnUrl,
    documents: Object.fromEntries(
      Object.entries(session.documents).map(([kind, document]) => [
        kind,
        document
          ? {
              ...Object.fromEntries(
                Object.entries(document).filter(
                  ([key]) =>
                    ![
                      "ocrResponse",
                      "retainedSideFields",
                      "retainedSideCaptureIds",
                      "sideResults",
                      "joinedCaptureIds",
                    ].includes(key),
                ),
              ),
              captures: Object.fromEntries(
                Object.entries(document.captures).map(([side, capture]) => [
                  side,
                  capture
                    ? {
                        id: capture.id,
                        side: capture.side,
                        createdAt: capture.createdAt,
                        quality: capture.quality,
                        timingsMs: capture.timingsMs,
                      }
                    : capture,
                ]),
              ),
            }
          : document,
      ]),
    ),
  };
}

async function runSimulatedExtraction(repository: SessionRepository, token: string, kind: DocumentKind) {
  await delay(450);
  await repository.mutateByPublicToken(token, (session) => markProcessingStage(session, kind, "ocr_reading"));
  await delay(1_050);
  await repository.mutateByPublicToken(token, (session) => markProcessingStage(session, kind, "field_validation"));
  await delay(550);
  await repository.mutateByPublicToken(token, (session) => {
    const document = session.documents[kind];
    if (!document || document.status !== "processing") return;
    const fields = simulatedOcrFields(kind);
    document.ocrResponse = { fields, meta: { simulated: true } };
    document.timingsMs = { quality: 0, ocr: 1_050, validation: 550, totalProcessing: 2_050 };
    registerOcrResult(session, kind, fields, []);
  });
}

function delay(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isFinalStatus(status: OnboardingSession["status"]): boolean {
  return ["succeeded", "document_failed", "consistency_failed", "technical_failed", "expired"].includes(status);
}

function isHttpError(error: unknown): error is Error & { statusCode: number; code?: string } {
  return (
    error instanceof Error &&
    "statusCode" in error &&
    typeof (error as Error & { statusCode?: unknown }).statusCode === "number"
  );
}

async function subsystemHealth(dependencies: AppDependencies) {
  const entries = await Promise.all(
    [
      ["database", dependencies.sessions.health?.() ?? Promise.resolve(true)],
      ["storage", dependencies.captures.health?.() ?? Promise.resolve(true)],
      ["queue", dependencies.queue.health?.() ?? Promise.resolve(true)],
      ["ocr", dependencies.ocr?.health?.() ?? Promise.resolve(true)],
      ["webhooks", dependencies.webhooks.health?.() ?? Promise.resolve(true)],
    ].map(async ([name, promise]) => [name, await promise] as const),
  );
  return Object.fromEntries(entries);
}

async function readCalibrationForm(request: FastifyRequest) {
  const fields: Record<string, string> = {};
  let image: Buffer | undefined;
  for await (const part of request.parts()) {
    if (part.type === "file") image = await part.toBuffer();
    else fields[part.fieldname] = String(part.value);
  }
  return { image, fields };
}
