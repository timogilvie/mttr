import { createSign, generateKeyPairSync, randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { QueryResult, QueryResultRow } from 'pg';
import type { Config } from '../config.js';
import type { DatabaseClient } from '../db/postgres.js';
import { createWebServer } from '../web/api.js';
import {
  buildCanonicalSnsMessage,
  type SnsMessage,
  type SnsNotification,
  type SnsSubscriptionConfirmation,
} from '../web/sns.js';

function result<T extends QueryResultRow>(rows: T[]): QueryResult<T> {
  return {
    rows,
    rowCount: rows.length,
    command: '',
    oid: 0,
    fields: [],
  };
}

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const certPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
const signingCertUrl = 'https://sns.us-east-1.amazonaws.com/SimpleNotificationService-test.pem';
const topicArn = 'arn:aws:sns:us-east-1:123456789012:mttr-alarms';

const baseConfig: Config = {
  openrouter: {
    apiKey: 'test-key',
    model: 'test-model',
    baseUrl: 'https://test.com',
    maxRetries: 4,
    backoffBaseMs: 1000,
    backoffMaxMs: 30000,
  },
  investigate: {
    model: 'test-investigate-model',
    modelFallback: 'test-fallback-model',
    maxToolIterations: 6,
    maxToolCalls: 12,
    closureEnabled: true,
    closureMaxToolIterations: 2,
    closureMaxToolCalls: 3,
    consecutiveFailureLimit: 3,
    llmTimeoutMs: 120000,
  },
  tools: {
    timeoutMs: 20000,
    resultMaxChars: 8000,
    defaultLookbackMinutes: 60,
    maxLookbackMinutes: 1440,
    maxConcurrency: 2,
  },
  healthReport: { s3Uri: 's3://test/report.md' },
  aws: { region: 'us-east-1', maxAttempts: 5 },
  monitoring: {
    intervalMs: 900000,
    sweep: { enabled: false, staleAfterMs: 21600000, maxIncidents: 3 },
  },
  state: { backend: 'postgres', path: '.mttr-state.json' },
  database: { ssl: false, maxConnections: 4, idleTimeoutMs: 30000 },
  alerts: {
    slack: {
      channel: 'mttr-alerts',
      timeoutMs: 10000,
    },
  },
  timeouts: { llmMs: 5000, s3Ms: 5000 },
  alarm: {
    webhook: { enabled: false, verifySignature: true, autoconfirm: true },
    trigger: { minSeverity: 'CRITICAL', cooldownMs: 600000, pollMs: 5000, coalesceMs: 2000 },
  },
};

function configWithWebhook(
  overrides: Partial<Config['alarm']['webhook']> = {}
): Config {
  return {
    ...baseConfig,
    alarm: {
      ...baseConfig.alarm,
      webhook: {
        enabled: true,
        pathToken: 'secret-token',
        topicArn,
        verifySignature: true,
        autoconfirm: true,
        ...overrides,
      },
    },
  };
}

interface FakeIncidentRow {
  incident_id: string;
  title: string;
  service: string | null;
  severity: string;
  state: string;
  opened_at: string;
  closed_at: string | null;
  current_disposition: string | null;
  current_next_stage: string | null;
  current_decision_json: Record<string, unknown> | null;
  last_run_id: string | null;
}

interface FakeAlarmTriggerRow {
  id: string;
  sns_message_id: string;
  alarm_arn: string;
  alarm_name: string;
  new_state: string;
  state_change_time: string;
  severity: string | null;
  spec_key: string | null;
  payload: Record<string, unknown>;
  status: string;
}

class FakeApiDatabase implements DatabaseClient {
  queries: string[] = [];
  runs = [
    {
      id: 'run-1',
      started_at: '2026-06-08T10:00:00Z',
      finished_at: '2026-06-08T10:01:00Z',
      status: 'success',
      trigger_source: 'scheduled',
      health_report_s3_uri: 's3://test/report.md',
      report_hash: 'abc123',
      summary: 'High 4xx',
      overall_severity: 'HIGH',
      raw_classification_json: { summary: 'classified' },
      raw_investigation_json: { summary: 'investigated' },
      raw_decision_json: { summary: 'decided' },
      raw_verification_json: null,
      error_message: null,
    },
  ];
  incidents: FakeIncidentRow[] = [
    {
      incident_id: 'INC-001',
      title: 'High 4xx',
      service: 'data-pipeline-api',
      severity: 'HIGH',
      state: 'decision',
      opened_at: '2026-06-08T10:00:00Z',
      closed_at: null,
      current_disposition: 'MITIGATE',
      current_next_stage: 'Mitigate',
      current_decision_json: { disposition: 'MITIGATE' },
      last_run_id: 'run-1',
    },
  ];
  events = [
    {
      id: 'event-1',
      incident_id: 'INC-001',
      run_id: 'run-1',
      stage: 'Decide',
      message: 'Ready for mitigation: High 4xx',
      severity: 'HIGH',
      evidence_json: { transition_type: 'ready_for_mitigation', alertable: true },
      created_at: '2026-06-08T10:01:00Z',
    },
  ];
  alerts = [
    {
      id: 'alert-1',
      incident_id: 'INC-001',
      run_id: 'run-1',
      channel: 'slack',
      sent_at: '2026-06-08T10:02:00Z',
      dedupe_key: 'slack:INC-001:ready_for_mitigation:HIGH:MITIGATE',
      payload_json: { text: 'Ready for mitigation' },
    },
  ];
  heartbeats = [
    {
      worker_id: 'worker-1',
      process_name: 'mttr-worker',
      last_seen_at: new Date().toISOString(),
      metadata_json: { version: 'test' },
    },
  ];
  processedSnsMessages = new Set<string>();
  alarmTriggers: FakeAlarmTriggerRow[] = [];
  failAlarmTriggerInsert = false;
  private snapshot?:
    | {
        processedSnsMessages: Set<string>;
        alarmTriggers: FakeAlarmTriggerRow[];
      }
    | undefined;

  async query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    params: readonly unknown[] = []
  ): Promise<QueryResult<T>> {
    this.queries.push(text);
    const normalized = text.replace(/\s+/g, ' ').trim();

    if (normalized === 'BEGIN') {
      this.snapshot = {
        processedSnsMessages: new Set(this.processedSnsMessages),
        alarmTriggers: this.alarmTriggers.map((row) => ({ ...row, payload: { ...row.payload } })),
      };
      return result<T>([]);
    }
    if (normalized === 'COMMIT') {
      this.snapshot = undefined;
      return result<T>([]);
    }
    if (normalized === 'ROLLBACK') {
      if (this.snapshot) {
        this.processedSnsMessages = this.snapshot.processedSnsMessages;
        this.alarmTriggers = this.snapshot.alarmTriggers;
      }
      this.snapshot = undefined;
      return result<T>([]);
    }

    if (normalized.startsWith('INSERT INTO processed_sns_messages')) {
      const messageId = String(params[0]);
      if (this.processedSnsMessages.has(messageId)) {
        return result<T>([]);
      }
      this.processedSnsMessages.add(messageId);
      return result<T>([{ sns_message_id: messageId } as unknown as T]);
    }

    if (normalized.startsWith('INSERT INTO alarm_triggers')) {
      if (this.failAlarmTriggerInsert) {
        throw new Error('alarm trigger insert failed');
      }
      const id = randomUUID();
      this.alarmTriggers.push({
        id,
        sns_message_id: String(params[0]),
        alarm_arn: String(params[1]),
        alarm_name: String(params[2]),
        new_state: String(params[3]),
        state_change_time: String(params[4]),
        severity: params[5] ? String(params[5]) : null,
        spec_key: params[6] ? String(params[6]) : null,
        payload: JSON.parse(String(params[7])) as Record<string, unknown>,
        status: 'pending',
      });
      return result<T>([{ id } as unknown as T]);
    }

    if (normalized.includes('FROM runs') && normalized.includes('WHERE id = $1')) {
      return result<T>(this.runs.filter((row) => row.id === params[0]) as unknown as T[]);
    }
    if (normalized.includes('FROM runs')) {
      return result<T>(this.runs as unknown as T[]);
    }
    if (normalized.includes('count(*)::text')) {
      return result<T>([{ severity: 'HIGH', count: '1' } as unknown as T]);
    }
    if (normalized.includes('FROM incidents') && normalized.includes('incident_id = $1')) {
      return result<T>(
        this.incidents.filter((row) => row.incident_id === params[0]) as unknown as T[]
      );
    }
    if (normalized.includes('FROM incidents') && normalized.includes("state = 'absent_unverified'")) {
      return result<T>(
        this.incidents.filter((row) => row.state === 'absent_unverified') as unknown as T[]
      );
    }
    if (normalized.includes('FROM incidents') && normalized.includes('state NOT IN')) {
      return result<T>(
        this.incidents.filter(
          (row) => !['resolved', 'closed', 'absent_unverified'].includes(String(row.state))
        ) as unknown as T[]
      );
    }
    if (normalized.includes('FROM incidents')) {
      return result<T>(this.incidents as unknown as T[]);
    }
    if (normalized.includes('FROM worker_heartbeats')) {
      return result<T>(this.heartbeats as unknown as T[]);
    }
    if (normalized.includes('FROM incident_events')) {
      if (normalized.includes("evidence_json ? 'transition_type'")) {
        return result<T>(this.events as unknown as T[]);
      }
      return result<T>(
        this.events.filter((row) => row.incident_id === params[0]) as unknown as T[]
      );
    }
    if (normalized.includes('FROM alerts')) {
      return result<T>(this.alerts as unknown as T[]);
    }

    throw new Error(`Unexpected query: ${text}`);
  }
}

