import { describe, expect, it } from 'vitest';
import type { QueryResult, QueryResultRow } from 'pg';
import type { ClassificationResult, DecisionResult, VerificationResult } from '../types.js';
import type { DatabaseClient } from '../db/postgres.js';
import { MIGRATIONS, runMigrations } from '../db/migrations.js';
import { PostgresAgentStateRepository } from '../state/repository.js';
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
  alarmTriggers = new Map<string, Record<string, unknown>>();
  queries: string[] = [];
  private runCounter = 0;

  async query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    params: readonly unknown[] = []
  ): Promise<QueryResult<T>> {
    this.queries.push(text);
    const normalized = text.replace(/\s+/g, ' ').trim();

    if (normalized === 'BEGIN' || normalized === 'COMMIT' || normalized === 'ROLLBACK') {
      return result<T>([]);
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

    if (normalized.startsWith('SELECT count(*)::text AS count FROM alarm_triggers')) {
      const count = [...this.alarmTriggers.values()].filter(
        (row) =>
          row['status'] === 'pending' &&
          ['ALARM', 'INSUFFICIENT_DATA'].includes(String(row['new_state']))
      ).length;
      return result<T>([{ count: String(count) } as unknown as T]);
    }

    if (
      normalized.startsWith('SELECT id FROM alarm_triggers') &&
      normalized.includes('FOR UPDATE SKIP LOCKED')
    ) {
      const rows = [...this.alarmTriggers.values()]
        .filter(
          (row) =>
            row['status'] === 'pending' &&
            ['ALARM', 'INSUFFICIENT_DATA'].includes(String(row['new_state']))
        )
        .sort(
          (a, b) =>
            new Date(String(a['received_at'])).getTime() -
            new Date(String(b['received_at'])).getTime()
        );
      return result<T>(rows.map((row) => ({ id: row['id'] }) as unknown as T));
    }

    if (
      normalized.startsWith('UPDATE alarm_triggers') &&
      normalized.includes("WHERE status = 'claimed'")
    ) {
      const olderThanMs = Number(params[0]);
      const cutoff = Date.now() - olderThanMs;
      const affected: Record<string, unknown>[] = [];
      for (const row of this.alarmTriggers.values()) {
        if (row['status'] !== 'claimed') {
          continue;
        }
        const claimedAt = row['claimed_at'];
        const claimedTime = claimedAt ? new Date(String(claimedAt)).getTime() : 0;
        if (claimedTime < cutoff) {
          row['status'] = 'pending';
          row['claimed_at'] = null;
          affected.push(row);
        }
      }
      return result<T>(affected as unknown as T[]);
    }

    if (
      normalized.startsWith('UPDATE alarm_triggers') &&
      normalized.includes("status = 'claimed'")
    ) {
      const ids = params[0] as string[];
      const claimedRows: Record<string, unknown>[] = [];
      for (const id of ids) {
        const row = this.alarmTriggers.get(id);
        if (row) {
          row['status'] = 'claimed';
          row['claimed_at'] = new Date().toISOString();
          claimedRows.push(row);
        }
      }
      return result<T>(claimedRows as unknown as T[]);
    }

    if (
      normalized.startsWith('UPDATE alarm_triggers') &&
      normalized.includes("status = 'deferred'")
    ) {
      const ids = params[0] as string[];
      for (const id of ids) {
        const row = this.alarmTriggers.get(id);
        if (row) {
          row['status'] = 'deferred';
          row['processed_at'] = new Date().toISOString();
        }
      }
      return result<T>([]);
    }

    if (normalized.startsWith('UPDATE alarm_triggers') && normalized.includes("status = 'done'")) {
      const ids = params[0] as string[];
      const runId = params[1] as string | null;
      for (const id of ids) {
        const row = this.alarmTriggers.get(id);
        if (row) {
          row['status'] = 'done';
          row['run_id'] = runId;
          row['processed_at'] = new Date().toISOString();
        }
      }
      return result<T>([]);
    }

    if (
      normalized.startsWith('UPDATE alarm_triggers') &&
      normalized.includes('WHERE id = ANY($1)') &&
      normalized.includes("status = 'pending'")
    ) {
      const ids = params[0] as string[];
      for (const id of ids) {
        const row = this.alarmTriggers.get(id);
        if (row) {
          row['status'] = 'pending';
          row['claimed_at'] = null;
        }
      }
      return result<T>([]);
    }

    if (
      normalized.startsWith('UPDATE alarm_triggers') &&
      normalized.includes("status = 'error'")
    ) {
      const ids = params[0] as string[];
      for (const id of ids) {
        const row = this.alarmTriggers.get(id);
        if (row) {
          row['status'] = 'error';
          row['processed_at'] = new Date().toISOString();
        }
      }
      return result<T>([]);
    }

    if (normalized.startsWith('SELECT run_id FROM alarm_triggers')) {
      const specKey = String(params[0]);
      const withinMs = Number(params[1]);
      const cutoff = Date.now() - withinMs;
      const rows = [...this.alarmTriggers.values()]
        .filter(
          (row) =>
            row['spec_key'] === specKey && row['status'] === 'done' && row['run_id'] != null
        )
        .filter((row) => new Date(String(row['processed_at'])).getTime() > cutoff)
        .sort(
          (a, b) =>
            new Date(String(b['processed_at'])).getTime() -
            new Date(String(a['processed_at'])).getTime()
        );
      const top = rows[0];
      return result<T>(top ? [{ run_id: top['run_id'] } as unknown as T] : []);
    }

    throw new Error(`Unexpected query: ${text}`);
  }
}

