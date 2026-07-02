import { describe, expect, it } from 'vitest';
import type { QueryResult, QueryResultRow } from 'pg';
import type { ClassificationResult, DecisionResult, VerificationResult } from '../types.js';
import type { DatabaseClient } from '../db/postgres.js';
import { MIGRATIONS, runMigrations } from '../db/migrations.js';
import {
  enqueueAlarmTriggerOnce,
  markSnsMessageProcessed,
  PostgresAgentStateRepository,
} from '../state/repository.js';
import {
  hashReportContent,
  hasProcessedReport,
  reconcileObservations,
  recordProcessedReport,
} from '../state/agentState.js';

function result<T extends QueryResultRow>(rows: T[]): QueryResult<T> {
  return {
    rows,
    rowCount: rows.length,
    command: '',
    oid: 0,
    fields: [],
  };
}

function classification(
  severity: 'MEDIUM' | 'HIGH' = 'MEDIUM',
  evidence = ['105 4xx errors']
): ClassificationResult {
  return {
    summary: 'finding',
    overall_severity: severity,
    incidents: [],
    findings: [
      {
        title: 'High 4xx Error Rate in data-pipeline-api',
        classification: 'AUTH_FAILURE',
        severity,
        confidence: 0.7,
        affected_services: ['data-pipeline-api'],
        evidence,
        reason_not_incident: 'No supporting logs.',
      },
    ],
  };
}

class FakeStateDatabase implements DatabaseClient {
  reports = new Map<string, Record<string, unknown>>();
  observations = new Map<string, Record<string, unknown>>();
  runs = new Map<string, Record<string, unknown>>();
  incidents = new Map<string, Record<string, unknown>>();
  alerts = new Map<string, Record<string, unknown>>();
  workerHeartbeats = new Map<string, Record<string, unknown>>();
  incidentEvents: Array<Record<string, unknown>> = [];
  processedSnsMessages = new Set<string>();
  alarmTriggers: Array<Record<string, unknown>> = [];
  queries: string[] = [];
  private runCounter = 0;
  private snapshot?:
    | {
        processedSnsMessages: Set<string>;
        alarmTriggers: Array<Record<string, unknown>>;
      }
    | undefined;

