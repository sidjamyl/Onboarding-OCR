import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import { HttpOcrGateway } from "../adapters/ocr-http.js";
import { normalizeOcrFields } from "../domain/normalization.js";
import { DocumentQualityEngine } from "./engine.js";
import { loadQualityProfile, QualityProfileStore } from "./profile.js";
import { FileTemplateStore } from "./template-store.js";

const sampleSchema = z.object({
  id: z.string().min(1),
  image: z.string().min(1),
  documentKind: z.enum(["dz-id", "dz-driving-licence", "dz-passport"]),
  templateId: z.string().optional(),
  expected: z.enum(["accept", "reject"]),
  /** OCR response field names and ground truth; never printed by this command. */
  fields: z.record(z.string(), z.string()).optional(),
});
const manifestSchema = z.object({ cases: z.array(sampleSchema).min(1) });
type Sample = z.infer<typeof sampleSchema>;

type OcrResult = { correct: number; total: number; durationMs: number; error: boolean };
type CaseResult = {
  id: string;
  expected: Sample["expected"];
  passed: boolean;
  failedChecks: string[];
  qualityMs: number;
  ocrCopy: boolean;
  originalOcr?: OcrResult;
  preparedOcr?: OcrResult;
};

function responseFields(response: Record<string, unknown>): Record<string, string | null> {
  const fields =
    response.mergedFields ??
    response.merged_fields ??
    response.fields ??
    (response.result as Record<string, unknown> | undefined)?.fields;
  return fields && typeof fields === "object" && !Array.isArray(fields)
    ? normalizeOcrFields(fields as Record<string, unknown>)
    : {};
}

async function runOcr(gateway: HttpOcrGateway, sample: Sample, image: Buffer): Promise<OcrResult> {
  const started = performance.now();
  try {
    const response = await gateway.extractSingle(sample.documentKind, {
      name: "document",
      data: image,
      contentType: "image/jpeg",
    });
    const observed = responseFields(response);
    const expected = sample.fields ?? {};
    return {
      correct: Object.entries(expected).filter(([key, value]) => observed[key] === value.trim()).length,
      total: Object.keys(expected).length,
      durationMs: Math.round(performance.now() - started),
      error: false,
    };
  } catch {
    return {
      correct: 0,
      total: Object.keys(sample.fields ?? {}).length,
      durationMs: Math.round(performance.now() - started),
      error: true,
    };
  }
}

export function summarizeBenchmark(results: CaseResult[]) {
  const bad = results.filter((result) => result.expected === "reject");
  const good = results.filter((result) => result.expected === "accept");
  const ocr = (variant: "originalOcr" | "preparedOcr") => {
    const tested = results.flatMap((result) => (result[variant] ? [result[variant]] : []));
    return {
      documents: tested.length,
      errors: tested.filter((item) => item.error).length,
      correctFields: tested.reduce((sum, item) => sum + item.correct, 0),
      labeledFields: tested.reduce((sum, item) => sum + item.total, 0),
      meanMs: tested.length ? Math.round(tested.reduce((sum, item) => sum + item.durationMs, 0) / tested.length) : null,
    };
  };
  return {
    total: results.length,
    badAccepted: bad.filter((result) => result.passed).length,
    badTotal: bad.length,
    goodRejected: good.filter((result) => !result.passed).length,
    goodTotal: good.length,
    meanQualityMs: results.length
      ? Math.round(results.reduce((sum, item) => sum + item.qualityMs, 0) / results.length)
      : 0,
    originalOcr: ocr("originalOcr"),
    preparedOcr: ocr("preparedOcr"),
  };
}

async function main() {
  const manifestPath = process.argv[2];
  if (!manifestPath) throw new Error("Usage: npm run benchmark -- <manifest.json>");
  const absoluteManifest = resolve(manifestPath);
  const manifest = manifestSchema.parse(JSON.parse(await readFile(absoluteManifest, "utf8")));
  const unique = new Set(manifest.cases.map((sample) => sample.id));
  if (unique.size !== manifest.cases.length) throw new Error("Benchmark case IDs must be unique");

  const profile = loadQualityProfile(process.env.QUALITY_PROFILE_JSON, "enforce");
  const templates = new FileTemplateStore(resolve(process.env.QUALITY_TEMPLATE_DIR ?? "quality-templates"));
  const engine = new DocumentQualityEngine(templates, new QualityProfileStore(profile));
  const gateway =
    process.env.OCR_BASE_URL && process.env.OCR_BASIC_USERNAME && process.env.OCR_BASIC_PASSWORD
      ? new HttpOcrGateway({
          baseUrl: process.env.OCR_BASE_URL.replace(/\/+$/, ""),
          username: process.env.OCR_BASIC_USERNAME,
          password: process.env.OCR_BASIC_PASSWORD,
          timeoutMs: Number(process.env.OCR_TIMEOUT_MS ?? 200_000),
        })
      : undefined;

  const results: CaseResult[] = [];
  for (const sample of manifest.cases) {
    const image = await readFile(resolve(dirname(absoluteManifest), sample.image));
    const { report, ocrImage } = await engine.assess(image, {
      documentKind: sample.documentKind,
      ...(sample.templateId ? { templateId: sample.templateId } : {}),
    });
    const result: CaseResult = {
      id: sample.id,
      expected: sample.expected,
      passed: report.passed,
      failedChecks: report.checks.filter((check) => check.status === "fail").map((check) => check.key),
      qualityMs: report.durationMs,
      ocrCopy: Boolean(ocrImage),
    };
    if (gateway && sample.expected === "accept" && report.passed && ocrImage && sample.fields) {
      result.originalOcr = await runOcr(gateway, sample, image);
      result.preparedOcr = await runOcr(gateway, sample, ocrImage.image);
    }
    results.push(result);
  }
  // No image bytes, OCR response, or labeled personal data are emitted.
  process.stdout.write(`${JSON.stringify({ cases: results, summary: summarizeBenchmark(results) }, null, 2)}\n`);
  if (results.some((result) => result.passed !== (result.expected === "accept"))) process.exitCode = 1;
}

if (process.argv[1] && /(?:^|[\\/])benchmark\.(?:js|ts)$/.test(process.argv[1]))
  main().catch((error: unknown) => {
    process.stderr.write(`${String(error)}\n`);
    process.exitCode = 2;
  });
