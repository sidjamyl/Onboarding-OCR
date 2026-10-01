import { createRuntime } from "./runtime.js";
import { ExpirationService } from "./services/expiration.js";

const runtime = await createRuntime({ consumeJobs: true });
const expiration = new ExpirationService(runtime.sessions, runtime.queue);
const purge = async () => {
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60_000);
  const expiredSessions = (await runtime.sessions.findOlderThan?.(cutoff)) ?? [];
  const objectKeys = expiredSessions.flatMap((session) =>
    Object.values(session.documents).flatMap((document) =>
      document
        ? Object.values(document.captures).flatMap((capture) =>
            capture ? [capture.objectKey, ...(capture.ocrObjectKey ? [capture.ocrObjectKey] : [])] : [],
          )
        : [],
    ),
  );
  await Promise.all(objectKeys.map((key) => runtime.captures.remove(key)));
  const deleted = await runtime.sessions.purgeOlderThan?.(cutoff);
  if (deleted) console.info(`Purged ${deleted} expired onboarding sessions`);
};
await purge();
await expiration.process();
await runtime.tasks.recover();
const retentionTimer = setInterval(
  () => void purge().catch((error) => console.error("Retention sweep failed", error)),
  24 * 60 * 60_000,
);
retentionTimer.unref();
const expirationTimer = setInterval(
  () =>
    void expiration
      .process()
      .then(() => runtime.tasks.recover())
      .catch((error) => console.error("Pending work sweep failed", error)),
  60_000,
);
expirationTimer.unref();
const close = async () => {
  await runtime.queue.stop();
  await runtime.closeManagement();
  process.exit(0);
};
process.on("SIGTERM", close);
process.on("SIGINT", close);
console.info("Onboarding extraction worker is ready");
