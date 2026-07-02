import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { rmSync } from 'node:fs';
import { Orchestrator } from '../orchestrator.js';
import type { Config } from '../config.js';
import type { StageResult, ClassificationResult } from '../types.js';
import { canonicalObservationKey } from '../state/agentState.js';

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
