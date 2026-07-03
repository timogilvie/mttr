import { timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import type { Config } from '../config.js';
import type { DatabaseClient, DatabasePool } from '../db/postgres.js';
import { createPostgresPool } from '../db/postgres.js';
import { enqueueAlarmTriggerOnce, markSnsMessageProcessed } from '../state/repository.js';
import type { TriggerSource } from '../state/repository.js';
import type { Severity } from '../types.js';
import { ALARM_PIPELINE_COUNTER_METRICS, emitCounter } from '../util/metrics.js';
import { alarmIdentityFromSns } from '../report/alarmSpecFromSns.js';
import {
  UnsupportedSnsMessageError,
  confirmSnsSubscription,
  isAllowedSnsUrl,
  parseCloudWatchAlarmMessage,
  parseSnsMessage,
  verifySnsMessageSignature,
} from './sns.js';

type JsonRecord = Record<string, unknown>;

/**
 * Constant-time comparison of the path token so a `!==` short-circuit cannot
 * leak the matching-prefix length to a timing attacker.
 */
function tokensMatch(provided: string, expected: string): boolean {
  const providedBuf = Buffer.from(provided);
  const expectedBuf = Buffer.from(expected);
  if (providedBuf.length !== expectedBuf.length) {
    return false;
  }
  return timingSafeEqual(providedBuf, expectedBuf);
}

interface RunRow {
  id: string;
  started_at: Date | string;
  finished_at: Date | string | null;
  status: string;
  trigger_source: TriggerSource;
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

interface WebhookDependencies {
  fetchSigningCert?: (url: string, signal: AbortSignal) => Promise<string>;
  confirmSubscriptionGet?: (url: string, signal: AbortSignal) => Promise<void>;
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
    triggerSource: row.trigger_source,
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
  ownedPool?: DatabasePool,
  webhookDependencies: WebhookDependencies = {}
): FastifyInstance {
  const db = client ?? createPostgresPool(config);
  const poolToClose = ownedPool ?? (client ? undefined : (db as DatabasePool));
  const app = Fastify({ logger: false });
  const staticRoot = resolve(process.cwd(), 'dist/web');
  const snsCertCache = new Map<string, string>();

  app.addHook('onClose', async () => {
    await poolToClose?.end();
  });

  if (existsSync(staticRoot)) {
    void app.register(fastifyStatic, {
      root: staticRoot,
      prefix: '/',
    });
  }

  if (config.alarm.webhook.enabled) {
    void app.register(async (webhookApp) => {
      webhookApp.addContentTypeParser(
        'text/plain',
        { parseAs: 'string' },
        (_request, body, done) => done(null, body)
      );

      webhookApp.post('/webhooks/cloudwatch/:token', async (request, reply) => {
        const { token } = request.params as { token: string };
        const expectedToken = config.alarm.webhook.pathToken;
        if (!expectedToken || !tokensMatch(token, expectedToken)) {
          return reply.code(404).send({ error: 'not_found' });
        }

        let message;
        try {
          message = parseSnsMessage(request.body);
        } catch (error) {
          if (error instanceof UnsupportedSnsMessageError) {
            // Structurally valid SNS envelope we don't act on (e.g.
            // UnsubscribeConfirmation): ack so SNS does not retry.
            request.log.info({ messageType: error.messageType }, 'Ignoring unsupported SNS message type');
            return reply.code(200).send({ ok: true });
          }
          return reply.code(400).send({ error: 'invalid_sns_message' });
        }

        if (config.alarm.webhook.verifySignature) {
          const verificationOptions = { cache: snsCertCache };
          if (webhookDependencies.fetchSigningCert) {
            Object.assign(verificationOptions, {
              fetchCert: webhookDependencies.fetchSigningCert,
            });
          }
          const verified = await verifySnsMessageSignature(message, verificationOptions);
          if (!verified) {
            emitCounter(request.log, ALARM_PIPELINE_COUNTER_METRICS.SIGNATURE_REJECTED, {
              sns_message_id: message.MessageId,
            });
            return reply.code(403).send({ error: 'invalid_sns_signature' });
          }
        }

        if (message.Type === 'SubscriptionConfirmation') {
          if (
            config.alarm.webhook.autoconfirm &&
            config.alarm.webhook.topicArn &&
            message.TopicArn === config.alarm.webhook.topicArn
          ) {
            // Only GET a SubscribeURL that points at an AWS SNS host, so the
            // confirmation handshake can never be turned into an SSRF request to
            // an arbitrary internal endpoint.
            if (!isAllowedSnsUrl(message.SubscribeURL)) {
              request.log.warn(
                { topicArn: message.TopicArn },
                'Refusing to confirm SNS subscription: SubscribeURL is not an SNS host'
              );
              return reply.code(403).send({ error: 'invalid_subscribe_url' });
            }
            try {
              const confirmationOptions = {};
              if (webhookDependencies.confirmSubscriptionGet) {
                Object.assign(confirmationOptions, {
                  confirmGet: webhookDependencies.confirmSubscriptionGet,
                });
              }
              await confirmSnsSubscription(message.SubscribeURL, confirmationOptions);
            } catch {
              request.log.warn({ topicArn: message.TopicArn }, 'SNS subscription confirmation failed');
            }
          }
          return reply.code(200).send({ ok: true });
        }

        // A valid SNS signature only proves the message came from SNS, not that
        // it came from *our* topic. Any account can publish a CloudWatch-shaped
        // alarm to their own topic and replay the signed envelope here, so bind
        // notifications to the expected topic ARN before enqueueing.
        if (
          config.alarm.webhook.topicArn &&
          message.TopicArn !== config.alarm.webhook.topicArn
        ) {
          return reply.code(403).send({ error: 'unexpected_topic_arn' });
        }

        const alarmMessage = parseCloudWatchAlarmMessage(message.Message);
        if (!alarmMessage) {
          await markSnsMessageProcessed(db, message.MessageId);
          return reply.code(200).send({ ok: true });
        }

        const alarmIdentity = alarmIdentityFromSns(alarmMessage);
        const enqueueResult = await enqueueAlarmTriggerOnce(db, {
          snsMessageId: message.MessageId,
          alarmArn: alarmMessage.AlarmArn,
          alarmName: alarmMessage.AlarmName,
          newState: alarmMessage.NewStateValue,
          stateChangeTime: alarmMessage.StateChangeTime,
          ...(alarmIdentity.ok
            ? {
                severity: alarmIdentity.severity,
                specKey: alarmIdentity.dedupeKey,
              }
            : {}),
          payload: alarmMessage,
        });
        if (enqueueResult.duplicate) {
          // Idempotent replay of an SNS message we already processed (any new_state) — not a
          // fresh alarm, so it must not also be counted as `alarms_received`.
          emitCounter(request.log, ALARM_PIPELINE_COUNTER_METRICS.IDEMPOTENT_DROPPED, {
            alarm_name: alarmMessage.AlarmName,
            sns_message_id: message.MessageId,
          });
        } else if (enqueueResult.enqueued && alarmMessage.NewStateValue === 'ALARM') {
          emitCounter(request.log, ALARM_PIPELINE_COUNTER_METRICS.ALARMS_RECEIVED, {
            alarm_name: alarmMessage.AlarmName,
            sns_message_id: message.MessageId,
            trigger_id: enqueueResult.id,
          });
        }
        return reply.code(200).send({ ok: true });
      });
    });
  }

  app.get('/api/status', async () => {
    const staleAfterMs = config.monitoring.intervalMs * 2;
    const [runResult, incidentResult, heartbeatResult, transitionResult] =
      await Promise.all([
      db.query<RunRow>(
        `SELECT id, started_at, finished_at, status, trigger_source, health_report_s3_uri, report_hash,
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
      `SELECT id, started_at, finished_at, status, trigger_source, health_report_s3_uri, report_hash,
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
        `SELECT id, started_at, finished_at, status, trigger_source, health_report_s3_uri, report_hash,
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
