import type { Config } from '../config.js';
import type { DatabaseClient, DatabasePool } from '../db/postgres.js';
import { createPostgresPool } from '../db/postgres.js';
import type {
  ClassificationResult,
  DecisionResult,
  DecisionDisposition,
  DecisionNextStage,
  InvestigationResult,
  Severity,
  Stage,
  VerificationResult,
} from '../types.js';
import {
  type AgentState,
  type ObservationState,
  type ObservationReconciliation,
  loadAgentState,
  saveAgentState,
} from './agentState.js';
import {
  type IncidentTransition,
  type PersistedIncidentSnapshot,
  transitionsFromDecision,
  transitionsFromVerification,
} from './transitions.js';

type RunStatus = 'running' | 'success' | 'skipped' | 'error';
export type TriggerSource = 'scheduled' | 'alarm';

export interface AlarmTriggerRow {
  id: string;
  sns_message_id: string;
  alarm_arn: string;
  alarm_name: string;
  new_state: 'ALARM' | 'OK' | 'INSUFFICIENT_DATA';
  state_change_time: Date | string;
  severity: string | null;
  spec_key: string | null;
  payload: unknown;
  status: 'pending' | 'claimed' | 'done' | 'deferred' | 'error';
  received_at: Date | string;
  claimed_at: Date | string | null;
  processed_at: Date | string | null;
  run_id: string | null;
}

export interface ProcessedSnsMessageRow {
  sns_message_id: string;
  received_at: Date | string;
}

export interface AlarmTriggerEnqueueInput {
  snsMessageId: string;
  alarmArn: string;
  alarmName: string;
  newState: 'ALARM' | 'OK' | 'INSUFFICIENT_DATA';
  stateChangeTime: string;
  severity?: string | null;
  specKey?: string | null;
  payload: unknown;
}

export interface AlarmTriggerEnqueueResult {
  duplicate: boolean;
  enqueued: boolean;
  id?: string;
}

export interface RunRecordUpdate {
  status: Exclude<RunStatus, 'running'>;
  finishedAt: string;
  reportHash?: string;
  summary?: string;
  overallSeverity?: Severity;
  errorMessage?: string;
}

export interface StageOutputUpdate {
  stage: 'Classify' | 'Investigate' | 'Decide' | 'Verify';
  data: ClassificationResult | InvestigationResult | DecisionResult | VerificationResult;
}

export interface IncidentEventInput {
  incidentId: string;
  title: string;
  stage: Stage;
  message: string;
  severity?: Severity;
  evidence: unknown;
  service?: string | null;
}

export interface AlertRecordInput {
  incidentId: string;
  runId: string | undefined;
  channel: string;
  dedupeKey: string;
  payload: unknown;
}

export interface AgentStateRepository {
  load(): Promise<AgentState>;
  save(state: AgentState): Promise<void>;
  startRun?(startedAt: string): Promise<string | undefined>;
  finishRun?(runId: string | undefined, update: RunRecordUpdate): Promise<void>;
  recordReconciliation?(
    runId: string | undefined,
    reconciliation: ObservationReconciliation
  ): Promise<void>;
  recordDecisions?(runId: string | undefined, decision: DecisionResult): Promise<void>;
  recordStageOutput?(runId: string | undefined, update: StageOutputUpdate): Promise<void>;
  recordIncidentEvents?(
    runId: string | undefined,
    events: IncidentEventInput[]
  ): Promise<void>;
  recordDecisionTransitions?(
    runId: string | undefined,
    decision: DecisionResult
  ): Promise<IncidentTransition[]>;
  recordVerificationTransitions?(
    runId: string | undefined,
    verification: VerificationResult
  ): Promise<IncidentTransition[]>;
  hasAlert?(dedupeKey: string): Promise<boolean>;
  recordAlertSent?(alert: AlertRecordInput): Promise<void>;
  close?(): Promise<void>;

