import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as investigateStage from '../stages/investigate.js';
import { callOpenRouterWithTools } from '../llm/toolLoop.js';
import type { Config } from '../config.js';
import type { StageInput, ClassificationResult, InvestigationResult } from '../types.js';

vi.mock('../llm/toolLoop.js');

const mockLoop = vi.mocked(callOpenRouterWithTools);

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
  healthReport: { s3Uri: 's3://test/report.md' },
  aws: { region: 'us-east-1', maxAttempts: 5 },
  monitoring: { intervalMs: 5000 },
  state: { path: '.test-mttr-state.json' },
  timeouts: { llmMs: 5000, s3Ms: 5000 },
};

const mockInput: StageInput = { stage: 'Investigate', timestamp: '2026-06-07T12:00:00Z' };

const validInvestigationJson = JSON.stringify({
  summary: 'Investigated the 4xx finding.',
  overall_assessment: 'POSSIBLE_INCIDENT',
  overall_severity: 'MEDIUM',
  investigations: [],
  cross_cutting_observations: [],
  priority_order: [],
});

function loopResult(content: string) {
  return { content, iterations: 1, toolCalls: 1, usedFallback: false };
}

const emptyClassification: ClassificationResult = {
  summary: 'No actionable incidents detected.',
  overall_severity: 'NONE',
  incidents: [],
  findings: [],
};

const classificationWithFinding: ClassificationResult = {
  summary: 'A finding to investigate.',
  overall_severity: 'MEDIUM',
  incidents: [],
  findings: [
    {
      title: 'High 4xx Error Rate in data-pipeline-api',
      classification: 'AUTH_FAILURE',
      severity: 'MEDIUM',
      confidence: 0.7,
      affected_services: ['data-pipeline-api'],
      evidence: ['60 4xx errors in ALB metrics.'],
      reason_not_incident: 'No supporting logs.',
    },
  ],
};

describe('investigate stage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('short-circuits on empty classification with no LLM call', async () => {
    const result = await investigateStage.run(mockInput, mockConfig, emptyClassification);

    expect(result.status).toBe('success');
    expect(mockLoop).not.toHaveBeenCalled();
    const data = result.data as InvestigationResult;
    expect(data.overall_assessment).toBe('NO_ACTIONABLE_INCIDENT');
    expect(data.overall_severity).toBe('NONE');
  });

  it('short-circuits on a Stage 1 failure fallback (empty arrays)', async () => {
    const failureFallback: ClassificationResult = {
      summary: 'Classification failed: LLM returned invalid JSON after retry',
      overall_severity: 'NONE',
      incidents: [],
      findings: [],
    };

    const result = await investigateStage.run(mockInput, mockConfig, failureFallback);

    expect(result.status).toBe('success');
    expect(mockLoop).not.toHaveBeenCalled();
    expect((result.data as InvestigationResult).overall_assessment).toBe('NO_ACTIONABLE_INCIDENT');
  });

  it('returns a validated investigation on the happy path', async () => {
    mockLoop.mockResolvedValue(loopResult(validInvestigationJson));

    const result = await investigateStage.run(mockInput, mockConfig, classificationWithFinding);

    expect(result.status).toBe('success');
    expect(mockLoop).toHaveBeenCalledTimes(1);
    const data = result.data as InvestigationResult;
    expect(data.overall_assessment).toBe('POSSIBLE_INCIDENT');
    expect(data.overall_severity).toBe('MEDIUM');
  });

  it('strips markdown fences from the response', async () => {
    mockLoop.mockResolvedValue(loopResult('```json\n' + validInvestigationJson + '\n```'));

    const result = await investigateStage.run(mockInput, mockConfig, classificationWithFinding);

    expect(result.status).toBe('success');
    expect((result.data as InvestigationResult).overall_assessment).toBe('POSSIBLE_INCIDENT');
  });

  it('repairs once on invalid JSON and succeeds', async () => {
    mockLoop
      .mockResolvedValueOnce(loopResult('not valid json'))
      .mockResolvedValueOnce(loopResult(validInvestigationJson));

    const result = await investigateStage.run(mockInput, mockConfig, classificationWithFinding);

    expect(result.status).toBe('success');
    expect(mockLoop).toHaveBeenCalledTimes(2);
    // repair turn is invoked with no tools
    expect((mockLoop.mock.calls[1]![0] as { tools: unknown[] }).tools).toEqual([]);
    expect((result.data as InvestigationResult).overall_assessment).toBe('POSSIBLE_INCIDENT');
  });

  it('returns the safe fallback when repair also fails', async () => {
    mockLoop
      .mockResolvedValueOnce(loopResult('still bad'))
      .mockResolvedValueOnce(loopResult('also bad'));

    const result = await investigateStage.run(mockInput, mockConfig, classificationWithFinding);

    expect(result.status).toBe('success');
    expect(mockLoop).toHaveBeenCalledTimes(2);
    const data = result.data as InvestigationResult;
    expect(data.overall_assessment).toBe('INSUFFICIENT_EVIDENCE');
    expect(data.summary).toContain('Investigation failed');
  });

  it('returns status error when the tool loop throws', async () => {
    mockLoop.mockRejectedValue(new Error('tool loop timed out'));

    const result = await investigateStage.run(mockInput, mockConfig, classificationWithFinding);

    expect(result.status).toBe('error');
    expect(result.error).toContain('tool loop timed out');
  });
});
