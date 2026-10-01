import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, existsSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import openCv from "@techstark/opencv-js";
import { createRequire } from "node:module";
import * as quality from "../src/lib/quality-core.ts";
import * as camera from "../src/lib/camera.ts";

const cv = await openCv;
const sharp = createRequire(new URL("../../backend/package.json", import.meta.url))("sharp");
const savedProfile = JSON.parse(readFileSync(new URL("../../backend/config/quality-profile.json", import.meta.url), "utf8"));
const profile = { ...quality.defaultQualityProfile, ...savedProfile, image: { ...quality.defaultQualityProfile.image, ...savedProfile.image }, severity: { ...quality.defaultQualityProfile.severity, ...savedProfile.severity } };

// Run the real worker's capture path with real OpenCV; only browser canvas I/O is emulated.
class Canvas {
  constructor(width, height) { this.width = width; this.height = height; }
  getContext() {
    return {
      drawImage: (frame, ...args) => {
        const crop = args.length === 8 ? args.slice(0, 4) : [0, 0, frame.width, frame.height];
        const source = cv.matFromArray(frame.height, frame.width, cv.CV_8UC4, frame.pixels);
        const roi = source.roi(new cv.Rect(...crop));
        const output = new cv.Mat();
        try {
          cv.resize(roi, output, new cv.Size(this.width, this.height), 0, 0, cv.INTER_LINEAR);
          this.pixels = Uint8ClampedArray.from(output.data);
        } finally { output.delete(); roi.delete(); source.delete(); }
      },
      getImageData: () => ({ data: this.pixels, width: this.width, height: this.height }),
      putImageData: (image) => { this.pixels = image.data; },
    };
  }
  async convertToBlob() { return new Blob([this.pixels]); }
}

const compiled = ts.transpileModule(readFileSync(new URL("../src/workers/quality.worker.ts", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText;
const exports = {};
vm.runInNewContext(compiled, {
  exports, self: {}, OffscreenCanvas: Canvas, Uint8ClampedArray, Blob, console,
  ImageData: class { constructor(data, width, height) { this.data = data; this.width = width; this.height = height; } },
  require: (name) => name === "@techstark/opencv-js" ? cv : name === "../lib/camera" ? camera : quality,
});

async function compareCapture(bytes) {
  const decoded = await sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const frame = { width: decoded.info.width, height: decoded.info.height, pixels: decoded.data, close() { this.closed = true; } };
  const scale = Math.min(1, profile.capture.analysisSize / Math.max(frame.width, frame.height));
  const canvas = new Canvas(Math.round(frame.width * scale), Math.round(frame.height * scale));
  canvas.getContext().drawImage(frame, 0, 0, canvas.width, canvas.height);
  const source = cv.matFromImageData(canvas.getContext().getImageData());
  const live = quality.analyzeFrame(cv, source, { profile, format: quality.formatForDocument("dz-id"), context: "live", sourceScale: 1 / scale });
  source.delete(); live.rectified?.delete();
  const photoGuide = { guide: { x: 0.1, y: 0.1, width: 0.8, height: 0.8 }, viewportWidth: frame.width, viewportHeight: frame.height };
  const capture = await exports.analyzeCapture(cv, { type: "capture", id: "test", frames: [frame], profile, format: quality.formatForDocument("dz-id"), jpegQuality: 0.95, photoGuide });
  assert.ok(live.quad, "document must be detected in live analysis");
  assert.deepEqual(JSON.parse(JSON.stringify(capture.analysis.quad)), live.quad);
  assert.equal(capture.analysis.evaluation.passed, live.evaluation.passed);
  assert.equal(capture.analysis.evaluation.hint, live.evaluation.hint);
  const crop = camera.frameCropRegion(frame.width, frame.height, frame.width, frame.height, photoGuide.guide);
  assert.equal(capture.width, crop.width);
  assert.equal(capture.height, crop.height);
  assert.equal(capture.photo.size, crop.width * crop.height * 4, "only guide pixels leave the worker");
  assert.equal(frame.closed, true);
}

test("final capture uses the live scene and scale, then crops only the emitted photo", async () => {
  const bytes = await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="3200" height="2200"><rect width="3200" height="2200" fill="#333"/><rect x="420" y="340" width="2360" height="1485" fill="white"/><text x="650" y="900" font-size="160">IDENTITY DOCUMENT TEST</text><text x="650" y="1200" font-size="100">0123456789</text></svg>')).png().toBuffer();
  await compareCapture(bytes);
});

const screenshot = process.env.CAPTURE_REGRESSION_SCREENSHOT ?? "C:/Users/ASUS/Downloads/IMG_9668.png";
test("the reported phone screenshot no longer loses its contours during final capture", { skip: !existsSync(screenshot) }, async () => {
  const bytes = await sharp(screenshot).extract({ left: 54, top: 1116, width: 1060, height: 668 }).resize({ width: 2560 }).png().toBuffer();
  await compareCapture(bytes);
});

test("the lab mask highlights chromatic candidates without changing the captured pixels", async () => {
  const bytes = await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1100"><rect width="1600" height="1100" fill="#333"/><rect x="180" y="150" width="1240" height="780" fill="#eae6df"/><rect x="550" y="400" width="400" height="300" fill="#f2c35f"/><rect x="250" y="250" width="100" height="300" fill="#78aa87"/></svg>')).png().toBuffer();
  const decoded = await sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const frame = { width: decoded.info.width, height: decoded.info.height, pixels: decoded.data, close() {} };
  const capture = await exports.analyzeCapture(cv, { type: "capture", id: "mask", frames: [frame], profile: quality.defaultQualityProfile, format: quality.formatForDocument("dz-id"), jpegQuality: 0.95, colorGlarePreview: true });
  assert.ok(capture.colorGlarePreview);
  const mask = new Uint8Array(await capture.colorGlarePreview.arrayBuffer());
  let highlighted = 0;
  for (let offset = 0; offset < mask.length; offset += 4)
    if (mask[offset] > 240 && mask[offset + 1] < 100 && mask[offset + 2] > 130) highlighted += 1;
  const expected = capture.analysis.metrics.image.colorGlareRatio;
  assert.ok(expected > 0.03);
  assert.ok(Math.abs(highlighted / (mask.length / 4) - expected) < 0.0001);
  assert.deepEqual(Buffer.from(await capture.photo.arrayBuffer()), decoded.data);
});
