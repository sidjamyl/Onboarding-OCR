import { createHash, randomBytes, randomUUID } from "node:crypto";
import type pg from "pg";
import type { ApiKeyRecord, ClientApplication } from "./model.js";

export interface ApplicationStore {
  list(): Promise<ClientApplication[]>;
  find(id: string): Promise<ClientApplication | null>;
  save(application: ClientApplication, expectedVersion?: number): Promise<boolean>;
  authenticate(key: string): Promise<ClientApplication | null>;
  keys(applicationId: string): Promise<ApiKeyRecord[]>;
  addKey(record: ApiKeyRecord, digest: string): Promise<void>;
  revokeKey(applicationId: string, keyId: string): Promise<boolean>;
}
export const keyDigest = (key: string) => createHash("sha256").update(key).digest("hex");
export async function issueKey(
  store: ApplicationStore,
  applicationId: string,
  name: string,
  expiresAt: string | null = null,
) {
  const key = `ocr_live_${randomBytes(32).toString("base64url")}`;
  const record: ApiKeyRecord = {
    id: randomUUID(),
    applicationId,
    name,
    prefix: key.slice(0, 17),
    createdAt: new Date().toISOString(),
    expiresAt,
    revokedAt: null,
    lastUsedAt: null,
  };
  await store.addKey(record, keyDigest(key));
  return { ...record, key };
}

export class MemoryApplicationStore implements ApplicationStore {
  private applications = new Map<string, ClientApplication>();
  private credentials = new Map<string, { record: ApiKeyRecord; digest: string }>();
  async list() {
    return structuredClone([...this.applications.values()]);
  }
  async find(id: string) {
    return structuredClone(this.applications.get(id) ?? null);
  }
  async save(application: ClientApplication, expectedVersion?: number) {
    const current = this.applications.get(application.id);
    if (expectedVersion == null ? Boolean(current) : current?.version !== expectedVersion) return false;
    this.applications.set(application.id, structuredClone(application));
    return true;
  }
  async authenticate(key: string) {
    const now = new Date().toISOString();
    const entry = [...this.credentials.values()].find(
      ({ digest, record }) =>
        digest === keyDigest(key) && !record.revokedAt && (!record.expiresAt || record.expiresAt > now),
    );
    if (!entry) return null;
    const application = await this.find(entry.record.applicationId);
    if (!application?.enabled) return null;
    entry.record.lastUsedAt = now;
    return application;
  }
  async keys(applicationId: string) {
    return structuredClone(
      [...this.credentials.values()]
        .filter(({ record }) => record.applicationId === applicationId)
        .map(({ record }) => record),
    );
  }
  async addKey(record: ApiKeyRecord, digest: string) {
    this.credentials.set(record.id, { record: structuredClone(record), digest });
  }
  async revokeKey(applicationId: string, keyId: string) {
    const entry = this.credentials.get(keyId);
    if (!entry || entry.record.applicationId !== applicationId) return false;
    entry.record.revokedAt ??= new Date().toISOString();
    return true;
  }
}

export class PostgresApplicationStore implements ApplicationStore {
  constructor(readonly pool: Pick<pg.Pool, "query">) {}
  async migrate() {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS onboarding_applications (id text PRIMARY KEY, version integer NOT NULL, data jsonb NOT NULL);
      CREATE TABLE IF NOT EXISTS onboarding_api_keys (
        id uuid PRIMARY KEY, application_id text NOT NULL REFERENCES onboarding_applications(id),
        digest text NOT NULL UNIQUE, data jsonb NOT NULL
      );
      CREATE INDEX IF NOT EXISTS onboarding_api_keys_application_idx ON onboarding_api_keys(application_id);
    `);
  }
  async list() {
    return (
      await this.pool.query<{ data: ClientApplication }>(
        "SELECT data FROM onboarding_applications ORDER BY data->>'createdAt' DESC",
      )
    ).rows.map(({ data }) => data);
  }
  async find(id: string) {
    return (
      (await this.pool.query<{ data: ClientApplication }>("SELECT data FROM onboarding_applications WHERE id=$1", [id]))
        .rows[0]?.data ?? null
    );
  }
  async save(application: ClientApplication, expectedVersion?: number) {
    const result =
      expectedVersion == null
        ? await this.pool.query(
            "INSERT INTO onboarding_applications (id, version, data) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING",
            [application.id, application.version, application],
          )
        : await this.pool.query("UPDATE onboarding_applications SET version=$2, data=$3 WHERE id=$1 AND version=$4", [
            application.id,
            application.version,
            application,
            expectedVersion,
          ]);
    return result.rowCount === 1;
  }
  async authenticate(key: string) {
    const now = new Date().toISOString();
    const result = await this.pool.query<{ data: ClientApplication }>(
      `
      WITH used AS (
        UPDATE onboarding_api_keys k SET data=jsonb_set(k.data, '{lastUsedAt}', to_jsonb($2::text))
        FROM onboarding_applications a
        WHERE k.application_id=a.id AND k.digest=$1 AND k.data->>'revokedAt' IS NULL
          AND (k.data->>'expiresAt' IS NULL OR k.data->>'expiresAt'>$2)
          AND a.data->>'enabled'='true'
        RETURNING k.application_id
      ) SELECT a.data FROM onboarding_applications a JOIN used ON used.application_id=a.id
    `,
      [keyDigest(key), now],
    );
    return result.rows[0]?.data ?? null;
  }
  async keys(applicationId: string) {
    return (
      await this.pool.query<{ data: ApiKeyRecord }>(
        "SELECT data FROM onboarding_api_keys WHERE application_id=$1 ORDER BY data->>'createdAt' DESC",
        [applicationId],
      )
    ).rows.map(({ data }) => data);
  }
  async addKey(record: ApiKeyRecord, digest: string) {
    await this.pool.query("INSERT INTO onboarding_api_keys (id, application_id, digest, data) VALUES ($1,$2,$3,$4)", [
      record.id,
      record.applicationId,
      digest,
      record,
    ]);
  }
  async revokeKey(applicationId: string, keyId: string) {
    const result = await this.pool.query(
      "UPDATE onboarding_api_keys SET data=jsonb_set(data,'{revokedAt}',to_jsonb($3::text)) WHERE id=$1 AND application_id=$2",
      [keyId, applicationId, new Date().toISOString()],
    );
    return result.rowCount === 1;
  }
}
