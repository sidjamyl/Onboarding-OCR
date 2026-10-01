/**
 * Shared capture-quality core.
 *
 * The canonical copy lives in `backend/src/quality/core/quality-core.ts` and is mirrored to
 * `frontend/src/lib/quality-core.ts` by `npm run sync:quality-core`; a backend test fails when the
 * two copies drift. The same code therefore measures the live camera frames on the phone and the
 * final photo on the server, so a threshold tuned in the calibration cockpit means the same thing
 * on both sides. The file must stay dependency free: OpenCV.js is passed in by the caller.
 */

export type QualityMode = "off" | "observe" | "enforce";
export type Severity = "block" | "warn" | "off";
export type AnalysisContext = "live" | "capture";
export type Point = { x: number; y: number };
export type Quad = [Point, Point, Point, Point];

export const checkKeys = [
  "document_found",
  "document_inside",
  "document_fill",
  "aspect_ratio",
  "perspective",
  "stability",
  "resolution",
  "sharpness",
  "motion_blur",
  "focus_uniformity",
  "exposure",
  "highlights",
  "shadows_clipped",
  "contrast",
  "glare",
  "color_glare",
  "illumination",
  "noise",
] as const;
export type CheckKey = (typeof checkKeys)[number];

/** Actionable instruction shown to the end user; only one is displayed at a time. */
export type CaptureHint =
  | "find_document"
  | "show_whole_document"
  | "move_closer"
  | "move_back"
  | "wrong_document"
  | "hold_parallel"
  | "hold_still"
  | "focus"
  | "more_light"
  | "less_light"
  | "avoid_glare"
  | "even_light"
  | "ready";

export type DocumentFormat = { id: "id-1" | "id-3"; widthMm: number; heightMm: number; aspectRatio: number };

export const documentFormats: Record<DocumentFormat["id"], DocumentFormat> = {
  "id-1": { id: "id-1", widthMm: 85.6, heightMm: 53.98, aspectRatio: 85.6 / 53.98 },
  "id-3": { id: "id-3", widthMm: 125, heightMm: 88, aspectRatio: 125 / 88 },
};

/** ID cards and the biometric driving licence are ID-1; the passport data page is ID-3. */
export function formatForDocument(kind?: string): DocumentFormat {
  return kind?.includes("passport") ? documentFormats["id-3"] : documentFormats["id-1"];
}

export type QualityProfile = {
  version: 2;
  mode: QualityMode;
  capture: {
    /** Delay between two live analyses. */
    samplingIntervalMs: number;
    /** Longest side of the frame copied from the video for live analysis. */
    analysisSize: number;
    /** Consecutive passing frames required before the automatic capture. */
    stableFrames: number;
    /** Mean corner displacement between frames, as a fraction of the frame diagonal. */
    maxCornerMotion: number;
    /** Full-resolution frames grabbed when capturing; the sharpest one is kept. */
    burstFrames: number;
    autoCapture: boolean;
    /** Try ImageCapture.takePhoto() before falling back to the video frame. */
    stillCapture: boolean;
    idealVideoWidth: number;
    jpegQuality: number;
  };
  document: {
    minFill: number;
    maxFill: number;
    edgeMargin: number;
    aspectTolerance: number;
    maxAngleDeviation: number;
    maxSideRatio: number;
    minDpi: number;
  };
  image: {
    /** Variance of the Laplacian on the rectified document at canonical size (final photo). */
    minSharpness: number;
    /** Same measure on live preview frames, which are smaller and softer than the final photo. */
    minSharpnessLive: number;
    minMotionIsotropy: number;
    minFocusUniformity: number;
    exposureMin: number;
    exposureMax: number;
    maxHighlightClip: number;
    maxShadowClip: number;
    minContrast: number;
    maxGlareRatio: number;
    maxGlareBlob: number;
    /** Minimum HSV value (0–255) of a colored reflection candidate. */
    minColorGlareValue: number;
    /** Minimum HSV saturation (0–1) of a colored reflection candidate. */
    minColorGlareSaturation: number;
    maxColorGlareRatio: number;
    minIllumination: number;
    maxNoise: number;
  };
  severity: Record<CheckKey, Severity>;
  preprocess: {
    enabled: boolean;
    /** Resolution of the OCR copy, in pixels per inch of the physical document. */
    targetDpi: number;
    marginRatio: number;
    illuminationStrength: number;
    whiteBalance: boolean;
    claheClipLimit: number;
    claheTileGrid: number;
    denoiseAboveNoise: number;
    sharpenAmount: number;
    sharpenSigma: number;
    jpegQuality: number;
  };
  orb: {
    ratioThreshold: number;
    minimumGoodMatches: number;
    minimumInlierRatio: number;
    ransacThreshold: number;
    minSpatialCoverage: number;
    maxReprojectionError: number;
    projectionMinAreaRatio: number;
    projectionMaxAreaRatio: number;
    projectionMarginRatio: number;
  };
};

