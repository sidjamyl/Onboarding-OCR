import { cv, ImageProcessor } from "ppu-ocv";
import sharp from "sharp";
import type { QualityCheck, QualityReport } from "../domain/types.js";
import type { QualityAssessment, QualityEngine } from "../ports.js";
import {
  analyzeFrame,
  measureImage,
  type CaptureHint,
  formatForDocument,
  round,
  type OpenCv,
  type Quad,
} from "./core/quality-core.js";
import { prepareForOcr } from "./preprocess.js";
import {
  defaultQualityProfile,
  type QualityProfile,
  type QualityProfileSource,
  QualityProfileStore,
} from "./profile.js";
import type { FileTemplateStore } from "./template-store.js";
import type { NormalizedRegion, OrbTemplate } from "./types.js";

const hintMessages: Record<CaptureHint, string> = {
  find_document: "Place the document on a plain, contrasting surface",
  show_whole_document: "Keep every edge and corner inside the frame",
  move_closer: "Move closer so the document fills the frame",
  move_back: "Move back slightly so the whole document is visible",
  wrong_document: "Show the expected document, flat and unfolded",
  hold_parallel: "Hold the phone parallel to the document",
  hold_still: "Hold the phone still",
  focus: "Hold still and let the camera focus",
  more_light: "Move to a brighter place",
  less_light: "Reduce the light or avoid direct sunlight",
  avoid_glare: "Tilt the document slightly to remove reflections",
  even_light: "Move the document into even light, without shadows",
  ready: "Capture is ready",
};

export class DocumentQualityEngine implements QualityEngine {
  constructor(
    private readonly templates?: FileTemplateStore,
    private readonly profiles: QualityProfileSource = new QualityProfileStore(defaultQualityProfile),
  ) {}

  async analyze(image: Buffer, templateId?: string): Promise<QualityReport> {
    return (await this.assess(image, { ...(templateId ? { templateId } : {}), prepare: false })).report;
  }