function signMessage(message: SnsMessage): SnsMessage {
  const signer = createSign(message.SignatureVersion === '1' ? 'RSA-SHA1' : 'RSA-SHA256');
  signer.update(buildCanonicalSnsMessage(message), 'utf8');
  signer.end();
  return {
    ...message,
    Signature: signer.sign(privateKey).toString('base64'),
  };
}

function cloudWatchAlarmPayload(
  overrides: Partial<Record<string, unknown>> = {}
): Record<string, unknown> {
  return {
    AlarmArn: 'arn:aws:cloudwatch:us-east-1:123456789012:alarm:CPUHigh',
    AlarmName: 'CPUHigh',
    NewStateValue: 'ALARM',
    StateChangeTime: '2026-07-01T12:34:56.000+0000',
    AWSAccountId: '123456789012',
    Region: 'US East (N. Virginia)',
    ...overrides,
  };
}

function notificationMessage(
  overrides: Partial<SnsNotification> = {},
  alarmPayload: Record<string, unknown> = cloudWatchAlarmPayload()
): SnsNotification {
  return signMessage({
    Type: 'Notification',
    MessageId: 'message-1',
    TopicArn: topicArn,
    Subject: 'ALARM: "CPUHigh"',
    Message: JSON.stringify(alarmPayload),
    Timestamp: '2026-07-01T12:35:00.000Z',
    SignatureVersion: '2',
    Signature: '',
    SigningCertURL: signingCertUrl,
    UnsubscribeURL: 'https://sns.us-east-1.amazonaws.com/?Action=Unsubscribe',
    ...overrides,
  } as SnsNotification) as SnsNotification;
}