  // Alarm trigger queue (T5) — optional; only implemented for the Postgres backend.
  reclaimStaleClaimedTriggers?(olderThanMs: number): Promise<number>;
  countPendingAlarmTriggers?(): Promise<number>;
  claimPendingAlarmTriggers?(): Promise<AlarmTriggerRow[]>;
  deferAlarmTriggers?(ids: string[]): Promise<void>;
  completeAlarmTriggers?(ids: string[], runId: string | null): Promise<void>;
  releaseAlarmTriggers?(ids: string[]): Promise<void>;
  failAlarmTriggers?(ids: string[]): Promise<void>;
  findRecentLaunchForSpecKey?(
    specKey: string,
    withinMs: number
  ): Promise<{ runId: string } | null>;
}

export class FileAgentStateRepository implements AgentStateRepository {
  private readonly sentAlertKeys = new Set<string>();

  constructor(private readonly path: string) {}

  async load(): Promise<AgentState> {
    return loadAgentState(this.path);
  }

  async save(state: AgentState): Promise<void> {
    await saveAgentState(this.path, state);
  }

  async startRun(_startedAt: string): Promise<undefined> {
    return undefined;
  }

  async finishRun(_runId: string | undefined, _update: RunRecordUpdate): Promise<void> {
    return;
  }

  async recordReconciliation(
    _runId: string | undefined,
    _reconciliation: ObservationReconciliation
  ): Promise<void> {
    return;
  }

  async recordDecisions(_runId: string | undefined, _decision: DecisionResult): Promise<void> {
    return;
  }

  async recordStageOutput(
    _runId: string | undefined,
    _update: StageOutputUpdate
  ): Promise<void> {
    return;
  }

  async recordIncidentEvents(
    _runId: string | undefined,
    _events: IncidentEventInput[]
  ): Promise<void> {
    return;
  }

  async recordDecisionTransitions(
    _runId: string | undefined,
    _decision: DecisionResult
  ): Promise<IncidentTransition[]> {
    return [];
  }

  async recordVerificationTransitions(
    _runId: string | undefined,
    _verification: VerificationResult
  ): Promise<IncidentTransition[]> {
    return [];
  }

  async hasAlert(dedupeKey: string): Promise<boolean> {
    return this.sentAlertKeys.has(dedupeKey);
  }

  async recordAlertSent(alert: AlertRecordInput): Promise<void> {
    this.sentAlertKeys.add(alert.dedupeKey);
  }

  async reclaimStaleClaimedTriggers(_olderThanMs: number): Promise<number> {
    return 0;
  }

  async countPendingAlarmTriggers(): Promise<number> {
    return 0;
  }

  async claimPendingAlarmTriggers(): Promise<AlarmTriggerRow[]> {
    return [];
  }

  async deferAlarmTriggers(_ids: string[]): Promise<void> {
    return;
  }

  async completeAlarmTriggers(_ids: string[], _runId: string | null): Promise<void> {
    return;
  }

  async releaseAlarmTriggers(_ids: string[]): Promise<void> {
    return;
  }

  async failAlarmTriggers(_ids: string[]): Promise<void> {
    return;
  }

  async findRecentLaunchForSpecKey(
    _specKey: string,
    _withinMs: number
  ): Promise<{ runId: string } | null> {
    return null;
  }
}

interface ReportStateRow {
  health_report_s3_uri: string;
  report_hash: string;
  processed_at: Date | string;
}

interface ObservationStateRow {
  observation_key: string;
  observation_type: ObservationState['type'];
  title: string;
  classification: string;
  affected_services: string[];
  severity: ObservationState['severity'];
  confidence: number;
  signature: string;
  status: ObservationState['status'];
  first_seen: Date | string;
  last_seen: Date | string;
  last_changed_at: Date | string;
  occurrences: number;
  resolved_at: Date | string | null;
}

interface RunRow {
  id: string;
  trigger_source?: TriggerSource;
}