  /**
   * Authoritative check of the final photo, with the same detector and thresholds as the phone,
   * plus the OCR copy when the document was located and preprocessing is enabled.
   */
  async assess(
    image: Buffer,
    options: { templateId?: string; documentKind?: string; prepare?: boolean; previewAlignment?: boolean } = {},
  ): Promise<QualityAssessment> {
    const started = performance.now();
    const profile = this.profiles.current();
    const { mode, orb } = profile;
    const decoded = await sharp(image, { failOn: "error" })
      .rotate()
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const { width, height } = decoded.info;
    await ImageProcessor.initRuntime();
    const source = cv.matFromArray(height, width, cv.CV_8UC4, decoded.data);
    let analysisRectified: OpenCv | undefined;
    try {
      const format = formatForDocument(options.documentKind ?? options.templateId);
      let selectedTemplate: OrbTemplate | undefined;
      let selectedAlignment: Awaited<ReturnType<typeof alignWithTemplate>> | undefined;
      // The OCR gateway aligns an already localized document, not the table and hands around it.
      // Keep the same ordering here: contour rectification first, ORB on the document second.
      const contourAnalysis = analyzeFrame(cv, source, { profile, format, context: "capture" });
      analysisRectified = contourAnalysis.rectified;
      const candidates =
        mode !== "off" && options.templateId && this.templates
          ? await this.templates.findVariants(options.templateId)
          : [];
      if (candidates.length) {
        const orbSource = contourAnalysis.rectified ?? source;
        const captureFeatures = await extractOrb(
          Buffer.from(orbSource.data as Uint8Array),
          orbSource.cols,
          orbSource.rows,
          [],
        );
        const ranked = await Promise.all(
          candidates.map(async (template) => ({
            template,
            alignment: await alignWithTemplate(captureFeatures, orbSource.cols, orbSource.rows, template, orb),
          })),
        );
        ranked.sort(
          (a, b) =>
            Number(b.alignment.matched) - Number(a.alignment.matched) ||
            b.alignment.inlierRatio - a.alignment.inlierRatio ||
            a.alignment.reprojectionError - b.alignment.reprojectionError,
        );
        selectedTemplate = ranked[0]?.template;
        selectedAlignment = ranked[0]?.alignment;
      }
      const localOrbQuad =
        selectedAlignment && "quad" in selectedAlignment && selectedAlignment.matched
          ? selectedAlignment.quad
          : undefined;
      const orbQuad =
        localOrbQuad && contourAnalysis.rectified && contourAnalysis.quad
          ? mapRectifiedQuadToSource(
              localOrbQuad,
              contourAnalysis.rectified.cols,
              contourAnalysis.rectified.rows,
              contourAnalysis.quad,
            )
          : localOrbQuad;
      const analysis = orbQuad
        ? analyzeFrame(cv, source, { profile, format, context: "capture", quad: orbQuad })
        : contourAnalysis;
      if (analysis !== contourAnalysis) {
        analysisRectified?.delete();
        analysisRectified = analysis.rectified;
      }
      const checks: QualityCheck[] =
        mode === "off"
          ? []
          : analysis.evaluation.checks.map((check) => ({
              key: check.key,
              passed: check.passed,
              status: check.status,
              value: check.value,
              threshold: check.threshold,
              message: hintMessages[check.hint],
              hint: check.hint,
              durationMs: analysis.durationMs.total,
            }));

      const templateMatched = Boolean(selectedAlignment?.matched);
      const homography =
        selectedAlignment && "homography" in selectedAlignment && selectedAlignment.matched
          ? selectedAlignment.homography
          : undefined;
      const selectedTemplateId = selectedTemplate?.id ?? options.templateId;
      if (mode !== "off" && options.templateId && this.templates) {
        if (selectedAlignment) {
          const alignment = selectedAlignment;
          const coverageOk = alignment.spatialCoverage >= orb.minSpatialCoverage;
          const reprojectionOk = alignment.reprojectionError <= orb.maxReprojectionError;
          checks.push(
            timedCheck(
              "template_alignment",
              alignment.matched,
              alignment.inlierRatio,
              selectedTemplate?.parameters.minimumInlierRatio ?? orb.minimumInlierRatio,
              "Show the expected side of the document",
              alignment.durationMs,
              alignment.matched ? "pass" : "fail",
            ),
            timedCheck(
              "orb_spatial_coverage",
              coverageOk,
              alignment.spatialCoverage,
              orb.minSpatialCoverage,
              "Move closer and keep the full document visible",
              alignment.durationMs,
              coverageOk ? "pass" : "fail",
            ),
            timedCheck(
              "orb_reprojection",
              reprojectionOk,
              alignment.reprojectionError,
              orb.maxReprojectionError,
              "Hold the phone parallel to the document",
              alignment.durationMs,
              reprojectionOk ? "pass" : "fail",
            ),
            timedCheck(
              "orb_geometry",
              alignment.geometryPlausible,
              String(alignment.geometryPlausible),
              "true",
              "Show the expected document without folding it",
              alignment.durationMs,
              alignment.geometryPlausible ? "pass" : "fail",
            ),
          );
        } else
          checks.push(
            timedCheck(
              "template_alignment",
              false,
              "missing_variant",
              "valid template",
              "No template configured; geometric checks were used",
              0,
              "not_applicable",
            ),
          );
      }

      // Required zones are checked after ORB rectification. A valid homography alone cannot
      // prove that small digits or an MRZ survived focus loss or a local reflection.
      if (mode !== "off" && selectedTemplate && templateMatched && analysis.rectified) {
        for (const zone of selectedTemplate.zones) {
          if (zone.role !== "required") continue;
          const rectified = analysis.rectified;
          const x = Math.max(0, Math.floor(zone.x * rectified.cols));
          const y = Math.max(0, Math.floor(zone.y * rectified.rows));
          const w = Math.min(rectified.cols - x, Math.ceil(zone.width * rectified.cols));
          const h = Math.min(rectified.rows - y, Math.ceil(zone.height * rectified.rows));
          if (w < 8 || h < 8) {
            checks.push(
              timedCheck(
                `zone:${zone.id}:visible`,
                false,
                "missing",
                "visible",
                `${zone.label}: show the whole document`,
                0,
              ),
            );
            continue;
          }
          const roi = rectified.roi(new cv.Rect(x, y, w, h));
          try {
            const contiguous = roi.clone();
            let local: ReturnType<typeof measureImage>;
            try {
              local = measureImage(contiguous.data as Uint8Array, w, h, profile.image);
            } finally {
              contiguous.delete();
            }
            checks.push(
              timedCheck(
                `zone:${zone.id}:sharpness`,
                local.sharpness >= profile.image.minSharpness,
                round(local.sharpness),
                profile.image.minSharpness,
                `${zone.label}: focus and retake`,
                0,
              ),
              timedCheck(
                `zone:${zone.id}:glare`,
                local.glareRatio <= profile.image.maxGlareRatio && local.glareBlob <= profile.image.maxGlareBlob,
                round(local.glareRatio, 4),
                profile.image.maxGlareRatio,
                `${zone.label}: remove reflection`,
                0,
              ),
              timedCheck(
                `zone:${zone.id}:exposure`,
                local.paper >= profile.image.exposureMin && local.paper <= profile.image.exposureMax,
                local.paper,
                `${profile.image.exposureMin}–${profile.image.exposureMax}`,
                `${zone.label}: improve lighting`,
                0,
              ),
            );
          } finally {
            roi.delete();
          }
        }
      }

      const rejected = checks.some((check) => check.status === "fail");
      const shouldPrepare =
        (options.prepare ?? true) && profile.preprocess.enabled && Boolean(analysis.quad) && !rejected;
      const ocrImage =
        shouldPrepare && analysis.quad
          ? await prepareForOcr(source, analysis.quad, format, profile.preprocess, analysis.metrics.image?.noise ?? 0)
          : undefined;
      const alignmentImage =
        options.previewAlignment && templateMatched && analysis.rectified
          ? {
              image: await sharp(Buffer.from(analysis.rectified.data as Uint8Array), {
                raw: { width: analysis.rectified.cols, height: analysis.rectified.rows, channels: 4 },
              })
                .jpeg({ quality: 90 })
                .toBuffer(),
              width: analysis.rectified.cols,
              height: analysis.rectified.rows,
            }
          : undefined;

      const report: QualityReport = {
        passed: mode !== "enforce" || !rejected,
        mode,
        checks,
        templateMatched,
        ...(selectedTemplateId ? { templateId: selectedTemplateId } : {}),
        ...(homography ? { homography } : {}),
        hint:
          checks.find((check) => check.status === "fail")?.hint ??
          (templateMatched
            ? analysis.evaluation.hint
            : selectedAlignment
              ? "wrong_document"
              : analysis.evaluation.hint),
        score: analysis.evaluation.score,
        diagnostics: {
          metrics: flattenMetrics(analysis.metrics),
          ...(analysis.quad
            ? {
                geometry: {
                  corners: analysis.quad.map((p) => ({ x: p.x / width, y: p.y / height })),
                  coverage: analysis.metrics.geometry?.fill ?? 0,
                  ...(analysis.metrics.geometry
                    ? { dpi: analysis.metrics.geometry.dpi, angleDeviation: analysis.metrics.geometry.angleDeviation }
                    : {}),
                  method: orbQuad ? "orb" : "contour",
                },
              }
            : {}),
          photo: { width, height },
          ...(selectedTemplateId ? { selectedTemplateId } : {}),
        },
        durationMs: 0,
      };
      report.durationMs = round(performance.now() - started);
      return { report, ...(ocrImage ? { ocrImage } : {}), ...(alignmentImage ? { alignmentImage } : {}) };
    } finally {
      // The shared core returns a native matrix for inspection; it is owned by this call.
      analysisRectified?.delete();
      source.delete();
    }
  }