function subscriptionConfirmationMessage(
  overrides: Partial<SnsSubscriptionConfirmation> = {}
): SnsSubscriptionConfirmation {
  return signMessage({
    Type: 'SubscriptionConfirmation',
    MessageId: 'sub-message-1',
    TopicArn: topicArn,
    Message: 'You have chosen to subscribe...',
    Timestamp: '2026-07-01T12:35:00.000Z',
    SignatureVersion: '2',
    Signature: '',
    SigningCertURL: signingCertUrl,
    SubscribeURL: 'https://sns.us-east-1.amazonaws.com/?Action=ConfirmSubscription',
    Token: 'token-123',
    ...overrides,
  } as SnsSubscriptionConfirmation) as SnsSubscriptionConfirmation;
}

describe('web API', () => {
  const apps: ReturnType<typeof createWebServer>[] = [];

  afterEach(async () => {
    await Promise.all(apps.map((app) => app.close()));
    apps.length = 0;
  });

  function appFor(
    config = baseConfig,
    db = new FakeApiDatabase(),
    webhookDependencies?: Parameters<typeof createWebServer>[3]
  ) {
    const app = createWebServer(config, db, undefined, webhookDependencies);
    apps.push(app);
    return { app, db };
  }

  it('returns current status with last run and open incidents', async () => {
    const { app } = appFor();

    const response = await app.inject({ method: 'GET', url: '/api/status' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: 'red',
      lastRun: {
        id: 'run-1',
        status: 'success',
        triggerSource: 'scheduled',
        overallSeverity: 'HIGH',
      },
      openIncidentCounts: { HIGH: 1 },
      workerHeartbeat: {
        workerId: 'worker-1',
        processName: 'mttr-worker',
      },
      stale: {
        worker: false,
        report: true,
      },
      openIncidents: [
        {
          incidentId: 'INC-001',
          severity: 'HIGH',
          currentDisposition: 'MITIGATE',
        },
      ],
      recentTransitions: [
        {
          stage: 'Decide',
          evidence: { transition_type: 'ready_for_mitigation' },
        },
      ],
    });
  });

  it('dedupes legacy open incident rows in status responses', async () => {
    const db = new FakeApiDatabase();
    db.incidents = [
      {
        incident_id: 'hash-observation-id',
        title: 'High 4xx',
        service: 'data-pipeline-api',
        severity: 'HIGH',
        state: 'open',
        opened_at: '2026-06-08T10:00:00Z',
        closed_at: null,
        current_disposition: null,
        current_next_stage: null,
        current_decision_json: null,
        last_run_id: 'run-1',
      },
      {
        incident_id: 'INC-001',
        title: 'High 4xx',
        service: 'data-pipeline-api',
        severity: 'HIGH',
        state: 'decision',
        opened_at: '2026-06-08T10:01:00Z',
        closed_at: null,
        current_disposition: 'MITIGATE',
        current_next_stage: 'Mitigate',
        current_decision_json: { disposition: 'MITIGATE' },
        last_run_id: 'run-1',
      },
    ];
    const { app } = appFor(baseConfig, db);

    const response = await app.inject({ method: 'GET', url: '/api/status' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      openIncidentCounts: { HIGH: 1 },
      openIncidents: [
        {
          incidentId: 'INC-001',
          currentDisposition: 'MITIGATE',
        },
      ],
    });
  });

  it('keeps absent-but-unverified incidents out of the open list and the severity roll-up', async () => {
    const db = new FakeApiDatabase();
    const [seeded] = db.incidents;
    if (!seeded) {
      throw new Error('Expected fake database to seed an incident');
    }
    db.incidents = [
      seeded,
      {
        ...seeded,
        incident_id: 'INC-ABSENT',
        title: 'No requests on mlflow',
        service: 'mlflow',
        severity: 'CRITICAL',
        state: 'absent_unverified',
        closed_at: null,
      },
    ];
    const { app } = appFor(baseConfig, db);

    const response = await app.inject({ method: 'GET', url: '/api/status' });
    const body = response.json();

    expect(response.statusCode).toBe(200);
    expect(body.openIncidents).toHaveLength(1);
    expect(body.openIncidents[0]).toMatchObject({ incidentId: 'INC-001' });
    // A CRITICAL incident that merely stopped being reported must not turn the board red.
    expect(body.openIncidentCounts).not.toMatchObject({ CRITICAL: 1 });
    expect(body.absentUnverifiedIncidents).toMatchObject([
      { incidentId: 'INC-ABSENT', state: 'absent_unverified' },
    ]);
  });

  it('returns a markdown handoff brief for an incident', async () => {
    const { app } = appFor();

    const response = await app.inject({ method: 'GET', url: '/api/incidents/INC-001/brief' });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/markdown');
    expect(response.body).toContain('# High 4xx');
    expect(response.body).toContain('- **Incident ID**: `INC-001`');
    expect(response.body).toContain('## Closure gate');
  });

  it('404s the handoff brief for an unknown incident', async () => {
    const { app } = appFor();

    const response = await app.inject({ method: 'GET', url: '/api/incidents/nope/brief' });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: 'incident_not_found' });
  });

  it('returns run list with trigger provenance', async () => {
    const db = new FakeApiDatabase();
    const scheduledRun = db.runs[0];
    if (!scheduledRun) {
      throw new Error('Expected fake database to seed a scheduled run');
    }
    db.runs = [
      scheduledRun,
      {
        ...scheduledRun,
        id: 'run-2',
        started_at: '2026-06-08T10:05:00Z',
        trigger_source: 'alarm',
      },
    ];
    const { app } = appFor(baseConfig, db);

    const response = await app.inject({ method: 'GET', url: '/api/runs' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      runs: [
        { id: 'run-1', triggerSource: 'scheduled' },
        { id: 'run-2', triggerSource: 'alarm' },
      ],
    });
  });

  it('returns run detail with raw stage output and trigger provenance', async () => {
    const { app } = appFor();

    const response = await app.inject({ method: 'GET', url: '/api/runs/run-1' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      run: {
        id: 'run-1',
        triggerSource: 'scheduled',
        raw: {
          classification: { summary: 'classified' },
          investigation: { summary: 'investigated' },
          decision: { summary: 'decided' },
        },
      },
      incidents: [
        {
          incidentId: 'INC-001',
          title: 'High 4xx',
        },
      ],
    });
  });

  it('returns incident detail with timeline events', async () => {
    const { app } = appFor();

    const response = await app.inject({ method: 'GET', url: '/api/incidents/INC-001' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      incident: {
        incidentId: 'INC-001',
        title: 'High 4xx',
      },
      events: [
        {
          stage: 'Decide',
          evidence: { transition_type: 'ready_for_mitigation', alertable: true },
        },
      ],
      alerts: [
        {
          dedupeKey: 'slack:INC-001:ready_for_mitigation:HIGH:MITIGATE',
        },
      ],
    });
  });

  it('returns alert history and settings', async () => {
    const { app } = appFor();

    const alertsResponse = await app.inject({ method: 'GET', url: '/api/alerts' });
    const settingsResponse = await app.inject({ method: 'GET', url: '/api/settings' });

    expect(alertsResponse.json()).toMatchObject({
      alerts: [{ dedupeKey: 'slack:INC-001:ready_for_mitigation:HIGH:MITIGATE' }],
    });
    expect(settingsResponse.json()).toMatchObject({
      settings: {
        healthReportS3Uri: 's3://test/report.md',
        monitorIntervalMs: 900000,
        slackAlerts: {
          enabled: false,
          channel: 'mttr-alerts',
        },
      },
    });
  });

  it('does not mount the cloudwatch webhook when disabled', async () => {
    const { app } = appFor(baseConfig);

    const response = await app.inject({
      method: 'POST',
      url: '/webhooks/cloudwatch/secret-token',
      payload: '{}',
      headers: { 'content-type': 'text/plain' },
    });

    expect(response.statusCode).toBe(404);
  });

  it('auto-confirms a valid subscription for the expected topic', async () => {
    const subscribeCalls: string[] = [];
    const { app } = appFor(configWithWebhook(), new FakeApiDatabase(), {
      fetchSigningCert: async () => certPem,
      confirmSubscriptionGet: async (url) => {
        subscribeCalls.push(url);
      },
    });
    const message = subscriptionConfirmationMessage();

    const response = await app.inject({
      method: 'POST',
      url: '/webhooks/cloudwatch/secret-token',
      payload: JSON.stringify(message),
      headers: { 'content-type': 'text/plain' },
    });

    expect(response.statusCode).toBe(200);
    expect(subscribeCalls).toEqual([message.SubscribeURL]);
  });

  it('does not auto-confirm when the topic ARN does not match', async () => {
    const subscribeCalls: string[] = [];
    const { app } = appFor(configWithWebhook(), new FakeApiDatabase(), {
      fetchSigningCert: async () => certPem,
      confirmSubscriptionGet: async (url) => {
        subscribeCalls.push(url);
      },
    });
    const message = subscriptionConfirmationMessage({
      TopicArn: 'arn:aws:sns:us-east-1:123456789012:different-topic',
    });

    const response = await app.inject({
      method: 'POST',
      url: '/webhooks/cloudwatch/secret-token',
      payload: JSON.stringify(message),
      headers: { 'content-type': 'text/plain' },
    });

    expect(response.statusCode).toBe(200);
    expect(subscribeCalls).toEqual([]);
  });

  it('refuses to confirm a subscription whose SubscribeURL is not an SNS host', async () => {
    const subscribeCalls: string[] = [];
    const { app } = appFor(configWithWebhook(), new FakeApiDatabase(), {
      fetchSigningCert: async () => certPem,
      confirmSubscriptionGet: async (url) => {
        subscribeCalls.push(url);
      },
    });
    // Correct topic + signature, but SubscribeURL points at an internal host:
    // confirming it would be an SSRF, so it must be rejected without a fetch.
    const message = subscriptionConfirmationMessage({
      SubscribeURL: 'https://169.254.169.254/latest/meta-data/',
    });

    const response = await app.inject({
      method: 'POST',
      url: '/webhooks/cloudwatch/secret-token',
      payload: JSON.stringify(message),
      headers: { 'content-type': 'text/plain' },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: 'invalid_subscribe_url' });
    expect(subscribeCalls).toEqual([]);
  });

  it('rejects requests with the wrong path token before enqueueing', async () => {
    const db = new FakeApiDatabase();
    const { app } = appFor(configWithWebhook(), db, {
      fetchSigningCert: async () => certPem,
    });

    const response = await app.inject({
      method: 'POST',
      url: '/webhooks/cloudwatch/wrong-token',
      payload: JSON.stringify(notificationMessage()),
      headers: { 'content-type': 'text/plain' },
    });

    expect(response.statusCode).toBe(404);
    expect(db.alarmTriggers).toHaveLength(0);
    expect(db.processedSnsMessages.size).toBe(0);
  });

  it('rejects a notification with a bad SNS signature', async () => {
    const { app, db } = appFor(configWithWebhook(), new FakeApiDatabase(), {
      fetchSigningCert: async () => certPem,
    });
    const message = {
      ...notificationMessage(),
      Signature: 'ZmFrZQ==',
    };

    const response = await app.inject({
      method: 'POST',
      url: '/webhooks/cloudwatch/secret-token',
      payload: JSON.stringify(message),
      headers: { 'content-type': 'text/plain' },
    });

    expect(response.statusCode).toBe(403);
    expect(db.alarmTriggers).toHaveLength(0);
    expect(db.processedSnsMessages.size).toBe(0);
  });

  it('enqueues a valid ALARM notification exactly once', async () => {
    const db = new FakeApiDatabase();
    const { app } = appFor(configWithWebhook(), db, {
      fetchSigningCert: async () => certPem,
    });
    const message = notificationMessage();

    const response = await app.inject({
      method: 'POST',
      url: '/webhooks/cloudwatch/secret-token',
      payload: JSON.stringify(message),
      headers: { 'content-type': 'text/plain' },
    });

    expect(response.statusCode).toBe(200);
    expect(db.processedSnsMessages.has(message.MessageId)).toBe(true);
    expect(db.alarmTriggers).toHaveLength(1);
    expect(db.alarmTriggers[0]).toMatchObject({
      sns_message_id: message.MessageId,
      alarm_arn: 'arn:aws:cloudwatch:us-east-1:123456789012:alarm:CPUHigh',
      alarm_name: 'CPUHigh',
      new_state: 'ALARM',
      status: 'pending',
      payload: {
        AlarmName: 'CPUHigh',
        NewStateValue: 'ALARM',
      },
    });
  });

  it('dedupes duplicate SNS message ids without enqueueing twice', async () => {
    const db = new FakeApiDatabase();
    const { app } = appFor(configWithWebhook(), db, {
      fetchSigningCert: async () => certPem,
    });
    const message = notificationMessage({ MessageId: 'duplicate-message' });

    const first = app.inject({
      method: 'POST',
      url: '/webhooks/cloudwatch/secret-token',
      payload: JSON.stringify(message),
      headers: { 'content-type': 'text/plain' },
    });
    const second = app.inject({
      method: 'POST',
      url: '/webhooks/cloudwatch/secret-token',
      payload: JSON.stringify(message),
      headers: { 'content-type': 'text/plain' },
    });

    const [firstResponse, secondResponse] = await Promise.all([first, second]);

    expect(firstResponse.statusCode).toBe(200);
    expect(secondResponse.statusCode).toBe(200);
    expect(db.processedSnsMessages.has('duplicate-message')).toBe(true);
    expect(db.alarmTriggers).toHaveLength(1);
  });

  it('enqueues OK notifications so the consumer can verify recovery', async () => {
    const db = new FakeApiDatabase();
    const { app } = appFor(configWithWebhook(), db, {
      fetchSigningCert: async () => certPem,
    });
    const message = notificationMessage({}, cloudWatchAlarmPayload({ NewStateValue: 'OK' }));

    const response = await app.inject({
      method: 'POST',
      url: '/webhooks/cloudwatch/secret-token',
      payload: JSON.stringify(message),
      headers: { 'content-type': 'text/plain' },
    });

    expect(response.statusCode).toBe(200);
    expect(db.processedSnsMessages.has(message.MessageId)).toBe(true);
    expect(db.alarmTriggers).toHaveLength(1);
    expect(db.alarmTriggers[0]).toMatchObject({
      new_state: 'OK',
      status: 'pending',
      alarm_name: 'CPUHigh',
    });
  });

  it('rejects a validly-signed notification from an unexpected topic ARN', async () => {
    const db = new FakeApiDatabase();
    const { app } = appFor(configWithWebhook(), db, {
      fetchSigningCert: async () => certPem,
    });
    // Genuine SNS signature, but published to a foreign topic the attacker owns.
    const message = notificationMessage({
      TopicArn: 'arn:aws:sns:us-east-1:999999999999:attacker-topic',
    });

    const response = await app.inject({
      method: 'POST',
      url: '/webhooks/cloudwatch/secret-token',
      payload: JSON.stringify(message),
      headers: { 'content-type': 'text/plain' },
    });

    expect(response.statusCode).toBe(403);
    expect(db.alarmTriggers).toHaveLength(0);
    expect(db.processedSnsMessages.size).toBe(0);
  });

  it('acknowledges an unsupported SNS message type without enqueueing', async () => {
    const db = new FakeApiDatabase();
    const { app } = appFor(configWithWebhook(), db, {
      fetchSigningCert: async () => certPem,
    });
    const message = { ...notificationMessage(), Type: 'UnsubscribeConfirmation' };

    const response = await app.inject({
      method: 'POST',
      url: '/webhooks/cloudwatch/secret-token',
      payload: JSON.stringify(message),
      headers: { 'content-type': 'text/plain' },
    });

    expect(response.statusCode).toBe(200);
    expect(db.alarmTriggers).toHaveLength(0);
    expect(db.processedSnsMessages.size).toBe(0);
  });

  it('returns 400 for a malformed (non-SNS) request body', async () => {
    const { app } = appFor(configWithWebhook(), new FakeApiDatabase(), {
      fetchSigningCert: async () => certPem,
    });

    const response = await app.inject({
      method: 'POST',
      url: '/webhooks/cloudwatch/secret-token',
      payload: JSON.stringify({ not: 'an sns envelope' }),
      headers: { 'content-type': 'text/plain' },
    });

    expect(response.statusCode).toBe(400);
  });

  describe('alarm pipeline instrumentation', () => {
    // Fastify's `logger: false` uses a null logger whose `.child()` returns the same instance
    // (see fastify/lib/logger-factory.js), so `request.log` === `app.log` here — spying on
    // `app.log.info` observes every metric emitted through `request.log` during the request.
    // Fastify itself also calls `childLogger.info({ req }, 'incoming request')` on every request
    // regardless of logger config, so filter down to payloads that carry our `metric` field.
    function metricPayloads(infoSpy: ReturnType<typeof vi.spyOn>): Array<Record<string, unknown>> {
      return infoSpy.mock.calls
        .map((call) => call[0] as Record<string, unknown>)
        .filter((payload) => typeof payload['metric'] === 'string');
    }

    it('emits signature_rejected on a bad SNS signature, and nothing else', async () => {
      const { app, db } = appFor(configWithWebhook(), new FakeApiDatabase(), {
        fetchSigningCert: async () => certPem,
      });
      const infoSpy = vi.spyOn(app.log, 'info');
      const message = { ...notificationMessage(), Signature: 'ZmFrZQ==' };

      const response = await app.inject({
        method: 'POST',
        url: '/webhooks/cloudwatch/secret-token',
        payload: JSON.stringify(message),
        headers: { 'content-type': 'text/plain' },
      });

      expect(response.statusCode).toBe(403);
      const metrics = metricPayloads(infoSpy);
      expect(metrics).toEqual([
        expect.objectContaining({
          metric: 'alarm_pipeline.signature_rejected',
          sns_message_id: message.MessageId,
        }),
      ]);
      expect(db.alarmTriggers).toHaveLength(0);
    });

    it('emits alarms_received with the trigger id on a valid ALARM enqueue', async () => {
      const db = new FakeApiDatabase();
      const { app } = appFor(configWithWebhook(), db, {
        fetchSigningCert: async () => certPem,
      });
      const infoSpy = vi.spyOn(app.log, 'info');
      const message = notificationMessage();

      const response = await app.inject({
        method: 'POST',
        url: '/webhooks/cloudwatch/secret-token',
        payload: JSON.stringify(message),
        headers: { 'content-type': 'text/plain' },
      });

      expect(response.statusCode).toBe(200);
      const metrics = metricPayloads(infoSpy);
      expect(metrics).toEqual([
        expect.objectContaining({
          metric: 'alarm_pipeline.alarms_received',
          alarm_name: 'CPUHigh',
          sns_message_id: message.MessageId,
          trigger_id: db.alarmTriggers[0]?.id,
        }),
      ]);
    });

    it('emits idempotent_dropped (not alarms_received) on a duplicate SNS message id', async () => {
      const db = new FakeApiDatabase();
      const { app } = appFor(configWithWebhook(), db, {
        fetchSigningCert: async () => certPem,
      });
      const message = notificationMessage({ MessageId: 'duplicate-message' });

      await app.inject({
        method: 'POST',
        url: '/webhooks/cloudwatch/secret-token',
        payload: JSON.stringify(message),
        headers: { 'content-type': 'text/plain' },
      });

      const infoSpy = vi.spyOn(app.log, 'info');
      const response = await app.inject({
        method: 'POST',
        url: '/webhooks/cloudwatch/secret-token',
        payload: JSON.stringify(message),
        headers: { 'content-type': 'text/plain' },
      });

      expect(response.statusCode).toBe(200);
      const metrics = metricPayloads(infoSpy);
      expect(metrics).toEqual([
        expect.objectContaining({
          metric: 'alarm_pipeline.idempotent_dropped',
          alarm_name: 'CPUHigh',
          sns_message_id: 'duplicate-message',
        }),
      ]);
      expect(metrics.some((metric) => metric['metric'] === 'alarm_pipeline.alarms_received')).toBe(
        false
      );
    });

    it('does not emit alarms_received or idempotent_dropped for a non-ALARM notification', async () => {
      const db = new FakeApiDatabase();
      const { app } = appFor(configWithWebhook(), db, {
        fetchSigningCert: async () => certPem,
      });
      const infoSpy = vi.spyOn(app.log, 'info');
      const message = notificationMessage({}, cloudWatchAlarmPayload({ NewStateValue: 'OK' }));

      const response = await app.inject({
        method: 'POST',
        url: '/webhooks/cloudwatch/secret-token',
        payload: JSON.stringify(message),
        headers: { 'content-type': 'text/plain' },
      });

      expect(response.statusCode).toBe(200);
      const metrics = metricPayloads(infoSpy);
      expect(
        metrics.some((metric) =>
          ['alarm_pipeline.alarms_received', 'alarm_pipeline.idempotent_dropped'].includes(
            metric['metric'] as string
          )
        )
      ).toBe(false);
    });
  });
});