interface IncidentSnapshotRow {
  incident_id: string;
  severity: Severity | null;
  state: string | null;
  current_disposition: DecisionDisposition | null;
  current_next_stage: DecisionNextStage | null;
  closed_at: Date | string | null;
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

function primaryService(observation: ObservationState): string | null {
  return observation.affectedServices[0] ?? null;
}

function incidentStateFor(kind: 'new' | 'changed' | 'recurring' | 'resolved'): string {
  if (kind === 'resolved') {
    return 'resolved';
  }
  if (kind === 'changed') {
    return 'changed';
  }
  return 'open';
}

function observedAt(observation: ObservationState): string {
  return observation.resolvedAt ?? observation.lastChangedAt;
}

const REDACTED = '[REDACTED]';
const SENSITIVE_KEY_RE = /(?:api[_-]?key|authorization|token|secret|password|credential|connectionstring|database_url|pooled_database_url|webhook)/i;

function sanitizeForStorage(value: unknown, depth = 0): unknown {
  if (depth > 8) {
    return '[Max depth exceeded]';
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeForStorage(item, depth + 1));
  }
  if (value && typeof value === 'object') {
    const sanitized: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      sanitized[key] = SENSITIVE_KEY_RE.test(key) ? REDACTED : sanitizeForStorage(item, depth + 1);
    }
    return sanitized;
  }
  if (typeof value === 'string') {
    return value.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, `Bearer ${REDACTED}`);
  }
  return value;
}

function stageOutputColumn(stage: StageOutputUpdate['stage']): string {
  switch (stage) {
    case 'Classify':
      return 'raw_classification_json';
    case 'Investigate':
      return 'raw_investigation_json';
    case 'Decide':
      return 'raw_decision_json';
    case 'Verify':
      return 'raw_verification_json';
  }
}

function snapshotFromRow(row: IncidentSnapshotRow): PersistedIncidentSnapshot {
  return {
    incidentId: row.incident_id,
    severity: row.severity,
    state: row.state,
    currentDisposition: row.current_disposition,
    currentNextStage: row.current_next_stage,
    closedAt: row.closed_at ? toIso(row.closed_at) : null,
  };
}

function transitionEvents(
  stage: 'Decide' | 'Verify',
  transitions: IncidentTransition[]
): IncidentEventInput[] {
  return transitions.map((item) => ({
    incidentId: item.incidentId,
    title: item.title,
    stage,
    message: item.message,
    severity: item.severity,
    service: item.service,
    evidence: item.evidence,
  }));
}

