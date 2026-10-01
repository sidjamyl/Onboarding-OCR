import { Worker } from "node:worker_threads";
import type { QualityReport } from "../domain/types.js";
import type { QualityAssessment, QualityEngine } from "../ports.js";
import type { QualityProfileSource } from "./profile.js";

/** Runs the CPU-heavy OpenCV analysis in a worker thread so the Fastify event loop stays free. */
export class WorkerThreadQualityEngine implements QualityEngine {
  constructor(
    private readonly templateDirectory: string,
    private readonly profiles: QualityProfileSource,
    private readonly timeoutMs = 20_000,
    private readonly bundledTemplateDirectory?: string,
  ) {}

  async analyze(image: Buffer, templateId?: string): Promise<QualityReport> {
    return (await this.run(image, { ...(templateId ? { templateId } : {}), prepare: false })).report;
  }

  assess(
    image: Buffer,
    options: { templateId?: string; documentKind?: string; prepare?: boolean },
  ): Promise<QualityAssessment> {
    return this.run(image, { ...options, prepare: options.prepare ?? true });
  }

  private run(
    image: Buffer,
    options: { templateId?: string; documentKind?: string; prepare: boolean },
  ): Promise<QualityAssessment> {
    const worker = new Worker(new URL("./quality-worker.js", import.meta.url));
    const bytes = Uint8Array.from(image);
    return new Promise<QualityAssessment>((resolve, reject) => {
      const timeout = setTimeout(() => {
        void worker.terminate();
        reject(new Error("Image quality worker timed out"));
      }, this.timeoutMs);
      worker.once(
        "message",
        (message: {
          report?: QualityReport;
          ocrImage?: QualityAssessment["ocrImage"] & { image: Uint8Array };
          error?: string;
        }) => {
          clearTimeout(timeout);
          void worker.terminate();
          if (message.error) reject(new Error(message.error));
          else if (message.report)
            resolve({
              report: message.report,
              ...(message.ocrImage
                ? { ocrImage: { ...message.ocrImage, image: Buffer.from(message.ocrImage.image) } }
                : {}),
            });
          else reject(new Error("Quality worker returned no report"));
        },
      );
      worker.once("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      worker.postMessage(
        {
          image: bytes.buffer,
          options,
          templateDirectory: this.templateDirectory,
          bundledTemplateDirectory: this.bundledTemplateDirectory,
          profile: this.profiles.current(),
        },
        [bytes.buffer],
      );
    });
  }
}
