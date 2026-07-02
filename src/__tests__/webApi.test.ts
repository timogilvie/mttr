import { afterEach, describe, expect, it } from 'vitest';
import type { QueryResult, QueryResultRow } from 'pg';
import type { Config } from '../config.js';
import type { DatabaseClient } from '../db/postgres.js';
import { createWebServer } from '../web/api.js';

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
});