  async createTemplate(input: {
    id: string;
    name: string;
    documentKind: string;
    image: Buffer;
    mimeType: OrbTemplate["image"]["mimeType"];
    zones: OrbTemplate["zones"];
    ignoredRegions: NormalizedRegion[];
    useWolfBinarization?: boolean;
  }): Promise<OrbTemplate> {
    const decoded = await sharp(input.image).rotate().ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const features = await extractOrb(decoded.data, decoded.info.width, decoded.info.height, input.ignoredRegions);
    const orb = this.profiles.current().orb;
    const now = new Date().toISOString();
    const template: OrbTemplate = {
      id: input.id,
      name: input.name,
      documentKind: input.documentKind,
      version: 1,
      width: decoded.info.width,
      height: decoded.info.height,
      image: {
        fileName: `${input.id}.${input.mimeType === "image/png" ? "png" : "jpg"}`,
        mimeType: input.mimeType,
      },
      zones: input.zones,
      ignoredRegions: input.ignoredRegions,
      orb: features,
      parameters: {
        ratioThreshold: orb.ratioThreshold,
        minimumGoodMatches: orb.minimumGoodMatches,
        minimumInlierRatio: orb.minimumInlierRatio,
        ransacThreshold: orb.ransacThreshold,
      },
      useWolfBinarization: input.useWolfBinarization ?? false,
      createdAt: now,
      updatedAt: now,
    };
    await this.templates?.putImage(template, input.image);
    await this.templates?.put(template);
    return template;
  }

