import { loadEnvFile } from '../env.js';
import { loadConfig } from '../config.js';
import { createPostgresPool } from './postgres.js';
import { runMigrations } from './migrations.js';

async function main(): Promise<void> {
  loadEnvFile();
  const config = loadConfig();
  const pool = createPostgresPool(config);

  try {
    await runMigrations(pool);
    console.log('[DB] Migrations complete');
  } finally {
    await pool.end();
  }
}

void main().catch((error) => {
  console.error('[DB] Migration failed:', error);
  process.exit(1);
});
