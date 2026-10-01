import { z } from "zod";

export const createSessionInput = z.object({
  clientReference: z.string().min(1).max(120),
  policyId: z.string().min(1).optional(),
  locale: z.enum(["fr", "ar", "en"]).default("fr"),
  webhookDestinationId: z.string().min(1).optional(),
  returnDestinationId: z.string().min(1).optional(),
});

export const documentSelectionInput = z.object({
  documents: z
    .array(z.enum(["dz-id", "dz-driving-licence", "dz-passport"]))
    .min(1)
    .max(3),
});

const sessionStatus = {
  type: "string",
  enum: [
    "created",
    "capturing",
    "processing",
    "awaiting_confirmation",
    "awaiting_submission",
    "succeeded",
    "document_failed",
    "consistency_failed",
    "technical_failed",
    "expired",
  ],
} as const;

const errorResponse = {
  type: "object",
  required: ["error"],
  properties: { error: { type: "string" }, detail: { type: "string" } },
} as const;

export const createSessionRouteSchema = {
  summary: "Create an idempotent onboarding session",
  security: [{ ApiKeyAuth: [] }],
  headers: {
    type: "object",
    required: ["x-api-key", "idempotency-key"],
    properties: {
      "x-api-key": { type: "string", minLength: 1 },
      "idempotency-key": { type: "string", minLength: 8 },
    },
  },
  body: z.toJSONSchema(createSessionInput, { target: "draft-7" }),
  response: {
    201: {
      type: "object",
      required: ["sessionId", "status", "accessUrl", "expiresAt"],
      properties: {
        sessionId: { type: "string", format: "uuid" },
        status: sessionStatus,
        accessUrl: { type: "string", format: "uri" },
        expiresAt: { type: "string", format: "date-time" },
      },
    },
    400: errorResponse,
    401: errorResponse,
    403: errorResponse,
  },
} as const;

const authenticatedSessionRoute = {
  headers: {
    type: "object",
    required: ["x-api-key"],
    properties: { "x-api-key": { type: "string", minLength: 1 } },
  },
  params: {
    type: "object",
    required: ["id"],
    properties: { id: { type: "string", format: "uuid" } },
  },
} as const;

export const sessionStatusRouteSchema = {
  ...authenticatedSessionRoute,
  summary: "Read the current onboarding status",
  security: [{ ApiKeyAuth: [] }],
  response: {
    200: {
      type: "object",
      required: ["sessionId", "clientReference", "status", "reasonCode", "updatedAt"],
      properties: {
        sessionId: { type: "string", format: "uuid" },
        clientReference: { type: "string" },
        status: sessionStatus,
        reasonCode: { anyOf: [{ type: "string" }, { type: "null" }] },
        updatedAt: { type: "string", format: "date-time" },
      },
    },
    401: errorResponse,
    404: errorResponse,
  },
} as const;

export const sessionResultRouteSchema = {
  ...authenticatedSessionRoute,
  summary: "Read the final OCR result and consistency decision",
  security: [{ ApiKeyAuth: [] }],
  response: {
    200: {
      type: "object",
      required: [
        "sessionId",
        "clientReference",
        "status",
        "policy",
        "reasonCode",
        "result",
        "documents",
        "consistency",
      ],
      additionalProperties: true,
      properties: {
        sessionId: { type: "string", format: "uuid" },
        clientReference: { type: "string" },
        status: sessionStatus,
        policy: {
          type: "object",
          required: ["id", "version"],
          properties: { id: { type: "string" }, version: { type: "integer" } },
        },
        reasonCode: { anyOf: [{ type: "string" }, { type: "null" }] },
        result: { anyOf: [{ type: "object", additionalProperties: true }, { type: "null" }] },
        documents: { type: "object", additionalProperties: true },
        consistency: {
          type: "object",
          required: ["nin", "dateOfBirth"],
          additionalProperties: true,
          properties: {
            nin: { type: "string", enum: ["matched", "mismatched", "unknown"] },
            dateOfBirth: { type: "string", enum: ["matched", "mismatched", "unknown"] },
          },
        },
      },
    },
    401: errorResponse,
    404: errorResponse,
    409: {
      type: "object",
      required: ["error", "status", "reasonCode"],
      properties: {
        error: { type: "string" },
        status: sessionStatus,
        reasonCode: { anyOf: [{ type: "string" }, { type: "null" }] },
      },
    },
  },
} as const;
