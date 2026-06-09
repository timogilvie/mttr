import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as investigateStage from '../stages/investigate.js';
import { callOpenRouterWithTools } from '../llm/toolLoop.js';
import { discoverLogGroupsTool, queryLogsTool } from '../tools/cloudwatchLogs.js';
import type { Config } from '../config.js';
import type { StageInput, ClassificationResult, InvestigationResult } from '../types.js';

vi.mock('../llm/toolLoop.js');
vi.mock('../tools/cloudwatchLogs.js', () => ({
  discoverLogGroupsTool: {
    handler: vi.fn(),
  },
  queryLogsTool: {
    handler: vi.fn(),
  },
}));

const mockLoop = vi.mocked(callOpenRouterWithTools);
const mockDiscoverLogGroups = vi.mocked(discoverLogGroupsTool.handler);
const mockQueryLogs = vi.mocked(queryLogsTool.handler);

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
    mockDiscoverLogGroups.mockResolvedValue(
      'Found 2 candidate log group(s):\n' +
        'logGroupName=/ecs/hokusai-api-development, storedBytes=11701821\n' +
        'logGroupName=/ecs/hokusai/api/development, storedBytes=0'
    );
    mockQueryLogs.mockResolvedValue(
      'Query returned 1 row(s):\nstatus=401, path=/api/probe, requests=12'
    );
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
    expect(mockDiscoverLogGroups).toHaveBeenCalledWith(
      { service_name: 'data-pipeline-api', limit: 5 },
      expect.objectContaining({ region: 'us-east-1' })
    );
    expect(mockQueryLogs).toHaveBeenCalledWith(
      expect.objectContaining({
        log_group: '/ecs/hokusai-api-development',
        lookback_minutes: mockConfig.tools.maxLookbackMinutes,
      }),
      expect.objectContaining({ region: 'us-east-1' })
    );
    expect(mockQueryLogs).toHaveBeenCalledTimes(1);
    expect(mockLoop.mock.calls[0]![0].prompt).toContain('Pre-gathered Tool Evidence');
    expect(mockLoop.mock.calls[0]![0].prompt).toContain('standard 4xx/auth breakdown');
    expect(mockLoop.mock.calls[0]![0].prompt).toContain('1440 minute lookback');
    const data = result.data as InvestigationResult;
    expect(data.overall_assessment).toBe('POSSIBLE_INCIDENT');
    expect(data.overall_severity).toBe('MEDIUM');
  });

  it('pre-gathers warning samples for warning findings', async () => {
    mockLoop.mockResolvedValue(loopResult(validInvestigationJson));
    const warningClassification: ClassificationResult = {
      summary: 'Warnings to investigate.',
      overall_severity: 'LOW',
      incidents: [],
      findings: [
        {
          title: 'High Warning Count in auth-service',
          classification: 'OBSERVABILITY_FAILURE',
          severity: 'LOW',
          confidence: 0.6,
          affected_services: ['auth-service'],
          evidence: ['65 warnings in recent logs.'],
          reason_not_incident: 'Warnings do not indicate a specific actionable incident.',
        },
      ],
    };

    const result = await investigateStage.run(mockInput, mockConfig, warningClassification);

    expect(result.status).toBe('success');
    expect(mockDiscoverLogGroups).toHaveBeenCalledWith(
      { service_name: 'auth-service', limit: 5 },
      expect.objectContaining({ region: 'us-east-1' })
    );
    expect(mockQueryLogs).toHaveBeenCalledWith(
      expect.objectContaining({
        log_group: '/ecs/hokusai-api-development',
        filter_or_query: expect.stringContaining('WARN'),
      }),
      expect.objectContaining({ region: 'us-east-1' })
    );
    expect(mockLoop.mock.calls[0]![0].prompt).toContain('standard warning sample');
  });

  it('queries multiple non-empty candidate log groups during standard evidence gathering', async () => {
    mockLoop.mockResolvedValue(loopResult(validInvestigationJson));
    mockDiscoverLogGroups.mockResolvedValue(
      'Found 3 candidate log group(s):\n' +
        'logGroupName=/ecs/hokusai-api-development, storedBytes=11701821\n' +
        'logGroupName=/ecs/hokusai-api-secondary, storedBytes=42\n' +
        'logGroupName=/ecs/hokusai/api/development, storedBytes=0'
    );

    const result = await investigateStage.run(mockInput, mockConfig, classificationWithFinding);

    expect(result.status).toBe('success');
    expect(mockQueryLogs).toHaveBeenCalledTimes(2);
    expect(mockQueryLogs).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ log_group: '/ecs/hokusai-api-development' }),
      expect.anything()
    );
    expect(mockQueryLogs).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ log_group: '/ecs/hokusai-api-secondary' }),
      expect.anything()
    );
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
