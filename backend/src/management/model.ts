import { z } from "zod";
import { documentKinds, type Policy } from "../domain/types.js";

export const documentRulesSchema = z
  .object({
    mode: z.enum(["all", "optional", "exact"]),
    documents: z.array(z.enum(documentKinds)).min(1).max(documentKinds.length),
    requiredDocuments: z.array(z.enum(documentKinds)).default([]),
    count: z.number().int().min(1).max(documentKinds.length).optional(),
  })
  .strict()
  .superRefine((rules, ctx) => {
    if (
      new Set(rules.documents).size !== rules.documents.length ||
      new Set(rules.requiredDocuments).size !== rules.requiredDocuments.length
    )
      ctx.addIssue({ code: "custom", message: "Documents must be unique" });
    if (rules.requiredDocuments.some((kind) => !rules.documents.includes(kind)))
      ctx.addIssue({ code: "custom", message: "Mandatory documents must belong to the list" });
    if (
      rules.mode === "exact" &&
      (rules.count == null || rules.count > rules.documents.length || rules.count < rules.requiredDocuments.length)
    )
      ctx.addIssue({ code: "custom", message: "The exact count must include mandatory documents and fit the list" });
  });
export type DocumentRules = z.infer<typeof documentRulesSchema>;

const destinationUrl = z
  .string()
  .url()
  .max(2048)
  .refine(
    (url) => ["http:", "https:"].includes(new URL(url).protocol) && !new URL(url).username && !new URL(url).password,
    "Use an HTTP(S) URL without credentials",
  );
export const applicationInput = z
  .object({
    name: z.string().trim().min(2).max(100),
    enabled: z.boolean().default(true),
    rules: documentRulesSchema,
    webhookUrl: destinationUrl.nullable().default(null),
    returnUrl: destinationUrl.nullable().default(null),
    version: z.number().int().positive().optional(),
  })
  .strict();

export type ClientApplication = {
  id: string;
  name: string;
  enabled: boolean;
  version: number;
  rules: DocumentRules;
  webhookUrl: string | null;
  webhookSecret: string | null;
  returnUrl: string | null;
  createdAt: string;
  updatedAt: string;
  /** Imported credentials retain their existing destination identifiers. */
  legacy?: {
    allowedPolicies: string[];
    webhookDestinations: Array<{ id: string; url: string; secret: string }>;
    returnDestinations: Array<{ id: string; url: string }>;
  };
};
export type ApiKeyRecord = {
  id: string;
  applicationId: string;
  name: string;
  prefix: string;
  createdAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
  lastUsedAt: string | null;
};
export function policyForApplication(application: ClientApplication): Policy {
  const { rules } = application;
  const all = rules.mode === "all";
  const exact = rules.mode === "exact";
  if (exact && rules.count === undefined) throw new Error("Exact document rules require a count");
  const count = rules.count ?? rules.documents.length;
  return {
    id: `application:${application.id}`,
    label: application.name,
    version: application.version,
    selection: all ? "all" : exact ? "exact" : "minimum",
    allowedDocuments: [...rules.documents],
    requiredDocuments: all ? [...rules.documents] : [...rules.requiredDocuments],
    minimumDocuments: all ? rules.documents.length : exact ? count : Math.max(1, rules.requiredDocuments.length),
    maximumDocuments: exact ? count : rules.documents.length,
  };
}
export function publicApplication(application: ClientApplication) {
  const { webhookSecret, legacy, ...safe } = application;
  return { ...safe, webhookConfigured: Boolean(webhookSecret), imported: Boolean(legacy) };
}