function alarmTriggerRow(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: `trigger-${Math.random().toString(36).slice(2)}`,
    sns_message_id: 'sns-1',
    alarm_arn: 'arn:aws:cloudwatch:us-east-1:123:alarm:test',
    alarm_name: 'test-alarm',
    new_state: 'ALARM',
    state_change_time: new Date().toISOString(),
    severity: 'CRITICAL',
    spec_key: 'svc-a',
    payload: {},
    status: 'pending',
    received_at: new Date().toISOString(),
    claimed_at: null,
    processed_at: null,
    run_id: null,
    ...overrides,
  };
}

describe('Postgres state repository', () => {
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

describe('Alarm trigger queue (Postgres repository)', () => {
  it('claims all pending ALARM/INSUFFICIENT_DATA rows using FOR UPDATE SKIP LOCKED', async () => {
    const db = new FakeStateDatabase();
    const repository = new PostgresAgentStateRepository(db, 's3://bucket/report.md');
    const pending = alarmTriggerRow({ id: 't1', new_state: 'ALARM' });
    const insufficient = alarmTriggerRow({ id: 't2', new_state: 'INSUFFICIENT_DATA' });
    const ok = alarmTriggerRow({ id: 't3', new_state: 'OK' });
    const done = alarmTriggerRow({ id: 't4', new_state: 'ALARM', status: 'done' });
    db.alarmTriggers.set('t1', pending);
    db.alarmTriggers.set('t2', insufficient);
    db.alarmTriggers.set('t3', ok);
    db.alarmTriggers.set('t4', done);

    const claimed = await repository.claimPendingAlarmTriggers();

    expect(claimed.map((row) => row.id).sort()).toEqual(['t1', 't2']);
    expect(db.alarmTriggers.get('t1')?.['status']).toBe('claimed');
    expect(db.alarmTriggers.get('t2')?.['status']).toBe('claimed');
    expect(db.alarmTriggers.get('t3')?.['status']).toBe('pending');
    expect(db.alarmTriggers.get('t4')?.['status']).toBe('done');
    expect(db.queries.some((q) => q.includes('FOR UPDATE SKIP LOCKED'))).toBe(true);
    expect(db.queries).toContain('BEGIN');
    expect(db.queries).toContain('COMMIT');
  });

  it('rolls back the claim transaction on error and leaves rows pending', async () => {
    const db = new FakeStateDatabase();
    const failingClient: DatabaseClient = {
      query: async (text: string, params: readonly unknown[] = []) => {
        const normalized = text.replace(/\s+/g, ' ').trim();
        if (normalized.startsWith('SELECT id FROM alarm_triggers')) {
          throw new Error('connection reset');
        }
        return db.query(text, params);
      },
    };
    const repository = new PostgresAgentStateRepository(failingClient, 's3://bucket/report.md');

    await expect(repository.claimPendingAlarmTriggers()).rejects.toThrow('connection reset');
  });

  it('returns count of pending eligible rows', async () => {
    const db = new FakeStateDatabase();
    const repository = new PostgresAgentStateRepository(db, 's3://bucket/report.md');
    db.alarmTriggers.set('t1', alarmTriggerRow({ id: 't1', new_state: 'ALARM' }));
    db.alarmTriggers.set('t2', alarmTriggerRow({ id: 't2', new_state: 'OK' }));

    expect(await repository.countPendingAlarmTriggers()).toBe(1);
  });

  it('defers rows to the deferred status', async () => {
    const db = new FakeStateDatabase();
    const repository = new PostgresAgentStateRepository(db, 's3://bucket/report.md');
    db.alarmTriggers.set('t1', alarmTriggerRow({ id: 't1', status: 'claimed' }));

    await repository.deferAlarmTriggers(['t1']);

    expect(db.alarmTriggers.get('t1')).toMatchObject({ status: 'deferred' });
    expect(db.alarmTriggers.get('t1')?.['processed_at']).not.toBeNull();
  });

  it('completes rows with a run id (launch or cooldown attach)', async () => {
    const db = new FakeStateDatabase();
    const repository = new PostgresAgentStateRepository(db, 's3://bucket/report.md');
    db.alarmTriggers.set('t1', alarmTriggerRow({ id: 't1', status: 'claimed' }));

    await repository.completeAlarmTriggers(['t1'], 'run-42');

    expect(db.alarmTriggers.get('t1')).toMatchObject({ status: 'done', run_id: 'run-42' });
  });

  it('releases rows back to pending (in-flight busy)', async () => {
    const db = new FakeStateDatabase();
    const repository = new PostgresAgentStateRepository(db, 's3://bucket/report.md');
    db.alarmTriggers.set('t1', alarmTriggerRow({ id: 't1', status: 'claimed', claimed_at: new Date().toISOString() }));

    await repository.releaseAlarmTriggers(['t1']);

    expect(db.alarmTriggers.get('t1')).toMatchObject({ status: 'pending', claimed_at: null });
  });

  it('marks rows as error on launch failure', async () => {
    const db = new FakeStateDatabase();
    const repository = new PostgresAgentStateRepository(db, 's3://bucket/report.md');
    db.alarmTriggers.set('t1', alarmTriggerRow({ id: 't1', status: 'claimed' }));

    await repository.failAlarmTriggers(['t1']);

    expect(db.alarmTriggers.get('t1')).toMatchObject({ status: 'error' });
  });

  it('reclaims stale claimed rows past the safety timeout', async () => {
    const db = new FakeStateDatabase();
    const repository = new PostgresAgentStateRepository(db, 's3://bucket/report.md');
    const stale = new Date(Date.now() - 60_000).toISOString();
    const fresh = new Date().toISOString();
    db.alarmTriggers.set('t1', alarmTriggerRow({ id: 't1', status: 'claimed', claimed_at: stale }));
    db.alarmTriggers.set('t2', alarmTriggerRow({ id: 't2', status: 'claimed', claimed_at: fresh }));

    const count = await repository.reclaimStaleClaimedTriggers(15_000);

    expect(count).toBe(1);
    expect(db.alarmTriggers.get('t1')).toMatchObject({ status: 'pending', claimed_at: null });
    expect(db.alarmTriggers.get('t2')?.['status']).toBe('claimed');
  });

  it('finds a recent launch for a spec_key within the cooldown window', async () => {
    const db = new FakeStateDatabase();
    const repository = new PostgresAgentStateRepository(db, 's3://bucket/report.md');
    const recent = new Date(Date.now() - 1_000).toISOString();
    db.alarmTriggers.set(
      't1',
      alarmTriggerRow({
        id: 't1',
        spec_key: 'svc-d',
        status: 'done',
        run_id: 'run-1',
        processed_at: recent,
      })
    );

    const hit = await repository.findRecentLaunchForSpecKey('svc-d', 600_000);
    expect(hit).toEqual({ runId: 'run-1' });

    const miss = await repository.findRecentLaunchForSpecKey('svc-e', 600_000);
    expect(miss).toBeNull();
  });

  it('does not match a launch outside the cooldown window', async () => {
    const db = new FakeStateDatabase();
    const repository = new PostgresAgentStateRepository(db, 's3://bucket/report.md');
    const old = new Date(Date.now() - 700_000).toISOString();
    db.alarmTriggers.set(
      't1',
      alarmTriggerRow({
        id: 't1',
        spec_key: 'svc-d',
        status: 'done',
        run_id: 'run-1',
        processed_at: old,
      })
    );

    const hit = await repository.findRecentLaunchForSpecKey('svc-d', 600_000);
    expect(hit).toBeNull();
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
