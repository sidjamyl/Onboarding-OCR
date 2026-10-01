import type { OnboardingSession } from "../domain/types.js";
import type { SessionRepository, TaskQueue } from "../ports.js";

const finalStatuses: OnboardingSession["status"][] = [
  "succeeded",
  "document_failed",
  "consistency_failed",
  "technical_failed",
  "expired",
];

export class DurableTaskDispatcher {
  constructor(
    private readonly sessions: SessionRepository,
    private readonly queue: TaskQueue,
  ) {}

  prepare(session: OnboardingSession, now = new Date()): void {
    if (finalStatuses.includes(session.status) && !session.webhookQueuedAt && !session.webhookDeliveredAt) {
      session.webhookQueuedAt = now.toISOString();
    }
  }

  async dispatch(session: OnboardingSession): Promise<void> {
    for (const document of Object.values(session.documents)) {
      if (!document || finalStatuses.includes(session.status)) continue;
      // Existing reviewed sessions predate per-face jobs; do not re-extract their accepted documents.
      if (!document.sideResults && document.status !== "processing") continue;
      let pending = false;
      for (const side of document.requiredSides) {
        const capture = document.captures[side];
        if (!capture) continue;
        const result = document.sideResults?.[side];
        if (result?.captureId === capture.id && result.status === "ready") continue;
        pending = true;
        if (result?.status === "processing" && (result.leaseUntil ?? 0) > Date.now()) continue;
        await this.queue.enqueueExtraction({ sessionId: session.id, kind: document.kind, side, captureId: capture.id });
      }
      // Recover a crash between persisting the final face and joining its readings.
      if (
        !pending &&
        document.status === "processing" &&
        document.requiredSides.every((side) => document.captures[side])
      )
        await this.queue.enqueueExtraction({ sessionId: session.id, kind: document.kind });
    }
    if (finalStatuses.includes(session.status) && session.webhookQueuedAt && !session.webhookDeliveredAt) {
      await this.queue.enqueueWebhook({ sessionId: session.id });
    }
  }

  async recover(): Promise<number> {
    const sessions = (await this.sessions.findPendingWork?.()) ?? [];
    let dispatched = 0;
    for (const session of sessions) {
      const hadPendingMarker = Boolean(session.webhookQueuedAt);
      this.prepare(session);
      if (!hadPendingMarker && session.webhookQueuedAt) {
        session.version += 1;
        session.updatedAt = new Date().toISOString();
        try {
          await this.sessions.save(session);
        } catch {
          continue;
        }
      }
      await this.dispatch(session);
      dispatched += 1;
    }
    return dispatched;
  }
}
