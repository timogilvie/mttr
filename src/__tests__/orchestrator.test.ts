import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { rmSync } from 'node:fs';
import { Orchestrator } from '../orchestrator.js';
import type { Config } from '../config.js';
import type { StageResult, ClassificationResult, VerificationResult } from '../types.js';
import { canonicalObservationKey } from '../state/agentState.js';
import type { AgentState } from '../state/agentState.js';
import { buildActiveAlarmSpec, buildMandatoryIncident } from '../report/mandatoryIncidents.js';
import type {
  AgentStateRepository,
  AlarmTriggerRow,
  IncidentEventInput,
  RunRecordUpdate,
  StageOutputUpdate,
} from '../state/repository.js';

vi.mock('../stages/classify.js');
vi.mock('../stages/investigate.js');
vi.mock('../stages/verify.js');
vi.mock('../report/fetchReport.js');

let stateFileCounter = 0;

const mockConfig: Config = {
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
  healthReport: {
    s3Uri: 's3://test/report.md',
  },
  aws: {
    region: 'us-east-1',
    maxAttempts: 5,
  },
  monitoring: {
    intervalMs: 1000,
  },
  state: {
    backend: 'file',
    path: '.test-mttr-state.json',
  },
  database: {
    ssl: false,
    maxConnections: 4,
    idleTimeoutMs: 30000,
  },
  alerts: {
    slack: {
      channel: 'slack',
      timeoutMs: 10000,
    },
  },
  timeouts: {
    llmMs: 5000,
    s3Ms: 5000,
  },
  alarm: {
    webhook: {
      enabled: false,
      verifySignature: true,
      autoconfirm: true,
    },
    trigger: {
      minSeverity: 'CRITICAL',
      cooldownMs: 600000,
      pollMs: 5000,
      coalesceMs: 2000,
    },
  },
};

function alarmPayload(alarmName = 'api-task-health', service = 'api') {
  return {
    AlarmName: alarmName,
    AlarmArn: `arn:aws:cloudwatch:us-east-1:123456789012:alarm:${alarmName}`,
    NewStateValue: 'ALARM',
    NewStateReason: 'Threshold crossed',
    StateChangeTime: '2026-06-08T10:00:00.000Z',
    Trigger: {
      MetricName: 'UnHealthyHostCount',
      Namespace: 'AWS/ApplicationELB',
      Dimensions: [{ name: 'ServiceName', value: service }],
    },
  };
}

function alarmTrigger(
  overrides: Partial<AlarmTriggerRow> = {},
  payload = alarmPayload()
): AlarmTriggerRow {
  return {
    id: 'trigger-1',
    sns_message_id: 'sns-1',
    alarm_arn: 'arn:aws:cloudwatch:us-east-1:123456789012:alarm:api-task-health',
    alarm_name: 'api-task-health',
    new_state: 'ALARM',
    state_change_time: '2026-06-08T10:00:00.000Z',
    severity: 'CRITICAL',
    spec_key: 'api|UNKNOWN|api-task-health|',
    payload,
    status: 'claimed',
    received_at: '2026-06-08T10:00:01.000Z',
    claimed_at: '2026-06-08T10:00:02.000Z',
    processed_at: null,
    run_id: null,
    ...overrides,
  };
}

function expectedAlarmIncident() {
  return buildMandatoryIncident(
    buildActiveAlarmSpec({ service: 'api', alarmName: 'api-task-health' }),
    0
  );
}

class FakeOrchestratorRepository implements AgentStateRepository {
  state: AgentState = { version: 1, observations: {} };
  runs: Array<{ id: string; startedAt: string; triggerSource: string | undefined }> = [];
  finishes: Array<{ runId: string | undefined; update: RunRecordUpdate }> = [];
  stageOutputs: StageOutputUpdate[] = [];
  eventStages: string[] = [];
  private runCounter = 0;

  async load(): Promise<AgentState> {
    return this.state;
  }

  async save(state: AgentState): Promise<void> {
    this.state = state;
  }

