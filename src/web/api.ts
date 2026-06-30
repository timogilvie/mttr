import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import type { Config } from '../config.js';
import type { DatabaseClient, DatabasePool } from '../db/postgres.js';
import { createPostgresPool } from '../db/postgres.js';
import type { Severity } from '../types.js';

type JsonRecord = Record<string, unknown>;

interface RunRow {
  id: string;
  started_at: Date | string;
  finished_at: Date | string | null;
  status: string;
  health_report_s3_uri: string;
  report_hash: string | null;
  summary: string | null;
  overall_severity: Severity | null;
  raw_classification_json?: unknown;
  raw_investigation_json?: unknown;
  raw_decision_json?: unknown;
  raw_verification_json?: unknown;
  error_message: string | null;
}

interface IncidentRow {
  incident_id: string;
  title: string;
  service: string | null;
  severity: Severity;
  state: string;
  opened_at: Date | string;
  closed_at: Date | string | null;
  current_disposition: string | null;
  current_next_stage: string | null;
  current_decision_json: unknown;
  last_run_id: string | null;
}

interface IncidentEventRow {
  id: string;
  incident_id: string;
  run_id: string | null;
  stage: string;
  message: string;
  severity: Severity | null;
  evidence_json: unknown;
  created_at: Date | string;
}

interface AlertRow {
  id: string;
  incident_id: string;
  run_id: string | null;
  channel: string;
  sent_at: Date | string;
  dedupe_key: string;
  payload_json: unknown;
}

interface WorkerHeartbeatRow {
  worker_id: string;
  process_name: string;
  last_seen_at: Date | string;
  metadata_json: unknown;
}

function toIso(value: Date | string | null): string | null {
  if (!value) {
    return null;
  }
  return value instanceof Date ? value.toISOString() : value;
}

function runDto(row: RunRow): JsonRecord {
  return {
    id: row.id,
    startedAt: toIso(row.started_at),
    finishedAt: toIso(row.finished_at),
    status: row.status,
    healthReportS3Uri: row.health_report_s3_uri,
    reportHash: row.report_hash,
    summary: row.summary,
    overallSeverity: row.overall_severity,
    errorMessage: row.error_message,
  };
}

function runDetailDto(row: RunRow): JsonRecord {
  return {
    ...runDto(row),
    raw: {
      classification: row.raw_classification_json ?? null,
      investigation: row.raw_investigation_json ?? null,
      decision: row.raw_decision_json ?? null,
      verification: row.raw_verification_json ?? null,
    },
  };
}

function incidentDto(row: IncidentRow): JsonRecord {
  return {
    incidentId: row.incident_id,
    title: row.title,
    service: row.service,
    severity: row.severity,
    state: row.state,
    openedAt: toIso(row.opened_at),
    closedAt: toIso(row.closed_at),
    currentDisposition: row.current_disposition,
    currentNextStage: row.current_next_stage,
    currentDecision: row.current_decision_json ?? null,
    lastRunId: row.last_run_id,
  };
}

function incidentDedupeKey(row: IncidentRow): string {
  return [
    row.title.trim().toLowerCase().replace(/\s+/g, ' '),
    row.service?.trim().toLowerCase() ?? '',
    row.severity,
  ].join('|');
}

function incidentPreference(row: IncidentRow): number {
  return [
    row.current_disposition ? 8 : 0,
    row.current_next_stage ? 4 : 0,
    row.current_decision_json ? 2 : 0,
    row.last_run_id ? 1 : 0,
  ].reduce((sum, value) => sum + value, 0);
}

function dedupeIncidents(rows: IncidentRow[]): IncidentRow[] {
  const byKey = new Map<string, IncidentRow>();
  for (const row of rows) {
    const key = incidentDedupeKey(row);
    const existing = byKey.get(key);
    if (!existing || incidentPreference(row) > incidentPreference(existing)) {
      byKey.set(key, row);
    }
  }
  return [...byKey.values()];
}

function incidentCounts(rows: IncidentRow[]): Partial<Record<Severity, number>> {
  const counts: Partial<Record<Severity, number>> = {};
  for (const row of rows) {
    counts[row.severity] = (counts[row.severity] ?? 0) + 1;
  }
  return counts;
}

function eventDto(row: IncidentEventRow): JsonRecord {
  return {
    id: row.id,
    incidentId: row.incident_id,
    runId: row.run_id,
    stage: row.stage,
    message: row.message,
    severity: row.severity,
    evidence: row.evidence_json ?? null,
    createdAt: toIso(row.created_at),
  };
}