  async updateTemplate(input: {
    id: string;
    name: string;
    zones: OrbTemplate["zones"];
    ignoredRegions: NormalizedRegion[];
    useWolfBinarization?: boolean;
  }): Promise<OrbTemplate | null> {
    const current = await this.templates?.get(input.id);
    const image = await this.templates?.getImage(input.id);
    if (!current || !image) return null;
    const decoded = await sharp(image.data).rotate().ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const features = await extractOrb(decoded.data, decoded.info.width, decoded.info.height, input.ignoredRegions);
    const orb = this.profiles.current().orb;
    const updated: OrbTemplate = {
      ...current,
      name: input.name,
      version: current.version + 1,
      zones: input.zones,
      ignoredRegions: input.ignoredRegions,
      orb: features,
      parameters: {
        ratioThreshold: orb.ratioThreshold,
        minimumGoodMatches: orb.minimumGoodMatches,
        minimumInlierRatio: orb.minimumInlierRatio,
        ransacThreshold: orb.ransacThreshold,
      },
      useWolfBinarization: input.useWolfBinarization ?? false,
      updatedAt: new Date().toISOString(),
    };
    await this.templates?.put(updated);
    return updated;
  }
}

async function extractOrb(rgba: Buffer, width: number, height: number, ignored: NormalizedRegion[]) {
  await ImageProcessor.initRuntime();
  const source = cv.matFromArray(height, width, cv.CV_8UC4, rgba);
  const gray = new cv.Mat();
  const mask = new cv.Mat(height, width, cv.CV_8UC1, new cv.Scalar(255));
  const keypoints = new cv.KeyPointVector();
  const descriptors = new cv.Mat();
  const orb = new cv.ORB(3000, 1.2, 8, 31, 0, 2, cv.ORB_HARRIS_SCORE, 31, 20);
  try {
    cv.cvtColor(source, gray, cv.COLOR_RGBA2GRAY);
    for (const region of ignored) {
      const p1 = new cv.Point(Math.floor(region.x * width), Math.floor(region.y * height));
      const p2 = new cv.Point(
        Math.ceil((region.x + region.width) * width),
        Math.ceil((region.y + region.height) * height),
      );
      cv.rectangle(mask, p1, p2, new cv.Scalar(0), -1);
    }
    orb.detectAndCompute(gray, mask, keypoints, descriptors);
    return {
      keypoints: Array.from({ length: keypoints.size() }, (_, index) => {
        const point = keypoints.get(index).pt;
        return { x: point.x, y: point.y };
      }),
      descriptors: Array.from(descriptors.data as Uint8Array),
      rows: descriptors.rows,
      cols: descriptors.cols,
    };
  } finally {
    source.delete();
    gray.delete();
    mask.delete();
    keypoints.delete();
    descriptors.delete();
    orb.delete();
  }
}

