/// <reference lib="webworker" />
import openCvModule from "@techstark/opencv-js";
import { frameCropRegion, type PhotoGuide } from "../lib/camera";
import {
  analyzeFrame,
  isColorGlareCandidate,
  type DocumentFormat,
  type FrameAnalysis,
  type OpenCv,
  type QualityProfile,
  type Quad,
} from "../lib/quality-core";

export type WorkerRequest =
  | {
      type: "frame";
      id: string;
      pixels: ArrayBuffer;
      width: number;
      height: number;
      sourceScale: number;
      profile: QualityProfile;
      format: DocumentFormat;
    }
  | {
      type: "capture";
      id: string;
      frames: ImageBitmap[];
      profile: QualityProfile;
      format: DocumentFormat;
      jpegQuality: number;
      photoGuide?: PhotoGuide;
      colorGlarePreview?: boolean;
    }
  | { type: "warmup"; id: string };

export type CaptureResult = {
  analysis: FrameAnalysis;
  photo: Blob;
  preview?: Blob;
  colorGlarePreview?: Blob;
  width: number;
  height: number;
  frameIndex: number;
  candidates: Array<{ score: number; sharpness: number; passed: boolean }>;
};

export type WorkerResponse =
  | { id: string; type: "frame"; analysis: FrameAnalysis }
  | { id: string; type: "capture"; result: CaptureResult }
  | { id: string; type: "ready" }
  | { id: string; type: "error"; message: string };

const scope = self as unknown as DedicatedWorkerGlobalScope;
// @techstark/opencv-js 5 exports a promise of the runtime. Bundler interop copies its `then` onto
// the module namespace, so the package is imported statically (never with `import()`) and the
// runtime is kept in a plain holder instead of being returned from a promise.
let runtime: Promise<{ cv: OpenCv }> | undefined;

function loadOpenCv(): Promise<{ cv: OpenCv }> {
  runtime ??= (async () => {
    const exported = openCvModule as unknown;
    if (exported instanceof Promise) return { cv: (await exported) as OpenCv };
    const cv = exported as OpenCv;
    if (!cv.Mat)
      await new Promise<void>((resolve) => {
        const previous = cv.onRuntimeInitialized;
        cv.onRuntimeInitialized = () => {
          previous?.();
          resolve();
        };
      });
    return { cv };
  })();
  return runtime;
}

let previousQuad: Quad | null = null;
let previousSize = "";
scope.onmessage = async ({ data }: MessageEvent<WorkerRequest>) => {
  try {
    const { cv } = await loadOpenCv();
    if (data.type === "warmup") return reply({ id: data.id, type: "ready" });
    if (data.type === "frame") {
      const size = `${data.width}x${data.height}`;
      if (size !== previousSize) previousQuad = null;
      previousSize = size;
      const image = new ImageData(new Uint8ClampedArray(data.pixels), data.width, data.height);
      const source = cv.matFromImageData(image);
      try {
        const analysis = analyzeFrame(cv, source, {
          profile: data.profile,
          format: data.format,
          context: "live",
          sourceScale: data.sourceScale,
          previousQuad,
        });
        previousQuad = analysis.quad;
        const { rectified, ...report } = analysis;
        rectified?.delete();
        return reply({ id: data.id, type: "frame", analysis: report });
      } finally {
        source.delete();
      }
    }
    reply({ id: data.id, type: "capture", result: await analyzeCapture(cv, data) });
  } catch (error) {
    reply({ id: data.id, type: "error", message: error instanceof Error ? error.message : String(error) });
  }
};

