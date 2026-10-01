import type { CaptureResult, WorkerRequest, WorkerResponse } from "../workers/quality.worker";
import type { PhotoGuide } from "./camera";
import { type DocumentFormat, type FrameAnalysis, formatForDocument, type QualityProfile } from "./quality-core";

export type { CaptureResult };

type Pending = { resolve: (value: WorkerResponse) => void; reject: (error: Error) => void; timeout: number };
type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;

/**
 * Owns one quality worker for the lifetime of a camera screen. Live frames are analysed with the
 * shared core in `live` context; the final burst uses the same wide scene and analysis scale
 * in `capture` context. Only the selected native-resolution photo is cropped for upload.
 */
export class QualityAnalyzer {
  private readonly worker = new Worker(new URL("../workers/quality.worker.ts", import.meta.url));
  private readonly pending = new Map<string, Pending>();
  readonly ready: Promise<void>;

  constructor() {
    this.worker.onmessage = ({ data }: MessageEvent<WorkerResponse>) => {
      const request = this.pending.get(data.id);
      if (!request) return;
      clearTimeout(request.timeout);
      this.pending.delete(data.id);
      if (data.type === "error") request.reject(new Error(data.message));
      else request.resolve(data);
    };
    this.worker.onerror = (event) => {
      event.preventDefault();
      this.failAll(new Error(event.message || "Quality worker failed to load"));
    };
    this.ready = this.send({ type: "warmup" }, [], 30_000).then(() => undefined);
  }

  async analyzeFrame(
    frame: ImageData,
    options: { profile: QualityProfile; format: DocumentFormat; sourceScale: number },
  ): Promise<FrameAnalysis> {
    const response = await this.send(
      { type: "frame", pixels: frame.data.buffer, width: frame.width, height: frame.height, ...options },
      [frame.data.buffer],
      4_000,
    );
    if (response.type !== "frame") throw new Error("Unexpected worker response");
    return response.analysis;
  }

  async analyzeCapture(
    frames: ImageBitmap[],
    options: { profile: QualityProfile; format: DocumentFormat; photoGuide?: PhotoGuide; colorGlarePreview?: boolean },
  ): Promise<CaptureResult> {
    const response = await this.send(
      { type: "capture", frames, jpegQuality: options.profile.capture.jpegQuality, ...options },
      frames,
      20_000,
    );
    if (response.type !== "capture") throw new Error("Unexpected worker response");
    return response.result;
  }

  close() {
    this.failAll(new Error("Quality analyzer closed"));
    this.worker.terminate();
  }

  private send(message: DistributiveOmit<WorkerRequest, "id">, transfer: Transferable[], timeoutMs: number) {
    const id = crypto.randomUUID();
    return new Promise<WorkerResponse>((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("Quality check timed out"));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timeout });
      this.worker.postMessage({ ...message, id }, transfer);
    });
  }

  private failAll(error: Error) {
    for (const request of this.pending.values()) {
      clearTimeout(request.timeout);
      request.reject(error);
    }
    this.pending.clear();
  }
}

let shared: { analyzer: QualityAnalyzer; users: number; idle?: number } | undefined;

/**
 * One worker survives between the front and back captures, so OpenCV (several megabytes of
 * WebAssembly) is compiled once per journey. It is released a minute after its last user.
 */
export function acquireAnalyzer(): { analyzer: QualityAnalyzer; release: () => void } {
  if (!shared) shared = { analyzer: new QualityAnalyzer(), users: 0 };
  const entry = shared;
  window.clearTimeout(entry.idle);
  entry.users += 1;
  let released = false;
  return {
    analyzer: entry.analyzer,
    release: () => {
      if (released) return;
      released = true;
      entry.users -= 1;
      if (entry.users > 0) return;
      entry.idle = window.setTimeout(() => {
        if (entry.users > 0 || shared !== entry) return;
        entry.analyzer.close();
        shared = undefined;
      }, 60_000);
    },
  };
}

/** Analyses an uploaded photo as a final capture; used by the local quality laboratory. */
export async function inspectPhoto(blob: Blob, profile: QualityProfile, documentKind?: string) {
  const analyzer = new QualityAnalyzer();
  try {
    const bitmap = await createImageBitmap(blob);
    const started = performance.now();
    const result = await analyzer.analyzeCapture([bitmap], {
      profile,
      format: formatForDocument(documentKind),
      colorGlarePreview: true,
    });
    return { ...result, durationMs: Math.round(performance.now() - started) };
  } finally {
    analyzer.close();
  }
}