export const defaultQualityProfile: QualityProfile = {
  version: 2,
  mode: "enforce",
  capture: {
    samplingIntervalMs: 180,
    analysisSize: 1280,
    stableFrames: 4,
    maxCornerMotion: 0.012,
    burstFrames: 3,
    autoCapture: true,
    stillCapture: false,
    idealVideoWidth: 3840,
    jpegQuality: 0.95,
  },
  document: {
    minFill: 0.6,
    maxFill: 0.97,
    edgeMargin: 0.012,
    aspectTolerance: 0.14,
    maxAngleDeviation: 14,
    maxSideRatio: 1.22,
    minDpi: 220,
  },
  image: {
    minSharpness: 40,
    minSharpnessLive: 40,
    minMotionIsotropy: 0.3,
    minFocusUniformity: 0.15,
    exposureMin: 105,
    exposureMax: 225,
    maxHighlightClip: 0.04,
    maxShadowClip: 0.12,
    minContrast: 0.35,
    maxGlareRatio: 0.012,
    maxGlareBlob: 0.006,
    minColorGlareValue: 220,
    minColorGlareSaturation: 0.25,
    maxColorGlareRatio: 0.03,
    minIllumination: 0.62,
    maxNoise: 6,
  },
  severity: {
    document_found: "block",
    document_inside: "block",
    document_fill: "block",
    aspect_ratio: "block",
    perspective: "block",
    stability: "block",
    resolution: "block",
    sharpness: "block",
    motion_blur: "warn",
    focus_uniformity: "warn",
    exposure: "block",
    highlights: "block",
    shadows_clipped: "warn",
    contrast: "warn",
    glare: "block",
    // Bright printed security colors can also trigger this proxy; calibrate before blocking.
    color_glare: "warn",
    illumination: "block",
    noise: "warn",
  },
  preprocess: {
    enabled: true,
    targetDpi: 400,
    marginRatio: 0.015,
    illuminationStrength: 0,
    whiteBalance: false,
    claheClipLimit: 0,
    claheTileGrid: 8,
    denoiseAboveNoise: 100,
    sharpenAmount: 0,
    sharpenSigma: 1,
    jpegQuality: 95,
  },
  orb: {
    ratioThreshold: 0.75,
    minimumGoodMatches: 18,
    minimumInlierRatio: 0.42,
    ransacThreshold: 4,
    minSpatialCoverage: 0.08,
    maxReprojectionError: 8,
    projectionMinAreaRatio: 0.3,
    projectionMaxAreaRatio: 2.2,
    projectionMarginRatio: 0.35,
  },
};

/** Width of the rectified copy used for measurements: about 300 dpi for an ID-1 card. */
export const canonicalWidth = 1024;

export type GeometryMetrics = {
  fill: number;
  margin: number;
  aspectRatio: number;
  aspectError: number;
  angleDeviation: number;
  sideRatio: number;
  documentWidthPx: number;
  dpi: number;
};

export type ImageMetrics = {
  width: number;
  height: number;
  mean: number;
  /** 90th percentile of the luminance: the brightness of the document background. */
  paper: number;
  p2: number;
  p98: number;
  highlightClip: number;
  shadowClip: number;
  contrast: number;
  sharpness: number;
  tenengrad: number;
  motionIsotropy: number;
  focusUniformity: number;
  glareRatio: number;
  glareBlob: number;
  colorGlareRatio: number;
  illumination: number;
  noise: number;
};

export type FrameMetrics = {
  geometry?: GeometryMetrics;
  image?: ImageMetrics;
  /** Mean corner motion since the previous frame, as a fraction of the frame diagonal. */
  cornerMotion?: number;
};

export type CoreCheck = {
  key: CheckKey;
  status: "pass" | "warn" | "fail" | "not_applicable";
  passed: boolean;
  severity: Severity;
  value: number | string;
  threshold: string;
  hint: CaptureHint;
};

