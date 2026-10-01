import { createHmac } from "node:crypto";
import type { OnboardingSession } from "../domain/types.js";
import type { WebhookGateway } from "../ports.js";

export class HttpWebhookGateway implements WebhookGateway {
  constructor(private readonly destinations: Map<string, { url: string; secret: string }>) {}
  async sendCompleted(session: OnboardingSession): Promise<void> {
    if (!session.webhookDestinationId && !session.webhookDestination) return;
    const destination =
      session.webhookDestination ??
      this.destinations.get(`${session.clientApplicationId}:${session.webhookDestinationId}`);
    if (!destination) throw new Error("Webhook destination is not registered");
    const body = JSON.stringify({
      eventId: session.webhookEventId,
      event: "onboarding.completed",
      sessionId: session.id,
      status: session.status,
      reasonCode: session.reasonCode ?? null,
      completedAt: session.result?.completedAt ?? session.updatedAt,
    });
    const signature = createHmac("sha256", destination.secret).update(body).digest("hex");
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const response = await fetch(destination.url, {
          method: "POST",
          headers: { "content-type": "application/json", "x-onboarding-signature": `sha256=${signature}` },
          body,
          signal: AbortSignal.timeout(10_000),
        });
        if (response.ok) return;
        lastError = new Error(`Webhook returned ${response.status}`);
      } catch (error) {
        lastError = error;
      }
      await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** attempt));
    }
    throw lastError;
  }
  async health() {
    return true;
  }
}