async function alignWithTemplate(
  features: Awaited<ReturnType<typeof extractOrb>>,
  width: number,
  height: number,
  template: OrbTemplate,
  settings: QualityProfile["orb"],
) {
  const started = performance.now();
  // Match the OCR gateway's ORB worker: the exported template owns Lowe, match and
  // RANSAC parameters; capture-specific geometry limits remain in the quality profile.
  const parameters = template.parameters;
  if (!features.rows || !template.orb.rows)
    return {
      matched: false,
      inlierRatio: 0,
      spatialCoverage: 0,
      reprojectionError: Number.POSITIVE_INFINITY,
      geometryPlausible: false,
      durationMs: round(performance.now() - started),
    };
  const queryDescriptors = cv.matFromArray(features.rows, features.cols, cv.CV_8U, features.descriptors);
  const templateDescriptors = cv.matFromArray(template.orb.rows, template.orb.cols, cv.CV_8U, template.orb.descriptors);
  const matcher = new cv.BFMatcher(cv.NORM_HAMMING, false);
  const matches = new cv.DMatchVectorVector();
  const sourcePoints: number[] = [];
  const destinationPoints: number[] = [];
  try {
    matcher.knnMatch(queryDescriptors, templateDescriptors, matches, 2);
    let goodMatches = 0;
    for (let index = 0; index < matches.size(); index += 1) {
      const neighbors = matches.get(index);
      if (neighbors.size() >= 2) {
        const best = neighbors.get(0);
        const second = neighbors.get(1);
        if (best.distance < parameters.ratioThreshold * second.distance) {
          const query = features.keypoints[best.queryIdx];
          const target = template.orb.keypoints[best.trainIdx];
          if (query && target) {
            sourcePoints.push(query.x, query.y);
            destinationPoints.push(target.x, target.y);
            goodMatches += 1;
          }
        }
      }
      neighbors.delete();
    }
    if (goodMatches < parameters.minimumGoodMatches) {
      return {
        matched: false,
        inlierRatio: 0,
        spatialCoverage: 0,
        reprojectionError: Number.POSITIVE_INFINITY,
        geometryPlausible: false,
        durationMs: round(performance.now() - started),
      };
    }
    const source = cv.matFromArray(goodMatches, 1, cv.CV_32FC2, sourcePoints);
    const destination = cv.matFromArray(goodMatches, 1, cv.CV_32FC2, destinationPoints);
    const inlierMask = new cv.Mat();
    const matrix = cv.findHomography(source, destination, cv.RANSAC, parameters.ransacThreshold, inlierMask);
    try {
      if (matrix.rows !== 3 || matrix.cols !== 3)
        return {
          matched: false,
          inlierRatio: 0,
          spatialCoverage: 0,
          reprojectionError: Number.POSITIVE_INFINITY,
          geometryPlausible: false,
          durationMs: round(performance.now() - started),
        };
      const inliers = Array.from(inlierMask.data as Uint8Array).filter(Boolean).length;
      const inlierRatio = inliers / goodMatches;
      const homography = Array.from(matrix.data64F as Float64Array);
      const inlierIndexes = Array.from(inlierMask.data as Uint8Array).flatMap((flag, index) => (flag ? [index] : []));
      const inlierSource = inlierIndexes.map((index) => ({
        x: sample(sourcePoints, index * 2),
        y: sample(sourcePoints, index * 2 + 1),
      }));
      const spatialCoverage = pointCoverage(inlierSource, width, height);
      const reprojectionError = meanReprojectionError(homography, sourcePoints, destinationPoints, inlierIndexes);
      const geometryPlausible = plausibleProjection(
        homography,
        width,
        height,
        template.width,
        template.height,
        settings,
      );
      const quad = invertHomography(homography)
        ? projectedDocumentCorners(homography, template.width, template.height)
        : undefined;
      return {
        matched:
          matrix.rows === 3 &&
          inlierRatio >= parameters.minimumInlierRatio &&
          spatialCoverage >= settings.minSpatialCoverage &&
          reprojectionError <= settings.maxReprojectionError &&
          geometryPlausible,
        inlierRatio: round(inlierRatio, 4),
        spatialCoverage: round(spatialCoverage, 4),
        reprojectionError: round(reprojectionError, 4),
        geometryPlausible,
        ...(quad ? { quad } : {}),
        homography,
        durationMs: round(performance.now() - started),
      };
    } finally {
      source.delete();
      destination.delete();
      inlierMask.delete();
      matrix.delete();
    }
  } finally {
    queryDescriptors.delete();
    templateDescriptors.delete();
    matcher.delete();
    matches.delete();
  }
}

function pointCoverage(points: Array<{ x: number; y: number }>, width: number, height: number) {
  if (points.length < 4) return 0;
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  return ((Math.max(...xs) - Math.min(...xs)) * (Math.max(...ys) - Math.min(...ys))) / (width * height);
}

function project(h: number[], x: number, y: number) {
  const divisor = sample(h, 6) * x + sample(h, 7) * y + sample(h, 8);
  return {
    x: (sample(h, 0) * x + sample(h, 1) * y + sample(h, 2)) / divisor,
    y: (sample(h, 3) * x + sample(h, 4) * y + sample(h, 5)) / divisor,
  };
}

function invertHomography(h: number[]): number[] | null {
  if (h.length !== 9 || h.some((value) => !Number.isFinite(value))) return null;
  const a = sample(h, 0),
    b = sample(h, 1),
    c = sample(h, 2);
  const d = sample(h, 3),
    e = sample(h, 4),
    f = sample(h, 5);
  const g = sample(h, 6),
    i = sample(h, 7),
    j = sample(h, 8);
  const adj = [
    e * j - f * i,
    c * i - b * j,
    b * f - c * e,
    f * g - d * j,
    a * j - c * g,
    c * d - a * f,
    d * i - e * g,
    b * g - a * i,
    a * e - b * d,
  ];
  const det = a * sample(adj, 0) + b * sample(adj, 3) + c * sample(adj, 6);
  return Math.abs(det) > 1e-9 ? adj.map((value) => value / det) : null;
}