export type Evaluation = {
  /** Every blocking check passed. */
  passed: boolean;
  /** Every evaluated check passed, warnings included. */
  flawless: boolean;
  checks: CoreCheck[];
  hint: CaptureHint;
  score: number;
};

export function evaluateFrame(metrics: FrameMetrics, profile: QualityProfile, context: AnalysisContext): Evaluation {
  const { image: limits, severity } = profile;
  const checks: CoreCheck[] = [];
  const add = (key: CheckKey, passed: boolean, value: number | string, threshold: string, hint: CaptureHint) => {
    const level = severity[key];
    if (level === "off") return;
    checks.push({
      key,
      passed,
      severity: level,
      status: passed ? "pass" : level === "block" ? "fail" : "warn",
      value: typeof value === "number" ? round(value, 4) : value,
      threshold,
      hint,
    });
  };
  const geometry = metrics.geometry;
  add("document_found", Boolean(geometry), geometry ? "located" : "missing", "located", "find_document");
  if (geometry) {
    const limits = profile.document;
    add(
      "document_inside",
      geometry.margin >= limits.edgeMargin,
      geometry.margin,
      `≥ ${limits.edgeMargin}`,
      "show_whole_document",
    );
    add(
      "document_fill",
      geometry.fill >= limits.minFill && geometry.fill <= limits.maxFill,
      geometry.fill,
      `${limits.minFill}–${limits.maxFill}`,
      geometry.fill < limits.minFill ? "move_closer" : "move_back",
    );
    add(
      "aspect_ratio",
      geometry.aspectError <= limits.aspectTolerance,
      geometry.aspectError,
      `≤ ${limits.aspectTolerance}`,
      "wrong_document",
    );
    add(
      "perspective",
      geometry.angleDeviation <= limits.maxAngleDeviation && geometry.sideRatio <= limits.maxSideRatio,
      geometry.angleDeviation,
      `≤ ${limits.maxAngleDeviation}°; sides ≤ ${limits.maxSideRatio}`,
      "hold_parallel",
    );
    add("resolution", geometry.dpi >= limits.minDpi, geometry.dpi, `≥ ${limits.minDpi}`, "move_closer");
  }
  if (context === "live" && metrics.cornerMotion !== undefined)
    add(
      "stability",
      metrics.cornerMotion <= profile.capture.maxCornerMotion,
      metrics.cornerMotion,
      `≤ ${profile.capture.maxCornerMotion}`,
      "hold_still",
    );
  const image = metrics.image;
  if (image) {
    const minSharpness = context === "live" ? limits.minSharpnessLive : limits.minSharpness;
    add("sharpness", image.sharpness >= minSharpness, image.sharpness, `≥ ${minSharpness}`, "focus");
    add(
      "motion_blur",
      image.motionIsotropy >= limits.minMotionIsotropy,
      image.motionIsotropy,
      `≥ ${limits.minMotionIsotropy}`,
      "hold_still",
    );
    add(
      "focus_uniformity",
      image.focusUniformity >= limits.minFocusUniformity,
      image.focusUniformity,
      `≥ ${limits.minFocusUniformity}`,
      "hold_parallel",
    );
    // Exposure is judged on the paper, not the mean: a light card is legitimately bright on average.
    add(
      "exposure",
      image.paper >= limits.exposureMin && image.paper <= limits.exposureMax,
      image.paper,
      `${limits.exposureMin}–${limits.exposureMax}`,
      image.paper < limits.exposureMin ? "more_light" : "less_light",
    );
    add(
      "highlights",
      image.highlightClip <= limits.maxHighlightClip,
      image.highlightClip,
      `≤ ${limits.maxHighlightClip}`,
      "less_light",
    );
    add(
      "shadows_clipped",
      image.shadowClip <= limits.maxShadowClip,
      image.shadowClip,
      `≤ ${limits.maxShadowClip}`,
      "more_light",
    );
    add("contrast", image.contrast >= limits.minContrast, image.contrast, `≥ ${limits.minContrast}`, "more_light");
    add(
      "glare",
      image.glareRatio <= limits.maxGlareRatio && image.glareBlob <= limits.maxGlareBlob,
      `${round(image.glareRatio, 4)} · ${round(image.glareBlob, 4)}`,
      `≤ ${limits.maxGlareRatio} · ≤ ${limits.maxGlareBlob}`,
      "avoid_glare",
    );
    add(
      "color_glare",
      image.colorGlareRatio <= limits.maxColorGlareRatio,
      image.colorGlareRatio,
      `≤ ${limits.maxColorGlareRatio}`,
      "avoid_glare",
    );
    add(
      "illumination",
      image.illumination >= limits.minIllumination,
      image.illumination,
      `≥ ${limits.minIllumination}`,
      "even_light",
    );
    add("noise", image.noise <= limits.maxNoise, image.noise, `≤ ${limits.maxNoise}`, "more_light");
  }
  const blocking = checks.filter((check) => check.status === "fail");
  const warnings = checks.filter((check) => check.status === "warn");
  const primary = blocking[0] ?? warnings[0];
  return {
    passed: blocking.length === 0,
    flawless: blocking.length === 0 && warnings.length === 0,
    checks,
    hint: primary?.hint ?? "ready",
    score: frameScore(metrics, profile, context),
  };
}

