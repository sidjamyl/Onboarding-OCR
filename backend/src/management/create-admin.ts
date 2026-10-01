import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import { loadConfig } from "../config.js";
import { provisionAdministrator } from "./auth.js";
import { createManagement } from "./runtime.js";

const config = loadConfig();
if (config.REPOSITORY_DRIVER !== "postgres")
  throw new Error("Administrator provisioning requires durable PostgreSQL storage");
const email = z.email().parse(process.argv[2] ?? process.env.ADMIN_EMAIL ?? "admin@onboarding.local");
const password = process.env.ADMIN_PASSWORD ?? randomBytes(24).toString("base64url");
const management = await createManagement(config);
try {
  if (!management.auth) throw new Error("Set BETTER_AUTH_SECRET before provisioning an administrator");
  await provisionAdministrator(management.auth, email, password);
  const directory = resolve(".local");
  await mkdir(directory, { recursive: true });
  const path = resolve(directory, "admin-access.txt");
  await writeFile(
    path,
    `Administration: ${config.PUBLIC_BASE_URL}/admin\nEmail: ${email}\nPassword: ${password}\n\nStore this password in your password manager, then remove this file.\n`,
    { mode: 0o600 },
  );
  console.info(`Administrator provisioned. Credentials were written to ${path}; no password is printed.`);
} finally {
  await management.closeManagement();
}
