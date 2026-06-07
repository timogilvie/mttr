import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Orchestrator } from '../orchestrator.js';
import type { Config } from '../config.js';
import type { StageResult, ClassificationResult } from '../types.js';

vi.mock('../stages/classify.js');
vi.mock('../stages/investigate.js');

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
  timeouts: {
    llmMs: 5000,
    s3Ms: 5000,
  },
};

describe('Orchestrator', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('ticks continue while long Classify task is in flight', async () => {
    const classifyStage = await import('../stages/classify.js');

    const mockResult: StageResult = {
      stage: 'Classify',
      status: 'success',
      timestamp: new Date().toISOString(),
    };

    vi.mocked(classifyStage.run).mockResolvedValue(mockResult);

    const orchestrator = new Orchestrator(mockConfig);
    orchestrator.start();

    expect(classifyStage.run).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(500);
    expect(classifyStage.run).toHaveBeenCalledTimes(1);

    orchestrator.stop();
  });

  it('overlapping Classify runs are skipped', async () => {
    const classifyStage = await import('../stages/classify.js');

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

    vi.mocked(classifyStage.run)
      .mockReturnValueOnce(firstPromise)
      .mockResolvedValue(mockResult);

    const orchestrator = new Orchestrator(mockConfig);
    orchestrator.start();

    expect(classifyStage.run).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1000);
    expect(classifyStage.run).toHaveBeenCalledTimes(1);

    resolveFirst!();
    await vi.waitFor(() => Promise.resolve());

    await vi.advanceTimersByTimeAsync(1000);
    expect(classifyStage.run).toHaveBeenCalledTimes(2);

    orchestrator.stop();
  });

  it('stage rejection is logged and later ticks continue', async () => {
    const classifyStage = await import('../stages/classify.js');

    const mockResult: StageResult = {
      stage: 'Classify',
      status: 'success',
      timestamp: new Date().toISOString(),
    };

    vi.mocked(classifyStage.run)
      .mockRejectedValueOnce(new Error('Test error'))
      .mockResolvedValue(mockResult);

    const orchestrator = new Orchestrator(mockConfig);
    orchestrator.start();

    expect(classifyStage.run).toHaveBeenCalledTimes(1);

    await vi.waitFor(() => Promise.resolve());

    await vi.advanceTimersByTimeAsync(1000);
    expect(classifyStage.run).toHaveBeenCalledTimes(2);

    orchestrator.stop();
  });

  it('stop() prevents further ticks', async () => {
    const classifyStage = await import('../stages/classify.js');

    const mockResult: StageResult = {
      stage: 'Classify',
      status: 'success',
      timestamp: new Date().toISOString(),
    };

    vi.mocked(classifyStage.run).mockResolvedValue(mockResult);

    const orchestrator = new Orchestrator(mockConfig);
    orchestrator.start();

    expect(classifyStage.run).toHaveBeenCalledTimes(1);

    orchestrator.stop();

    await vi.advanceTimersByTimeAsync(5000);

    expect(classifyStage.run).toHaveBeenCalledTimes(1);
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

    vi.mocked(classifyStage.run).mockResolvedValue(actionableClassifyResult);
    vi.mocked(investigateStage.run).mockResolvedValue(investigateResult);

    const orchestrator = new Orchestrator(mockConfig);
    orchestrator.start();

    await vi.advanceTimersByTimeAsync(10);

    expect(investigateStage.run).toHaveBeenCalledTimes(1);
    const call = vi.mocked(investigateStage.run).mock.calls[0]!;
    expect(call[0]).toEqual(expect.objectContaining({ stage: 'Investigate' }));
    expect(call[1]).toBe(mockConfig);
    expect((call[2] as ClassificationResult).findings).toHaveLength(1);

    orchestrator.stop();
  });

  it('skips Investigate when Classify has no incidents or findings', async () => {
    const classifyStage = await import('../stages/classify.js');
    const investigateStage = await import('../stages/investigate.js');

    vi.mocked(classifyStage.run).mockResolvedValue({
      stage: 'Classify',
      status: 'success',
      timestamp: 't',
      data: { summary: '', overall_severity: 'NONE', incidents: [], findings: [] },
    });

    const orchestrator = new Orchestrator(mockConfig);
    orchestrator.start();

    await vi.advanceTimersByTimeAsync(10);

    expect(classifyStage.run).toHaveBeenCalledTimes(1);
    expect(investigateStage.run).not.toHaveBeenCalled();

    orchestrator.stop();
  });

  it('logs an Investigate error and later ticks continue', async () => {
    const classifyStage = await import('../stages/classify.js');
    const investigateStage = await import('../stages/investigate.js');

    vi.mocked(classifyStage.run).mockResolvedValue(actionableClassifyResult);
    vi.mocked(investigateStage.run)
      .mockRejectedValueOnce(new Error('investigate boom'))
      .mockResolvedValue(investigateResult);

    const orchestrator = new Orchestrator(mockConfig);
    orchestrator.start();

    await vi.advanceTimersByTimeAsync(1000);
    expect(classifyStage.run).toHaveBeenCalledTimes(2);
    expect(investigateStage.run).toHaveBeenCalledTimes(2);

    orchestrator.stop();
  });
});
