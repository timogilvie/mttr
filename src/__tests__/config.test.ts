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

  it('applies investigate, tools, and rate-limit defaults when unset', () => {
    process.env['OPENROUTER_API_KEY'] = 'test-key';
    for (const key of [
      'INVESTIGATE_MODEL',
      'INVESTIGATE_MODEL_FALLBACK',
      'INVESTIGATE_MAX_TOOL_ITERATIONS',
      'INVESTIGATE_MAX_TOOL_CALLS',
      'INVESTIGATE_CONSECUTIVE_FAILURE_LIMIT',
      'INVESTIGATE_LLM_TIMEOUT_MS',
      'TOOL_TIMEOUT_MS',
      'TOOL_RESULT_MAX_CHARS',
      'TOOL_DEFAULT_LOOKBACK_MINUTES',
      'TOOL_MAX_LOOKBACK_MINUTES',
      'TOOL_MAX_CONCURRENCY',
      'OPENROUTER_MAX_RETRIES',
      'OPENROUTER_BACKOFF_BASE_MS',
      'OPENROUTER_BACKOFF_MAX_MS',
      'AWS_MAX_ATTEMPTS',
    ]) {
      delete process.env[key];
    }

    const config = loadConfig();

    expect(config.investigate.model).toBe('openai/gpt-5.4');
    expect(config.investigate.modelFallback).toBe('anthropic/claude-3.5-sonnet');
    expect(config.investigate.maxToolIterations).toBe(6);
    expect(config.investigate.maxToolCalls).toBe(12);
    expect(config.investigate.consecutiveFailureLimit).toBe(3);
    expect(config.investigate.llmTimeoutMs).toBe(120000);
    expect(config.tools.timeoutMs).toBe(20000);
    expect(config.tools.resultMaxChars).toBe(8000);
    expect(config.tools.defaultLookbackMinutes).toBe(60);
    expect(config.tools.maxLookbackMinutes).toBe(1440);
    expect(config.tools.maxConcurrency).toBe(2);
    expect(config.openrouter.maxRetries).toBe(4);
    expect(config.openrouter.backoffBaseMs).toBe(1000);
    expect(config.openrouter.backoffMaxMs).toBe(30000);
    expect(config.aws.maxAttempts).toBe(5);
  });

  it('reads investigate model overrides from env', () => {
    process.env['OPENROUTER_API_KEY'] = 'test-key';
    process.env['INVESTIGATE_MODEL'] = 'custom/model';
    process.env['INVESTIGATE_MODEL_FALLBACK'] = 'custom/fallback';

    const config = loadConfig();

    expect(config.investigate.model).toBe('custom/model');
    expect(config.investigate.modelFallback).toBe('custom/fallback');
  });

  it('non-numeric investigate budget throws with variable name', () => {
    process.env['OPENROUTER_API_KEY'] = 'test-key';
    process.env['INVESTIGATE_MAX_TOOL_CALLS'] = 'lots';

    expect(() => loadConfig()).toThrow('INVESTIGATE_MAX_TOOL_CALLS');
  });

  it('non-numeric AWS_MAX_ATTEMPTS throws with variable name', () => {
    process.env['OPENROUTER_API_KEY'] = 'test-key';
    process.env['AWS_MAX_ATTEMPTS'] = 'five';

    expect(() => loadConfig()).toThrow('AWS_MAX_ATTEMPTS');
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
