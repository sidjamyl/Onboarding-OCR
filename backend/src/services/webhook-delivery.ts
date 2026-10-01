import type { SessionRepository, WebhookGateway } from "../ports.js";

export class WebhookDeliveryService {
  constructor(
    private readonly sessions: SessionRepository,
    private readonly webhooks: WebhookGateway,
  ) {}
  async process(input: { sessionId: string }) {
    const session = await this.sessions.findById(input.sessionId);
    if (!session) throw new Error("Session not found for webhook delivery");
    if (session.webhookDeliveredAt) return;
    const started = performance.now();
    await this.webhooks.sendCompleted(session);
    for (const document of Object.values(session.documents))
      if (document) {
        document.timingsMs.webhookDelivery = Math.round((performance.now() - started) * 100) / 100;
      }
    session.version += 1;
    session.updatedAt = new Date().toISOString();
    session.webhookDeliveredAt = session.updatedAt;
    await this.sessions.save(session);
  }
}