  async query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    params: readonly unknown[] = []
  ): Promise<QueryResult<T>> {
    this.queries.push(text);
    const normalized = text.replace(/\s+/g, ' ').trim();

    if (normalized === 'BEGIN' || normalized === 'COMMIT' || normalized === 'ROLLBACK') {
      if (normalized === 'BEGIN') {
        this.snapshot = {
          processedSnsMessages: new Set(this.processedSnsMessages),
          alarmTriggers: this.alarmTriggers.map((row) => ({ ...row })),
        };
      }
      if (normalized === 'COMMIT') {
        this.snapshot = undefined;
      }
      if (normalized === 'ROLLBACK' && this.snapshot) {
        this.processedSnsMessages = this.snapshot.processedSnsMessages;
        this.alarmTriggers = this.snapshot.alarmTriggers;
        this.snapshot = undefined;
      }
      return result<T>([]);
    }

    if (normalized.startsWith('INSERT INTO processed_sns_messages')) {
      const snsMessageId = String(params[0]);
      if (this.processedSnsMessages.has(snsMessageId)) {
        return result<T>([]);
      }
      this.processedSnsMessages.add(snsMessageId);
      return result<T>([{ sns_message_id: snsMessageId } as unknown as T]);
    }

    if (normalized.startsWith('INSERT INTO alarm_triggers')) {
      const id = `trigger-${this.alarmTriggers.length + 1}`;
      this.alarmTriggers.push({
        id,
        sns_message_id: params[0],
        alarm_arn: params[1],
        alarm_name: params[2],
        new_state: params[3],
        state_change_time: params[4],
        severity: params[5],
        spec_key: params[6],
        payload: JSON.parse(String(params[7])),
        status: 'pending',
      });
      return result<T>([{ id } as unknown as T]);
    }

    if (normalized.startsWith('SELECT health_report_s3_uri')) {
      const report = this.reports.get(String(params[0]));
      return result<T>(report ? [report as T] : []);
    }

    if (normalized.startsWith('SELECT observation_key')) {
      const uri = String(params[0]);
      const rows = [...this.observations.values()].filter(
        (row) => row['health_report_s3_uri'] === uri
      );
      return result<T>(rows as unknown as T[]);
    }

    if (normalized.startsWith('SELECT incident_id, severity, state, current_disposition')) {
      const ids = params[0] as string[];
      const rows = ids
        .map((id) => this.incidents.get(id))
        .filter((row): row is Record<string, unknown> => Boolean(row))
        .map((row) => ({
          incident_id: row['incident_id'],
          severity: row['severity'],
          state: row['state'],
          current_disposition: row['current_disposition'] ?? null,
          current_next_stage: row['current_next_stage'] ?? null,
          closed_at: row['closed_at'] ?? null,
        }));
      return result<T>(rows as unknown as T[]);
    }

    if (normalized.startsWith('SELECT dedupe_key FROM alerts')) {
      const alert = this.alerts.get(String(params[0]));
      return result<T>(alert ? [alert as T] : []);
    }

    if (normalized.startsWith('INSERT INTO report_states')) {
      this.reports.set(String(params[0]), {
        health_report_s3_uri: params[0],
        report_hash: params[1],
        processed_at: params[2],
      });
      return result<T>([]);
    }

    if (normalized.startsWith('INSERT INTO worker_heartbeats')) {
      this.workerHeartbeats.set(String(params[0]), {
        worker_id: params[0],
        process_name: params[1],
        last_seen_at: params[2],
        metadata_json: JSON.parse(String(params[3])),
      });
      return result<T>([]);
    }

    if (normalized.startsWith('INSERT INTO runs')) {
      this.runCounter += 1;
      const id = `run-${this.runCounter}`;
      this.runs.set(id, {
        id,
        started_at: params[0],
        status: params[1],
        health_report_s3_uri: params[2],
      });
      return result<T>([{ id } as unknown as T]);
    }

    if (normalized.startsWith('UPDATE runs')) {
      const id = String(params[0]);
      const existing = this.runs.get(id);
      if (!existing) {
        throw new Error(`No run ${id}`);
      }
      if (normalized.includes('raw_classification_json')) {
        this.runs.set(id, { ...existing, raw_classification_json: JSON.parse(String(params[1])) });
        return result<T>([]);
      }
      if (normalized.includes('raw_investigation_json')) {
        this.runs.set(id, { ...existing, raw_investigation_json: JSON.parse(String(params[1])) });
        return result<T>([]);
      }
      if (normalized.includes('raw_decision_json')) {
        this.runs.set(id, { ...existing, raw_decision_json: JSON.parse(String(params[1])) });
        return result<T>([]);
      }
      if (normalized.includes('raw_verification_json')) {
        this.runs.set(id, { ...existing, raw_verification_json: JSON.parse(String(params[1])) });
        return result<T>([]);
      }
      this.runs.set(id, {
        ...existing,
        finished_at: params[1],
        status: params[2],
        report_hash: params[3],
        summary: params[4],
        overall_severity: params[5],
        error_message: params[6],
      });
      return result<T>([]);
    }

    if (normalized.startsWith('INSERT INTO incident_events')) {
      this.incidentEvents.push({
        incident_id: params[0],
        run_id: params[1],
        stage: params[2],
        message: params[3],
        severity: params[4],
        evidence_json: JSON.parse(String(params[5])),
      });
      return result<T>([]);
    }

    if (normalized.startsWith('INSERT INTO alerts')) {
      const dedupeKey = String(params[3]);
      if (!this.alerts.has(dedupeKey)) {
        this.alerts.set(dedupeKey, {
          incident_id: params[0],
          run_id: params[1],
          channel: params[2],
          dedupe_key: params[3],
          payload_json: JSON.parse(String(params[4])),
        });
      }
      return result<T>([]);
    }

    if (normalized.startsWith('INSERT INTO incidents') && normalized.includes('current_disposition')) {
      const id = String(params[0]);
      const existing = this.incidents.get(id);
      this.incidents.set(id, {
        ...existing,
        incident_id: params[0],
        title: params[1],
        service: params[2],
        severity: params[3],
        state: params[4],
        opened_at: existing?.['opened_at'] ?? params[5],
        current_disposition: params[6],
        current_next_stage: params[7],
        current_decision_json: JSON.parse(String(params[8])),
        last_run_id: params[9],
      });
      return result<T>([]);
    }

    if (normalized.startsWith('INSERT INTO incidents') && normalized.includes('now()')) {
      const id = String(params[0]);
      const existing = this.incidents.get(id);
      this.incidents.set(id, {
        ...existing,
        incident_id: params[0],
        title: params[1],
        service: params[2] ?? existing?.['service'],
        severity: params[3],
        state: existing?.['state'] ?? params[4],
        last_run_id: params[5],
      });
      return result<T>([]);
    }

    if (normalized.startsWith('INSERT INTO incidents')) {
      const id = String(params[0]);
      const existing = this.incidents.get(id);
      this.incidents.set(id, {
        ...existing,
        incident_id: params[0],
        title: params[1],
        service: params[2],
        severity: params[3],
        state: params[4],
        opened_at: existing?.['opened_at'] ?? params[5],
        closed_at: params[6],
        last_run_id: params[7],
      });
      return result<T>([]);
    }

    if (normalized.startsWith('DELETE FROM observation_states')) {
      const uri = String(params[0]);
      for (const [key, row] of this.observations.entries()) {
        if (row['health_report_s3_uri'] === uri) {
          this.observations.delete(key);
        }
      }
      return result<T>([]);
    }

    if (normalized.startsWith('INSERT INTO observation_states')) {
      const row = {
        health_report_s3_uri: params[0],
        observation_key: params[1],
        observation_type: params[2],
        title: params[3],
        classification: params[4],
        affected_services: params[5],
        severity: params[6],
        confidence: params[7],
        signature: params[8],
        status: params[9],
        first_seen: params[10],
        last_seen: params[11],
        last_changed_at: params[12],
        occurrences: params[13],
        resolved_at: params[14],
      };
      this.observations.set(`${String(params[0])}:${String(params[1])}`, row);
      return result<T>([]);
    }

    throw new Error(`Unexpected query: ${text}`);
  }
}