/** Ranks otherwise acceptable frames; sharpness dominates because it is what OCR loses first. */
export function frameScore(metrics: FrameMetrics, profile: QualityProfile, context: AnalysisContext): number {
  const image = metrics.image;
  if (!image) return 0;
  const limits = profile.image;
  const minSharpness = context === "live" ? limits.minSharpnessLive : limits.minSharpness;
  const center = (limits.exposureMin + limits.exposureMax) / 2;
  const radius = Math.max(1, (limits.exposureMax - limits.exposureMin) / 2);
  return round(
    0.45 * clamp01(image.sharpness / Math.max(1, minSharpness * 3)) +
      0.15 * clamp01(1 - Math.abs(image.paper - center) / radius) +
      0.15 * clamp01(1 - image.glareRatio / Math.max(0.0001, limits.maxGlareRatio * 2)) +
      0.25 * clamp01(image.illumination),
    4,
  );
}

/**
 * Measures the rectified document. `rgba` holds `width * height * 4` bytes and should only
 * contain the document, never the background, so that table texture cannot fake sharpness.
 */
export function measureImage(
  rgba: ArrayLike<number>,
  width: number,
  height: number,
  limits: Pick<QualityProfile["image"], "minColorGlareValue" | "minColorGlareSaturation"> = defaultQualityProfile.image,
): ImageMetrics {
  const size = width * height;
  const gray = new Uint8Array(size);
  const glare = new Uint8Array(size);
  const histogram = new Uint32Array(256);
  let glarePixels = 0;
  let colorGlarePixels = 0;
  for (let pixel = 0, offset = 0; pixel < size; pixel += 1, offset += 4) {
    const red = rgba[offset] ?? 0;
    const green = rgba[offset + 1] ?? 0;
    const blue = rgba[offset + 2] ?? 0;
    const luma = (red * 77 + green * 150 + blue * 29) >> 8;
    gray[pixel] = luma;
    histogram[luma] = (histogram[luma] ?? 0) + 1;
    const max = Math.max(red, green, blue);
    const min = Math.min(red, green, blue);
    // Specular reflections on laminated cards clip the sensor and are nearly colourless; well
    // exposed white paper stays below this level, so it is not mistaken for glare.
    if (max >= 252 && max - min <= 24) {
      glare[pixel] = 1;
      glarePixels += 1;
    }
    // Holographic highlights can be gold or iridescent without clipping any channel.
    // Require both brightness and saturation to avoid counting ordinary darker print.
    if (isColorGlareCandidate(max, min, limits)) colorGlarePixels += 1;
  }
  let sum = 0;
  for (let value = 0; value < 256; value += 1) sum += value * (histogram[value] ?? 0);
  const p2 = percentile(histogram, size, 0.02);
  const p98 = percentile(histogram, size, 0.98);
  let highlight = 0;
  for (let value = 250; value < 256; value += 1) highlight += histogram[value] ?? 0;
  let shadow = 0;
  for (let value = 0; value <= 8; value += 1) shadow += histogram[value] ?? 0;

  // Sharpness, motion and noise share a single pass over the interior pixels.
  const columns = 4;
  const rows = 3;
  const tileLaplacian = new Float64Array(columns * rows * 3);
  let lapSum = 0;
  let lapSquares = 0;
  let gradientX = 0;
  let gradientY = 0;
  const edgeStrength = new Uint16Array(size);
  const noiseResponse = new Uint16Array(size);
  const edgeHistogram = new Uint32Array(4096);
  let count = 0;
  for (let y = 1; y < height - 1; y += 1) {
    const tileRow = Math.min(rows - 1, Math.floor((y * rows) / height));
    for (let x = 1; x < width - 1; x += 1) {
      const index = y * width + x;
      const c = gray[index] ?? 0;
      const n = gray[index - width] ?? 0;
      const s = gray[index + width] ?? 0;
      const w = gray[index - 1] ?? 0;
      const e = gray[index + 1] ?? 0;
      const nw = gray[index - width - 1] ?? 0;
      const ne = gray[index - width + 1] ?? 0;
      const sw = gray[index + width - 1] ?? 0;
      const se = gray[index + width + 1] ?? 0;
      const laplacian = n + s + w + e - 4 * c;
      const gx = ne + 2 * e + se - nw - 2 * w - sw;
      const gy = sw + 2 * s + se - nw - 2 * n - ne;
      lapSum += laplacian;
      lapSquares += laplacian * laplacian;
      gradientX += gx * gx;
      gradientY += gy * gy;
      count += 1;
      const tile = (tileRow * columns + Math.min(columns - 1, Math.floor((x * columns) / width))) * 3;
      tileLaplacian[tile] = (tileLaplacian[tile] ?? 0) + laplacian;
      tileLaplacian[tile + 1] = (tileLaplacian[tile + 1] ?? 0) + laplacian * laplacian;
      tileLaplacian[tile + 2] = (tileLaplacian[tile + 2] ?? 0) + 1;
      const strength = Math.min(4095, Math.abs(gx) + Math.abs(gy));
      edgeStrength[index] = strength;
      edgeHistogram[strength] = (edgeHistogram[strength] ?? 0) + 1;
      noiseResponse[index] = Math.abs(c * 4 - 2 * (n + s + w + e) + nw + ne + sw + se);
    }
  }
  // Immerkaer's fast noise estimate, restricted to the 70 % flattest pixels so that the
  // strokes of the text are not counted as noise.
  let flatLimit = 0;
  for (let cumulative = 0; flatLimit < 4096; flatLimit += 1) {
    cumulative += edgeHistogram[flatLimit] ?? 0;
    if (cumulative >= count * 0.7) break;
  }
  let noiseSum = 0;
  let noiseCount = 0;
  for (let y = 1; y < height - 1; y += 1)
    for (let x = 1; x < width - 1; x += 1) {
      const index = y * width + x;
      if ((edgeStrength[index] ?? 0) > flatLimit) continue;
      noiseSum += noiseResponse[index] ?? 0;
      noiseCount += 1;
    }
  const lapMean = lapSum / Math.max(1, count);
  const sharpness = lapSquares / Math.max(1, count) - lapMean * lapMean;
  const tileVariances: number[] = [];
  for (let tile = 0; tile < columns * rows; tile += 1) {
    const tileCount = tileLaplacian[tile * 3 + 2] ?? 0;
    if (!tileCount) continue;
    const mean = (tileLaplacian[tile * 3] ?? 0) / tileCount;
    tileVariances.push((tileLaplacian[tile * 3 + 1] ?? 0) / tileCount - mean * mean);
  }
  // Tiles without text (plain background, portrait) are ignored for focus uniformity.
  const sortedTiles = [...tileVariances].sort((a, b) => a - b);
  const tileMedian = sortedTiles[Math.floor(sortedTiles.length / 2)] ?? 0;
  const contentTiles = sortedTiles.filter((variance) => variance >= tileMedian * 0.25);
  const median = contentTiles[Math.floor(contentTiles.length / 2)] ?? 0;
  const focusUniformity = contentTiles.length >= 3 && median > 0 ? (contentTiles[0] ?? 0) / median : 1;

  return {
    width,
    height,
    mean: sum / size,
    paper: percentile(histogram, size, 0.9),
    p2,
    p98,
    highlightClip: highlight / size,
    shadowClip: shadow / size,
    contrast: (p98 - p2) / 255,
    sharpness,
    tenengrad: (gradientX + gradientY) / Math.max(1, count),
    motionIsotropy: Math.min(gradientX, gradientY) / Math.max(1, gradientX, gradientY),
    focusUniformity,
    glareRatio: glarePixels / size,
    glareBlob: largestBlob(glare, width, height),
    colorGlareRatio: colorGlarePixels / size,
    illumination: illuminationUniformity(gray, width, height),
    noise: noiseCount ? (Math.sqrt(Math.PI / 2) * (noiseSum / noiseCount)) / 6 : 0,
  };
}

