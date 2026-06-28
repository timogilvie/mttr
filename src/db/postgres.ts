import { Pool, type PoolConfig, type QueryResult, type QueryResultRow } from 'pg';
import type { Config } from '../config.js';

export interface DatabaseClient {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    params?: readonly unknown[]
  ): Promise<QueryResult<T>>;
}

export interface DatabasePool extends DatabaseClient {
  end(): Promise<void>;
}

export function createPostgresPool(config: Config): DatabasePool {
  if (!config.database.runtimeUrl) {
    throw new Error('DATABASE_URL or POOLED_DATABASE_URL is required to create a Postgres pool');
  }

  const poolConfig: PoolConfig = {
    connectionString: config.database.runtimeUrl,
    max: config.database.maxConnections,
    idleTimeoutMillis: config.database.idleTimeoutMs,
  };

  if (config.database.ssl) {
    poolConfig.ssl = { rejectUnauthorized: false };
  }

  return new Pool(poolConfig);
}