describe('Postgres state repository', () => {
  it('marks SNS messages processed once', async () => {
    const db = new FakeStateDatabase();

    await expect(markSnsMessageProcessed(db, 'sns-1')).resolves.toBe(true);
    await expect(markSnsMessageProcessed(db, 'sns-1')).resolves.toBe(false);
    expect(db.processedSnsMessages.has('sns-1')).toBe(true);
  });

  it('atomically enqueues an ALARM trigger once per SNS message id', async () => {
    const db = new FakeStateDatabase();

    await expect(
      enqueueAlarmTriggerOnce(db, {
        snsMessageId: 'sns-1',
        alarmArn: 'arn:aws:cloudwatch:us-east-1:123456789012:alarm:CPUHigh',
        alarmName: 'CPUHigh',
        newState: 'ALARM',
        stateChangeTime: '2026-07-01T12:34:56.000+0000',
        payload: { AlarmName: 'CPUHigh', NewStateValue: 'ALARM' },
      })
    ).resolves.toMatchObject({ duplicate: false, enqueued: true, id: 'trigger-1' });

    await expect(
      enqueueAlarmTriggerOnce(db, {
        snsMessageId: 'sns-1',
        alarmArn: 'arn:aws:cloudwatch:us-east-1:123456789012:alarm:CPUHigh',
        alarmName: 'CPUHigh',
        newState: 'ALARM',
        stateChangeTime: '2026-07-01T12:34:56.000+0000',
        payload: { AlarmName: 'CPUHigh', NewStateValue: 'ALARM' },
      })
    ).resolves.toMatchObject({ duplicate: true, enqueued: false });

    expect(db.processedSnsMessages.size).toBe(1);
    expect(db.alarmTriggers).toHaveLength(1);
  });

  it('records non-ALARM messages without enqueueing a trigger row', async () => {
    const db = new FakeStateDatabase();

    await expect(
      enqueueAlarmTriggerOnce(db, {
        snsMessageId: 'sns-2',
        alarmArn: 'arn:aws:cloudwatch:us-east-1:123456789012:alarm:CPUHigh',
        alarmName: 'CPUHigh',
        newState: 'OK',
        stateChangeTime: '2026-07-01T12:34:56.000+0000',
        payload: { AlarmName: 'CPUHigh', NewStateValue: 'OK' },
      })
    ).resolves.toMatchObject({ duplicate: false, enqueued: false });

    expect(db.processedSnsMessages.has('sns-2')).toBe(true);
    expect(db.alarmTriggers).toHaveLength(0);
  });

  it('runs the enqueue transaction on a single pinned pool connection and releases it', async () => {
    const pinned = new FakeStateDatabase();
    const poolQueries: string[] = [];
    let released = 0;
    // A pool-like client: query() would check out a fresh connection per call,
    // so a real transaction must go through connect() to pin one connection.
    const pool = {
      async query<T extends QueryResultRow = QueryResultRow>(
        text: string,
        params: readonly unknown[] = []
      ): Promise<QueryResult<T>> {
        poolQueries.push(text.replace(/\s+/g, ' ').trim());
        return pinned.query<T>(text, params);
      },
      async connect() {
        return {
          query: pinned.query.bind(pinned),
          release: () => {
            released += 1;
          },
        };
      },
    };

    await expect(
      enqueueAlarmTriggerOnce(pool as unknown as DatabaseClient, {
        snsMessageId: 'sns-pinned',
        alarmArn: 'arn:aws:cloudwatch:us-east-1:123456789012:alarm:CPUHigh',
        alarmName: 'CPUHigh',
        newState: 'ALARM',
        stateChangeTime: '2026-07-01T12:34:56.000+0000',
        payload: { AlarmName: 'CPUHigh', NewStateValue: 'ALARM' },
      })
    ).resolves.toMatchObject({ duplicate: false, enqueued: true });

    // Every statement ran on the pinned connection; the pool was never queried
    // directly, so BEGIN..COMMIT could not be split across connections.
    expect(poolQueries).toHaveLength(0);
    expect(pinned.queries[0]?.trim()).toBe('BEGIN');
    expect(pinned.queries.at(-1)?.trim()).toBe('COMMIT');
    expect(released).toBe(1);
  });

  it('persists worker run lifecycle fields', async () => {
    const db = new FakeStateDatabase();
    const repository = new PostgresAgentStateRepository(db, 's3://bucket/report.md');

    const runId = await repository.startRun('2026-06-08T10:00:00Z');
    await repository.finishRun(runId, {
      status: 'success',
      finishedAt: '2026-06-08T10:01:00Z',
      reportHash: 'abc123',
      summary: 'A finding to investigate.',
      overallSeverity: 'MEDIUM',
    });

    expect(db.runs.get(runId)).toMatchObject({
      started_at: '2026-06-08T10:00:00Z',
      finished_at: '2026-06-08T10:01:00Z',
      status: 'success',
      health_report_s3_uri: 's3://bucket/report.md',
      report_hash: 'abc123',
      summary: 'A finding to investigate.',
      overall_severity: 'MEDIUM',
      error_message: null,
    });
    expect(db.workerHeartbeats.get('default')).toMatchObject({
      worker_id: 'default',
      process_name: 'mttr-worker',
      last_seen_at: '2026-06-08T10:00:00Z',
      metadata_json: { health_report_s3_uri: 's3://bucket/report.md' },
    });
  });

  it('persists report hashes and recurring observations', async () => {
    const db = new FakeStateDatabase();
    const repository = new PostgresAgentStateRepository(db, 's3://bucket/report.md');
    const fingerprint = hashReportContent('# report');

    const firstState = await repository.load();
    expect(hasProcessedReport(firstState, 's3://bucket/report.md', fingerprint)).toBe(false);

    recordProcessedReport(firstState, 's3://bucket/report.md', fingerprint, '2026-06-08T10:00:00Z');
    const firstReconciliation = reconcileObservations(
      firstState,
      classification(),
      '2026-06-08T10:00:00Z'
    );
    await repository.save(firstState);

    expect(firstReconciliation.shouldInvestigate).toBe(true);

    const secondState = await repository.load();
    expect(hasProcessedReport(secondState, 's3://bucket/report.md', fingerprint)).toBe(true);
    const secondReconciliation = reconcileObservations(
      secondState,
      classification(),
      '2026-06-08T10:15:00Z'
    );

    expect(secondReconciliation.recurringObservations).toHaveLength(1);
    expect(secondReconciliation.recurringObservations[0]?.occurrences).toBe(2);
    expect(secondReconciliation.shouldInvestigate).toBe(false);
  });

  it('persists severity escalation and resolved observations', async () => {
    const db = new FakeStateDatabase();
    const repository = new PostgresAgentStateRepository(db, 's3://bucket/report.md');
    const state = await repository.load();

    reconcileObservations(state, classification(), '2026-06-08T10:00:00Z');
    await repository.save(state);

    const escalatedState = await repository.load();
    const escalated = reconcileObservations(
      escalatedState,
      classification('HIGH'),
      '2026-06-08T10:15:00Z'
    );
    expect(escalated.changedObservations).toHaveLength(1);
    expect(escalated.changedObservations[0]?.severity).toBe('HIGH');
    await repository.save(escalatedState);

    const clearState = await repository.load();
    const resolved = reconcileObservations(
      clearState,
      { summary: 'clear', overall_severity: 'NONE', incidents: [], findings: [] },
      '2026-06-08T10:30:00Z'
    );

    expect(resolved.resolvedObservations).toHaveLength(1);
    expect(resolved.resolvedObservations[0]?.status).toBe('resolved');
  });

  it('syncs reconciled observations into incidents with run linkage', async () => {
    const db = new FakeStateDatabase();
    const repository = new PostgresAgentStateRepository(db, 's3://bucket/report.md');
    const runId = await repository.startRun('2026-06-08T10:00:00Z');
    const state = await repository.load();
    const first = reconcileObservations(state, classification(), '2026-06-08T10:00:00Z');

    await repository.recordReconciliation(runId, first);

    const incident = [...db.incidents.values()][0];
    expect(incident).toMatchObject({
      title: 'High 4xx Error Rate in data-pipeline-api',
      service: 'data-pipeline-api',
      severity: 'MEDIUM',
      state: 'open',
      opened_at: '2026-06-08T10:00:00Z',
      closed_at: null,
      last_run_id: runId,
    });

    const clearState = await repository.load();
    clearState.observations = state.observations;
    const resolved = reconcileObservations(
      clearState,
      { summary: 'clear', overall_severity: 'NONE', incidents: [], findings: [] },
      '2026-06-08T10:15:00Z'
    );

    await repository.recordReconciliation(runId, resolved);

    const resolvedIncident = db.incidents.get(String(incident?.['incident_id']));
    expect(resolvedIncident).toMatchObject({
      state: 'resolved',
      closed_at: '2026-06-08T10:15:00Z',
      last_run_id: runId,
    });
  });

  it('records current decision fields on incidents', async () => {
    const db = new FakeStateDatabase();
    const repository = new PostgresAgentStateRepository(db, 's3://bucket/report.md');
    const runId = await repository.startRun('2026-06-08T10:00:00Z');
    const decision: DecisionResult = {
      summary: 'Decision stage selected Verify.',
      overall_next_stage: 'Verify',
      handoff_notes: ['INC-001: verify first'],
      decisions: [
        {
          incident_id: 'INC-001',
          title: 'High 4xx',
          disposition: 'VERIFY',
          next_stage: 'Verify',
          severity: 'MEDIUM',
          affected_services: ['data-pipeline-api'],
          rationale: 'Verify current health.',
          evidence_to_pass: ['e'],
          follow_up_actions: [],
        },
      ],
    };

    await repository.recordDecisions(runId, decision);

    expect(db.incidents.get('INC-001')).toMatchObject({
      current_disposition: 'VERIFY',
      current_next_stage: 'Verify',
      last_run_id: runId,
      service: 'data-pipeline-api',
    });
    expect(db.incidents.get('INC-001')?.['current_decision_json']).toMatchObject({
      incident_id: 'INC-001',
      disposition: 'VERIFY',
    });
  });

  it('persists decision transition events with alert metadata', async () => {
    const db = new FakeStateDatabase();
    const repository = new PostgresAgentStateRepository(db, 's3://bucket/report.md');
    const runId = await repository.startRun('2026-06-08T10:00:00Z');
    const decision: DecisionResult = {
      summary: 'Decision stage selected mitigation.',
      overall_next_stage: 'Mitigate',
      handoff_notes: ['INC-001: mitigate now'],
      decisions: [
        {
          incident_id: 'INC-001',
          title: 'High 4xx',
          disposition: 'MITIGATE',
          next_stage: 'Mitigate',
          severity: 'HIGH',
          affected_services: ['data-pipeline-api'],
          rationale: 'Error rate is user visible.',
          evidence_to_pass: ['e'],
          follow_up_actions: [],
        },
      ],
    };

    const transitions = await repository.recordDecisionTransitions(runId, decision);

    expect(transitions[0]).toMatchObject({
      transitionType: 'new_incident',
      alertable: true,
    });
    expect(db.incidentEvents[0]).toMatchObject({
      incident_id: 'INC-001',
      run_id: runId,
      stage: 'Decide',
      severity: 'HIGH',
    });
    expect(db.incidentEvents[0]?.['evidence_json']).toMatchObject({
      transition_type: 'new_incident',
      alertable: true,
      next_stage: 'Mitigate',
    });
  });

  it('records unchanged decision transitions as non-alertable', async () => {
    const db = new FakeStateDatabase();
    const repository = new PostgresAgentStateRepository(db, 's3://bucket/report.md');
    const runId = await repository.startRun('2026-06-08T10:00:00Z');
    db.incidents.set('INC-001', {
      incident_id: 'INC-001',
      title: 'High 4xx',
      service: 'data-pipeline-api',
      severity: 'MEDIUM',
      state: 'decision',
      current_disposition: 'VERIFY',
      current_next_stage: 'Verify',
      closed_at: null,
    });

    await repository.recordDecisionTransitions(runId, {
      summary: 'Decision stage selected Verify.',
      overall_next_stage: 'Verify',
      handoff_notes: [],
      decisions: [
        {
          incident_id: 'INC-001',
          title: 'High 4xx',
          disposition: 'VERIFY',
          next_stage: 'Verify',
          severity: 'MEDIUM',
          affected_services: ['data-pipeline-api'],
          rationale: 'Verify current health.',
          evidence_to_pass: ['e'],
          follow_up_actions: [],
        },
      ],
    });

    expect(db.incidentEvents[0]?.['evidence_json']).toMatchObject({
      transition_type: 'unchanged',
      alertable: false,
    });
  });

  it('persists verification transition events', async () => {
    const db = new FakeStateDatabase();
    const repository = new PostgresAgentStateRepository(db, 's3://bucket/report.md');
    const runId = await repository.startRun('2026-06-08T10:00:00Z');
    db.incidents.set('INC-001', {
      incident_id: 'INC-001',
      title: 'High 4xx',
      service: 'data-pipeline-api',
      severity: 'MEDIUM',
      state: 'decision',
      current_disposition: 'VERIFY',
      current_next_stage: 'Verify',
      closed_at: null,
    });
    const verification: VerificationResult = {
      summary: 'Recovered.',
      overall_status: 'VERIFIED_RECOVERED_TRANSIENT',
      overall_next_stage: 'None',
      verifications: [
        {
          incident_id: 'INC-001',
          title: 'High 4xx',
          status: 'VERIFIED_RECOVERED_TRANSIENT',
          severity: 'LOW',
          rationale: 'Errors returned to baseline.',
          checks: [],
          recommended_next_stage: 'None',
        },
      ],
    };

    const transitions = await repository.recordVerificationTransitions(runId, verification);

    expect(transitions[0]).toMatchObject({
      transitionType: 'recovered',
      alertable: true,
    });
    expect(db.incidentEvents[0]).toMatchObject({
      incident_id: 'INC-001',
      stage: 'Verify',
      severity: 'LOW',
    });
    expect(db.incidentEvents[0]?.['evidence_json']).toMatchObject({
      transition_type: 'recovered',
      alertable: true,
      status: 'VERIFIED_RECOVERED_TRANSIENT',
    });
  });

  it('persists raw stage JSON on runs with secret-like values redacted', async () => {
    const db = new FakeStateDatabase();
    const repository = new PostgresAgentStateRepository(db, 's3://bucket/report.md');
    const runId = await repository.startRun('2026-06-08T10:00:00Z');
    const rawClassification = {
      ...classification(),
      diagnostic: {
        apiKey: 'should-not-store',
        authorization: 'Bearer abc.def.ghi',
      },
    } as unknown as ClassificationResult;

    await repository.recordStageOutput(runId, {
      stage: 'Classify',
      data: rawClassification,
    });

    expect(db.runs.get(runId)?.['raw_classification_json']).toMatchObject({
      diagnostic: {
        apiKey: '[REDACTED]',
        authorization: '[REDACTED]',
      },
    });
  });

  it('records ordered incident events with sanitized evidence and run linkage', async () => {
    const db = new FakeStateDatabase();
    const repository = new PostgresAgentStateRepository(db, 's3://bucket/report.md');
    const runId = await repository.startRun('2026-06-08T10:00:00Z');

    await repository.recordIncidentEvents(runId, [
      {
        incidentId: 'INC-001',
        title: 'High 4xx',
        stage: 'Classify',
        message: 'AUTH_FAILURE: High 4xx',
        severity: 'MEDIUM',
        service: 'data-pipeline-api',
        evidence: { evidence: ['4xx'], token: 'secret-token' },
      },
      {
        incidentId: 'INC-001',
        title: 'High 4xx',
        stage: 'Investigate',
        message: 'POSSIBLE_INCIDENT: High 4xx',
        severity: 'MEDIUM',
        evidence: { supporting_evidence: ['Authorization: Bearer abc.def'] },
      },
    ]);

    expect(db.incidentEvents.map((event) => event['stage'])).toEqual([
      'Classify',
      'Investigate',
    ]);
    expect(db.incidentEvents[0]).toMatchObject({
      incident_id: 'INC-001',
      run_id: runId,
      message: 'AUTH_FAILURE: High 4xx',
      severity: 'MEDIUM',
    });
    expect(db.incidentEvents[0]?.['evidence_json']).toMatchObject({
      evidence: ['4xx'],
      token: '[REDACTED]',
    });
    expect(db.incidentEvents[1]?.['evidence_json']).toMatchObject({
      supporting_evidence: ['Authorization: Bearer [REDACTED]'],
    });
    expect(db.incidents.get('INC-001')).toMatchObject({
      title: 'High 4xx',
      service: 'data-pipeline-api',
      last_run_id: runId,
    });
  });

  it('persists sent alerts with dedupe keys and sanitized payloads', async () => {
    const db = new FakeStateDatabase();
    const repository = new PostgresAgentStateRepository(db, 's3://bucket/report.md');
    const runId = await repository.startRun('2026-06-08T10:00:00Z');

    expect(await repository.hasAlert('slack:INC-001:new_incident:HIGH:MITIGATE')).toBe(false);

    await repository.recordAlertSent({
      incidentId: 'INC-001',
      runId,
      channel: 'slack',
      dedupeKey: 'slack:INC-001:new_incident:HIGH:MITIGATE',
      payload: {
        text: 'High 4xx',
        webhookUrl: 'https://hooks.slack.test/services/secret',
      },
    });
    await repository.recordAlertSent({
      incidentId: 'INC-001',
      runId,
      channel: 'slack',
      dedupeKey: 'slack:INC-001:new_incident:HIGH:MITIGATE',
      payload: { text: 'duplicate' },
    });

    expect(await repository.hasAlert('slack:INC-001:new_incident:HIGH:MITIGATE')).toBe(true);
    expect(db.alerts.size).toBe(1);
    expect(db.alerts.get('slack:INC-001:new_incident:HIGH:MITIGATE')).toMatchObject({
      incident_id: 'INC-001',
      run_id: runId,
      channel: 'slack',
      dedupe_key: 'slack:INC-001:new_incident:HIGH:MITIGATE',
      payload_json: {
        text: 'High 4xx',
        webhookUrl: '[REDACTED]',
      },
    });
  });
});