/** HSV candidate selection shared by measurement and the laboratory mask. */
export function isColorGlareCandidate(
  value: number,
  minimum: number,
  limits: Pick<QualityProfile["image"], "minColorGlareValue" | "minColorGlareSaturation">,
): boolean {
  return value >= limits.minColorGlareValue && value > 0 && (value - minimum) / value >= limits.minColorGlareSaturation;
}

/** Ratio between the darkest and brightest paper background across a 6×4 grid (1 = even light). */
function illuminationUniformity(gray: Uint8Array, width: number, height: number) {
  const columns = 6;
  const rows = 4;
  const backgrounds: number[] = [];
  for (let row = 0; row < rows; row += 1)
    for (let column = 0; column < columns; column += 1) {
      const histogram = new Uint32Array(256);
      let total = 0;
      const x0 = Math.floor((column * width) / columns);
      const x1 = Math.floor(((column + 1) * width) / columns);
      const y0 = Math.floor((row * height) / rows);
      const y1 = Math.floor(((row + 1) * height) / rows);
      for (let y = y0; y < y1; y += 2)
        for (let x = x0; x < x1; x += 2) {
          const value = gray[y * width + x] ?? 0;
          histogram[value] = (histogram[value] ?? 0) + 1;
          total += 1;
        }
      // The 90th percentile ignores ink and approximates the local paper brightness.
      if (total) backgrounds.push(percentile(histogram, total, 0.9));
    }
  const max = Math.max(...backgrounds);
  return max > 0 ? Math.min(...backgrounds) / max : 0;
}