export async function markSnsMessageProcessed(
  client: DatabaseClient,
  snsMessageId: string
): Promise<boolean> {
  const result = await client.query<{ sns_message_id: string }>(
    `INSERT INTO processed_sns_messages (sns_message_id)
     VALUES ($1)
     ON CONFLICT (sns_message_id) DO NOTHING
     RETURNING sns_message_id`,
    [snsMessageId]
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * A pooled connection pinned for the lifetime of a transaction. `pg.Pool`
 * exposes `connect()`; test fakes and already-pinned clients do not.
 */
interface PinnedClient extends DatabaseClient {
  release(): void;
}

interface ConnectablePool extends DatabaseClient {
  connect(): Promise<PinnedClient>;
}

function canConnect(client: DatabaseClient): client is ConnectablePool {
  return typeof (client as Partial<ConnectablePool>).connect === 'function';
}

export async function enqueueAlarmTriggerOnce(
  client: DatabaseClient,
  input: AlarmTriggerEnqueueInput
): Promise<AlarmTriggerEnqueueResult> {
  // A multi-statement transaction must run on a single connection. When given a
  // pool, check out one dedicated connection for the whole BEGIN..COMMIT so the
  // statements are actually atomic and the connection is not returned to the
  // pool mid-transaction. Fakes/single connections fall back to direct use.
  const pinned = canConnect(client) ? await client.connect() : null;
  const tx: DatabaseClient = pinned ?? client;
  try {
    await tx.query('BEGIN');
    try {
      const inserted = await tx.query<{ sns_message_id: string }>(
        `INSERT INTO processed_sns_messages (sns_message_id)
         VALUES ($1)
         ON CONFLICT (sns_message_id) DO NOTHING
         RETURNING sns_message_id`,
        [input.snsMessageId]
      );

      if ((inserted.rowCount ?? 0) === 0) {
        await tx.query('COMMIT');
        return { duplicate: true, enqueued: false };
      }

      if (input.newState !== 'ALARM') {
        await tx.query('COMMIT');
        return { duplicate: false, enqueued: false };
      }

      const result = await tx.query<{ id: string }>(
        `INSERT INTO alarm_triggers (
           sns_message_id, alarm_arn, alarm_name, new_state, state_change_time,
           severity, spec_key, payload, status
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, 'pending')
         RETURNING id`,
        [
          input.snsMessageId,
          input.alarmArn,
          input.alarmName,
          input.newState,
          input.stateChangeTime,
          input.severity ?? null,
          input.specKey ?? null,
          JSON.stringify(sanitizeForStorage(input.payload)),
        ]
      );
      const id = result.rows[0]?.id;
      if (!id) {
        throw new Error('Postgres did not return an alarm trigger id');
      }

      await tx.query('COMMIT');
      return { duplicate: false, enqueued: true, id };
    } catch (error) {
      await tx.query('ROLLBACK');
      throw error;
    }
  } finally {
    pinned?.release();
  }
}

export class PostgresAgentStateRepository implements AgentStateRepository {
  constructor(
    private readonly client: DatabaseClient,
    private readonly healthReportS3Uri: string,
    private readonly ownedPool?: DatabasePool
  ) {}

  async load(): Promise<AgentState> {
    const [reportResult, observationResult] = await Promise.all([
      this.client.query<ReportStateRow>(
        `SELECT health_report_s3_uri, report_hash, processed_at
         FROM report_states
         WHERE health_report_s3_uri = $1`,
        [this.healthReportS3Uri]
      ),
      this.client.query<ObservationStateRow>(
        `SELECT observation_key, observation_type, title, classification, affected_services,
                severity, confidence, signature, status, first_seen, last_seen,
                last_changed_at, occurrences, resolved_at
         FROM observation_states
         WHERE health_report_s3_uri = $1
         ORDER BY first_seen, observation_key`,
        [this.healthReportS3Uri]
      ),
    ]);

    const state: AgentState = { version: 1, observations: {} };
    const report = reportResult.rows[0];
    if (report) {
      state.lastReport = {
        s3Uri: report.health_report_s3_uri,
        fingerprint: report.report_hash,
        processedAt: toIso(report.processed_at),
      };
    }

    for (const row of observationResult.rows) {
      const observation: ObservationState = {
        key: row.observation_key,
        type: row.observation_type,
        title: row.title,
        classification: row.classification,
        affectedServices: row.affected_services,
        severity: row.severity,
        confidence: row.confidence,
        signature: row.signature,
        status: row.status,
        firstSeen: toIso(row.first_seen),
        lastSeen: toIso(row.last_seen),
        lastChangedAt: toIso(row.last_changed_at),
        occurrences: row.occurrences,
        ...(row.resolved_at ? { resolvedAt: toIso(row.resolved_at) } : {}),
      };
      state.observations[observation.key] = observation;
    }

    return state;
  }

  async save(state: AgentState): Promise<void> {
    await this.client.query('BEGIN');
    try {
      if (state.lastReport) {
        await this.client.query(
          `INSERT INTO report_states (health_report_s3_uri, report_hash, processed_at)
           VALUES ($1, $2, $3)
           ON CONFLICT (health_report_s3_uri)
           DO UPDATE SET report_hash = EXCLUDED.report_hash,
                         processed_at = EXCLUDED.processed_at`,
          [state.lastReport.s3Uri, state.lastReport.fingerprint, state.lastReport.processedAt]
        );
      }

      await this.client.query('DELETE FROM observation_states WHERE health_report_s3_uri = $1', [
        this.healthReportS3Uri,
      ]);

      for (const observation of Object.values(state.observations)) {
        await this.client.query(
          `INSERT INTO observation_states (
             health_report_s3_uri, observation_key, observation_type, title, classification,
             affected_services, severity, confidence, signature, status, first_seen, last_seen,
             last_changed_at, occurrences, resolved_at
           )
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
          [
            this.healthReportS3Uri,
            observation.key,
            observation.type,
            observation.title,
            observation.classification,
            observation.affectedServices,
            observation.severity,
            observation.confidence,
            observation.signature,
            observation.status,
            observation.firstSeen,
            observation.lastSeen,
            observation.lastChangedAt,
            observation.occurrences,
            observation.resolvedAt ?? null,
          ]
        );
      }

      await this.client.query('COMMIT');
    } catch (error) {
      await this.client.query('ROLLBACK');
      throw error;
    }
  }

  async startRun(startedAt: string): Promise<string> {
    await this.client.query(
      `INSERT INTO worker_heartbeats (worker_id, process_name, last_seen_at, metadata_json)
       VALUES ($1, $2, $3, $4::jsonb)
       ON CONFLICT (worker_id)
       DO UPDATE SET process_name = EXCLUDED.process_name,
                     last_seen_at = EXCLUDED.last_seen_at,
                     metadata_json = EXCLUDED.metadata_json`,
      [
        'default',
        'mttr-worker',
        startedAt,
        JSON.stringify({ health_report_s3_uri: this.healthReportS3Uri }),
      ]
    );

    const result = await this.client.query<RunRow>(
      `INSERT INTO runs (started_at, status, health_report_s3_uri)
       VALUES ($1, $2, $3)
       RETURNING id`,
      [startedAt, 'running', this.healthReportS3Uri]
    );
    const id = result.rows[0]?.id;
    if (!id) {
      throw new Error('Postgres did not return a run id');
    }
    return id;
  }

  async finishRun(runId: string | undefined, update: RunRecordUpdate): Promise<void> {
    if (!runId) {
      return;
    }

    await this.client.query(
      `UPDATE runs
       SET finished_at = $2,
           status = $3,
           report_hash = $4,
           summary = $5,
           overall_severity = $6,
           error_message = $7
       WHERE id = $1`,
      [
        runId,
        update.finishedAt,
        update.status,
        update.reportHash ?? null,
        update.summary ?? null,
        update.overallSeverity ?? null,
        update.errorMessage ?? null,
      ]
    );
  }

  async recordReconciliation(
    runId: string | undefined,
    reconciliation: ObservationReconciliation
  ): Promise<void> {
    if (!runId) {
      return;
    }

    const observations: Array<{
      kind: 'new' | 'changed' | 'recurring' | 'resolved';
      observation: ObservationState;
    }> = [
      ...reconciliation.newObservations.map((observation) => ({
        kind: 'new' as const,
        observation,
      })),
      ...reconciliation.changedObservations.map((observation) => ({
        kind: 'changed' as const,
        observation,
      })),
      ...reconciliation.recurringObservations.map((observation) => ({
        kind: 'recurring' as const,
        observation,
      })),
      ...reconciliation.resolvedObservations.map((observation) => ({
        kind: 'resolved' as const,
        observation,
      })),
    ];

    for (const { kind, observation } of observations) {
      const state = incidentStateFor(kind);
      const closedAt = kind === 'resolved' ? observedAt(observation) : null;
      await this.client.query(
        `INSERT INTO incidents (
           incident_id, title, service, severity, state, opened_at, closed_at, last_run_id
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (incident_id)
         DO UPDATE SET title = EXCLUDED.title,
                       service = EXCLUDED.service,
                       severity = EXCLUDED.severity,
                       state = EXCLUDED.state,
                       closed_at = EXCLUDED.closed_at,
                       last_run_id = EXCLUDED.last_run_id`,
        [
          observation.key,
          observation.title,
          primaryService(observation),
          observation.severity,
          state,
          observation.firstSeen,
          closedAt,
          runId,
        ]
      );
    }
  }

  async recordDecisions(runId: string | undefined, decision: DecisionResult): Promise<void> {
    if (!runId) {
      return;
    }

    const now = new Date().toISOString();
    for (const item of decision.decisions) {
      await this.client.query(
        `INSERT INTO incidents (
           incident_id, title, service, severity, state, opened_at, current_disposition,
           current_next_stage, current_decision_json, last_run_id
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10)
         ON CONFLICT (incident_id)
         DO UPDATE SET title = EXCLUDED.title,
                       service = EXCLUDED.service,
                       severity = EXCLUDED.severity,
                       current_disposition = EXCLUDED.current_disposition,
                       current_next_stage = EXCLUDED.current_next_stage,
                       current_decision_json = EXCLUDED.current_decision_json,
                       last_run_id = EXCLUDED.last_run_id`,
        [
          item.incident_id,
          item.title,
          item.affected_services[0] ?? null,
          item.severity,
          'decision',
          now,
          item.disposition,
          item.next_stage,
          JSON.stringify(item),
          runId,
        ]
      );
    }
  }

  async recordStageOutput(runId: string | undefined, update: StageOutputUpdate): Promise<void> {
    if (!runId) {
      return;
    }

    const column = stageOutputColumn(update.stage);
    await this.client.query(
      `UPDATE runs
       SET ${column} = $2::jsonb
       WHERE id = $1`,
      [runId, JSON.stringify(sanitizeForStorage(update.data))]
    );
  }

  async recordIncidentEvents(
    runId: string | undefined,
    events: IncidentEventInput[]
  ): Promise<void> {
    if (!runId || events.length === 0) {
      return;
    }

    for (const event of events) {
      await this.client.query(
        `INSERT INTO incidents (incident_id, title, service, severity, state, opened_at, last_run_id)
         VALUES ($1, $2, $3, $4, $5, now(), $6)
         ON CONFLICT (incident_id)
         DO UPDATE SET title = EXCLUDED.title,
                       service = COALESCE(EXCLUDED.service, incidents.service),
                       severity = EXCLUDED.severity,
                       last_run_id = EXCLUDED.last_run_id`,
        [
          event.incidentId,
          event.title,
          event.service ?? null,
          event.severity ?? 'NONE',
          'open',
          runId,
        ]
      );

      await this.client.query(
        `INSERT INTO incident_events (
           incident_id, run_id, stage, message, severity, evidence_json
         )
         VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
        [
          event.incidentId,
          runId,
          event.stage,
          event.message,
          event.severity ?? null,
          JSON.stringify(sanitizeForStorage(event.evidence)),
        ]
      );
    }
  }

  async recordDecisionTransitions(
    runId: string | undefined,
    decision: DecisionResult
  ): Promise<IncidentTransition[]> {
    if (!runId || decision.decisions.length === 0) {
      return [];
    }

    const previous = await this.loadIncidentSnapshots(
      decision.decisions.map((item) => item.incident_id)
    );
    const transitions = transitionsFromDecision(previous, decision);
    await this.recordIncidentEvents(runId, transitionEvents('Decide', transitions));
    return transitions;
  }

  async recordVerificationTransitions(
    runId: string | undefined,
    verification: VerificationResult
  ): Promise<IncidentTransition[]> {
    if (!runId || verification.verifications.length === 0) {
      return [];
    }

    const previous = await this.loadIncidentSnapshots(
      verification.verifications.map((item) => item.incident_id)
    );
    const transitions = transitionsFromVerification(previous, verification);
    await this.recordIncidentEvents(runId, transitionEvents('Verify', transitions));
    return transitions;
  }

  async hasAlert(dedupeKey: string): Promise<boolean> {
    const result = await this.client.query<{ dedupe_key: string }>(
      `SELECT dedupe_key
       FROM alerts
       WHERE dedupe_key = $1
       LIMIT 1`,
      [dedupeKey]
    );
    return result.rows.length > 0;
  }

  async recordAlertSent(alert: AlertRecordInput): Promise<void> {
    await this.client.query(
      `INSERT INTO alerts (incident_id, run_id, channel, dedupe_key, payload_json)
       VALUES ($1, $2, $3, $4, $5::jsonb)
       ON CONFLICT (dedupe_key) DO NOTHING`,
      [
        alert.incidentId,
        alert.runId ?? null,
        alert.channel,
        alert.dedupeKey,
        JSON.stringify(sanitizeForStorage(alert.payload)),
      ]
    );
  }

  async reclaimStaleClaimedTriggers(olderThanMs: number): Promise<number> {
    const result = await this.client.query(
      `UPDATE alarm_triggers
       SET status = 'pending', claimed_at = null
       WHERE status = 'claimed'
         AND claimed_at < now() - make_interval(secs => $1::double precision / 1000)`,
      [olderThanMs]
    );
    return result.rowCount ?? 0;
  }

  async countPendingAlarmTriggers(): Promise<number> {
    const result = await this.client.query<{ count: string }>(
      `SELECT count(*)::text AS count
       FROM alarm_triggers
       WHERE status = 'pending' AND new_state IN ('ALARM', 'INSUFFICIENT_DATA')`
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  async claimPendingAlarmTriggers(): Promise<AlarmTriggerRow[]> {
    await this.client.query('BEGIN');
    try {
      const pending = await this.client.query<{ id: string }>(
        `SELECT id
         FROM alarm_triggers
         WHERE status = 'pending' AND new_state IN ('ALARM', 'INSUFFICIENT_DATA')
         ORDER BY received_at
         FOR UPDATE SKIP LOCKED`
      );

      const ids = pending.rows.map((row) => row.id);
      if (ids.length === 0) {
        await this.client.query('COMMIT');
        return [];
      }

      const claimed = await this.client.query<AlarmTriggerRow>(
        `UPDATE alarm_triggers
         SET status = 'claimed', claimed_at = now()
         WHERE id = ANY($1)
         RETURNING *`,
        [ids]
      );

      await this.client.query('COMMIT');
      return claimed.rows;
    } catch (error) {
      await this.client.query('ROLLBACK');
      throw error;
    }
  }

  async deferAlarmTriggers(ids: string[]): Promise<void> {
    if (ids.length === 0) {
      return;
    }
    await this.client.query(
      `UPDATE alarm_triggers
       SET status = 'deferred', processed_at = now()
       WHERE id = ANY($1)`,
      [ids]
    );
  }

  async completeAlarmTriggers(ids: string[], runId: string | null): Promise<void> {
    if (ids.length === 0) {
      return;
    }
    await this.client.query(
      `UPDATE alarm_triggers
       SET status = 'done', run_id = $2, processed_at = now()
       WHERE id = ANY($1)`,
      [ids, runId]
    );
  }

  async releaseAlarmTriggers(ids: string[]): Promise<void> {
    if (ids.length === 0) {
      return;
    }
    await this.client.query(
      `UPDATE alarm_triggers
       SET status = 'pending', claimed_at = null
       WHERE id = ANY($1)`,
      [ids]
    );
  }

  async failAlarmTriggers(ids: string[]): Promise<void> {
    if (ids.length === 0) {
      return;
    }
    await this.client.query(
      `UPDATE alarm_triggers
       SET status = 'error', processed_at = now()
       WHERE id = ANY($1)`,
      [ids]
    );
  }

  async findRecentLaunchForSpecKey(
    specKey: string,
    withinMs: number
  ): Promise<{ runId: string } | null> {
    const result = await this.client.query<{ run_id: string }>(
      `SELECT run_id
       FROM alarm_triggers
       WHERE spec_key = $1
         AND status = 'done'
         AND run_id IS NOT NULL
         AND processed_at > now() - make_interval(secs => $2::double precision / 1000)
       ORDER BY processed_at DESC
       LIMIT 1`,
      [specKey, withinMs]
    );
    const row = result.rows[0];
    return row ? { runId: row.run_id } : null;
  }

  private async loadIncidentSnapshots(
    incidentIds: string[]
  ): Promise<Map<string, PersistedIncidentSnapshot>> {
    const uniqueIds = [...new Set(incidentIds)];
    if (uniqueIds.length === 0) {
      return new Map();
    }

    const result = await this.client.query<IncidentSnapshotRow>(
      `SELECT incident_id, severity, state, current_disposition, current_next_stage, closed_at
       FROM incidents
       WHERE incident_id = ANY($1)`,
      [uniqueIds]
    );

    return new Map(result.rows.map((row) => [row.incident_id, snapshotFromRow(row)]));
  }

  async close(): Promise<void> {
    await this.ownedPool?.end();
  }
}

export function createAgentStateRepository(config: Config): AgentStateRepository {
  if (config.state.backend === 'postgres') {
    const pool = createPostgresPool(config);
    return new PostgresAgentStateRepository(pool, config.healthReport.s3Uri, pool);
  }

  return new FileAgentStateRepository(config.state.path);
}
