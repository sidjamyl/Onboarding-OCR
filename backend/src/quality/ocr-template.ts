import { z } from "zod";
import type { OrbTemplate } from "./types.js";

// OCR/src/core/extraction/profiled/template.ts is the source contract for exports from
// template-ocr-lab. Keep its ORB descriptors and per-template parameters unchanged.
const region = z.object({
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  width: z.number().positive().max(1),
  height: z.number().positive().max(1),
});
const exportedTemplate = z
  .object({
    formatVersion: z.literal(1),
    id: z.string().regex(/^[a-z0-9][a-z0-9-]{1,100}$/i),
    document: z.string().min(1),
    variant: z.string().default("default"),
    version: z.number().int().positive(),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    zones: z.array(
      region.extend({
        id: z.string().min(1),
        field: z.string().min(1),
        role: z.enum(["required", "optional"]),
        content: z.enum(["arabic", "latin", "numeric", "date", "mixed"]),
      }),
    ),
    ignoredRegions: z.array(region).default([]),
    orb: z.object({
      keypoints: z.array(z.object({ x: z.number().finite(), y: z.number().finite() })),
      descriptors: z.array(z.number().int().min(0).max(255)),
      rows: z.number().int().nonnegative(),
      cols: z.number().int().nonnegative(),
      parameters: z.object({
        ratioThreshold: z.number().min(0.1).max(0.99),
        minimumGoodMatches: z.number().int().min(4).max(1_000),
        minimumInlierRatio: z.number().min(0).max(1),
        ransacThreshold: z.number().positive().max(50),
      }),
    }),
  })
  .superRefine((template, context) => {
    if (
      [...template.zones, ...template.ignoredRegions].some(
        (region) => region.x + region.width > 1 || region.y + region.height > 1,
      )
    )
      context.addIssue({ code: "custom", message: "Template region exceeds document bounds" });
    if (
      template.orb.keypoints.length !== template.orb.rows ||
      template.orb.descriptors.length !== template.orb.rows * template.orb.cols
    )
      context.addIssue({ code: "custom", message: "ORB descriptor dimensions do not match" });
  });

export function fromOcrTemplate(input: unknown, timestamp: string): OrbTemplate {
  const source = exportedTemplate.parse(input);
  const documentKind = source.document.replace(/-(front|back|single)$/, "");
  return {
    id: source.id,
    name: `${source.document} · ${source.variant}`,
    documentKind,
    version: source.version,
    width: source.width,
    height: source.height,
    // OCR exports carry descriptors and geometry, not the reference photo.
    image: { fileName: `${source.id}.png`, mimeType: "image/png" },
    zones: source.zones.map((zone) => ({ ...zone, label: zone.field })),
    ignoredRegions: source.ignoredRegions,
    orb: {
      keypoints: source.orb.keypoints,
      descriptors: source.orb.descriptors,
      rows: source.orb.rows,
      cols: source.orb.cols,
    },
    parameters: source.orb.parameters,
    useWolfBinarization: false,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}
