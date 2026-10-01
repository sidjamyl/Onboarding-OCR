import { z } from "zod";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { checkKeys, defaultQualityProfile, type QualityProfile } from "./core/quality-core.js";

export { defaultQualityProfile, type QualityProfile };

const severity = z.enum(["block", "warn", "off"]);

const captureSchema = z.object({
  samplingIntervalMs: z.number().int().min(60).max(5_000),
  analysisSize: z.number().int().min(480).max(2_560),
  stableFrames: z.number().int().min(1).max(20),
  maxCornerMotion: z.number().min(0.001).max(0.2),
  burstFrames: z.number().int().min(1).max(8),
  autoCapture: z.boolean(),
  stillCapture: z.boolean(),
  idealVideoWidth: z.number().int().min(640).max(8_000),
  jpegQuality: z.number().min(0.5).max(1),
});

const documentSchema = z
  .object({
    minFill: z.number().min(0).max(1),
    maxFill: z.number().min(0).max(1),
    edgeMargin: z.number().min(0).max(0.3),
    aspectTolerance: z.number().min(0).max(1),
    maxAngleDeviation: z.number().min(0).max(45),
    maxSideRatio: z.number().min(1).max(3),
    minDpi: z.number().min(50).max(1_200),
  })
  .refine((value) => value.minFill < value.maxFill, { message: "Minimum coverage must be lower than maximum" });

const imageSchema = z
  .object({
    minSharpness: z.number().min(0).max(100_000),
    minSharpnessLive: z.number().min(0).max(100_000),
    minMotionIsotropy: z.number().min(0).max(1),
    minFocusUniformity: z.number().min(0).max(1),
    exposureMin: z.number().min(0).max(254),
    exposureMax: z.number().min(1).max(255),
    maxHighlightClip: z.number().min(0).max(1),
    maxShadowClip: z.number().min(0).max(1),
    minContrast: z.number().min(0).max(1),
    maxGlareRatio: z.number().min(0).max(1),
    maxGlareBlob: z.number().min(0).max(1),
    minColorGlareValue: z.number().int().min(0).max(255).default(defaultQualityProfile.image.minColorGlareValue),
    minColorGlareSaturation: z.number().min(0).max(1).default(defaultQualityProfile.image.minColorGlareSaturation),
    maxColorGlareRatio: z.number().min(0).max(1).default(defaultQualityProfile.image.maxColorGlareRatio),
    minIllumination: z.number().min(0).max(1),
    maxNoise: z.number().min(0).max(100),
  })
  .refine((value) => value.exposureMin < value.exposureMax, {
    message: "Exposure minimum must be lower than its maximum",
  });

const preprocessSchema = z.object({
  enabled: z.boolean(),
  targetDpi: z.number().int().min(150).max(800),
  marginRatio: z.number().min(0).max(0.1),
  illuminationStrength: z.number().min(0).max(1),
  whiteBalance: z.boolean(),
  claheClipLimit: z.number().min(0).max(8),
  claheTileGrid: z.number().int().min(2).max(32),
  denoiseAboveNoise: z.number().min(0).max(100),
  sharpenAmount: z.number().min(0).max(3),
  sharpenSigma: z.number().min(0.3).max(5),
  jpegQuality: z.number().int().min(60).max(100),
});

const orbSchema = z
  .object({
    ratioThreshold: z.number().min(0.1).max(0.99),
    minimumGoodMatches: z.number().int().min(4).max(500),
    minimumInlierRatio: z.number().min(0).max(1),
    ransacThreshold: z.number().min(0.1).max(50),
    minSpatialCoverage: z.number().min(0).max(1),
    maxReprojectionError: z.number().min(0.1).max(100),
    projectionMinAreaRatio: z.number().min(0.01).max(10),
    projectionMaxAreaRatio: z.number().min(0.01).max(10),
    projectionMarginRatio: z.number().min(0).max(2),
  })
  .refine((value) => value.projectionMinAreaRatio < value.projectionMaxAreaRatio, {
    message: "Projection minimum area ratio must be lower than its maximum",
  });

export const qualityProfileSchema = z.object({
  version: z.literal(2),
  mode: z.enum(["off", "observe", "enforce"]),
  capture: captureSchema,
  document: documentSchema,
  image: imageSchema,
  severity: z.object(
    Object.fromEntries(
      checkKeys.map((key) => [
        key,
        key === "color_glare" ? severity.default(defaultQualityProfile.severity.color_glare) : severity,
      ]),
    ) as Record<(typeof checkKeys)[number], typeof severity>,
  ),
  preprocess: preprocessSchema,
  orb: orbSchema,
});

// Compile-time guard: the zod schema and the shared core type must describe the same profile.
type SchemaProfile = z.infer<typeof qualityProfileSchema>;
const _sameShape: [SchemaProfile, QualityProfile] = [defaultQualityProfile, defaultQualityProfile as SchemaProfile];
void _sameShape;

/**
 * Parses a profile. Version 1 profiles (whole-frame metrics) cannot be translated meaningfully,
 * so only their mode and ORB settings are kept on top of the version 2 defaults.
 */
export function parseQualityProfile(input: unknown): QualityProfile {
  if (input && typeof input === "object" && (input as { version?: unknown }).version === 1) {
    const legacy = input as { mode?: QualityProfile["mode"]; orb?: QualityProfile["orb"] };
    return qualityProfileSchema.parse({
      ...structuredClone(defaultQualityProfile),
      ...(legacy.mode ? { mode: legacy.mode } : {}),
      ...(legacy.orb ? { orb: legacy.orb } : {}),
    });
  }
  return qualityProfileSchema.parse(input);
}

export interface QualityProfileSource {
  current(): QualityProfile;
}

export class QualityProfileStore implements QualityProfileSource {
  private profile: QualityProfile;

  constructor(
    initial: unknown = defaultQualityProfile,
    private readonly filePath?: string,
  ) {
    this.profile = parseQualityProfile(initial);
  }

  static async open(initial: unknown, filePath: string): Promise<QualityProfileStore> {
    let saved: unknown = initial;
    try {
      saved = JSON.parse(await readFile(filePath, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return new QualityProfileStore(saved, filePath);
  }

  current(): QualityProfile {
    return structuredClone(this.profile);
  }

  replace(next: unknown): QualityProfile {
    this.profile = parseQualityProfile(next);
    return this.current();
  }

  async save(next: unknown): Promise<QualityProfile> {
    const parsed = parseQualityProfile(next);
    if (this.filePath) {
      await mkdir(dirname(this.filePath), { recursive: true });
      const temporaryPath = `${this.filePath}.${randomUUID()}.tmp`;
      await writeFile(temporaryPath, `${JSON.stringify(parsed, null, 2)}\n`);
      await rename(temporaryPath, this.filePath);
    }
    this.profile = parsed;
    return this.current();
  }
}

export function loadQualityProfile(serialized: string | undefined, mode: QualityProfile["mode"]): QualityProfile {
  const input = serialized ? JSON.parse(serialized) : defaultQualityProfile;
  return { ...parseQualityProfile(input), mode };
}