function projectedDocumentCorners(h: number[], width: number, height: number): Quad | undefined {
  const inverse = invertHomography(h);
  if (!inverse) return undefined;
  const points = [
    project(inverse, 0, 0),
    project(inverse, width, 0),
    project(inverse, width, height),
    project(inverse, 0, height),
  ] as Quad;
  return points.every((point) => Number.isFinite(point.x) && Number.isFinite(point.y)) ? points : undefined;
}

function mapRectifiedQuadToSource(local: Quad, width: number, height: number, source: Quad): Quad {
  const from = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, width, 0, width, height, 0, height]);
  const to = cv.matFromArray(
    4,
    1,
    cv.CV_32FC2,
    source.flatMap((point) => [point.x, point.y]),
  );
  const matrix = cv.getPerspectiveTransform(from, to);
  try {
    const h = Array.from(matrix.data64F as Float64Array);
    return local.map((point) => project(h, point.x, point.y)) as Quad;
  } finally {
    from.delete();
    to.delete();
    matrix.delete();
  }
}

function meanReprojectionError(h: number[], source: number[], destination: number[], indexes: number[]) {
  if (!indexes.length || h.length !== 9) return Number.POSITIVE_INFINITY;
  const total = indexes.reduce((sum, index) => {
    const projected = project(h, sample(source, index * 2), sample(source, index * 2 + 1));
    return (
      sum + Math.hypot(projected.x - sample(destination, index * 2), projected.y - sample(destination, index * 2 + 1))
    );
  }, 0);
  return total / indexes.length;
}

function plausibleProjection(
  h: number[],
  width: number,
  height: number,
  targetWidth: number,
  targetHeight: number,
  settings: QualityProfile["orb"],
) {
  // Same source-corner projection validated by OCR/src/infra/templates/orb-worker.ts.
  if (h.length !== 9 || h.some((value) => !Number.isFinite(value))) return false;
  const points = [project(h, 0, 0), project(h, width, 0), project(h, width, height), project(h, 0, height)];
  const area = Math.abs(
    points.reduce((sum, point, index) => {
      const next = points[(index + 1) % points.length] ?? point;
      return sum + point.x * next.y - next.x * point.y;
    }, 0) / 2,
  );
  const ratio = area / (targetWidth * targetHeight);
  return (
    ratio >= settings.projectionMinAreaRatio &&
    ratio <= settings.projectionMaxAreaRatio &&
    points.every(
      (point) =>
        point.x >= -targetWidth * settings.projectionMarginRatio &&
        point.x <= targetWidth * (1 + settings.projectionMarginRatio) &&
        point.y >= -targetHeight * settings.projectionMarginRatio &&
        point.y <= targetHeight * (1 + settings.projectionMarginRatio),
    )
  );
}

function flattenMetrics(metrics: ReturnType<typeof analyzeFrame>["metrics"]) {
  const output: Record<string, number> = {};
  for (const [group, values] of Object.entries({ geometry: metrics.geometry, image: metrics.image }))
    if (values) for (const [key, value] of Object.entries(values)) output[`${group}.${key}`] = round(value, 4);
  if (metrics.cornerMotion !== undefined) output.cornerMotion = round(metrics.cornerMotion, 4);
  return output;
}

function timedCheck(
  key: string,
  passed: boolean,
  value: number | string,
  threshold: number | string,
  message: string,
  durationMs: number,
  status: QualityCheck["status"] = passed ? "pass" : "fail",
): QualityCheck {
  const hint: CaptureHint = key.endsWith(":glare")
    ? "avoid_glare"
    : key.endsWith(":sharpness")
      ? "focus"
      : key.endsWith(":exposure")
        ? "more_light"
        : key.endsWith(":visible")
          ? "show_whole_document"
          : key === "orb_reprojection" || key === "orb_geometry"
            ? "hold_parallel"
            : key === "orb_spatial_coverage"
              ? "move_closer"
              : "wrong_document";
  return { key, passed, status, value, threshold, message, durationMs, hint };
}

function sample(values: ArrayLike<number>, index: number): number {
  return values[index] ?? 0;
}