function alertDto(row: AlertRow): JsonRecord {
  return {
    id: row.id,
    incidentId: row.incident_id,
    runId: row.run_id,
    channel: row.channel,
    sentAt: toIso(row.sent_at),
    dedupeKey: row.dedupe_key,
    payload: row.payload_json ?? null,
  };
}

function workerHeartbeatDto(row: WorkerHeartbeatRow): JsonRecord {
  return {
    workerId: row.worker_id,
    processName: row.process_name,
    lastSeenAt: toIso(row.last_seen_at),
    metadata: row.metadata_json ?? null,
  };
}

function parseLimit(value: unknown, fallback: number, max: number): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return fallback;
  }
  return Math.min(Math.floor(parsed), max);
}

function statusFromSeverity(severity: Severity | null): 'green' | 'yellow' | 'red' {
  if (severity === 'HIGH' || severity === 'CRITICAL') {
    return 'red';
  }
  if (severity === 'LOW' || severity === 'MEDIUM') {
    return 'yellow';
  }
  return 'green';
}

function isOlderThan(value: Date | string | null, thresholdMs: number): boolean {
  if (!value) {
    return true;
  }
  const timestamp = new Date(value).getTime();
  return !Number.isFinite(timestamp) || Date.now() - timestamp > thresholdMs;
}

