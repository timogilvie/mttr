import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadConfig } from '../config.js';

describe('config', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('loads config with required env vars', () => {
    process.env['OPENROUTER_API_KEY'] = 'test-key';

    const config = loadConfig();

    expect(config.openrouter.apiKey).toBe('test-key');
    expect(config.openrouter.model).toBe('openai/gpt-4o-mini');
    expect(config.openrouter.baseUrl).toBe('https://openrouter.ai/api/v1');
    expect(config.healthReport.s3Uri).toBe(
      's3://hokusai-health-reports-development/latest/development/report.md'
    );
    expect(config.aws.region).toBe('us-east-1');
    expect(config.monitoring.intervalMs).toBe(300000);
    expect(config.timeouts.llmMs).toBe(60000);
    expect(config.timeouts.s3Ms).toBe(15000);
  });

  it('missing OPENROUTER_API_KEY throws', () => {
    delete process.env['OPENROUTER_API_KEY'];

    expect(() => loadConfig()).toThrow('OPENROUTER_API_KEY');
  });

  it('applies defaults when optional vars are absent', () => {
    process.env['OPENROUTER_API_KEY'] = 'test-key';
    delete process.env['OPENROUTER_MODEL'];
    delete process.env['MONITOR_INTERVAL_MS'];

    const config = loadConfig();

    expect(config.openrouter.model).toBe('openai/gpt-4o-mini');
    expect(config.monitoring.intervalMs).toBe(300000);
  });

  it('non-numeric interval throws with variable name', () => {
    process.env['OPENROUTER_API_KEY'] = 'test-key';
    process.env['MONITOR_INTERVAL_MS'] = 'not-a-number';

    expect(() => loadConfig()).toThrow('MONITOR_INTERVAL_MS');
  });

  it('non-numeric timeout throws with variable name', () => {
    process.env['OPENROUTER_API_KEY'] = 'test-key';
    process.env['LLM_TIMEOUT_MS'] = 'invalid';

    expect(() => loadConfig()).toThrow('LLM_TIMEOUT_MS');
  });
});
