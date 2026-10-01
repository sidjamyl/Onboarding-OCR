import { randomBytes, randomUUID } from "node:crypto";
import { fromNodeHeaders } from "better-auth/node";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { AppConfig } from "../config.js";
import { DomainError } from "../domain/workflow.js";
import type { OcrGateway } from "../ports.js";
import type { AdminAuth } from "./auth.js";
import { onboardingCatalog } from "./catalog.js";
import { applicationInput, publicApplication, type ClientApplication } from "./model.js";
import { issueKey, type ApplicationStore } from "./store.js";

export async function registerAdministration(
  app: FastifyInstance,
  dependencies: { config: AppConfig; auth: AdminAuth; applications: ApplicationStore; ocr?: OcrGateway },
) {
  const { auth, applications, config } = dependencies;
  app.route({
    method: ["GET", "POST"],
    url: "/api/auth/*",
    schema: { hide: true },
    async handler(request, reply) {
      const headers = fromNodeHeaders(request.headers);
      // Derive this from the socket; never accept a caller-supplied rate-limit identity.
      headers.set("x-onboarding-auth-ip", request.ip);
      const response = await auth.handler(
        new Request(new URL(request.url, config.PUBLIC_BASE_URL), {
          method: request.method,
          headers,
          ...(request.body ? { body: JSON.stringify(request.body) } : {}),
        }),
      );
      reply.code(response.status);
      for (const [name, value] of response.headers) if (name !== "set-cookie") reply.header(name, value);
      const cookies = response.headers.getSetCookie();
      if (cookies.length) reply.header("set-cookie", cookies);
      return reply.send(await response.text());
    },
  });
  const guard = async (request: FastifyRequest, reply: FastifyReply) => {
    reply.header("cache-control", "no-store");
    if (!["GET", "HEAD"].includes(request.method) && request.headers.origin !== config.PUBLIC_BASE_URL)
      return reply.code(403).send({ error: "invalid_origin" });
    const session = await auth.api.getSession({ headers: fromNodeHeaders(request.headers) });
    if (!session?.user.isAdmin) return reply.code(401).send({ error: "admin_authentication_required" });
  };
  const options = { onRequest: guard, schema: { hide: true } };
  app.get("/admin/session", options, async (request, reply) => {
    const session = await auth.api.getSession({ headers: fromNodeHeaders(request.headers) });
    if (!session?.user.isAdmin) return reply.code(401).send({ error: "admin_authentication_required" });
    return { user: { name: session.user.name, email: session.user.email } };
  });
  app.get("/admin/catalog", options, async () => onboardingCatalog(dependencies.ocr));
  app.get("/admin/applications", options, async () => ({
    applications: (await applications.list()).map(publicApplication),
  }));
  async function validateDestinations(input: z.infer<typeof applicationInput>) {
    if (
      config.NODE_ENV === "production" &&
      [input.webhookUrl, input.returnUrl].some((url) => url && new URL(url).protocol !== "https:")
    )
      throw new DomainError("https_required", "Production destinations must use HTTPS");
    const catalog = await onboardingCatalog(dependencies.ocr);
    if (!catalog.gatewayReachable)
      throw new DomainError("gateway_unavailable", "Reconnect the OCR gateway before changing document rules", 503);
    if (input.rules.documents.some((id) => !catalog.documents.find((document) => document.id === id)?.available))
      throw new DomainError("unsupported_document", "A selected document is unavailable in the gateway");
  }
  app.post("/admin/applications", options, async (request, reply) => {
    const input = applicationInput.parse(request.body);
    await validateDestinations(input);
    const now = new Date().toISOString();
    const application: ClientApplication = {
      id: randomUUID(),
      name: input.name,
      enabled: input.enabled,
      rules: input.rules,
      webhookUrl: input.webhookUrl,
      webhookSecret: input.webhookUrl ? randomBytes(32).toString("base64url") : null,
      returnUrl: input.returnUrl,
      version: 1,
      createdAt: now,
      updatedAt: now,
    };
    await applications.save(application);
    return reply
      .code(201)
      .send({ application: publicApplication(application), webhookSecret: application.webhookSecret });
  });
  const params = z.object({ id: z.string().min(1) });
  app.put("/admin/applications/:id", options, async (request, reply) => {
    const { id } = params.parse(request.params);
    const current = await applications.find(id);
    if (!current) return reply.code(404).send({ error: "application_not_found" });
    const input = applicationInput.parse(request.body);
    if (input.version !== current.version)
      return reply.code(409).send({ error: "application_changed", detail: "Refresh this application before saving" });
    const ruleChanged = JSON.stringify(input.rules) !== JSON.stringify(current.rules);
    if (ruleChanged) await validateDestinations(input);
    else if (
      config.NODE_ENV === "production" &&
      [input.webhookUrl, input.returnUrl].some((url) => url && new URL(url).protocol !== "https:")
    )
      throw new DomainError("https_required", "Production destinations must use HTTPS");
    const newSecret = input.webhookUrl && !current.webhookSecret ? randomBytes(32).toString("base64url") : null;
    const updated: ClientApplication = {
      ...current,
      name: input.name,
      enabled: input.enabled,
      rules: input.rules,
      version: current.version + 1,
      webhookUrl: input.webhookUrl,
      webhookSecret: input.webhookUrl ? (current.webhookSecret ?? newSecret) : null,
      returnUrl: input.returnUrl,
      updatedAt: new Date().toISOString(),
    };
    // Saving an imported application moves it to the rules managed by this panel.
    delete updated.legacy;
    if (!(await applications.save(updated, current.version)))
      return reply.code(409).send({ error: "application_changed" });
    return { application: publicApplication(updated), webhookSecret: newSecret };
  });
  app.get("/admin/applications/:id/keys", options, async (request) => ({
    keys: await applications.keys(params.parse(request.params).id),
  }));
  app.post("/admin/applications/:id/keys", options, async (request, reply) => {
    const { id } = params.parse(request.params);
    if (!(await applications.find(id))) return reply.code(404).send({ error: "application_not_found" });
    const input = z
      .object({ name: z.string().trim().min(2).max(80), expiresAt: z.iso.datetime().nullable().default(null) })
      .strict()
      .parse(request.body);
    if (input.expiresAt && new Date(input.expiresAt).valueOf() <= Date.now())
      throw new DomainError("invalid_expiration", "Choose an expiration in the future");
    return reply
      .code(201)
      .send(
        await issueKey(applications, id, input.name, input.expiresAt ? new Date(input.expiresAt).toISOString() : null),
      );
  });
  app.delete("/admin/applications/:id/keys/:keyId", options, async (request, reply) => {
    const { id, keyId } = params.extend({ keyId: z.uuid() }).parse(request.params);
    if (!(await applications.revokeKey(id, keyId))) return reply.code(404).send({ error: "key_not_found" });
    return { revoked: true };
  });
  app.post("/admin/applications/:id/webhook-secret", options, async (request, reply) => {
    const current = await applications.find(params.parse(request.params).id);
    if (!current?.webhookUrl) return reply.code(404).send({ error: "webhook_not_configured" });
    const secret = randomBytes(32).toString("base64url");
    const updated = {
      ...current,
      webhookSecret: secret,
      version: current.version + 1,
      updatedAt: new Date().toISOString(),
    };
    if (!(await applications.save(updated, current.version)))
      return reply.code(409).send({ error: "application_changed" });
    return {
      secret,
      application: publicApplication(updated),
    };
  });
}