/** Largest connected glare region, as a fraction of the document, on a 4×4-pixel grid. */
function largestBlob(mask: Uint8Array, width: number, height: number) {
  const cell = 4;
  const columns = Math.ceil(width / cell);
  const rows = Math.ceil(height / cell);
  const grid = new Uint8Array(columns * rows);
  for (let y = 0; y < height; y += 1)
    for (let x = 0; x < width; x += 1)
      if (mask[y * width + x]) {
        const index = Math.floor(y / cell) * columns + Math.floor(x / cell);
        grid[index] = Math.min(255, (grid[index] ?? 0) + 1);
      }
  const threshold = (cell * cell) / 2;
  const seen = new Uint8Array(columns * rows);
  const stack: number[] = [];
  let largest = 0;
  for (let start = 0; start < grid.length; start += 1) {
    if (seen[start] || (grid[start] ?? 0) < threshold) continue;
    let area = 0;
    stack.push(start);
    seen[start] = 1;
    while (stack.length) {
      const index = stack.pop() ?? 0;
      area += 1;
      const x = index % columns;
      const neighbours = [index - columns, index + columns, x > 0 ? index - 1 : -1, x < columns - 1 ? index + 1 : -1];
      for (const next of neighbours)
        if (next >= 0 && next < grid.length && !seen[next] && (grid[next] ?? 0) >= threshold) {
          seen[next] = 1;
          stack.push(next);
        }
    }
    largest = Math.max(largest, area);
  }
  return largest / (columns * rows);
}

// biome-ignore lint/suspicious/noExplicitAny: the browser and Node OpenCV.js builds ship incompatible typings.
export type OpenCv = any;

/** Warps the quadrilateral to a `width × height` RGBA mat. The caller owns the returned mat. */
export function rectify(
  cv: OpenCv,
  source: OpenCv,
  quad: Quad,
  width: number,
  height: number,
  options: { marginRatio?: number; interpolation?: "linear" | "cubic" } = {},
): OpenCv {
  const marginRatio = options.marginRatio ?? 0;
  const expanded = marginRatio ? expandQuad(quad, marginRatio) : quad;
  const from = cv.matFromArray(
    4,
    1,
    cv.CV_32FC2,
    expanded.flatMap((point) => [point.x, point.y]),
  );
  const to = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, width, 0, width, height, 0, height]);
  const matrix = cv.getPerspectiveTransform(from, to);
  const output = new cv.Mat();
  try {
    // Measurements use bilinear sampling: cubic overshoot would add artificial edges and highlights.
    const interpolation = options.interpolation === "cubic" ? cv.INTER_CUBIC : cv.INTER_LINEAR;
    cv.warpPerspective(source, output, matrix, new cv.Size(width, height), interpolation, cv.BORDER_REPLICATE);
    return output;
  } finally {
    from.delete();
    to.delete();
    matrix.delete();
  }
}