  async startRun(startedAt: string, triggerSource?: 'scheduled' | 'alarm'): Promise<string> {
    this.runCounter += 1;
    const id = `run-${this.runCounter}`;
    this.runs.push({ id, startedAt, triggerSource });
    return id;
  }

  async finishRun(runId: string | undefined, update: RunRecordUpdate): Promise<void> {
    this.finishes.push({ runId, update });
  }

  async recordReconciliation(): Promise<void> {
    return;
  }

  async recordStageOutput(_runId: string | undefined, update: StageOutputUpdate): Promise<void> {
    this.stageOutputs.push(update);
  }

  async recordIncidentEvents(
    _runId: string | undefined,
    events: IncidentEventInput[]
  ): Promise<void> {
    this.eventStages.push(...events.map((event) => event.stage));
  }

  async recordDecisionTransitions(): Promise<[]> {
    return [];
  }

  async recordVerificationTransitions(): Promise<[]> {
    return [];
  }

  async recordDecisions(): Promise<void> {
    return;
  }
}

describe('Orchestrator', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stateFileCounter += 1;
    mockConfig.state.path = `/private/tmp/mttr-orchestrator-${process.pid}-${stateFileCounter}.json`;
    rmSync(mockConfig.state.path, { force: true });
    vi.useFakeTimers();
  });

  afterEach(() => {
    rmSync(mockConfig.state.path, { force: true });
    vi.useRealTimers();
  });

  async function mockReport(text = '# report'): Promise<void> {
    const { fetchReport } = await import('../report/fetchReport.js');
    vi.mocked(fetchReport).mockResolvedValue(text);
  }

  it('ticks continue while long Classify task is in flight', async () => {
    const classifyStage = await import('../stages/classify.js');
    await mockReport();

    const mockResult: StageResult = {
      stage: 'Classify',
      status: 'success',
      timestamp: new Date().toISOString(),
    };

    vi.mocked(classifyStage.runWithReport).mockResolvedValue(mockResult);

    const orchestrator = new Orchestrator(mockConfig);
    orchestrator.start();

    await vi.waitFor(() => expect(classifyStage.runWithReport).toHaveBeenCalledTimes(1));

    await vi.advanceTimersByTimeAsync(500);
    expect(classifyStage.runWithReport).toHaveBeenCalledTimes(1);

    orchestrator.stop();
  });

  it('overlapping Classify runs are skipped', async () => {
    const classifyStage = await import('../stages/classify.js');
    await mockReport();

    let resolveFirst: (() => void) | null = null;
    const firstPromise = new Promise<StageResult>((resolve) => {
      resolveFirst = () =>
        resolve({
          stage: 'Classify',
          status: 'success',
          timestamp: new Date().toISOString(),
        });
    });

    const mockResult: StageResult = {
      stage: 'Classify',
      status: 'success',
      timestamp: new Date().toISOString(),
    };

    vi.mocked(classifyStage.runWithReport)
      .mockReturnValueOnce(firstPromise)
      .mockResolvedValue(mockResult);

    const orchestrator = new Orchestrator(mockConfig);
    orchestrator.start();

    await vi.waitFor(() => expect(classifyStage.runWithReport).toHaveBeenCalledTimes(1));

    await vi.advanceTimersByTimeAsync(1000);
    expect(classifyStage.runWithReport).toHaveBeenCalledTimes(1);

    resolveFirst!();
    await vi.waitFor(() => Promise.resolve());

    await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(() => expect(classifyStage.runWithReport).toHaveBeenCalledTimes(2));

    orchestrator.stop();
  });

  it('stage rejection is logged and later ticks continue', async () => {
    const classifyStage = await import('../stages/classify.js');
    await mockReport();

    const mockResult: StageResult = {
      stage: 'Classify',
      status: 'success',
      timestamp: new Date().toISOString(),
    };

    vi.mocked(classifyStage.runWithReport)
      .mockRejectedValueOnce(new Error('Test error'))
      .mockResolvedValue(mockResult);

    const orchestrator = new Orchestrator(mockConfig);
    orchestrator.start();

    await vi.waitFor(() => expect(classifyStage.runWithReport).toHaveBeenCalledTimes(1));

    await vi.waitFor(() => Promise.resolve());

    await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(() => expect(classifyStage.runWithReport).toHaveBeenCalledTimes(2));

    orchestrator.stop();
  });

  it('stop() prevents further ticks', async () => {
    const classifyStage = await import('../stages/classify.js');
    await mockReport();

    const mockResult: StageResult = {
      stage: 'Classify',
      status: 'success',
      timestamp: new Date().toISOString(),
    };

    vi.mocked(classifyStage.runWithReport).mockResolvedValue(mockResult);

    const orchestrator = new Orchestrator(mockConfig);
    orchestrator.start();

    await vi.waitFor(() => expect(classifyStage.runWithReport).toHaveBeenCalledTimes(1));

    orchestrator.stop();

    await vi.advanceTimersByTimeAsync(5000);

    expect(classifyStage.runWithReport).toHaveBeenCalledTimes(1);
  });

  const actionableClassification: ClassificationResult = {
    summary: 'A finding to investigate.',
    overall_severity: 'MEDIUM',
    incidents: [],
    findings: [
      {
        title: 'High 4xx',
        classification: 'AUTH_FAILURE',
        severity: 'MEDIUM',
        confidence: 0.7,
        affected_services: ['api'],
        evidence: ['e'],
        reason_not_incident: 'r',
      },
    ],
  };

  const actionableClassifyResult: StageResult = {
    stage: 'Classify',
    status: 'success',
    timestamp: 't',
    data: actionableClassification,
  };

  const investigateResult: StageResult = {
    stage: 'Investigate',
    status: 'success',
    timestamp: 't',
    data: {
      summary: 'done',
      overall_assessment: 'POSSIBLE_INCIDENT',
      overall_severity: 'MEDIUM',
      investigations: [],
      cross_cutting_observations: [],
      priority_order: [],
    },
  };

  it('chains Investigate after an actionable Classify result', async () => {
    const classifyStage = await import('../stages/classify.js');
    const investigateStage = await import('../stages/investigate.js');
    await mockReport();

    vi.mocked(classifyStage.runWithReport).mockResolvedValue(actionableClassifyResult);
    vi.mocked(investigateStage.run).mockResolvedValue(investigateResult);

    const config = { ...mockConfig, monitoring: { intervalMs: 1_000_000 } };
    const orchestrator = new Orchestrator(config);
    orchestrator.start();

    await vi.waitFor(() => expect(investigateStage.run).toHaveBeenCalledTimes(1));

    expect(investigateStage.run).toHaveBeenCalledTimes(1);
    const call = vi.mocked(investigateStage.run).mock.calls[0]!;
    expect(call[0]).toEqual(expect.objectContaining({ stage: 'Investigate' }));
    expect(call[1]).toEqual(config);
    expect((call[2] as ClassificationResult).findings).toHaveLength(1);

    orchestrator.stop();
  });

  it('passes canonical incident ids to downstream stages', async () => {
    const classifyStage = await import('../stages/classify.js');
    const investigateStage = await import('../stages/investigate.js');
    await mockReport();

    const incident = {
      incident_id: 'INC-001',
      title: 'High 5xx',
      classification: 'APPLICATION_ERROR' as const,
      severity: 'HIGH' as const,
      confidence: 0.95,
      affected_services: ['api'],
      evidence: ['ALB 5xx spike'],
      signals: {
        alarms: ['api-5xx'],
        metrics: ['HTTPCode_Target_5XX_Count'],
        logs: [],
      },
      suspected_causes: ['Application errors'],
      investigation_plan: {
        priority: 1,
        estimated_user_impact: 'PARTIAL' as const,
        first_actions: ['Check logs'],
        questions_to_answer: ['Which endpoint failed?'],
        suggested_cloudwatch_queries: ['5xx query'],
      },
      recommended_next_stage: 'INVESTIGATE',
    };
    const expectedId = canonicalObservationKey('incident', incident);

    vi.mocked(classifyStage.runWithReport).mockResolvedValue({
      stage: 'Classify',
      status: 'success',
      timestamp: 't',
      data: {
        summary: 'Incident to investigate.',
        overall_severity: 'HIGH',
        incidents: [incident],
        findings: [],
      },
    });
    vi.mocked(investigateStage.run).mockResolvedValue(investigateResult);

    const config = { ...mockConfig, monitoring: { intervalMs: 1_000_000 } };
    const orchestrator = new Orchestrator(config);
    orchestrator.start();

    await vi.waitFor(() => expect(investigateStage.run).toHaveBeenCalledTimes(1));

    const call = vi.mocked(investigateStage.run).mock.calls[0]!;
    expect((call[2] as ClassificationResult).incidents[0]?.incident_id).toBe(expectedId);

    orchestrator.stop();
  });

  it('skips Investigate when Classify has no incidents or findings', async () => {
    const classifyStage = await import('../stages/classify.js');
    const investigateStage = await import('../stages/investigate.js');
    await mockReport();

    vi.mocked(classifyStage.runWithReport).mockResolvedValue({
      stage: 'Classify',
      status: 'success',
      timestamp: 't',
      data: { summary: '', overall_severity: 'NONE', incidents: [], findings: [] },
    });

    const config = { ...mockConfig, monitoring: { intervalMs: 1_000_000 } };
    const orchestrator = new Orchestrator(config);
    orchestrator.start();

    await vi.waitFor(() => expect(classifyStage.runWithReport).toHaveBeenCalledTimes(1));

    expect(classifyStage.runWithReport).toHaveBeenCalledTimes(1);
    expect(investigateStage.run).not.toHaveBeenCalled();

    orchestrator.stop();
  });

  it('logs an Investigate error and later ticks continue', async () => {
    const classifyStage = await import('../stages/classify.js');
    const investigateStage = await import('../stages/investigate.js');
    const { fetchReport } = await import('../report/fetchReport.js');
    vi.mocked(fetchReport).mockResolvedValueOnce('first report').mockResolvedValue('second report');

    const changedClassifyResult: StageResult = {
      ...actionableClassifyResult,
      data: {
        ...actionableClassification,
        findings: [
          {
            ...actionableClassification.findings[0]!,
            evidence: ['changed evidence'],
          },
        ],
      },
    };

    vi.mocked(classifyStage.runWithReport)
      .mockResolvedValueOnce(actionableClassifyResult)
      .mockResolvedValue(changedClassifyResult);
    vi.mocked(investigateStage.run)
      .mockRejectedValueOnce(new Error('investigate boom'))
      .mockResolvedValue(investigateResult);

    const orchestrator = new Orchestrator(mockConfig);
    orchestrator.start();

    await vi.waitFor(() => expect(investigateStage.run).toHaveBeenCalledTimes(1));

    await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(() => expect(classifyStage.runWithReport).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(investigateStage.run).toHaveBeenCalledTimes(2));

    orchestrator.stop();
  });

  it('skips Classify and Investigate when the report content is unchanged', async () => {
    const classifyStage = await import('../stages/classify.js');
    const investigateStage = await import('../stages/investigate.js');
    await mockReport('same report');

    vi.mocked(classifyStage.runWithReport).mockResolvedValue(actionableClassifyResult);
    vi.mocked(investigateStage.run).mockResolvedValue(investigateResult);

    const config = { ...mockConfig, monitoring: { intervalMs: 1_000_000 } };
    const orchestrator = new Orchestrator(config);
    orchestrator.start();

    await vi.waitFor(() => expect(investigateStage.run).toHaveBeenCalledTimes(1));
    expect(classifyStage.runWithReport).toHaveBeenCalledTimes(1);
    expect(investigateStage.run).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1_000_000);
    expect(classifyStage.runWithReport).toHaveBeenCalledTimes(1);
    expect(investigateStage.run).toHaveBeenCalledTimes(1);

    orchestrator.stop();
  });

  it('skips Investigate for recurring unchanged observations from changed reports', async () => {
    const classifyStage = await import('../stages/classify.js');
    const investigateStage = await import('../stages/investigate.js');
    const { fetchReport } = await import('../report/fetchReport.js');
    vi.mocked(fetchReport).mockResolvedValueOnce('first report').mockResolvedValue('second report');

    vi.mocked(classifyStage.runWithReport).mockResolvedValue(actionableClassifyResult);
    vi.mocked(investigateStage.run).mockResolvedValue(investigateResult);

    const config = { ...mockConfig, monitoring: { intervalMs: 1_000_000 } };
    const orchestrator = new Orchestrator(config);
    orchestrator.start();

    await vi.waitFor(() => expect(investigateStage.run).toHaveBeenCalledTimes(1));
    expect(classifyStage.runWithReport).toHaveBeenCalledTimes(1);
    expect(investigateStage.run).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1_000_000);
    await vi.waitFor(() => expect(classifyStage.runWithReport).toHaveBeenCalledTimes(2));
    expect(investigateStage.run).toHaveBeenCalledTimes(1);

    orchestrator.stop();
  });
});

