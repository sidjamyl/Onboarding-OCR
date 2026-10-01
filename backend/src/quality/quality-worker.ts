import { parentPort } from "node:worker_threads";
import { DocumentQualityEngine } from "./engine.js";
import { type QualityProfile, QualityProfileStore } from "./profile.js";
import { FileTemplateStore } from "./template-store.js";

parentPort?.once(
  "message",
  async (message: {
    image: ArrayBuffer;
    options: { templateId?: string; documentKind?: string; prepare: boolean };
    templateDirectory: string;
    bundledTemplateDirectory?: string;
    profile: QualityProfile;
  }) => {
    try {
      const engine = new DocumentQualityEngine(
        new FileTemplateStore(message.templateDirectory, message.bundledTemplateDirectory),
        new QualityProfileStore(message.profile),
      );
      const { report, ocrImage } = await engine.assess(Buffer.from(message.image), message.options);
      if (!ocrImage) return parentPort?.postMessage({ report });
      const bytes = Uint8Array.from(ocrImage.image);
      parentPort?.postMessage({ report, ocrImage: { ...ocrImage, image: bytes } }, [bytes.buffer]);
    } catch (error) {
      parentPort?.postMessage({ error: error instanceof Error ? error.message : String(error) });
    }
  },
);
