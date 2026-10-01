import pg from "pg";
import type { OnboardingSession } from "../domain/types.js";
import type { SessionRepository } from "../ports.js";

export class PostgresSessionRepository implements SessionRepository {
  readonly #pool: pg.Pool;
  constructor(connectionString: string) {
    this.#pool = new pg.Pool({ connectionString });
  }

  async migrate(): Promise<void> {
    await this.#pool.query(`
      CREATE TABLE IF NOT EXISTS onboarding_sessions (
        id uuid PRIMARY KEY,
        public_token text UNIQUE NOT NULL,
        idempotency_key text UNIQUE NOT NULL,
        client_reference text NOT NULL,
        status text NOT NULL,
        aggregate jsonb NOT NULL,
        created_at timestamptz NOT NULL,
        updated_at timestamptz NOT NULL
      );
      CREATE INDEX IF NOT EXISTS onboarding_sessions_client_reference_idx
        ON onboarding_sessions(client_reference);
    `);
  }

  async create(session: OnboardingSession, idempotencyKey: string): Promise<OnboardingSession> {
    const result = await this.#pool.query<{ aggregate: OnboardingSession }>(
      `
      INSERT INTO onboarding_sessions
        (id, public_token, idempotency_key, client_reference, status, aggregate, created_at, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      ON CONFLICT (idempotency_key) DO UPDATE SET idempotency_key = EXCLUDED.idempotency_key
      RETURNING aggregate
    `,
      [
        session.id,
        session.publicToken,
        idempotencyKey,
        session.clientReference,
        session.status,
        session,
        session.createdAt,
        session.updatedAt,
      ],
    );
    const created = result.rows[0]?.aggregate;
    if (!created) throw new Error("PostgreSQL did not return the created session");
    return created;
  }

  async findById(id: string): Promise<OnboardingSession | null> {
    const result = await this.#pool.query<{ aggregate: OnboardingSession }>(
      "SELECT aggregate FROM onboarding_sessions WHERE id = $1",
      [id],
    );
    return result.rows[0]?.aggregate ?? null;
  }

  async findByPublicToken(token: string): Promise<OnboardingSession | null> {
    const result = await this.#pool.query<{ aggregate: OnboardingSession }>(
      "SELECT aggregate FROM onboarding_sessions WHERE public_token = $1",
      [token],
    );
    return result.rows[0]?.aggregate ?? null;
  }

  async mutateByPublicToken<T>(
    token: string,
    mutate: (session: OnboardingSession) => T,
  ): Promise<{ session: OnboardingSession; result: T } | null> {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      const selected = await client.query<{ aggregate: OnboardingSession }>(
        "SELECT aggregate FROM onboarding_sessions WHERE public_token = $1 FOR UPDATE",
        [token],
      );
      const session = selected.rows[0]?.aggregate;
      if (!session) {
        await client.query("ROLLBACK");
        return null;
      }
      const result = mutate(session);
      await client.query("UPDATE onboarding_sessions SET aggregate = $2, status = $3, updated_at = $4 WHERE id = $1", [
        session.id,
        session,
        session.status,
        session.updatedAt,
      ]);
      await client.query("COMMIT");
      return { session, result };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async findExpiredBefore(date: Date): Promise<OnboardingSession[]> {
    const result = await this.#pool.query<{ aggregate: OnboardingSession }>(
      `SELECT aggregate FROM onboarding_sessions
       WHERE (status = 'expired' AND NOT (aggregate ? 'webhookQueuedAt'))
          OR (status NOT IN ('succeeded', 'document_failed', 'consistency_failed', 'technical_failed', 'expired')
              AND (aggregate->>'expiresAt')::timestamptz <= $1)
       ORDER BY updated_at ASC
       LIMIT 100`,
      [date],
    );
    return result.rows.map((row) => row.aggregate);
  }

  async findPendingWork(): Promise<OnboardingSession[]> {
    const result = await this.#pool.query<{ aggregate: OnboardingSession }>(`
      SELECT aggregate FROM onboarding_sessions
      WHERE (status IN ('succeeded', 'document_failed', 'consistency_failed', 'technical_failed', 'expired')
             AND NOT (aggregate ? 'webhookDeliveredAt'))
         OR jsonb_path_exists(aggregate, '$.documents.* ? (@.status == "processing")')
         OR jsonb_path_exists(aggregate, '$.documents.*.sideResults.* ? (@.status != "ready")')
      ORDER BY updated_at ASC
      LIMIT 100
    `);
    return result.rows.map((row) => row.aggregate);
  }

  async findOlderThan(date: Date): Promise<OnboardingSession[]> {
    const result = await this.#pool.query<{ aggregate: OnboardingSession }>(
      "SELECT aggregate FROM onboarding_sessions WHERE created_at < $1 ORDER BY created_at ASC",
      [date],
    );
    return result.rows.map((row) => row.aggregate);
  }

  async save(session: OnboardingSession): Promise<void> {
    const result = await this.#pool.query(
      `UPDATE onboarding_sessions SET aggregate = $2, status = $3, updated_at = $4
       WHERE id = $1 AND (aggregate->>'version')::int < $5`,
      [session.id, session, session.status, session.updatedAt, session.version],
    );
    if (result.rowCount !== 1) throw new Error("Concurrent session update detected");
  }

  async purgeOlderThan(date: Date): Promise<number> {
    const result = await this.#pool.query("DELETE FROM onboarding_sessions WHERE created_at < $1", [date]);
    return result.rowCount ?? 0;
  }
  async health(): Promise<boolean> {
    try {
      await this.#pool.query("SELECT 1");
      return true;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    await this.#pool.end();
  }
}