/** Use the live analysis scale and scene; crop native pixels only after selecting a frame. */
export async function analyzeCapture(
  cv: OpenCv,
  request: Extract<WorkerRequest, { type: "capture" }>,
): Promise<CaptureResult> {
  let best: { index: number; analysis: FrameAnalysis; rectified?: OpenCv } | undefined;
  const candidates: CaptureResult["candidates"] = [];
  try {
    for (const [index, frame] of request.frames.entries()) {
      const scale = Math.min(1, request.profile.capture.analysisSize / Math.max(frame.width, frame.height));
      const width = Math.max(1, Math.round(frame.width * scale));
      const height = Math.max(1, Math.round(frame.height * scale));
      const canvas = new OffscreenCanvas(width, height);
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (!context) throw new Error("2D canvas is unavailable");
      context.drawImage(frame, 0, 0, width, height);
      const source = cv.matFromImageData(context.getImageData(0, 0, width, height));
      try {
        const analysis = analyzeFrame(cv, source, {
          profile: request.profile,
          format: request.format,
          context: "capture",
          sourceScale: 1 / scale,
        });
        candidates.push({
          score: analysis.evaluation.score,
          sharpness: analysis.metrics.image?.sharpness ?? 0,
          passed: analysis.evaluation.passed,
        });
        const better =
          !best ||
          Number(analysis.evaluation.passed) > Number(best.analysis.evaluation.passed) ||
          (analysis.evaluation.passed === best.analysis.evaluation.passed &&
            analysis.evaluation.score > best.analysis.evaluation.score);
        if (better) {
          best?.rectified?.delete();
          best = { index, analysis, ...(analysis.rectified ? { rectified: analysis.rectified } : {}) };
        } else analysis.rectified?.delete();
      } finally {
        source.delete();
      }
    }
    if (!best) throw new Error("No frame to analyse");
    const chosen = request.frames[best.index];
    if (!chosen) throw new Error("Missing burst frame");
    const region = request.photoGuide
      ? frameCropRegion(
          chosen.width,
          chosen.height,
          request.photoGuide.viewportWidth,
          request.photoGuide.viewportHeight,
          request.photoGuide.guide,
        )
      : { x: 0, y: 0, width: chosen.width, height: chosen.height };
    const photoCanvas = new OffscreenCanvas(region.width, region.height);
    const photoContext = photoCanvas.getContext("2d");
    if (!photoContext) throw new Error("2D canvas is unavailable");
    photoContext.drawImage(chosen, region.x, region.y, region.width, region.height, 0, 0, region.width, region.height);
    const photo = await photoCanvas.convertToBlob({ type: "image/jpeg", quality: request.jpegQuality });
    let colorGlarePreview: Blob | undefined;
    if (request.colorGlarePreview && best.rectified) {
      const rectified = best.rectified;
      const pixels = new Uint8ClampedArray(rectified.data as Uint8Array);
      for (let offset = 0; offset < pixels.length; offset += 4) {
        const red = pixels[offset] ?? 0,
          green = pixels[offset + 1] ?? 0,
          blue = pixels[offset + 2] ?? 0;
        if (isColorGlareCandidate(Math.max(red, green, blue), Math.min(red, green, blue), request.profile.image)) {
          pixels[offset] = Math.round(red * 0.3 + 255 * 0.7);
          pixels[offset + 1] = Math.round(green * 0.3 + 30 * 0.7);
          pixels[offset + 2] = Math.round(blue * 0.3 + 170 * 0.7);
        }
      }
      const maskCanvas = new OffscreenCanvas(rectified.cols, rectified.rows);
      const maskContext = maskCanvas.getContext("2d");
      if (maskContext) {
        maskContext.putImageData(new ImageData(pixels, rectified.cols, rectified.rows), 0, 0);
        colorGlarePreview = await maskCanvas.convertToBlob({ type: "image/png" });
      }
    }
    const { rectified: _rectified, ...analysis } = best.analysis as FrameAnalysis & { rectified?: OpenCv };
    return {
      analysis,
      photo,
      ...(colorGlarePreview ? { colorGlarePreview } : {}),
      width: region.width,
      height: region.height,
      frameIndex: best.index,
      candidates,
    };
  } finally {
    best?.rectified?.delete();
    for (const frame of request.frames) frame.close();
  }
}

function reply(message: WorkerResponse) {
  scope.postMessage(message);
}
