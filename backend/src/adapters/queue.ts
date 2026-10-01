import PgBoss from "pg-boss";
import type { ExtractionTask, TaskQueue } from "../ports.js";

type Handlers = {
  extraction?: (input: ExtractionTask) => Promise<void>;
  webhook?: (input: { sessionId: string }) => Promise<void>;
};

export class InlineTaskQueue implements TaskQueue {
  #handlers: Handlers | undefined;
  readonly #running = new Map<string, Promise<void>>();
  async start(handlers?: Handlers): Promise<void> {
    this.#handlers = handlers;
  }
  async enqueueExtraction(input: ExtractionTask): Promise<void> {
    const handler = this.#handlers?.extraction;
    if (!handler) throw new Error("Extraction worker has not started");
    const key = `${input.sessionId}:${input.kind}:${input.side ?? "join"}:${input.captureId ?? "latest"}`;
    if (this.#running.has(key)) return;
    // Capture admission returns immediately, while the next face can be photographed.
    const task = Promise.resolve()
      .then(async () => {
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            await handler(input);
            return;
          } catch {
            if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 20));
          }
        }
      })
      .finally(() => {
        this.#running.delete(key);
      });
    this.#running.set(key, task);
  }
  async enqueueWebhook(input: { sessionId: string }): Promise<void> {
    await this.#handlers?.webhook?.(input);
  }
  /** Await current background work for shutdown and deterministic integration checks. */
  async drain(): Promise<void> {
    while (this.#running.size) await Promise.all(this.#running.values());
  }
  async stop(): Promise<void> {
    await this.drain();
  }
  async health() {
    return Boolean(this.#handlers);
  }
}

export class PgBossTaskQueue implements TaskQueue {
  readonly #boss: PgBoss;
  #started = false;
  constructor(connectionString: string) {
    this.#boss = new PgBoss(connectionString);
  }
  async start(handlers?: Handlers): Promise<void> {
    await this.#boss.start();
    this.#started = true;
    await this.#boss.createQueue("extract-document");
    await this.#boss.createQueue("deliver-webhook");
    if (handlers?.extraction) {
      // Two independent workers let both faces progress without serialising the pair.
      for (let worker = 0; worker < 2; worker++)
        await this.#boss.work<ExtractionTask>("extract-document", async (jobs) => {
          for (const job of jobs) await handlers.extraction?.(job.data);
        });
    }
    if (handlers?.webhook)
      await this.#boss.work<{ sessionId: string }>("deliver-webhook", async (jobs) => {
        for (const job of jobs) await handlers.webhook?.(job.data);
      });
  }
  async enqueueExtraction(input: ExtractionTask): Promise<void> {
    await this.#boss.send("extract-document", input, {
      retryLimit: 3,
      retryDelay: 5,
      expireInSeconds: 240,
      singletonKey: `${input.sessionId}:${input.kind}:${input.side ?? "join"}:${input.captureId ?? "latest"}`,
    });
  }
  async enqueueWebhook(input: { sessionId: string }): Promise<void> {
    await this.#boss.send("deliver-webhook", input, {
      retryLimit: 8,
      retryBackoff: true,
      retryDelay: 15,
      expireInSeconds: 600,
      singletonKey: input.sessionId,
    });
  }
  async stop(): Promise<void> {
    await this.#boss.stop({ graceful: true, timeout: 10_000 });
    this.#started = false;
  }
  async health() {
    return this.#started;
  }
}
