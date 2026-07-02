import { createSign, generateKeyPairSync } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { QueryResult, QueryResultRow } from 'pg';
import type { Config } from '../config.js';
import type { DatabaseClient } from '../db/postgres.js';
import { createWebServer, type WebServerDependencies } from '../web/api.js';
import { buildCanonicalString, clearSnsCertCache, type SnsMessage } from '../web/snsVerify.js';

function result<T extends QueryResultRow>(rows: T[]): QueryResult<T> {
  return {
    rows,
    rowCount: rows.length,
    command: '',
    oid: 0,
    fields: [],
  };
}

const config: Config = {
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
  monitoring: { intervalMs: 900000 },
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

class FakeApiDatabase implements DatabaseClient {
  queries: string[] = [];
  runs = [
    {
      id: 'run-1',
      started_at: '2026-06-08T10:00:00Z',
      finished_at: '2026-06-08T10:01:00Z',
      status: 'success',
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

  async query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    params: readonly unknown[] = []
  ): Promise<QueryResult<T>> {
    this.queries.push(text);
    const normalized = text.replace(/\s+/g, ' ').trim();

    if (normalized.includes('FROM runs') && normalized.includes('WHERE id = $1')) {
      return result<T>(this.runs.filter((row) => row.id === params[0]) as unknown as T[]);
    }
    if (normalized.includes('FROM runs')) {
      return result<T>(this.runs as unknown as T[]);
    }
    if (normalized.includes('count(*)::text')) {
      return result<T>([{ severity: 'HIGH', count: '1' } as unknown as T]);
    }
    if (normalized.includes('FROM incidents') && normalized.includes('WHERE incident_id = $1')) {
      return result<T>(
        this.incidents.filter((row) => row.incident_id === params[0]) as unknown as T[]
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

interface FakeAlarmTriggerRow {
  id: string;
  sns_message_id: unknown;
  alarm_arn: unknown;
  alarm_name: unknown;
  new_state: unknown;
  state_change_time: unknown;
  payload: unknown;
}

class FakeWebhookDatabase extends FakeApiDatabase {
  processedMessageIds = new Set<string>();
  alarmTriggers: FakeAlarmTriggerRow[] = [];
  failAlarmTriggerInsert = false;
  private nextTriggerId = 1;

  override async query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    params: readonly unknown[] = []
  ): Promise<QueryResult<T>> {
    const normalized = text.replace(/\s+/g, ' ').trim();

    if (normalized === 'BEGIN' || normalized === 'COMMIT' || normalized === 'ROLLBACK') {
      return result<T>([]);
    }

    if (normalized.includes('INSERT INTO processed_sns_messages')) {
      const messageId = params[0] as string;
      if (this.processedMessageIds.has(messageId)) {
        return result<T>([]);
      }
      this.processedMessageIds.add(messageId);
      return result<T>([{ sns_message_id: messageId } as unknown as T]);
    }

    if (normalized.includes('INSERT INTO alarm_triggers')) {
      if (this.failAlarmTriggerInsert) {
        throw new Error('simulated alarm_triggers insert failure');
      }
      const id = `trigger-${this.nextTriggerId++}`;
      this.alarmTriggers.push({
        id,
        sns_message_id: params[0],
        alarm_arn: params[1],
        alarm_name: params[2],
        new_state: params[3],
        state_change_time: params[4],
        payload: params[5],
      });
      return result<T>([{ id } as unknown as T]);
    }

    return super.query<T>(text, params);
  }
}

const WEBHOOK_TOPIC_ARN = 'arn:aws:sns:us-east-1:123456789012:mttr-alarms';
const WEBHOOK_CERT_URL = 'https://sns.us-east-1.amazonaws.com/SimpleNotificationService-abc123.pem';
const WEBHOOK_PATH_TOKEN = 'secret123';

function webhookConfig(overrides: Partial<Config['alarm']['webhook']> = {}): Config {
  const webhook: Config['alarm']['webhook'] = {
    enabled: true,
    pathToken: WEBHOOK_PATH_TOKEN,
    verifySignature: true,
    autoconfirm: true,
    topicArn: WEBHOOK_TOPIC_ARN,
    ...overrides,
  };
  return {
    ...config,
    alarm: { ...config.alarm, webhook },
  };
}

function generateRsaKeyPair(): { publicKey: string; privateKey: string } {
  return generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
}

function signSnsMessage(message: SnsMessage, privateKey: string): string {
  const algorithm = message.SignatureVersion === '1' ? 'RSA-SHA1' : 'RSA-SHA256';
  const signer = createSign(algorithm);
  signer.update(buildCanonicalString(message), 'utf8');
  signer.end();
  return signer.sign(privateKey, 'base64');
}

function alarmMessageJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    AlarmName: 'high-error-rate',
    AlarmArn: 'arn:aws:cloudwatch:us-east-1:123456789012:alarm:high-error-rate',
    NewStateValue: 'ALARM',
    StateChangeTime: '2026-06-08T10:00:00.000Z',
    NewStateReason: 'Threshold Crossed',
    Region: 'US East (N. Virginia)',
    ...overrides,
  });
}

function buildNotification(overrides: Partial<SnsMessage> = {}): SnsMessage {
  return {
    Type: 'Notification',
    MessageId: 'msg-1',
    TopicArn: WEBHOOK_TOPIC_ARN,
    Message: alarmMessageJson(),
    Timestamp: '2026-06-08T10:00:00.000Z',
    SignatureVersion: '2',
    Signature: 'placeholder',
    SigningCertURL: WEBHOOK_CERT_URL,
    ...overrides,
  };
}

function buildConfirmation(overrides: Partial<SnsMessage> = {}): SnsMessage {
  return {
    Type: 'SubscriptionConfirmation',
    MessageId: 'msg-confirm-1',
    TopicArn: WEBHOOK_TOPIC_ARN,
    Message: 'You have chosen to subscribe to the topic. Confirm the subscription.',
    Timestamp: '2026-06-08T10:00:00.000Z',
    SignatureVersion: '2',
    Signature: 'placeholder',
    SigningCertURL: WEBHOOK_CERT_URL,
    SubscribeURL: `https://sns.us-east-1.amazonaws.com/?Action=ConfirmSubscription&TopicArn=${WEBHOOK_TOPIC_ARN}&Token=abc`,
    Token: 'abc',
    ...overrides,
  };
}

function signed(message: SnsMessage, privateKey: string): SnsMessage {
  return { ...message, Signature: signSnsMessage(message, privateKey) };
}

function fetchTextRecorder(
  cert: string,
  calls: string[] = []
): { fetchText: (url: string) => Promise<string>; calls: string[] } {
  return {
    calls,
    fetchText: async (url: string) => {
      calls.push(url);
      if (url === WEBHOOK_CERT_URL) {
        return cert;
      }
      return 'ok';
    },
  };
}

describe('web API', () => {
  const apps: ReturnType<typeof createWebServer>[] = [];

  afterEach(async () => {
    await Promise.all(apps.map((app) => app.close()));
    apps.length = 0;
  });

  function appFor(db = new FakeApiDatabase()) {
    const app = createWebServer(config, db);
    apps.push(app);
    return { app, db };
  }

  function webhookAppFor(
    db: FakeWebhookDatabase,
    cfg: Config,
    deps?: WebServerDependencies
  ): { app: ReturnType<typeof createWebServer>; db: FakeWebhookDatabase } {
    const app = createWebServer(cfg, db, undefined, deps);
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
    const { app } = appFor(db);

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

  it('returns run detail with raw stage output', async () => {
    const { app } = appFor();

    const response = await app.inject({ method: 'GET', url: '/api/runs/run-1' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      run: {
        id: 'run-1',
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

  describe('POST /webhooks/cloudwatch/:token', () => {
    let keyPair: { publicKey: string; privateKey: string };

    beforeEach(() => {
      clearSnsCertCache();
      keyPair = generateRsaKeyPair();
    });

    it('is not mounted when ALARM_WEBHOOK_ENABLED is false', async () => {
      const { app } = appFor();

      const response = await app.inject({
        method: 'POST',
        url: '/webhooks/cloudwatch/anytoken',
        payload: { Type: 'Notification' },
      });

      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({ error: 'not_found' });

      const health = await app.inject({ method: 'GET', url: '/healthz' });
      expect(health.statusCode).toBe(200);
    });

    it('returns 400 for a malformed JSON body sent as text/plain', async () => {
      const db = new FakeWebhookDatabase();
      const { fetchText } = fetchTextRecorder(keyPair.publicKey);
      const { app } = webhookAppFor(db, webhookConfig(), { fetchText });

      const response = await app.inject({
        method: 'POST',
        url: `/webhooks/cloudwatch/${WEBHOOK_PATH_TOKEN}`,
        headers: { 'content-type': 'text/plain' },
        payload: 'not-json{',
      });

      expect(response.statusCode).toBe(400);
      expect(db.alarmTriggers).toHaveLength(0);
    });

    it('parses a JSON body sent with text/plain content-type and enqueues', async () => {
      const db = new FakeWebhookDatabase();
      const { fetchText } = fetchTextRecorder(keyPair.publicKey);
      const { app } = webhookAppFor(db, webhookConfig(), { fetchText });
      const message = signed(buildNotification(), keyPair.privateKey);

      const response = await app.inject({
        method: 'POST',
        url: `/webhooks/cloudwatch/${WEBHOOK_PATH_TOKEN}`,
        headers: { 'content-type': 'text/plain' },
        payload: JSON.stringify(message),
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ status: 'enqueued' });
      expect(db.alarmTriggers).toHaveLength(1);
    });

    it('returns 400 when required SNS fields are missing', async () => {
      const db = new FakeWebhookDatabase();
      const { fetchText } = fetchTextRecorder(keyPair.publicKey);
      const { app } = webhookAppFor(db, webhookConfig(), { fetchText });

      const response = await app.inject({
        method: 'POST',
        url: `/webhooks/cloudwatch/${WEBHOOK_PATH_TOKEN}`,
        payload: { Type: 'Notification', MessageId: 'msg-1' },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({ error: 'invalid_body' });
      expect(db.alarmTriggers).toHaveLength(0);
    });

    it('returns 404 for the wrong path token, regardless of signature validity, with no side effects', async () => {
      const db = new FakeWebhookDatabase();
      const { fetchText, calls } = fetchTextRecorder(keyPair.publicKey);
      const { app } = webhookAppFor(db, webhookConfig(), { fetchText });
      const message = signed(buildNotification(), keyPair.privateKey);
      // Tamper with the signature too, to prove the wrong-token gate wins
      // regardless of signature validity (REQ-F7).
      const tampered = { ...message, Signature: 'not-a-real-signature' };

      const response = await app.inject({
        method: 'POST',
        url: '/webhooks/cloudwatch/wrong-token',
        payload: tampered,
      });

      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({ error: 'not_found' });
      expect(db.alarmTriggers).toHaveLength(0);
      expect(calls).toHaveLength(0);
    });

    it('returns 404 for an empty token segment', async () => {
      const db = new FakeWebhookDatabase();
      const { fetchText } = fetchTextRecorder(keyPair.publicKey);
      const { app } = webhookAppFor(db, webhookConfig(), { fetchText });

      const response = await app.inject({
        method: 'POST',
        url: '/webhooks/cloudwatch/',
        payload: { Type: 'Notification' },
      });

      expect(response.statusCode).toBe(404);
    });

    it('rejects a tampered Message with 403 and no side effects', async () => {
      const db = new FakeWebhookDatabase();
      const { fetchText } = fetchTextRecorder(keyPair.publicKey);
      const { app } = webhookAppFor(db, webhookConfig(), { fetchText });
      const message = signed(buildNotification(), keyPair.privateKey);
      const tampered: SnsMessage = { ...message, Message: alarmMessageJson({ AlarmName: 'tampered' }) };

      const response = await app.inject({
        method: 'POST',
        url: `/webhooks/cloudwatch/${WEBHOOK_PATH_TOKEN}`,
        payload: tampered,
      });

      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual({ error: 'invalid_signature' });
      expect(db.alarmTriggers).toHaveLength(0);
      expect(db.processedMessageIds.has(message.MessageId)).toBe(false);
    });

    it('rejects a disallowed SigningCertURL host with 403 and never fetches the cert', async () => {
      const db = new FakeWebhookDatabase();
      const { fetchText, calls } = fetchTextRecorder(keyPair.publicKey);
      const { app } = webhookAppFor(db, webhookConfig(), { fetchText });
      const message = signed(
        buildNotification({ SigningCertURL: 'https://evil.example.com/cert.pem' }),
        keyPair.privateKey
      );

      const response = await app.inject({
        method: 'POST',
        url: `/webhooks/cloudwatch/${WEBHOOK_PATH_TOKEN}`,
        payload: message,
      });

      expect(response.statusCode).toBe(403);
      expect(calls).toHaveLength(0);
      expect(db.alarmTriggers).toHaveLength(0);
    });

    it('rejects a SigningCertURL that is on an sns host but not https', async () => {
      const db = new FakeWebhookDatabase();
      const { fetchText, calls } = fetchTextRecorder(keyPair.publicKey);
      const { app } = webhookAppFor(db, webhookConfig(), { fetchText });
      const message = signed(
        buildNotification({ SigningCertURL: 'http://sns.us-east-1.amazonaws.com/cert.pem' }),
        keyPair.privateKey
      );

      const response = await app.inject({
        method: 'POST',
        url: `/webhooks/cloudwatch/${WEBHOOK_PATH_TOKEN}`,
        payload: message,
      });

      expect(response.statusCode).toBe(403);
      expect(calls).toHaveLength(0);
    });

    it('rejects a lookalike cert host (sns.<region>.amazonaws.com.evil.com)', async () => {
      const db = new FakeWebhookDatabase();
      const { fetchText, calls } = fetchTextRecorder(keyPair.publicKey);
      const { app } = webhookAppFor(db, webhookConfig(), { fetchText });
      const message = signed(
        buildNotification({ SigningCertURL: 'https://sns.us-east-1.amazonaws.com.evil.com/cert.pem' }),
        keyPair.privateKey
      );

      const response = await app.inject({
        method: 'POST',
        url: `/webhooks/cloudwatch/${WEBHOOK_PATH_TOKEN}`,
        payload: message,
      });

      expect(response.statusCode).toBe(403);
      expect(calls).toHaveLength(0);
    });

    it('rejects an unsupported SignatureVersion with 403, not 500', async () => {
      const db = new FakeWebhookDatabase();
      const { fetchText } = fetchTextRecorder(keyPair.publicKey);
      const { app } = webhookAppFor(db, webhookConfig(), { fetchText });
      const message = { ...buildNotification({ SignatureVersion: '3' }), Signature: 'irrelevant' };

      const response = await app.inject({
        method: 'POST',
        url: `/webhooks/cloudwatch/${WEBHOOK_PATH_TOKEN}`,
        payload: message,
      });

      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual({ error: 'invalid_signature' });
    });

    it('rejects a missing Signature field with 403, not 500', async () => {
      const db = new FakeWebhookDatabase();
      const { fetchText } = fetchTextRecorder(keyPair.publicKey);
      const { app } = webhookAppFor(db, webhookConfig(), { fetchText });
      const message = buildNotification();
      const withoutSignature: Record<string, unknown> = { ...message };
      delete withoutSignature['Signature'];

      const response = await app.inject({
        method: 'POST',
        url: `/webhooks/cloudwatch/${WEBHOOK_PATH_TOKEN}`,
        payload: withoutSignature,
      });

      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual({ error: 'invalid_signature' });
    });

    it('REQ-F7: correct token + tampered signature -> 403; valid signature + wrong token -> 404', async () => {
      const db = new FakeWebhookDatabase();
      const { fetchText } = fetchTextRecorder(keyPair.publicKey);
      const { app } = webhookAppFor(db, webhookConfig(), { fetchText });
      const validMessage = signed(buildNotification(), keyPair.privateKey);

      const badSignatureResponse = await app.inject({
        method: 'POST',
        url: `/webhooks/cloudwatch/${WEBHOOK_PATH_TOKEN}`,
        payload: { ...validMessage, Signature: 'tampered-signature-value' },
      });
      expect(badSignatureResponse.statusCode).toBe(403);

      const wrongTokenResponse = await app.inject({
        method: 'POST',
        url: '/webhooks/cloudwatch/wrong-token',
        payload: validMessage,
      });
      expect(wrongTokenResponse.statusCode).toBe(404);

      expect(db.alarmTriggers).toHaveLength(0);
    });

    it('confirms the SNS subscription via SubscribeURL GET when autoconfirm is on and the topic matches', async () => {
      const db = new FakeWebhookDatabase();
      const { fetchText, calls } = fetchTextRecorder(keyPair.publicKey);
      const { app } = webhookAppFor(db, webhookConfig({ autoconfirm: true }), { fetchText });
      const message = signed(buildConfirmation(), keyPair.privateKey);

      const response = await app.inject({
        method: 'POST',
        url: `/webhooks/cloudwatch/${WEBHOOK_PATH_TOKEN}`,
        payload: message,
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ status: 'confirmed' });
      expect(calls.filter((url) => url === message.SubscribeURL)).toHaveLength(1);
      expect(db.alarmTriggers).toHaveLength(0);
    });

    it('skips confirmation when ALARM_WEBHOOK_AUTOCONFIRM is off', async () => {
      const db = new FakeWebhookDatabase();
      const { fetchText, calls } = fetchTextRecorder(keyPair.publicKey);
      const { app } = webhookAppFor(db, webhookConfig({ autoconfirm: false }), { fetchText });
      const message = signed(buildConfirmation(), keyPair.privateKey);

      const response = await app.inject({
        method: 'POST',
        url: `/webhooks/cloudwatch/${WEBHOOK_PATH_TOKEN}`,
        payload: message,
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ status: 'confirmation_skipped' });
      expect(calls.filter((url) => url === message.SubscribeURL)).toHaveLength(0);
    });

    it('skips confirmation when TopicArn does not match the configured expected topic', async () => {
      const db = new FakeWebhookDatabase();
      const { fetchText, calls } = fetchTextRecorder(keyPair.publicKey);
      const { app } = webhookAppFor(db, webhookConfig(), { fetchText });
      const message = signed(
        buildConfirmation({ TopicArn: 'arn:aws:sns:us-east-1:123456789012:some-other-topic' }),
        keyPair.privateKey
      );

      const response = await app.inject({
        method: 'POST',
        url: `/webhooks/cloudwatch/${WEBHOOK_PATH_TOKEN}`,
        payload: message,
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ status: 'confirmation_skipped' });
      expect(calls.filter((url) => url === message.SubscribeURL)).toHaveLength(0);
    });

    it('rejects a disallowed SubscribeURL host with 403 and does not GET it', async () => {
      const db = new FakeWebhookDatabase();
      const { fetchText, calls } = fetchTextRecorder(keyPair.publicKey);
      const { app } = webhookAppFor(db, webhookConfig(), { fetchText });
      const message = signed(
        buildConfirmation({ SubscribeURL: 'https://evil.example.com/confirm' }),
        keyPair.privateKey
      );

      const response = await app.inject({
        method: 'POST',
        url: `/webhooks/cloudwatch/${WEBHOOK_PATH_TOKEN}`,
        payload: message,
      });

      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual({ error: 'invalid_subscribe_url' });
      expect(calls).not.toContain('https://evil.example.com/confirm');
    });

    it('enqueues exactly one pending alarm_triggers row for a valid ALARM notification', async () => {
      const db = new FakeWebhookDatabase();
      const { fetchText } = fetchTextRecorder(keyPair.publicKey);
      const { app } = webhookAppFor(db, webhookConfig(), { fetchText });
      const message = signed(buildNotification({ MessageId: 'msg-alarm-1' }), keyPair.privateKey);

      const response = await app.inject({
        method: 'POST',
        url: `/webhooks/cloudwatch/${WEBHOOK_PATH_TOKEN}`,
        payload: message,
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ status: 'enqueued' });
      expect(response.json()['triggerId']).toBeTruthy();
      expect(db.alarmTriggers).toHaveLength(1);
      expect(db.alarmTriggers[0]).toMatchObject({
        sns_message_id: 'msg-alarm-1',
        alarm_arn: 'arn:aws:cloudwatch:us-east-1:123456789012:alarm:high-error-rate',
        alarm_name: 'high-error-rate',
        new_state: 'ALARM',
      });
      // The full decoded CloudWatch alarm message is preserved as the stored
      // payload, not just the four fields promoted to their own columns.
      const storedPayload = JSON.parse(db.alarmTriggers[0]?.payload as string) as Record<string, unknown>;
      expect(storedPayload).toMatchObject({
        NewStateReason: 'Threshold Crossed',
        Region: 'US East (N. Virginia)',
      });
    });

    it('returns duplicate status and does not insert a second row for a repeated MessageId', async () => {
      const db = new FakeWebhookDatabase();
      const { fetchText } = fetchTextRecorder(keyPair.publicKey);
      const { app } = webhookAppFor(db, webhookConfig(), { fetchText });
      const message = signed(buildNotification({ MessageId: 'msg-dup-1' }), keyPair.privateKey);

      const first = await app.inject({
        method: 'POST',
        url: `/webhooks/cloudwatch/${WEBHOOK_PATH_TOKEN}`,
        payload: message,
      });
      const second = await app.inject({
        method: 'POST',
        url: `/webhooks/cloudwatch/${WEBHOOK_PATH_TOKEN}`,
        payload: message,
      });

      expect(first.statusCode).toBe(200);
      expect(first.json()).toMatchObject({ status: 'enqueued' });
      expect(second.statusCode).toBe(200);
      expect(second.json()).toEqual({ status: 'duplicate' });
      expect(db.alarmTriggers).toHaveLength(1);
    });

    it('enqueues distinct rows for distinct MessageIds', async () => {
      const db = new FakeWebhookDatabase();
      const { fetchText } = fetchTextRecorder(keyPair.publicKey);
      const { app } = webhookAppFor(db, webhookConfig(), { fetchText });
      const first = signed(buildNotification({ MessageId: 'msg-a' }), keyPair.privateKey);
      const secondMessage = signed(buildNotification({ MessageId: 'msg-b' }), keyPair.privateKey);

      await app.inject({ method: 'POST', url: `/webhooks/cloudwatch/${WEBHOOK_PATH_TOKEN}`, payload: first });
      await app.inject({
        method: 'POST',
        url: `/webhooks/cloudwatch/${WEBHOOK_PATH_TOKEN}`,
        payload: secondMessage,
      });

      expect(db.alarmTriggers).toHaveLength(2);
    });

    it('stays exactly-once under concurrent duplicate deliveries', async () => {
      const db = new FakeWebhookDatabase();
      const { fetchText } = fetchTextRecorder(keyPair.publicKey);
      const { app } = webhookAppFor(db, webhookConfig(), { fetchText });
      const message = signed(buildNotification({ MessageId: 'msg-concurrent' }), keyPair.privateKey);

      const [first, second] = await Promise.all([
        app.inject({ method: 'POST', url: `/webhooks/cloudwatch/${WEBHOOK_PATH_TOKEN}`, payload: message }),
        app.inject({ method: 'POST', url: `/webhooks/cloudwatch/${WEBHOOK_PATH_TOKEN}`, payload: message }),
      ]);

      const statuses = [first.json()['status'], second.json()['status']].sort();
      expect(statuses).toEqual(['duplicate', 'enqueued']);
      expect(db.alarmTriggers).toHaveLength(1);
    });

    it('still enqueues a pending trigger for an OK (recovery) notification', async () => {
      const db = new FakeWebhookDatabase();
      const { fetchText } = fetchTextRecorder(keyPair.publicKey);
      const { app } = webhookAppFor(db, webhookConfig(), { fetchText });
      const message = signed(
        buildNotification({ MessageId: 'msg-ok-1', Message: alarmMessageJson({ NewStateValue: 'OK' }) }),
        keyPair.privateKey
      );

      const response = await app.inject({
        method: 'POST',
        url: `/webhooks/cloudwatch/${WEBHOOK_PATH_TOKEN}`,
        payload: message,
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ status: 'enqueued' });
      expect(db.alarmTriggers).toMatchObject([{ new_state: 'OK' }]);
    });

    it('returns 400 for a Notification whose Message is not valid CloudWatch alarm JSON', async () => {
      const db = new FakeWebhookDatabase();
      const { fetchText } = fetchTextRecorder(keyPair.publicKey);
      const { app } = webhookAppFor(db, webhookConfig(), { fetchText });
      const message = signed(buildNotification({ Message: 'not a cloudwatch payload' }), keyPair.privateKey);

      const response = await app.inject({
        method: 'POST',
        url: `/webhooks/cloudwatch/${WEBHOOK_PATH_TOKEN}`,
        payload: message,
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({ error: 'invalid_alarm_payload' });
      expect(db.alarmTriggers).toHaveLength(0);
    });

    it('returns 200 ignored for UnsubscribeConfirmation with no side effects', async () => {
      const db = new FakeWebhookDatabase();
      const { fetchText, calls } = fetchTextRecorder(keyPair.publicKey);
      const { app } = webhookAppFor(db, webhookConfig(), { fetchText });
      const message = signed(
        buildConfirmation({ Type: 'UnsubscribeConfirmation', MessageId: 'msg-unsub-1' }),
        keyPair.privateKey
      );

      const response = await app.inject({
        method: 'POST',
        url: `/webhooks/cloudwatch/${WEBHOOK_PATH_TOKEN}`,
        payload: message,
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ status: 'ignored' });
      expect(db.alarmTriggers).toHaveLength(0);
      expect(calls.filter((url) => url === message.SubscribeURL)).toHaveLength(0);
    });

    it('returns 500 when the DB enqueue fails unexpectedly, without enqueueing twice', async () => {
      const db = new FakeWebhookDatabase();
      db.failAlarmTriggerInsert = true;
      const { fetchText } = fetchTextRecorder(keyPair.publicKey);
      const { app } = webhookAppFor(db, webhookConfig(), { fetchText });
      const message = signed(buildNotification({ MessageId: 'msg-fail-1' }), keyPair.privateKey);

      const response = await app.inject({
        method: 'POST',
        url: `/webhooks/cloudwatch/${WEBHOOK_PATH_TOKEN}`,
        payload: message,
      });

      expect(response.statusCode).toBe(500);
      expect(db.alarmTriggers).toHaveLength(0);
    });

    it('does not verify signatures when ALARM_WEBHOOK_VERIFY_SIGNATURE is disabled', async () => {
      const db = new FakeWebhookDatabase();
      const { fetchText } = fetchTextRecorder(keyPair.publicKey);
      const { app } = webhookAppFor(db, webhookConfig({ verifySignature: false }), { fetchText });
      const message = { ...buildNotification({ MessageId: 'msg-no-verify' }), Signature: 'not-a-signature' };

      const response = await app.inject({
        method: 'POST',
        url: `/webhooks/cloudwatch/${WEBHOOK_PATH_TOKEN}`,
        payload: message,
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ status: 'enqueued' });
    });
  });
});
