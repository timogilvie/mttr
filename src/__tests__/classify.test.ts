import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as classifyStage from '../stages/classify.js';
import type { Config } from '../config.js';
import type { StageInput } from '../types.js';

vi.mock('../report/fetchReport.js');
vi.mock('../llm/openrouter.js');

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
    intervalMs: 5000,
  },
  state: {
    path: '.test-mttr-state.json',
  },
  timeouts: {
    llmMs: 5000,
    s3Ms: 5000,
  },
};

const mockInput: StageInput = {
  stage: 'Classify',
  timestamp: '2026-06-06T12:00:00Z',
};

describe('classify stage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns no-incident result on success', async () => {
    const { fetchReport } = await import('../report/fetchReport.js');
    const { callOpenRouter } = await import('../llm/openrouter.js');

    vi.mocked(fetchReport).mockResolvedValue('# Test Report');
    vi.mocked(callOpenRouter).mockResolvedValue(
      JSON.stringify({
        summary: 'No actionable incidents detected.',
        overall_severity: 'NONE',
        incidents: [],
        findings: [],
      })
    );

    const result = await classifyStage.run(mockInput, mockConfig);

    expect(result.status).toBe('success');
    expect(result.stage).toBe('Classify');
    expect(result.data).toBeDefined();

    const data = result.data as { summary: string; overall_severity: string; incidents: unknown[]; findings: unknown[] };
    expect(data.summary).toBe('No actionable incidents detected.');
    expect(data.overall_severity).toBe('NONE');
    expect(data.incidents).toEqual([]);
    expect(data.findings).toEqual([]);
  });

  it('strips markdown fences from response', async () => {
    const { fetchReport } = await import('../report/fetchReport.js');
    const { callOpenRouter } = await import('../llm/openrouter.js');

    vi.mocked(fetchReport).mockResolvedValue('# Test Report');
    vi.mocked(callOpenRouter).mockResolvedValue(
      '```json\n{"summary": "No actionable incidents detected.", "overall_severity": "NONE", "incidents": [], "findings": []}\n```'
    );

    const result = await classifyStage.run(mockInput, mockConfig);

    expect(result.status).toBe('success');
    expect(result.data).toBeDefined();
  });

  it('retries once on invalid JSON and succeeds if repair is valid', async () => {
    const { fetchReport } = await import('../report/fetchReport.js');
    const { callOpenRouter } = await import('../llm/openrouter.js');

    vi.mocked(fetchReport).mockResolvedValue('# Test Report');
    vi.mocked(callOpenRouter)
      .mockResolvedValueOnce('invalid json')
      .mockResolvedValueOnce(
        JSON.stringify({
          summary: 'No actionable incidents detected.',
          overall_severity: 'NONE',
          incidents: [],
          findings: [],
        })
      );

    const result = await classifyStage.run(mockInput, mockConfig);

    expect(result.status).toBe('success');
    expect(callOpenRouter).toHaveBeenCalledTimes(2);
  });

  it('returns fallback if retry is also invalid', async () => {
    const { fetchReport } = await import('../report/fetchReport.js');
    const { callOpenRouter } = await import('../llm/openrouter.js');

    vi.mocked(fetchReport).mockResolvedValue('# Test Report');
    vi.mocked(callOpenRouter)
      .mockResolvedValueOnce('invalid json')
      .mockResolvedValueOnce('still invalid');

    const result = await classifyStage.run(mockInput, mockConfig);

    expect(result.status).toBe('success');
    expect(result.data).toBeDefined();

    const data = result.data as { summary: string };
    expect(data.summary).toContain('Classification failed');
  });

  it('adds mandatory incidents when the LLM ignores active alarms, ALB 5xx, and detector liveness loss', async () => {
    const { fetchReport } = await import('../report/fetchReport.js');
    const { callOpenRouter } = await import('../llm/openrouter.js');

    vi.mocked(fetchReport).mockResolvedValue(`# Hokusai Service Health Report

- Window: last 24 hours
- Generated: \`2026-06-06T11:35:04.881055+00:00\`

## Service Details

### auth-service

| Alarm | State |
| --- | --- |
| \`hokusai-auth-development-task-health\` | \`ALARM\` |

### data-pipeline-api

_ALB dims: TargetGroup=\`targetgroup/hokusai-reg-api-development/abc123\` LoadBalancer=\`app/hokusai-reg-api-development/def456\`_

| ALB target | Requests | 2xx | 4xx | 5xx | Avg latency |
| --- | ---: | ---: | ---: | ---: | ---: |
| \`hokusai-reg-api-development\` | 56 | 5 | 28 | 23 | 0.244s |

### deltaone-anomaly-detection

> No datapoints from the detector's liveness metric in this window.
`);
    vi.mocked(callOpenRouter).mockResolvedValue(
      JSON.stringify({
        summary: 'No actionable incidents detected.',
        overall_severity: 'NONE',
        incidents: [],
        findings: [],
      })
    );

    const result = await classifyStage.run(mockInput, mockConfig);

    expect(result.status).toBe('success');
    const data = result.data as {
      overall_severity: string;
      report_context?: { window_start?: string; window_end?: string };
      incidents: Array<{
        title: string;
        classification: string;
        severity: string;
        signals: {
          alarms: string[];
          cloudwatch_metrics?: Array<{
            metric_name: string;
            dimensions: Array<{ name: string; value: string }>;
          }>;
        };
      }>;
    };

    expect(data.overall_severity).toBe('HIGH');
    expect(data.report_context).toEqual({
      window_label: 'last 24 hours',
      generated_at: '2026-06-06T11:35:04.881Z',
      window_start: '2026-06-05T11:35:04.881Z',
      window_end: '2026-06-06T11:35:04.881Z',
    });
    expect(data.incidents).toHaveLength(3);
    expect(data.incidents.map((incident) => incident.title)).toEqual(
      expect.arrayContaining([
        'Active alarm for auth-service: hokusai-auth-development-task-health',
        'ALB 5xx responses for data-pipeline-api',
        'No detector liveness datapoints for deltaone-anomaly-detection',
      ])
    );
    expect(data.incidents.find((incident) => incident.title.includes('auth-service'))?.signals.alarms).toEqual([
      'hokusai-auth-development-task-health',
    ]);
    expect(data.incidents.find((incident) => incident.title.includes('data-pipeline-api'))?.classification).toBe(
      'APPLICATION_ERROR'
    );
    expect(
      data.incidents.find((incident) => incident.title.includes('data-pipeline-api'))?.signals
        .cloudwatch_metrics
    ).toEqual([
      expect.objectContaining({
        metric_name: 'HTTPCode_Target_5XX_Count',
        dimensions: [
          { name: 'LoadBalancer', value: 'app/hokusai-reg-api-development/def456' },
          { name: 'TargetGroup', value: 'targetgroup/hokusai-reg-api-development/abc123' },
        ],
      }),
      expect.objectContaining({
        metric_name: 'HTTPCode_ELB_5XX_Count',
        dimensions: [{ name: 'LoadBalancer', value: 'app/hokusai-reg-api-development/def456' }],
      }),
    ]);
    expect(data.incidents.find((incident) => incident.title.includes('deltaone'))?.classification).toBe(
      'OBSERVABILITY_FAILURE'
    );
  });
});