export function expandQuad(quad: Quad, ratio: number): Quad {
  const center = quad.reduce((sum, point) => ({ x: sum.x + point.x / 4, y: sum.y + point.y / 4 }), { x: 0, y: 0 });
  return quad.map((point) => ({
    x: point.x + (point.x - center.x) * ratio * 2,
    y: point.y + (point.y - center.y) * ratio * 2,
  })) as Quad;
}

export type FrameAnalysis = {
  /** Contours guide the preview; the server verifies the identity with ORB. */
  quad: Quad | null;
  metrics: FrameMetrics;
  evaluation: Evaluation;
  durationMs: { detection: number; measurement: number; total: number };
};

/**
 * Locates a plausible planar document for preview guidance. A contour is not an identity proof.
 */
export function analyzeFrame(
  cv: OpenCv,
  source: OpenCv,
  options: {
    profile: QualityProfile;
    format: DocumentFormat;
    context: AnalysisContext;
    sourceScale?: number;
    quad?: Quad | null;
    previousQuad?: Quad | null;
  },
): FrameAnalysis & { rectified?: OpenCv } {
  const started = now();
  const rgba = source.channels() === 4 ? source : convertToRgba(cv, source);
  const quad =
    options.quad === undefined
      ? detectQuad(cv, rgba, options.format, options.profile.capture.analysisSize)
      : options.quad;
  const detected = now();
  const metrics: FrameMetrics = {};
  let rectified: OpenCv | undefined;
  try {
    if (quad) {
      metrics.geometry = measureGeometry(quad, rgba.cols, rgba.rows, options.format, options.sourceScale ?? 1);
      if (options.previousQuad)
        metrics.cornerMotion =
          quad.reduce((sum, point, index) => sum + distance(point, options.previousQuad![index]!), 0) /
          4 /
          Math.hypot(rgba.cols, rgba.rows);
      // Never upscale measurements: missing pixels cannot be restored by interpolation.
      const width = Math.max(
        32,
        Math.round(Math.min(canonicalWidth, metrics.geometry.documentWidthPx / (options.sourceScale ?? 1))),
      );
      rectified = rectify(cv, rgba, quad, width, Math.round(width / options.format.aspectRatio));
      metrics.image = measureImage(rectified.data as Uint8Array, rectified.cols, rectified.rows, options.profile.image);
    }
  } finally {
    if (rgba !== source) rgba.delete();
  }
  const evaluation = evaluateFrame(metrics, options.profile, options.context);
  const finished = now();
  const result: FrameAnalysis & { rectified?: OpenCv } = {
    quad,
    metrics,
    evaluation,
    durationMs: {
      detection: round(detected - started, 2),
      measurement: round(finished - detected, 2),
      total: round(finished - started, 2),
    },
  };
  if (rectified) result.rectified = rectified;
  return result;
}

export function measureGeometry(
  quad: Quad,
  width: number,
  height: number,
  format: DocumentFormat,
  sourceScale = 1,
): GeometryMetrics {
  const top = distance(quad[0], quad[1]);
  const bottom = distance(quad[3], quad[2]);
  const left = distance(quad[0], quad[3]);
  const right = distance(quad[1], quad[2]);
  const documentWidth = Math.min(top, bottom);
  const aspectRatio = (top + bottom) / Math.max(1, left + right);
  return {
    fill: Math.sqrt(polygonArea(quad) / (width * height)),
    margin: Math.min(...quad.flatMap((p) => [p.x, p.y, width - p.x, height - p.y])) / Math.min(width, height),
    aspectRatio,
    aspectError: Math.abs(aspectRatio / format.aspectRatio - 1),
    angleDeviation: Math.max(...quad.map((p, i) => Math.abs(90 - angle(quad[(i + 3) % 4]!, p, quad[(i + 1) % 4]!)))),
    sideRatio: Math.max(ratio(top, bottom), ratio(left, right)),
    documentWidthPx: documentWidth * sourceScale,
    dpi: (documentWidth * sourceScale) / (format.widthMm / 25.4),
  };
}

