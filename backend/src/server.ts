import { buildApp } from "./app.js";
import { createRuntime } from "./runtime.js";

const runtime = await createRuntime({ consumeJobs: process.env.QUEUE_CONSUMER !== "false" });
const app = await buildApp(runtime);

const close = async () => {
  await app.close();
  await runtime.queue.stop();
};
process.on("SIGTERM", close);
process.on("SIGINT", close);

await app.listen({ host: runtime.config.HOST, port: runtime.config.PORT });
