import type { DatabaseClient } from './postgres.js';

export interface Migration {
  id: number;
  name: string;
  sql: string;
}

export const MIGRATIONS: Migration[] = [
  {
    id: 1,
    name: 'continuous_monitoring_state',
    sql: `
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS schema_migrations (
  id integer PRIMARY KEY,
  name text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS report_states (
  health_report_s3_uri text PRIMARY KEY,
  report_hash text NOT NULL,
  processed_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS observation_states (
  health_report_s3_uri text NOT NULL,
  observation_key text NOT NULL,
  observation_type text NOT NULL CHECK (observation_type IN ('incident', 'finding')),
  title text NOT NULL,
  classification text NOT NULL,
  affected_services text[] NOT NULL DEFAULT '{}',
  severity text NOT NULL CHECK (severity IN ('NONE', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL')),
  confidence double precision NOT NULL,
  signature text NOT NULL,
  status text NOT NULL CHECK (status IN ('active', 'resolved')),
  first_seen timestamptz NOT NULL,
  last_seen timestamptz NOT NULL,
  last_changed_at timestamptz NOT NULL,
  occurrences integer NOT NULL CHECK (occurrences > 0),
  resolved_at timestamptz,
  PRIMARY KEY (health_report_s3_uri, observation_key)
);

CREATE INDEX IF NOT EXISTS observation_states_status_idx
  ON observation_states (health_report_s3_uri, status, severity);

CREATE TABLE IF NOT EXISTS runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  started_at timestamptz NOT NULL,
  finished_at timestamptz,
  status text NOT NULL,
  health_report_s3_uri text NOT NULL,
  report_hash text,
  summary text,
  overall_severity text,
  raw_classification_json jsonb,
  raw_investigation_json jsonb,
  raw_decision_json jsonb,
  raw_verification_json jsonb,
  error_message text
);

CREATE INDEX IF NOT EXISTS runs_started_at_idx ON runs (started_at DESC);
CREATE INDEX IF NOT EXISTS runs_report_idx ON runs (health_report_s3_uri, report_hash);

CREATE TABLE IF NOT EXISTS incidents (
  incident_id text PRIMARY KEY,
  title text NOT NULL,
  service text,
  severity text NOT NULL CHECK (severity IN ('NONE', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL')),
  state text NOT NULL,
  opened_at timestamptz NOT NULL,
  closed_at timestamptz,
  current_disposition text,
  current_next_stage text,
  current_decision_json jsonb,
  last_run_id uuid REFERENCES runs(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS incidents_state_severity_idx ON incidents (state, severity);

CREATE TABLE IF NOT EXISTS incident_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  incident_id text NOT NULL REFERENCES incidents(incident_id) ON DELETE CASCADE,
  run_id uuid REFERENCES runs(id) ON DELETE SET NULL,
  stage text NOT NULL,
  message text NOT NULL,
  severity text,
  evidence_json jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS incident_events_incident_created_idx
  ON incident_events (incident_id, created_at);

CREATE TABLE IF NOT EXISTS alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  incident_id text NOT NULL REFERENCES incidents(incident_id) ON DELETE CASCADE,
  run_id uuid REFERENCES runs(id) ON DELETE SET NULL,
  channel text NOT NULL,
  sent_at timestamptz NOT NULL DEFAULT now(),
  dedupe_key text NOT NULL UNIQUE,
  payload_json jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS alerts_incident_sent_idx ON alerts (incident_id, sent_at);

CREATE TABLE IF NOT EXISTS worker_heartbeats (
  worker_id text PRIMARY KEY,
  process_name text NOT NULL,
  last_seen_at timestamptz NOT NULL,
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb
);
`,
  },
];

export async function runMigrations(client: DatabaseClient): Promise<void> {
  await client.query('BEGIN');
  try {
    await client.query(`
CREATE TABLE IF NOT EXISTS schema_migrations (
  id integer PRIMARY KEY,
  name text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
)`);

    for (const migration of MIGRATIONS) {
      const existing = await client.query<{ id: number }>(
        'SELECT id FROM schema_migrations WHERE id = $1',
        [migration.id]
      );
      if (existing.rowCount && existing.rowCount > 0) {
        continue;
      }
      await client.query(migration.sql);
      await client.query('INSERT INTO schema_migrations (id, name) VALUES ($1, $2)', [
        migration.id,
        migration.name,
      ]);
    }

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}