function detectQuad(cv: OpenCv, source: OpenCv, format: DocumentFormat, analysisSize: number): Quad | null {
  const gray = new cv.Mat();
  const edges = new cv.Mat();
  const contours = new cv.MatVector();
  const hierarchy = new cv.Mat();
  try {
    cv.cvtColor(source, gray, cv.COLOR_RGBA2GRAY);
    // Canny and polygon approximation must see the same scene scale as the phone preview.
    // Measurements still use the original pixels after mapping the detected corners back.
    const scale = Math.min(1, analysisSize / Math.max(source.cols, source.rows));
    if (scale < 1)
      cv.resize(
        gray,
        gray,
        new cv.Size(Math.round(source.cols * scale), Math.round(source.rows * scale)),
        0,
        0,
        cv.INTER_AREA,
      );
    cv.GaussianBlur(gray, gray, new cv.Size(5, 5), 0);
    cv.Canny(gray, edges, 35, 110);
    cv.findContours(edges, contours, hierarchy, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);
    let best: Quad | null = null;
    let bestArea = 0;
    for (let i = 0; i < contours.size(); i++) {
      const contour = contours.get(i);
      const approx = new cv.Mat();
      try {
        cv.approxPolyDP(contour, approx, cv.arcLength(contour, true) * 0.025, true);
        if (approx.rows !== 4 || !cv.isContourConvex(approx)) continue;
        const points = Array.from({ length: 4 }, (_, n) => ({
          x: approx.data32S[n * 2],
          y: approx.data32S[n * 2 + 1],
        }));
        const center = points.reduce((a, p) => ({ x: a.x + p.x / 4, y: a.y + p.y / 4 }), { x: 0, y: 0 });
        points.sort((a, b) => Math.atan2(a.y - center.y, a.x - center.x) - Math.atan2(b.y - center.y, b.x - center.x));
        const start = points.reduce((s, p, n) => (p.x + p.y < points[s]!.x + points[s]!.y ? n : s), 0);
        let quad = [...points.slice(start), ...points.slice(0, start)] as Quad;
        if (distance(quad[0], quad[1]) < distance(quad[1], quad[2])) quad = [quad[1], quad[2], quad[3], quad[0]];
        const area = polygonArea(quad);
        const geometry = measureGeometry(quad, gray.cols, gray.rows, format);
        if (area > bestArea && area >= gray.cols * gray.rows * 0.12 && geometry.aspectError < 0.4) {
          best = quad;
          bestArea = area;
        }
      } finally {
        contour.delete();
        approx.delete();
      }
    }
    return best
      ? (best.map((point) => ({
          x: (point.x * source.cols) / gray.cols,
          y: (point.y * source.rows) / gray.rows,
        })) as Quad)
      : null;
  } finally {
    gray.delete();
    edges.delete();
    contours.delete();
    hierarchy.delete();
  }
}

function convertToRgba(cv: OpenCv, mat: OpenCv) {
  const output = new cv.Mat();
  cv.cvtColor(mat, output, mat.channels() === 3 ? cv.COLOR_RGB2RGBA : cv.COLOR_GRAY2RGBA);
  return output;
}

export function normalizeQuad(quad: Quad, width: number, height: number): Quad {
  return quad.map((point) => ({ x: point.x / width, y: point.y / height })) as Quad;
}

export function denormalizeQuad(quad: Quad, width: number, height: number): Quad {
  return quad.map((point) => ({ x: point.x * width, y: point.y * height })) as Quad;
}

function percentile(histogram: Uint32Array, total: number, fraction: number) {
  const target = total * fraction;
  let cumulative = 0;
  for (let value = 0; value < 256; value += 1) {
    cumulative += histogram[value] ?? 0;
    if (cumulative >= target) return value;
  }
  return 255;
}

function polygonArea(points: Point[]) {
  let area = 0;
  for (let index = 0; index < points.length; index += 1) {
    const point = points[index] ?? { x: 0, y: 0 };
    const next = points[(index + 1) % points.length] ?? point;
    area += point.x * next.y - next.x * point.y;
  }
  return Math.abs(area) / 2;
}

function angle(previous: Point, point: Point, next: Point) {
  const a = { x: previous.x - point.x, y: previous.y - point.y };
  const b = { x: next.x - point.x, y: next.y - point.y };
  const cosine = (a.x * b.x + a.y * b.y) / Math.max(1e-9, Math.hypot(a.x, a.y) * Math.hypot(b.x, b.y));
  return (Math.acos(Math.max(-1, Math.min(1, cosine))) * 180) / Math.PI;
}

function distance(a: Point, b: Point) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function ratio(a: number, b: number) {
  return Math.max(a, b) / Math.max(1e-9, Math.min(a, b));
}

function clamp01(value: number) {
  return Math.max(0, Math.min(1, value));
}

function now() {
  return typeof performance === "undefined" ? Date.now() : performance.now();
}

export function round(value: number, precision = 2) {
  const factor = 10 ** precision;
  return Math.round(value * factor) / factor;
}
