import type { OnboardingSession } from "../domain/types.js";
import type { CaptureStore, SessionRepository } from "../ports.js";

function clone<T>(value: T): T {
  return structuredClone(value);
}

export class MemorySessionRepository implements SessionRepository {
  readonly #sessions = new Map<string, OnboardingSession>();
  readonly #idempotency = new Map<string, string>();

  async create(session: OnboardingSession, idempotencyKey: string): Promise<OnboardingSession> {
    const existingId = this.#idempotency.get(idempotencyKey);
    if (existingId) {
      const existing = this.#sessions.get(existingId);
      if (existing) return clone(existing);
      this.#idempotency.delete(idempotencyKey);
    }
    this.#sessions.set(session.id, clone(session));
    this.#idempotency.set(idempotencyKey, session.id);
    return clone(session);
  }

  async findById(id: string): Promise<OnboardingSession | null> {
    const session = this.#sessions.get(id);
    return session ? clone(session) : null;
  }

  async findByPublicToken(token: string): Promise<OnboardingSession | null> {
    const session = [...this.#sessions.values()].find((candidate) => candidate.publicToken === token);
    return session ? clone(session) : null;
  }

  async mutateByPublicToken<T>(
    token: string,
    mutate: (session: OnboardingSession) => T,
  ): Promise<{ session: OnboardingSession; result: T } | null> {
    const stored = [...this.#sessions.values()].find((candidate) => candidate.publicToken === token);
    if (!stored) return null;
    const session = clone(stored);
    const result = mutate(session);
    this.#sessions.set(session.id, clone(session));
    return { session: clone(session), result };
  }

  async findExpiredBefore(date: Date): Promise<OnboardingSession[]> {
    return [...this.#sessions.values()]
      .filter(
        (session) =>
          (session.status === "expired" && !session.webhookQueuedAt) ||
          (!["succeeded", "document_failed", "consistency_failed", "technical_failed", "expired"].includes(
            session.status,
          ) &&
            new Date(session.expiresAt) <= date),
      )
      .map(clone);
  }

  async findPendingWork(): Promise<OnboardingSession[]> {
    return [...this.#sessions.values()]
      .filter(
        (session) =>
          (isFinal(session.status) && !session.webhookDeliveredAt) ||
          Object.values(session.documents).some(
            (document) =>
              document?.status === "processing" ||
              Object.values(document?.sideResults ?? {}).some((side) => side?.status !== "ready"),
          ),
      )
      .map(clone);
  }

  async findOlderThan(date: Date): Promise<OnboardingSession[]> {
    return [...this.#sessions.values()].filter((session) => new Date(session.createdAt) < date).map(clone);
  }

  async save(session: OnboardingSession): Promise<void> {
    this.#sessions.set(session.id, clone(session));
  }
  async purgeOlderThan(date: Date): Promise<number> {
    let deleted = 0;
    for (const [id, session] of this.#sessions) {
      if (new Date(session.createdAt) < date) {
        this.#sessions.delete(id);
        deleted += 1;
      }
    }
    return deleted;
  }
  async health() {
    return true;
  }
}

function isFinal(status: OnboardingSession["status"]): boolean {
  return ["succeeded", "document_failed", "consistency_failed", "technical_failed", "expired"].includes(status);
}

export class MemoryCaptureStore implements CaptureStore {
  readonly #objects = new Map<string, Buffer>();
  async put(key: string, data: Buffer): Promise<void> {
    this.#objects.set(key, Buffer.from(data));
  }
  async get(key: string): Promise<Buffer> {
    const value = this.#objects.get(key);
    if (!value) throw new Error(`Capture not found: ${key}`);
    return Buffer.from(value);
  }
  async remove(key: string): Promise<void> {
    this.#objects.delete(key);
  }
  async health() {
    return true;
  }
}