describe('Orchestrator alarm trigger consumer seam (T5)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stateFileCounter += 1;
    mockConfig.state.path = `/private/tmp/mttr-orchestrator-${process.pid}-${stateFileCounter}.json`;
    rmSync(mockConfig.state.path, { force: true });
    vi.useFakeTimers();
  });

  afterEach(() => {
    rmSync(mockConfig.state.path, { force: true });
    vi.useRealTimers();
  });

  async function mockReport(text = '# report'): Promise<void> {
    const { fetchReport } = await import('../report/fetchReport.js');
    vi.mocked(fetchReport).mockResolvedValue(text);
  }

  const actionableClassification: ClassificationResult = {
    summary: 'A finding to investigate.',
    overall_severity: 'MEDIUM',
    incidents: [],
    findings: [
      {
        title: 'High 4xx',
        classification: 'AUTH_FAILURE',
        severity: 'MEDIUM',
        confidence: 0.7,
        affected_services: ['api'],
        evidence: ['e'],
        reason_not_incident: 'r',
      },
    ],
  };

  const actionableClassifyResult: StageResult = {
    stage: 'Classify',
    status: 'success',
    timestamp: 't',
    data: actionableClassification,
  };

  const investigateResult: StageResult = {
    stage: 'Investigate',
    status: 'success',
    timestamp: 't',
    data: {
      summary: 'done',
      overall_assessment: 'POSSIBLE_INCIDENT',
      overall_severity: 'MEDIUM',
      investigations: [],
      cross_cutting_observations: [],
      priority_order: [],
    },
  };

  it('investigateBusy reflects the in-flight Investigate stage', async () => {
    const classifyStage = await import('../stages/classify.js');
    const investigateStage = await import('../stages/investigate.js');
    await mockReport();

    vi.mocked(classifyStage.runWithReport).mockResolvedValue(actionableClassifyResult);

    let resolveInvestigate: (() => void) | null = null;
    const pending = new Promise<StageResult>((resolve) => {
      resolveInvestigate = () => resolve(investigateResult);
    });
    vi.mocked(investigateStage.run).mockReturnValue(pending);

    const config = { ...mockConfig, monitoring: { intervalMs: 1_000_000 } };
    const orchestrator = new Orchestrator(config);

    expect(orchestrator.investigateBusy).toBe(false);
    orchestrator.start();

    await vi.waitFor(() => expect(investigateStage.run).toHaveBeenCalledTimes(1));
    expect(orchestrator.investigateBusy).toBe(true);

    resolveInvestigate!();
    await vi.waitFor(() => expect(orchestrator.investigateBusy).toBe(false));

    orchestrator.stop();
  });

  it('launches an alarm-triggered Investigate to Decide to Verify run', async () => {
    const investigateStage = await import('../stages/investigate.js');
    const verifyStage = await import('../stages/verify.js');
    const repository = new FakeOrchestratorRepository();
    const trigger = alarmTrigger();

    vi.mocked(investigateStage.run).mockResolvedValue({
      stage: 'Investigate',
      status: 'success',
      timestamp: 't',
      data: {
        summary: 'possible alarm incident',
        overall_assessment: 'POSSIBLE_INCIDENT',
        overall_severity: 'CRITICAL',
        investigations: [
          {
            incident_id: canonicalObservationKey('incident', expectedAlarmIncident()),
            title: 'Active alarm for api: api-task-health',
            original_classification: 'UNKNOWN',
            investigation_status: 'POSSIBLE_INCIDENT',
            severity: 'CRITICAL',
            confidence: 0.8,
            affected_services: ['api'],
            confirmed_facts: ['Alarm api-task-health is active.'],
            supporting_evidence: ['CloudWatch alarm state=ALARM.'],
            contradicting_evidence: [],
            likely_causes: [],
            unknowns: [],
            additional_data_needed: [],
            unresolved_evidence_requirements: [],
            recommended_next_investigation_steps: [],
            requires_more_evidence_before_mitigation: false,
            possible_future_remediation: [],
          },
        ],
        cross_cutting_observations: [],
        priority_order: [],
      },
    });
    const verification: VerificationResult = {
      summary: 'verified',
      overall_status: 'STILL_INCONCLUSIVE',
      overall_next_stage: 'None',
      verifications: [
        {
          incident_id: 'incident-1',
          title: 'Active alarm for api: api-task-health',
          status: 'STILL_INCONCLUSIVE',
          severity: 'CRITICAL',
          rationale: 'Mock verification',
          checks: [],
          recommended_next_stage: 'None',
        },
      ],
    };
    vi.mocked(verifyStage.run).mockResolvedValue({
      stage: 'Verify',
      status: 'success',
      timestamp: 't',
      data: verification,
    });

    const orchestrator = new Orchestrator(mockConfig, repository);
    const result = await orchestrator.runInvestigationFromTrigger({
      triggers: [trigger],
      specKeys: [trigger.spec_key as string],
    });

    expect(result).toEqual({ status: 'launched', runId: 'run-1' });
    expect(repository.runs).toMatchObject([{ id: 'run-1', triggerSource: 'alarm' }]);
    expect(repository.finishes.at(-1)?.update).toMatchObject({
      status: 'success',
      overallSeverity: 'CRITICAL',
    });
    expect(repository.stageOutputs.map((output) => output.stage)).toEqual([
      'Classify',
      'Investigate',
      'Decide',
      'Verify',
    ]);
    expect(investigateStage.run).toHaveBeenCalledTimes(1);
    expect(verifyStage.run).toHaveBeenCalledTimes(1);
    expect((repository.stageOutputs[0]?.data as ClassificationResult).incidents[0]).toMatchObject({
      title: 'Active alarm for api: api-task-health',
      affected_services: ['api'],
      signals: { alarms: ['api-task-health'] },
    });
  });

  it('returns busy for trigger launches while Investigate is already in flight', async () => {
    const classifyStage = await import('../stages/classify.js');
    const investigateStage = await import('../stages/investigate.js');
    await mockReport();
    vi.mocked(classifyStage.runWithReport).mockResolvedValue(actionableClassifyResult);

    let resolveInvestigate: (() => void) | null = null;
    vi.mocked(investigateStage.run).mockReturnValue(
      new Promise<StageResult>((resolve) => {
        resolveInvestigate = () => resolve(investigateResult);
      })
    );

    const repository = new FakeOrchestratorRepository();
    const orchestrator = new Orchestrator(
      { ...mockConfig, monitoring: { intervalMs: 1_000_000 } },
      repository
    );
    orchestrator.start();
    await vi.waitFor(() => expect(orchestrator.investigateBusy).toBe(true));

    await expect(
      orchestrator.runInvestigationFromTrigger({
        triggers: [alarmTrigger()],
        specKeys: ['api|UNKNOWN|api-task-health|'],
      })
    ).resolves.toEqual({ status: 'busy' });
    expect(repository.runs).toHaveLength(1);

    resolveInvestigate!();
    await vi.waitFor(() => expect(orchestrator.investigateBusy).toBe(false));
    orchestrator.stop();
  });

  it('dedupes an alarm-born incident with the matching report-born mandatory incident', async () => {
    const investigateStage = await import('../stages/investigate.js');
    const repository = new FakeOrchestratorRepository();
    const orchestrator = new Orchestrator(mockConfig, repository);
    vi.mocked(investigateStage.run).mockResolvedValue(investigateResult);

    const reportIncident: ClassificationResult = {
      summary: 'Mandatory report incident',
      overall_severity: 'CRITICAL',
      findings: [],
      incidents: [expectedAlarmIncident()],
    };
    const canonicalId = canonicalObservationKey('incident', reportIncident.incidents[0]!);
    repository.state.observations[canonicalId] = {
      key: canonicalId,
      type: 'incident',
      title: reportIncident.incidents[0]!.title,
      classification: reportIncident.incidents[0]!.classification,
      affectedServices: reportIncident.incidents[0]!.affected_services,
      severity: reportIncident.incidents[0]!.severity,
      confidence: reportIncident.incidents[0]!.confidence,
      signature: 'existing-signature',
      status: 'active',
      firstSeen: '2026-06-08T09:55:00.000Z',
      lastSeen: '2026-06-08T09:55:00.000Z',
      lastChangedAt: '2026-06-08T09:55:00.000Z',
      occurrences: 1,
    };

    const result = await orchestrator.runInvestigationFromTrigger({
      triggers: [alarmTrigger()],
      specKeys: ['api|UNKNOWN|api-task-health|'],
    });

    expect(result).toEqual({ status: 'launched', runId: 'run-1' });
    expect(Object.keys(repository.state.observations)).toEqual([canonicalId]);
    expect(investigateStage.run).toHaveBeenCalledTimes(1);
  });

  it('starts the alarm trigger consumer when the webhook feature is enabled', async () => {
    const classifyStage = await import('../stages/classify.js');
    const investigateStage = await import('../stages/investigate.js');
    await mockReport();
    vi.mocked(classifyStage.runWithReport).mockResolvedValue(actionableClassifyResult);
    vi.mocked(investigateStage.run).mockResolvedValue(investigateResult);

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const config = {
      ...mockConfig,
      monitoring: { intervalMs: 1_000_000 },
      alarm: {
        ...mockConfig.alarm,
        webhook: { ...mockConfig.alarm.webhook, enabled: true },
      },
    };
    const orchestrator = new Orchestrator(config);

    orchestrator.start();

    expect(
      logSpy.mock.calls.some((call) => String(call[0]).includes('Alarm trigger consumer started'))
    ).toBe(true);

    expect(() => orchestrator.stop()).not.toThrow();
    logSpy.mockRestore();
  });

  it('does not start the alarm trigger consumer when the webhook feature is disabled', async () => {
    const classifyStage = await import('../stages/classify.js');
    const investigateStage = await import('../stages/investigate.js');
    await mockReport();
    vi.mocked(classifyStage.runWithReport).mockResolvedValue(actionableClassifyResult);
    vi.mocked(investigateStage.run).mockResolvedValue(investigateResult);

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const config = { ...mockConfig, monitoring: { intervalMs: 1_000_000 } };
    const orchestrator = new Orchestrator(config);

    orchestrator.start();

    expect(
      logSpy.mock.calls.some((call) => String(call[0]).includes('Alarm trigger consumer started'))
    ).toBe(false);

    orchestrator.stop();
    logSpy.mockRestore();
  });
});
