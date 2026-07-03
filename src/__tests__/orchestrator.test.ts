import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { Orchestrator } from '../orchestrator.js';
import type { Config } from '../config.js';
import type { StageResult, ClassificationResult } from '../types.js';
import { canonicalObservationKey } from '../state/agentState.js';
import { FileAgentStateRepository, type AlarmTriggerRow } from '../state/repository.js';
import type { AlarmTriggerBatch } from '../alarm/triggerConsumer.js';

vi.mock('../stages/classify.js');
vi.mock('../stages/investigate.js');
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

  function loadAlarmFixture(name: string): unknown {
    return JSON.parse(
      readFileSync(path.resolve('test/fixtures/sns-cloudwatch-alarm', name), 'utf8')
    ) as unknown;
  }

  function makeAlarmTriggerRow(overrides: Partial<AlarmTriggerRow> = {}): AlarmTriggerRow {
    return {
      id: 'trigger-1',
      sns_message_id: 'sns-1',
      alarm_arn: 'arn:aws:cloudwatch:us-east-1:123456789012:alarm:hokusai-auth-development-task-health',
      alarm_name: 'hokusai-auth-development-task-health',
      new_state: 'ALARM',
      state_change_time: '2026-07-01T10:00:00.000Z',
      severity: 'CRITICAL',
      spec_key: 'active-alarm-hokusai-auth-development-task-health',
      payload: loadAlarmFixture('task-health-alarm.json'),
      status: 'claimed',
      received_at: '2026-07-01T10:00:00.000Z',
      claimed_at: '2026-07-01T10:00:01.000Z',
      processed_at: null,
      run_id: null,
      ...overrides,
    };
  }

  describe('runInvestigationFromTrigger (T6)', () => {
    it('returns busy without doing work when an investigation is already in flight', async () => {
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
      orchestrator.start();

      await vi.waitFor(() => expect(investigateStage.run).toHaveBeenCalledTimes(1));
      expect(orchestrator.investigateBusy).toBe(true);

      const batch: AlarmTriggerBatch = {
        triggers: [makeAlarmTriggerRow()],
        specKeys: ['active-alarm-hokusai-auth-development-task-health'],
      };
      await expect(orchestrator.runInvestigationFromTrigger(batch)).resolves.toEqual({
        status: 'busy',
      });

      resolveInvestigate!();
      await vi.waitFor(() => expect(orchestrator.investigateBusy).toBe(false));

      orchestrator.stop();
    });

    it('returns busy when a scheduled Classify tick is still in flight', async () => {
      // Both entry points share persistClassification's load->reconcile->save cycle; a scheduled
      // Classify tick holding classifyInFlight must block the alarm path from racing it against
      // the same AgentState snapshot.
      const classifyStage = await import('../stages/classify.js');
      await mockReport();

      let resolveClassify: ((result: StageResult) => void) | null = null;
      const pending = new Promise<StageResult>((resolve) => {
        resolveClassify = resolve;
      });
      vi.mocked(classifyStage.runWithReport).mockReturnValue(pending);

      const config = { ...mockConfig, monitoring: { intervalMs: 1_000_000 } };
      const orchestrator = new Orchestrator(config);
      orchestrator.start();

      await vi.waitFor(() => expect(classifyStage.runWithReport).toHaveBeenCalledTimes(1));

      const batch: AlarmTriggerBatch = {
        triggers: [makeAlarmTriggerRow()],
        specKeys: ['active-alarm-hokusai-auth-development-task-health'],
      };
      await expect(orchestrator.runInvestigationFromTrigger(batch)).resolves.toEqual({
        status: 'busy',
      });

      resolveClassify!({
        stage: 'Classify',
        status: 'success',
        timestamp: 't',
        data: { summary: '', overall_severity: 'NONE', incidents: [], findings: [] },
      });
      orchestrator.stop();
    });

    it('returns an error when no trigger in the batch produces a valid incident spec', async () => {
      const orchestrator = new Orchestrator(mockConfig);

      const result = await orchestrator.runInvestigationFromTrigger({ triggers: [], specKeys: [] });

      expect(result).toEqual({
        status: 'error',
        message: expect.stringContaining('valid incident spec'),
      });
    });

    it('launches a run tagged alarm and drives the synthesized classification into Investigate/Decide', async () => {
      const investigateStage = await import('../stages/investigate.js');
      vi.mocked(investigateStage.run).mockResolvedValue(investigateResult);

      const startRunSpy = vi
        .spyOn(FileAgentStateRepository.prototype, 'startRun')
        .mockResolvedValue('alarm-run-1');

      const orchestrator = new Orchestrator(mockConfig);
      const batch: AlarmTriggerBatch = {
        triggers: [makeAlarmTriggerRow()],
        specKeys: ['active-alarm-hokusai-auth-development-task-health'],
      };

      const result = await orchestrator.runInvestigationFromTrigger(batch);

      expect(result).toEqual({ status: 'launched', runId: 'alarm-run-1' });
      expect(startRunSpy).toHaveBeenCalledWith(expect.any(String), 'alarm');
      expect(investigateStage.run).toHaveBeenCalledTimes(1);

      const call = vi.mocked(investigateStage.run).mock.calls[0]!;
      const classification = call[2] as ClassificationResult;
      expect(classification.incidents).toHaveLength(1);
      expect(classification.incidents[0]).toEqual(
        expect.objectContaining({
          title: 'Active alarm for hokusai-auth-development: hokusai-auth-development-task-health',
          classification: 'UNKNOWN',
          severity: 'CRITICAL',
          affected_services: ['hokusai-auth-development'],
        })
      );

      startRunSpy.mockRestore();
    });

    it('reconciles an alarm-born incident with a matching report-born incident to one identity', async () => {
      const classifyStage = await import('../stages/classify.js');
      const investigateStage = await import('../stages/investigate.js');
      await mockReport();
      vi.mocked(investigateStage.run).mockResolvedValue(investigateResult);

      const startRunSpy = vi
        .spyOn(FileAgentStateRepository.prototype, 'startRun')
        .mockResolvedValue('run-report-1');

      // Evidence phrasing intentionally differs from the alarm path's exact wording (see
      // `buildActiveAlarmSpec`'s evidence string) — the report and alarm entry points describe
      // the same alarm signal differently, which should still reconcile to one incident identity
      // (title/classification/affected_services match) even though the observation is flagged
      // "changed" rather than "recurring" and is re-investigated.
      const reportBornIncident: ClassificationResult['incidents'][number] = {
        incident_id: 'report-incident-1',
        title: 'Active alarm for hokusai-auth-development: hokusai-auth-development-task-health',
        classification: 'UNKNOWN',
        severity: 'CRITICAL',
        confidence: 0.95,
        affected_services: ['hokusai-auth-development'],
        evidence: ['Health report lists alarm hokusai-auth-development-task-health in ALARM state.'],
        signals: {
          alarms: ['hokusai-auth-development-task-health'],
          metrics: [],
          logs: [],
        },
        suspected_causes: ['CloudWatch alarm threshold is currently breached.'],
        investigation_plan: {
          priority: 1,
          estimated_user_impact: 'COMPLETE',
          first_actions: ['Inspect CloudWatch alarm history and reason.'],
          questions_to_answer: ['When did the alarm enter ALARM state?'],
          suggested_cloudwatch_queries: ['CloudWatch alarm history.'],
        },
        recommended_next_stage: 'INVESTIGATE',
      };

      vi.mocked(classifyStage.runWithReport).mockResolvedValue({
        stage: 'Classify',
        status: 'success',
        timestamp: 't',
        data: {
          summary: 'Active alarm detected.',
          overall_severity: 'CRITICAL',
          incidents: [reportBornIncident],
          findings: [],
        },
      });

      const config = { ...mockConfig, monitoring: { intervalMs: 1_000_000 } };
      const orchestrator = new Orchestrator(config);
      orchestrator.start();

      await vi.waitFor(() => expect(investigateStage.run).toHaveBeenCalledTimes(1));

      const batch: AlarmTriggerBatch = {
        triggers: [makeAlarmTriggerRow()],
        specKeys: ['active-alarm-hokusai-auth-development-task-health'],
      };
      const result = await orchestrator.runInvestigationFromTrigger(batch);
      expect(result.status).toBe('launched');
      // runInvestigationFromTrigger fully drives Investigate/Decide before resolving, so the
      // second call is already reflected by the time the await above completes.
      expect(investigateStage.run).toHaveBeenCalledTimes(2);

      const persisted = JSON.parse(readFileSync(config.state.path, 'utf8')) as {
        observations: Record<string, { occurrences: number }>;
      };
      const observationKeys = Object.keys(persisted.observations);

      expect(observationKeys).toHaveLength(1);
      expect(persisted.observations[observationKeys[0]!]?.occurrences).toBe(2);

      orchestrator.stop();
      startRunSpy.mockRestore();
    });

    it('drives Investigate/Decide on the file backend even when startRun returns undefined', async () => {
      // FileAgentStateRepository.startRun always returns undefined (the file backend does not
      // record runs). The alarm path must tolerate that the same way the scheduled path does —
      // proceeding with `runId = undefined` — instead of terminally failing every alarm batch.
      const investigateStage = await import('../stages/investigate.js');
      vi.mocked(investigateStage.run).mockResolvedValue(investigateResult);

      const orchestrator = new Orchestrator(mockConfig);
      const batch: AlarmTriggerBatch = {
        triggers: [makeAlarmTriggerRow()],
        specKeys: ['active-alarm-hokusai-auth-development-task-health'],
      };

      const result = await orchestrator.runInvestigationFromTrigger(batch);

      expect(result).toEqual({ status: 'launched', runId: undefined });
      expect(investigateStage.run).toHaveBeenCalledTimes(1);
    });

    it('does not resolve unrelated active observations left by prior report runs', async () => {
      const classifyStage = await import('../stages/classify.js');
      const investigateStage = await import('../stages/investigate.js');
      await mockReport();
      vi.mocked(investigateStage.run).mockResolvedValue(investigateResult);

      // Seed state via a scheduled report run that creates a completely unrelated active
      // observation (a finding on `api`, nothing to do with the alarm's service).
      vi.mocked(classifyStage.runWithReport).mockResolvedValue(actionableClassifyResult);

      let runCounter = 0;
      const startRunSpy = vi
        .spyOn(FileAgentStateRepository.prototype, 'startRun')
        .mockImplementation(async () => {
          runCounter += 1;
          return `run-${runCounter}`;
        });

      const config = { ...mockConfig, monitoring: { intervalMs: 1_000_000 } };
      const orchestrator = new Orchestrator(config);
      orchestrator.start();

      await vi.waitFor(() => expect(investigateStage.run).toHaveBeenCalledTimes(1));
      await vi.waitFor(() => expect(orchestrator.investigateBusy).toBe(false));

      const persistedBefore = JSON.parse(readFileSync(config.state.path, 'utf8')) as {
        observations: Record<string, { status: string }>;
      };
      const preexistingKeys = Object.keys(persistedBefore.observations);
      expect(preexistingKeys).toHaveLength(1);
      expect(persistedBefore.observations[preexistingKeys[0]!]?.status).toBe('active');

      // Fire an alarm for a totally unrelated service. Before this fix, the alarm's partial
      // classification would sweep the pre-existing active observation into 'resolved'.
      const batch: AlarmTriggerBatch = {
        triggers: [makeAlarmTriggerRow()],
        specKeys: ['active-alarm-hokusai-auth-development-task-health'],
      };
      const result = await orchestrator.runInvestigationFromTrigger(batch);
      expect(result.status).toBe('launched');

      const persistedAfter = JSON.parse(readFileSync(config.state.path, 'utf8')) as {
        observations: Record<string, { status: string }>;
      };
      // The alarm-born observation is added; the pre-existing one stays active.
      expect(Object.keys(persistedAfter.observations)).toHaveLength(2);
      expect(persistedAfter.observations[preexistingKeys[0]!]?.status).toBe('active');

      orchestrator.stop();
      startRunSpy.mockRestore();
    });
  });

  describe('runRecoveryVerifyFromTrigger (T7)', () => {
    it('invokes Verify only and confirms recovered verification', async () => {
      const investigateStage = await import('../stages/investigate.js');
      const verifyStage = await import('../stages/verify.js');
      const verifySpy = vi.spyOn(verifyStage, 'run').mockResolvedValue({
        stage: 'Verify',
        status: 'success',
        timestamp: 't',
        data: {
          summary: 'Recovered.',
          overall_status: 'VERIFIED_RECOVERED_TRANSIENT',
          overall_next_stage: 'None',
          verifications: [
            {
              incident_id: 'incident-1',
              title: 'Active alarm for api: test-alarm',
              status: 'VERIFIED_RECOVERED_TRANSIENT',
              severity: 'CRITICAL',
              rationale: 'Alarm is OK.',
              checks: [
                {
                  tool: 'find_alarms',
                  target: 'test-alarm',
                  status: 'passed',
                  evidence: 'state=OK',
                },
              ],
              recommended_next_stage: 'None',
            },
          ],
        },
      });
      const startRunSpy = vi
        .spyOn(FileAgentStateRepository.prototype, 'startRun')
        .mockResolvedValue('recovery-run-1');
      const stageSpy = vi.spyOn(FileAgentStateRepository.prototype, 'recordStageOutput');
      const eventsSpy = vi.spyOn(FileAgentStateRepository.prototype, 'recordIncidentEvents');
      const transitionsSpy = vi
        .spyOn(FileAgentStateRepository.prototype, 'recordVerificationTransitions')
        .mockResolvedValue([]);

      const orchestrator = new Orchestrator(mockConfig);
      const result = await orchestrator.runRecoveryVerifyFromTrigger(
        makeAlarmTriggerRow({ new_state: 'OK', alarm_name: 'test-alarm' }),
        {
          incidentId: 'incident-1',
          title: 'Active alarm for api: test-alarm',
          severity: 'CRITICAL',
          service: 'api',
          state: 'decision',
          closedAt: null,
        }
      );

      expect(result).toEqual({ status: 'confirmed', runId: 'recovery-run-1' });
      expect(investigateStage.run).not.toHaveBeenCalled();
      expect(verifySpy).toHaveBeenCalledTimes(1);
      expect(verifySpy.mock.calls[0]?.[2]).toMatchObject({
        decisions: [
          expect.objectContaining({
            incident_id: 'incident-1',
            next_stage: 'Verify',
            evidence_to_pass: expect.arrayContaining(['alarm=test-alarm', 'state=OK']),
          }),
        ],
      });
      expect(stageSpy).toHaveBeenCalledWith('recovery-run-1', expect.objectContaining({ stage: 'Verify' }));
      expect(eventsSpy).toHaveBeenCalledWith('recovery-run-1', expect.any(Array));
      expect(transitionsSpy).toHaveBeenCalledWith(
        'recovery-run-1',
        expect.objectContaining({ overall_status: 'VERIFIED_RECOVERED_TRANSIENT' })
      );

      verifySpy.mockRestore();
      startRunSpy.mockRestore();
      stageSpy.mockRestore();
      eventsSpy.mockRestore();
      transitionsSpy.mockRestore();
    });

    it('does not confirm or close when Verify returns non-recovery or an empty scope', async () => {
      const verifyStage = await import('../stages/verify.js');
      const verifySpy = vi.spyOn(verifyStage, 'run').mockResolvedValue({
        stage: 'Verify',
        status: 'success',
        timestamp: 't',
        data: {
          summary: 'No candidates.',
          overall_status: 'VERIFIED_NON_INCIDENT',
          overall_next_stage: 'None',
          verifications: [
            {
              incident_id: 'incident-1',
              title: 'Active alarm for api: test-alarm',
              status: 'VERIFIED_NON_INCIDENT',
              severity: 'CRITICAL',
              rationale: 'No checks.',
              checks: [],
              recommended_next_stage: 'None',
            },
          ],
        },
      });
      const startRunSpy = vi
        .spyOn(FileAgentStateRepository.prototype, 'startRun')
        .mockResolvedValue('recovery-run-2');
      const transitionsSpy = vi
        .spyOn(FileAgentStateRepository.prototype, 'recordVerificationTransitions')
        .mockResolvedValue([]);

      const orchestrator = new Orchestrator(mockConfig);
      const result = await orchestrator.runRecoveryVerifyFromTrigger(
        makeAlarmTriggerRow({ new_state: 'OK', alarm_name: 'test-alarm' }),
        {
          incidentId: 'incident-1',
          title: 'Active alarm for api: test-alarm',
          severity: 'CRITICAL',
          service: 'api',
          state: 'decision',
          closedAt: null,
        }
      );

      expect(result).toMatchObject({ status: 'not_confirmed', runId: 'recovery-run-2' });
      expect(transitionsSpy).toHaveBeenCalledWith(
        'recovery-run-2',
        expect.objectContaining({
          overall_status: 'STILL_INCONCLUSIVE',
          overall_next_stage: 'Investigate',
        })
      );

      verifySpy.mockRestore();
      startRunSpy.mockRestore();
      transitionsSpy.mockRestore();
    });
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