export function createWebServer(
  config: Config,
  client?: DatabaseClient,
  ownedPool?: DatabasePool
): FastifyInstance {
  const db = client ?? createPostgresPool(config);
  const poolToClose = ownedPool ?? (client ? undefined : (db as DatabasePool));
  const app = Fastify({ logger: false });
  const staticRoot = resolve(process.cwd(), 'dist/web');

  app.addHook('onClose', async () => {
    await poolToClose?.end();
  });

  if (existsSync(staticRoot)) {
    void app.register(fastifyStatic, {
      root: staticRoot,
      prefix: '/',
    });
  }

  app.get('/api/status', async () => {
    const staleAfterMs = config.monitoring.intervalMs * 2;
    const [runResult, incidentResult, heartbeatResult, transitionResult] =
      await Promise.all([
      db.query<RunRow>(
        `SELECT id, started_at, finished_at, status, health_report_s3_uri, report_hash,
                summary, overall_severity, error_message
         FROM runs
         ORDER BY started_at DESC
         LIMIT 1`
      ),
      db.query<IncidentRow>(
        `SELECT incident_id, title, service, severity, state, opened_at, closed_at,
                current_disposition, current_next_stage, current_decision_json, last_run_id
         FROM incidents
         WHERE state NOT IN ('resolved', 'closed')
         ORDER BY opened_at DESC
         LIMIT 20`
      ),
      db.query<WorkerHeartbeatRow>(
        `SELECT worker_id, process_name, last_seen_at, metadata_json
         FROM worker_heartbeats
         ORDER BY last_seen_at DESC
         LIMIT 1`
      ),
      db.query<IncidentEventRow>(
        `SELECT id, incident_id, run_id, stage, message, severity, evidence_json, created_at
         FROM incident_events
         WHERE evidence_json ? 'transition_type'
         ORDER BY created_at DESC
         LIMIT 10`
      ),
    ]);

    const dedupedIncidentRows = dedupeIncidents(incidentResult.rows);
    const openIncidents = dedupedIncidentRows.map(incidentDto);
    const lastRun = runResult.rows[0] ?? null;
    const workerHeartbeat = heartbeatResult.rows[0] ?? null;
    const highestSeverity = dedupedIncidentRows.reduce<Severity | null>((highest, row) => {
      const order: Severity[] = ['NONE', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];
      return !highest || order.indexOf(row.severity) > order.indexOf(highest)
        ? row.severity
        : highest;
    }, null);

    return {
      status: statusFromSeverity(highestSeverity),
      lastRun: lastRun ? runDto(lastRun) : null,
      workerHeartbeat: workerHeartbeat ? workerHeartbeatDto(workerHeartbeat) : null,
      stale: {
        worker: isOlderThan(workerHeartbeat?.last_seen_at ?? null, staleAfterMs),
        report: isOlderThan(lastRun?.started_at ?? null, staleAfterMs),
      },
      openIncidentCounts: incidentCounts(dedupedIncidentRows),
      openIncidents,
      recentTransitions: transitionResult.rows.map(eventDto),
    };
  });

  app.get('/api/runs', async (request) => {
    const limit = parseLimit((request.query as JsonRecord)['limit'], 50, 200);
    const result = await db.query<RunRow>(
      `SELECT id, started_at, finished_at, status, health_report_s3_uri, report_hash,
              summary, overall_severity, error_message
       FROM runs
       ORDER BY started_at DESC
       LIMIT $1`,
      [limit]
    );
    return { runs: result.rows.map(runDto) };
  });

  app.get('/api/runs/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const [result, incidentResult] = await Promise.all([
      db.query<RunRow>(
        `SELECT id, started_at, finished_at, status, health_report_s3_uri, report_hash,
                summary, overall_severity, raw_classification_json, raw_investigation_json,
                raw_decision_json, raw_verification_json, error_message
         FROM runs
         WHERE id = $1`,
        [id]
      ),
      db.query<IncidentRow>(
        `SELECT DISTINCT i.incident_id, i.title, i.service, i.severity, i.state, i.opened_at,
                i.closed_at, i.current_disposition, i.current_next_stage,
                i.current_decision_json, i.last_run_id
         FROM incidents i
         LEFT JOIN incident_events e ON e.incident_id = i.incident_id
         WHERE i.last_run_id = $1 OR e.run_id = $1
         ORDER BY i.opened_at DESC`,
        [id]
      ),
    ]);
    const row = result.rows[0];
    if (!row) {
      return reply.code(404).send({ error: 'run_not_found' });
    }
    return {
      run: runDetailDto(row),
      incidents: dedupeIncidents(incidentResult.rows).map(incidentDto),
    };
  });

  app.get('/api/incidents', async () => {
    const result = await db.query<IncidentRow>(
      `SELECT incident_id, title, service, severity, state, opened_at, closed_at,
              current_disposition, current_next_stage, current_decision_json, last_run_id
       FROM incidents
       ORDER BY opened_at DESC`
    );
    return { incidents: dedupeIncidents(result.rows).map(incidentDto) };
  });

  app.get('/api/incidents/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const [incidentResult, eventResult, alertResult] = await Promise.all([
      db.query<IncidentRow>(
        `SELECT incident_id, title, service, severity, state, opened_at, closed_at,
                current_disposition, current_next_stage, current_decision_json, last_run_id
         FROM incidents
         WHERE incident_id = $1`,
        [id]
      ),
      db.query<IncidentEventRow>(
        `SELECT id, incident_id, run_id, stage, message, severity, evidence_json, created_at
         FROM incident_events
         WHERE incident_id = $1
         ORDER BY created_at ASC, id ASC`,
        [id]
      ),
      db.query<AlertRow>(
        `SELECT id, incident_id, run_id, channel, sent_at, dedupe_key, payload_json
         FROM alerts
         WHERE incident_id = $1
         ORDER BY sent_at DESC, id DESC`,
        [id]
      ),
    ]);
    const row = incidentResult.rows[0];
    if (!row) {
      return reply.code(404).send({ error: 'incident_not_found' });
    }
    return {
      incident: incidentDto(row),
      events: eventResult.rows.map(eventDto),
      alerts: alertResult.rows.map(alertDto),
    };
  });

  app.get('/api/alerts', async (request) => {
    const limit = parseLimit((request.query as JsonRecord)['limit'], 50, 200);
    const result = await db.query<AlertRow>(
      `SELECT id, incident_id, run_id, channel, sent_at, dedupe_key, payload_json
       FROM alerts
       ORDER BY sent_at DESC
       LIMIT $1`,
      [limit]
    );
    return { alerts: result.rows.map(alertDto) };
  });

  app.get('/api/settings', async () => ({
    settings: {
      healthReportS3Uri: config.healthReport.s3Uri,
      monitorIntervalMs: config.monitoring.intervalMs,
      stateBackend: config.state.backend,
      slackAlerts: {
        enabled: Boolean(config.alerts.slack.webhookUrl),
        channel: config.alerts.slack.channel,
        timeoutMs: config.alerts.slack.timeoutMs,
      },
    },
  }));

  app.get('/healthz', async () => ({ ok: true }));

  app.setNotFoundHandler(async (request, reply) => {
    if (request.method === 'GET' && !request.url.startsWith('/api/') && existsSync(staticRoot)) {
      const html = await readFile(join(staticRoot, 'index.html'), 'utf8');
      return reply.type('text/html').send(html);
    }
    return reply.code(404).send({ error: 'not_found' });
  });

  return app;
}
