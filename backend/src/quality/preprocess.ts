import { cv } from "ppu-ocv";
import sharp from "sharp";
import {
  type DocumentFormat,
  type OpenCv,
  type QualityProfile,
  type Quad,
  rectify,
  round,
} from "./core/quality-core.js";

export type PreparedImage = {
  image: Buffer;
  width: number;
  height: number;
  steps: Array<{ step: string; durationMs: number; detail?: string }>;
};

/**
 * Produces the OCR copy of an admissible capture; the original photo is always kept as the source.
 *
 * Deep OCR models (PaddleOCR, VLMs) mostly gain from a flat, upright document at a consistent
 * resolution. Binarisation and strong denoising are deliberately absent: they erase the thin
 * strokes of Arabic script and small digits. Every step is mild and can be disabled in the profile.
 */
export async function prepareForOcr(
  rgba: OpenCv,
  quad: Quad,
  format: DocumentFormat,
  settings: QualityProfile["preprocess"],
  measuredNoise: number,
): Promise<PreparedImage> {
  const steps: PreparedImage["steps"] = [];
  const mats: OpenCv[] = [];
  const track = <T>(step: string, run: () => T, detail?: string): T => {
    const started = performance.now();
    const result = run();
    steps.push({ step, durationMs: round(performance.now() - started), ...(detail ? { detail } : {}) });
    return result;
  };
  try {
    // 1. Perspective rectification at the target resolution, never upscaled beyond 1.25× the capture.
    const nativeWidth = Math.max(distance(quad[0], quad[1]), distance(quad[3], quad[2]));
    const targetWidth = Math.round((format.widthMm / 25.4) * settings.targetDpi);
    const width = Math.round(Math.min(targetWidth, nativeWidth * 1.25) * (1 + 2 * settings.marginRatio));
    const height = Math.round(width / format.aspectRatio);
    const warped = track(
      "rectify",
      () => rectify(cv, rgba, quad, width, height, { marginRatio: settings.marginRatio, interpolation: "linear" }),
      `${width}×${height} px · ${Math.round(width / (1 + 2 * settings.marginRatio) / (format.widthMm / 25.4))} dpi`,
    );
    mats.push(warped);
    const rgb = new cv.Mat();
    mats.push(rgb);
    cv.cvtColor(warped, rgb, cv.COLOR_RGBA2RGB);

    // 2. White balance anchored on the paper, not grey-world: Algerian cards are tinted on purpose.
    if (settings.whiteBalance) track("white_balance", () => balanceOnPaper(rgb));

    // 3. Illumination flattening and local contrast on the lightness channel only.
    const lab = new cv.Mat();
    const channels = new cv.MatVector();
    mats.push(lab, channels);
    cv.cvtColor(rgb, lab, cv.COLOR_RGB2Lab);
    cv.split(lab, channels);
    const lightness = channels.get(0);
    mats.push(lightness);
    if (settings.illuminationStrength > 0)
      track(
        "illumination",
        () => flattenIllumination(lightness, settings.illuminationStrength),
        `strength ${settings.illuminationStrength}`,
      );
    if (settings.claheClipLimit > 0)
      track(
        "clahe",
        () => {
          const clahe = new cv.CLAHE(
            settings.claheClipLimit,
            new cv.Size(settings.claheTileGrid, settings.claheTileGrid),
          );
          clahe.apply(lightness, lightness);
          clahe.delete();
        },
        `clip ${settings.claheClipLimit} · ${settings.claheTileGrid}×${settings.claheTileGrid}`,
      );
    channels.set(0, lightness);
    cv.merge(channels, lab);
    cv.cvtColor(lab, rgb, cv.COLOR_Lab2RGB);

    // 4. Edge-preserving denoise only when the sensor noise was actually measured as high.
    if (measuredNoise > settings.denoiseAboveNoise)
      track(
        "denoise",
        () => {
          const filtered = new cv.Mat();
          cv.bilateralFilter(rgb, filtered, 5, Math.min(60, measuredNoise * 4), 3, cv.BORDER_REPLICATE);
          filtered.copyTo(rgb);
          filtered.delete();
        },
        `noise σ ${round(measuredNoise, 1)}`,
      );

    // 5. Mild unsharp mask to restore the edges softened by resampling.
    if (settings.sharpenAmount > 0)
      track(
        "sharpen",
        () => {
          const blurred = new cv.Mat();
          cv.GaussianBlur(rgb, blurred, new cv.Size(0, 0), settings.sharpenSigma);
          cv.addWeighted(rgb, 1 + settings.sharpenAmount, blurred, -settings.sharpenAmount, 0, rgb);
          blurred.delete();
        },
        `amount ${settings.sharpenAmount} · σ ${settings.sharpenSigma}`,
      );

    const started = performance.now();
    const image = await sharp(Buffer.from(rgb.data as Uint8Array), { raw: { width, height, channels: 3 } })
      .jpeg({ quality: settings.jpegQuality, chromaSubsampling: "4:4:4", mozjpeg: false })
      .toBuffer();
    steps.push({
      step: "encode",
      durationMs: round(performance.now() - started),
      detail: `JPEG q${settings.jpegQuality}`,
    });
    return { image, width, height, steps };
  } finally {
    for (const mat of mats) mat.delete();
  }
}

