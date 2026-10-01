import { randomUUID } from "node:crypto";
import pg from "pg";
import { getMigrations } from "better-auth/db/migration";
import { memoryAdapter } from "better-auth/adapters/memory";
import type { AppConfig } from "../config.js";
import { createAdminAuth, emptyAuthTables } from "./auth.js";
import { keyDigest, MemoryApplicationStore, PostgresApplicationStore, type ApplicationStore } from "./store.js";

export async function createManagement(config: AppConfig) {
  const pool =
    config.REPOSITORY_DRIVER === "postgres" ? new pg.Pool({ connectionString: config.DATABASE_URL }) : undefined;
  const applications: ApplicationStore = pool ? new PostgresApplicationStore(pool) : new MemoryApplicationStore();
  const connection = await pool?.connect();
  let auth: ReturnType<typeof createAdminAuth> | undefined;
  try {
    if (connection) {
      await connection.query("BEGIN");
      // Backend, worker and provisioning may boot together against the same database.
      await connection.query("SELECT pg_advisory_xact_lock(731084219)");
    }
    const initializer = connection ? new PostgresApplicationStore(connection) : applications;
    if (initializer instanceof PostgresApplicationStore) await initializer.migrate();
    for (const client of config.clients) {
      const now = new Date().toISOString();
      const created = await initializer.save({
        id: client.id,
        name: client.id === "default" ? "Existing integration" : client.id,
        enabled: true,
        version: 1,
        rules: {
          mode: "exact",
          documents: ["dz-id", "dz-driving-licence", "dz-passport"],
          requiredDocuments: [],
          count: 2,
        },
        webhookUrl: client.webhookDestinations[0]?.url ?? null,
        webhookSecret: client.webhookDestinations[0]?.secret ?? null,
        returnUrl: client.returnDestinations[0]?.url ?? null,
        legacy: {
          allowedPolicies: client.allowedPolicies,
          webhookDestinations: client.webhookDestinations,
          returnDestinations: client.returnDestinations,
        },
        createdAt: now,
        updatedAt: now,
      });
      // Import once. A revoked environment key must never be restored on restart.
      if (created)
        await initializer.addKey(
          {
            id: randomUUID(),
            applicationId: client.id,
            name: "Imported API key",
            prefix: "Imported credential",
            createdAt: now,
            expiresAt: null,
            revokedAt: null,
            lastUsedAt: null,
          },
          keyDigest(client.apiKey),
        );
    }
    auth = config.BETTER_AUTH_SECRET ? createAdminAuth(config, pool ?? memoryAdapter(emptyAuthTables())) : undefined;
    if (auth && pool) await (await getMigrations(auth.options)).runMigrations();
    await connection?.query("COMMIT");
  } catch (error) {
    await connection?.query("ROLLBACK");
    connection?.release();
    await pool?.end();
    throw error;
  }
  connection?.release();
  return {
    applications,
    ...(auth ? { auth } : {}),
    closeManagement: async () => {
      await pool?.end();
    },
  };
}
