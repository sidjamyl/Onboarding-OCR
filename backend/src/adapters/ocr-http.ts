import type { DocumentKind } from "../domain/types.js";
import type { OcrGateway, OcrInput } from "../ports.js";

/** Preserves safe upstream diagnostics without putting document fields into error logs. */
export class OcrRequestError extends Error {
  readonly response: { error: string; detail?: string };
  constructor(
    readonly upstreamStatus: number,
    payload: Record<string, unknown>,
  ) {
    super(`OCR request failed with status ${upstreamStatus}`);
    this.response = {
      error: typeof payload.error === "string" ? payload.error : "ocr_request_failed",
      ...(typeof payload.detail === "string" ? { detail: payload.detail } : {}),
    };
  }
}

export class HttpOcrGateway implements OcrGateway {
  constructor(
    private readonly config: {
      baseUrl: string;
      username: string;
      password: string;
      timeoutMs: number;
    },
  ) {}

  async extract(kind: DocumentKind, files: OcrInput[]): Promise<Record<string, unknown>> {
    const pair = kind !== "dz-passport";
    const endpoint = pair ? `/v1/extract-pair/${kind}` : `/v1/extract/${kind}`;
    const body = new FormData();
    for (const file of files) {
      body.set(
        pair ? file.name : "file",
        new Blob([new Uint8Array(file.data)], { type: file.contentType }),
        `${file.name}.jpg`,
      );
    }
    return this.request(endpoint, body);
  }

  async listDocuments(): Promise<Array<{ id: string; title: string; version: string }>> {
    const response = await fetch(`${this.config.baseUrl}/v1/documents`, {
      headers: {
        Authorization: `Basic ${Buffer.from(`${this.config.username}:${this.config.password}`).toString("base64")}`,
      },
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) throw new Error("Gateway discovery failed");
    const payload = (await response.json()) as { documents?: Array<{ id: string; title: string; version: string }> };
    if (!Array.isArray(payload.documents) || payload.documents.some((entry) => typeof entry.id !== "string"))
      throw new Error("Invalid gateway catalog");
    return payload.documents;
  }

  async extractSingle(documentType: string, file: OcrInput): Promise<Record<string, unknown>> {
    const body = new FormData();
    body.set("file", new Blob([new Uint8Array(file.data)], { type: file.contentType }), `${file.name}.jpg`);
    return this.request(`/v1/extract/${documentType}`, body);
  }

  async verify(documentType: string, file: OcrInput): Promise<Record<string, unknown>> {
    const body = new FormData();
    body.set("file", new Blob([new Uint8Array(file.data)], { type: file.contentType }), "capture.jpg");
    const result = await this.request(`/v1/verify/${documentType}`, body);
    if (result.verified !== true || result.document !== documentType) {
      throw new OcrRequestError(502, { error: "invalid_verification_response" });
    }
    return result;
  }

  private async request(endpoint: string, body: FormData): Promise<Record<string, unknown>> {
    const response = await fetch(`${this.config.baseUrl}${endpoint}`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${this.config.username}:${this.config.password}`).toString("base64")}`,
      },
      body,
      signal: AbortSignal.timeout(this.config.timeoutMs),
    });
    const payload = (await response.json().catch(() => ({ error: "invalid_ocr_response" }))) as Record<string, unknown>;
    if (!response.ok && (response.status !== 422 || typeof payload.error === "string")) {
      throw new OcrRequestError(response.status, payload);
    }
    if (payload.error === "invalid_ocr_response") throw new OcrRequestError(response.status, payload);
    return payload;
  }
  async health(): Promise<boolean> {
    try {
      return (await fetch(`${this.config.baseUrl}/readyz`, { signal: AbortSignal.timeout(3_000) })).ok;
    } catch {
      return false;
    }
  }
}