/** Divides the lightness by a smooth estimate of the paper background, blended by `strength`. */
function flattenIllumination(lightness: OpenCv, strength: number) {
  const small = new cv.Mat();
  const background = new cv.Mat();
  const normalized = new cv.Mat();
  const scale = 0.25;
  try {
    cv.resize(lightness, small, new cv.Size(0, 0), scale, scale, cv.INTER_AREA);
    // Closing removes the dark ink so that only the paper brightness remains.
    const size = oddAtLeast(Math.round(small.cols / 24), 5);
    const kernel = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(size, size));
    cv.morphologyEx(small, small, cv.MORPH_CLOSE, kernel);
    kernel.delete();
    cv.GaussianBlur(small, small, new cv.Size(0, 0), size / 2);
    cv.resize(small, background, new cv.Size(lightness.cols, lightness.rows), 0, 0, cv.INTER_LINEAR);
    const paper = percentileOf(background.data as Uint8Array, 0.95);
    cv.divide(lightness, background, normalized, paper);
    cv.addWeighted(lightness, 1 - strength, normalized, strength, 0, lightness);
  } finally {
    small.delete();
    background.delete();
    normalized.delete();
  }
}

/** Neutralises the brightest (paper) pixels, with channel gains limited to ±10 %. */
function balanceOnPaper(rgb: OpenCv) {
  const data = rgb.data as Uint8Array;
  const luminance = new Uint32Array(256);
  for (let index = 0; index < data.length; index += 12) {
    const value = ((data[index] ?? 0) * 77 + (data[index + 1] ?? 0) * 150 + (data[index + 2] ?? 0) * 29) >> 8;
    luminance[value] = (luminance[value] ?? 0) + 1;
  }
  const threshold = percentileOf(luminance, 0.9, true);
  const sums = [0, 0, 0];
  let count = 0;
  for (let index = 0; index < data.length; index += 12) {
    const red = data[index] ?? 0;
    const green = data[index + 1] ?? 0;
    const blue = data[index + 2] ?? 0;
    if ((red * 77 + green * 150 + blue * 29) >> 8 < threshold || Math.max(red, green, blue) >= 250) continue;
    sums[0] = (sums[0] ?? 0) + red;
    sums[1] = (sums[1] ?? 0) + green;
    sums[2] = (sums[2] ?? 0) + blue;
    count += 1;
  }
  if (count < 100) return;
  const means = sums.map((sum) => sum / count);
  const target = means.reduce((sum, value) => sum + value, 0) / 3;
  const gains = means.map((value) => Math.max(0.9, Math.min(1.1, target / Math.max(1, value))));
  const lookup = gains.map((gain) =>
    Uint8Array.from({ length: 256 }, (_, value) => Math.min(255, Math.round(value * gain))),
  );
  for (let index = 0; index < data.length; index += 3) {
    data[index] = lookup[0]?.[data[index] ?? 0] ?? 0;
    data[index + 1] = lookup[1]?.[data[index + 1] ?? 0] ?? 0;
    data[index + 2] = lookup[2]?.[data[index + 2] ?? 0] ?? 0;
  }
}

function percentileOf(values: Uint8Array | Uint32Array, fraction: number, isHistogram = false) {
  const histogram = isHistogram ? values : new Uint32Array(256);
  let total = 0;
  if (!isHistogram) {
    for (let index = 0; index < values.length; index += 5) {
      const value = values[index] ?? 0;
      histogram[value] = (histogram[value] ?? 0) + 1;
    }
  }
  for (const count of histogram) total += count;
  let cumulative = 0;
  for (let value = 0; value < 256; value += 1) {
    cumulative += histogram[value] ?? 0;
    if (cumulative >= total * fraction) return Math.max(1, value);
  }
  return 255;
}

function oddAtLeast(value: number, minimum: number) {
  const size = Math.max(minimum, value);
  return size % 2 ? size : size + 1;
}

function distance(a: { x: number; y: number }, b: { x: number; y: number }) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}