describe('database migrations', () => {
  it('creates the continuous-monitoring tables', () => {
    const sql = MIGRATIONS.map((migration) => migration.sql).join('\n');

    for (const table of [
      'report_states',
      'observation_states',
      'runs',
      'incidents',
      'incident_events',
      'alerts',
      'worker_heartbeats',
      'alarm_triggers',
      'processed_sns_messages',
    ]) {
      expect(sql).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
    }
  });

  it('adds alarm trigger queue migration with run provenance fields', () => {
    const migration = MIGRATIONS.find((item) => item.id === 2);

    expect(migration?.name).toBe('alarm_triggers_queue');
    expect(migration?.sql).toContain('new_state text NOT NULL CHECK');
    expect(migration?.sql).toContain("status text NOT NULL DEFAULT 'pending'");
    expect(migration?.sql).toContain('CREATE INDEX IF NOT EXISTS alarm_triggers_status_received_idx');
    expect(migration?.sql).toContain('ON alarm_triggers (status, received_at)');
    expect(migration?.sql).toContain('run_id uuid REFERENCES runs(id) ON DELETE SET NULL');
    expect(migration?.sql).toContain('ADD COLUMN IF NOT EXISTS trigger_source');
    expect(migration?.sql).toContain("trigger_source text NOT NULL DEFAULT 'scheduled'");
  });

  it('runs migrations inside a transaction and records applied migrations', async () => {
    const queries: string[] = [];
    const client: DatabaseClient = {
      async query<T extends QueryResultRow = QueryResultRow>(
        text: string,
        params: readonly unknown[] = []
      ): Promise<QueryResult<T>> {
        queries.push(`${text}:${params.join(',')}`);
        if (text.includes('SELECT id FROM schema_migrations')) {
          return result<T>([]);
        }
        return result<T>([]);
      },
    };

    await runMigrations(client);

    expect(queries[0]).toBe('BEGIN:');
    expect(queries.some((query) => query.includes('continuous_monitoring_state'))).toBe(true);
    expect(queries.some((query) => query.includes('alarm_triggers_queue'))).toBe(true);
    expect(queries.at(-1)).toBe('COMMIT:');
  });
});
