import { expireIfNeeded } from "../domain/workflow.js";
import type { SessionRepository, TaskQueue } from "../ports.js";
import { DurableTaskDispatcher } from "./durable-tasks.js";

export class ExpirationService {
  private readonly tasks: DurableTaskDispatcher;

  constructor(
    private readonly sessions: SessionRepository,
    queue: TaskQueue,
  ) {
    this.tasks = new DurableTaskDispatcher(sessions, queue);
  }

  async process(now = new Date()): Promise<number> {
    const expired = (await this.sessions.findExpiredBefore?.(now)) ?? [];
    let completed = 0;
    for (const session of expired) {
      const previousStatus = session.status;
      expireIfNeeded(session, now);
      this.tasks.prepare(session, now);
      if (session.status !== previousStatus) {
        try {
          await this.sessions.save(session);
        } catch {
          // A concurrent user mutation won the optimistic lock. The next sweep
          // will evaluate the latest aggregate instead of overwriting it.
          continue;
        }
      }
      if (session.status !== "expired") continue;
      await this.tasks.dispatch(session);
      completed += 1;
    }
    return completed;
  }
}
