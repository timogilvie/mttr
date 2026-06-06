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
  },
  healthReport: {
    s3Uri: 's3://test/report.md',
  },
  aws: {
    region: 'us-east-1',
  },
  monitoring: {
    intervalMs: 5000,
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
});
