import { documentKinds, type DocumentKind } from "../domain/types.js";
import type { OcrGateway } from "../ports.js";

const adapters: Record<DocumentKind, { title: string; gatewayTypes: string[]; sides: string[] }> = {
  "dz-id": { title: "National identity card", gatewayTypes: ["dz-id-front", "dz-id-back"], sides: ["front", "back"] },
  "dz-driving-licence": {
    title: "Driving licence",
    gatewayTypes: ["dz-driving-licence-front", "dz-driving-licence-back"],
    sides: ["front", "back"],
  },
  "dz-passport": { title: "Passport", gatewayTypes: ["dz-passport"], sides: ["single"] },
};
export async function onboardingCatalog(ocr?: OcrGateway) {
  try {
    if (!ocr?.listDocuments) throw new Error("Gateway discovery is unavailable");
    const documents = await ocr.listDocuments();
    const ids = new Set(documents.map((document) => document.id));
    const supported = documentKinds.map((id) => ({
      id,
      ...adapters[id],
      available: adapters[id].gatewayTypes.every((type) => ids.has(type)),
    }));
    const known = new Set(Object.values(adapters).flatMap((adapter) => adapter.gatewayTypes));
    return {
      gatewayReachable: true,
      documents: supported,
      unsupportedDocuments: documents.filter((document) => !known.has(document.id)),
    };
  } catch {
    return {
      gatewayReachable: false,
      documents: documentKinds.map((id) => ({ id, ...adapters[id], available: false })),
      unsupportedDocuments: [],
    };
  }
}
