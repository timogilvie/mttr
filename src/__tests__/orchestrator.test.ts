import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Orchestrator } from '../orchestrator.js';
import type { Config } from '../config.js';
import type { StageResult } from '../types.js';

vi.mock('../stages/classify.js');

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
});
