import { PGlite, type Transaction } from '@electric-sql/pglite';
import pg from 'pg';

const { Pool } = pg;

export type SqlParameter = string | number | boolean | Date | null | string[] | Record<string, unknown>;

export interface SqlClient {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    parameters?: SqlParameter[],
  ): Promise<T[]>;
  exec(sql: string): Promise<void>;
}

export interface A2SiteDatabase extends SqlClient {
  transaction<T>(operation: (client: SqlClient) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export interface DatabaseOptions {
  databaseUrl?: string;
  pglitePath?: string;
  maxConnections?: number;
  statementTimeoutMs?: number;
}

export interface DatabaseMigration {
  id: string;
  description: string;
  sql: string;
}

class PostgresClient implements SqlClient {
  constructor(private readonly client: pg.Pool | pg.PoolClient) {}

  async query<T extends Record<string, unknown>>(
    sql: string,
    parameters: SqlParameter[] = [],
  ): Promise<T[]> {
    const result = await this.client.query(sql, parameters as never[]);
    return result.rows as T[];
  }

  async exec(sql: string): Promise<void> {
    await this.client.query(sql);
  }
}

export class PostgresDatabase implements A2SiteDatabase {
  private readonly pool: pg.Pool;

  constructor(options: DatabaseOptions) {
    if (!options.databaseUrl) throw new Error('PostgreSQL 连接需要 databaseUrl');
    this.pool = new Pool({
      connectionString: options.databaseUrl,
      max: options.maxConnections ?? 10,
      statement_timeout: options.statementTimeoutMs ?? 10_000,
      connectionTimeoutMillis: 5_000,
      idleTimeoutMillis: 30_000,
    });
  }

  query<T extends Record<string, unknown>>(
    sql: string,
    parameters: SqlParameter[] = [],
  ): Promise<T[]> {
    return new PostgresClient(this.pool).query<T>(sql, parameters);
  }

  exec(sql: string): Promise<void> {
    return new PostgresClient(this.pool).exec(sql);
  }

  async transaction<T>(operation: (client: SqlClient) => Promise<T>): Promise<T> {
    const connection = await this.pool.connect();
    try {
      await connection.query('BEGIN');
      const result = await operation(new PostgresClient(connection));
      await connection.query('COMMIT');
      return result;
    } catch (error) {
      await connection.query('ROLLBACK');
      throw error;
    } finally {
      connection.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

class EmbeddedClient implements SqlClient {
  constructor(private readonly client: PGlite | Transaction) {}

  async query<T extends Record<string, unknown>>(
    sql: string,
    parameters: SqlParameter[] = [],
  ): Promise<T[]> {
    const result = await this.client.query<T>(sql, parameters);
    return result.rows;
  }

  async exec(sql: string): Promise<void> {
    await this.client.exec(sql);
  }
}

export class PGliteDatabase implements A2SiteDatabase {
  private readonly database: PGlite;

  constructor(path?: string) {
    this.database = path ? new PGlite(path) : new PGlite();
  }

  async ready(): Promise<void> {
    await this.database.waitReady;
  }

  query<T extends Record<string, unknown>>(
    sql: string,
    parameters: SqlParameter[] = [],
  ): Promise<T[]> {
    return new EmbeddedClient(this.database).query<T>(sql, parameters);
  }

  exec(sql: string): Promise<void> {
    return new EmbeddedClient(this.database).exec(sql);
  }

  async transaction<T>(operation: (client: SqlClient) => Promise<T>): Promise<T> {
    return this.database.transaction(async (transaction) => operation(new EmbeddedClient(transaction)));
  }

  async close(): Promise<void> {
    await this.database.close();
  }
}

export async function createDatabase(options: DatabaseOptions = {}): Promise<A2SiteDatabase> {
  if (options.databaseUrl) return new PostgresDatabase(options);
  const database = new PGliteDatabase(options.pglitePath);
  await database.ready();
  return database;
}

export async function runMigrations(
  database: A2SiteDatabase,
  migrations: DatabaseMigration[],
): Promise<string[]> {
  await database.exec(`
    CREATE TABLE IF NOT EXISTS a2site_schema_migrations (
      id TEXT PRIMARY KEY,
      description TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  const applied: string[] = [];
  for (const migration of migrations) {
    await database.transaction(async (client) => {
      const existing = await client.query<{ id: string }>(
        'SELECT id FROM a2site_schema_migrations WHERE id=$1',
        [migration.id],
      );
      if (existing.length > 0) return;
      await client.exec(migration.sql);
      await client.query(
        `INSERT INTO a2site_schema_migrations(id,description)
         VALUES($1,$2) ON CONFLICT(id) DO NOTHING`,
        [migration.id, migration.description],
      );
      applied.push(migration.id);
    });
  }
  return applied;
}
