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
    expect(config.monitoring.intervalMs).toBe(900000);
    expect(config.state.path).toBe('.mttr-state.json');
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
      'INVESTIGATE_CLOSURE_ENABLED',
      'INVESTIGATE_CLOSURE_MAX_TOOL_ITERATIONS',
      'INVESTIGATE_CLOSURE_MAX_TOOL_CALLS',
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
      'STATE_BACKEND',
      'AGENT_STATE_PATH',
      'DATABASE_URL',
      'POOLED_DATABASE_URL',
      'DATABASE_SSL',
      'DATABASE_MAX_CONNECTIONS',
      'DATABASE_IDLE_TIMEOUT_MS',
      'SLACK_WEBHOOK_URL',
      'SLACK_ALERT_CHANNEL',
      'SLACK_ALERT_TIMEOUT_MS',
    ]) {
      delete process.env[key];
    }

    const config = loadConfig();

    expect(config.investigate.model).toBe('openai/gpt-5.4');
    expect(config.investigate.modelFallback).toBe('anthropic/claude-3.5-sonnet');
    expect(config.investigate.maxToolIterations).toBe(6);
    expect(config.investigate.maxToolCalls).toBe(12);
    expect(config.investigate.closureEnabled).toBe(true);
    expect(config.investigate.closureMaxToolIterations).toBe(2);
    expect(config.investigate.closureMaxToolCalls).toBe(3);
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
    expect(config.state.backend).toBe('file');
    expect(config.state.path).toBe('.mttr-state.json');
    expect(config.database.url).toBeUndefined();
    expect(config.database.runtimeUrl).toBeUndefined();
    expect(config.database.ssl).toBe(false);
    expect(config.database.maxConnections).toBe(4);
    expect(config.database.idleTimeoutMs).toBe(30000);
    expect(config.alerts.slack.webhookUrl).toBeUndefined();
    expect(config.alerts.slack.channel).toBe('slack');
    expect(config.alerts.slack.timeoutMs).toBe(10000);
  });

  it('reads Slack alert settings from env', () => {
    process.env['OPENROUTER_API_KEY'] = 'test-key';
    process.env['SLACK_WEBHOOK_URL'] = 'https://hooks.slack.test/services/secret';
    process.env['SLACK_ALERT_CHANNEL'] = 'mttr-alerts';
    process.env['SLACK_ALERT_TIMEOUT_MS'] = '5000';

    const config = loadConfig();

    expect(config.alerts.slack.webhookUrl).toBe('https://hooks.slack.test/services/secret');
    expect(config.alerts.slack.channel).toBe('mttr-alerts');
    expect(config.alerts.slack.timeoutMs).toBe(5000);
  });

  it('reads postgres state backend and database settings from env', () => {
    process.env['OPENROUTER_API_KEY'] = 'test-key';
    process.env['STATE_BACKEND'] = 'postgres';
    process.env['DATABASE_URL'] = 'postgres://user:pass@localhost:5432/mttr';
    process.env['DATABASE_SSL'] = 'true';
    process.env['DATABASE_MAX_CONNECTIONS'] = '8';
    process.env['DATABASE_IDLE_TIMEOUT_MS'] = '45000';

    const config = loadConfig();

    expect(config.state.backend).toBe('postgres');
    expect(config.database.url).toBe('postgres://user:pass@localhost:5432/mttr');
    expect(config.database.runtimeUrl).toBe('postgres://user:pass@localhost:5432/mttr');
    expect(config.database.ssl).toBe(true);
    expect(config.database.maxConnections).toBe(8);
    expect(config.database.idleTimeoutMs).toBe(45000);
  });

  it('uses pooled database URL for runtime connections when provided', () => {
    process.env['OPENROUTER_API_KEY'] = 'test-key';
    process.env['STATE_BACKEND'] = 'postgres';
    process.env['DATABASE_URL'] = 'postgres://user:pass@direct.example.com:5432/mttr';
    process.env['POOLED_DATABASE_URL'] = 'postgres://user:pass@pooler.example.com:5432/mttr';

    const config = loadConfig();

    expect(config.database.url).toBe('postgres://user:pass@direct.example.com:5432/mttr');
    expect(config.database.runtimeUrl).toBe('postgres://user:pass@pooler.example.com:5432/mttr');
  });

  it('requires DATABASE_URL when postgres state backend is enabled', () => {
    process.env['OPENROUTER_API_KEY'] = 'test-key';
    process.env['STATE_BACKEND'] = 'postgres';
    delete process.env['DATABASE_URL'];

    expect(() => loadConfig()).toThrow('DATABASE_URL');
  });

  it('rejects unknown state backends', () => {
    process.env['OPENROUTER_API_KEY'] = 'test-key';
    process.env['STATE_BACKEND'] = 'redis';

    expect(() => loadConfig()).toThrow('STATE_BACKEND');
  });

  it('reads investigate model overrides from env', () => {
    process.env['OPENROUTER_API_KEY'] = 'test-key';
    process.env['INVESTIGATE_MODEL'] = 'custom/model';
    process.env['INVESTIGATE_MODEL_FALLBACK'] = 'custom/fallback';

    const config = loadConfig();

    expect(config.investigate.model).toBe('custom/model');
    expect(config.investigate.modelFallback).toBe('custom/fallback');
  });

  it('reads investigate closure overrides from env', () => {
    process.env['OPENROUTER_API_KEY'] = 'test-key';
    process.env['INVESTIGATE_CLOSURE_ENABLED'] = 'false';
    process.env['INVESTIGATE_CLOSURE_MAX_TOOL_ITERATIONS'] = '1';
    process.env['INVESTIGATE_CLOSURE_MAX_TOOL_CALLS'] = '2';

    const config = loadConfig();

    expect(config.investigate.closureEnabled).toBe(false);
    expect(config.investigate.closureMaxToolIterations).toBe(1);
    expect(config.investigate.closureMaxToolCalls).toBe(2);
  });

  it('non-numeric investigate budget throws with variable name', () => {
    process.env['OPENROUTER_API_KEY'] = 'test-key';
    process.env['INVESTIGATE_MAX_TOOL_CALLS'] = 'lots';

    expect(() => loadConfig()).toThrow('INVESTIGATE_MAX_TOOL_CALLS');
  });

  it('invalid investigate closure boolean throws with variable name', () => {
    process.env['OPENROUTER_API_KEY'] = 'test-key';
    process.env['INVESTIGATE_CLOSURE_ENABLED'] = 'maybe';

    expect(() => loadConfig()).toThrow('INVESTIGATE_CLOSURE_ENABLED');
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
    expect(config.monitoring.intervalMs).toBe(900000);
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

  describe('alarm', () => {
    beforeEach(() => {
      process.env['OPENROUTER_API_KEY'] = 'test-key';
      for (const key of [
        'ALARM_WEBHOOK_ENABLED',
        'ALARM_WEBHOOK_PATH_TOKEN',
        'ALARM_WEBHOOK_VERIFY_SIGNATURE',
        'ALARM_WEBHOOK_AUTOCONFIRM',
        'ALARM_TRIGGER_MIN_SEVERITY',
        'ALARM_TRIGGER_COOLDOWN_MS',
        'ALARM_TRIGGER_POLL_MS',
        'ALARM_TRIGGER_COALESCE_MS',
      ]) {
        delete process.env[key];
      }
    });

    it('applies ship-dark defaults when unset', () => {
      const config = loadConfig();

      expect(config.alarm.webhook.enabled).toBe(false);
      expect(config.alarm.webhook.pathToken).toBeUndefined();
      expect(config.alarm.webhook.verifySignature).toBe(true);
      expect(config.alarm.webhook.autoconfirm).toBe(true);
      expect(config.alarm.trigger.minSeverity).toBe('CRITICAL');
      expect(config.alarm.trigger.cooldownMs).toBe(600000);
      expect(config.alarm.trigger.pollMs).toBe(5000);
      expect(config.alarm.trigger.coalesceMs).toBe(2000);
    });

    it('reads explicit overrides for all alarm vars', () => {
      process.env['ALARM_WEBHOOK_ENABLED'] = 'true';
      process.env['ALARM_WEBHOOK_PATH_TOKEN'] = 'super-secret-token';
      process.env['ALARM_WEBHOOK_VERIFY_SIGNATURE'] = 'false';
      process.env['ALARM_WEBHOOK_AUTOCONFIRM'] = 'false';
      process.env['ALARM_TRIGGER_MIN_SEVERITY'] = 'HIGH';
      process.env['ALARM_TRIGGER_COOLDOWN_MS'] = '120000';
      process.env['ALARM_TRIGGER_POLL_MS'] = '1000';
      process.env['ALARM_TRIGGER_COALESCE_MS'] = '500';

      const config = loadConfig();

      expect(config.alarm.webhook.enabled).toBe(true);
      expect(config.alarm.webhook.pathToken).toBe('super-secret-token');
      expect(config.alarm.webhook.verifySignature).toBe(false);
      expect(config.alarm.webhook.autoconfirm).toBe(false);
      expect(config.alarm.trigger.minSeverity).toBe('HIGH');
      expect(config.alarm.trigger.cooldownMs).toBe(120000);
      expect(config.alarm.trigger.pollMs).toBe(1000);
      expect(config.alarm.trigger.coalesceMs).toBe(500);
    });

    it('normalizes severity case-insensitively', () => {
      process.env['ALARM_TRIGGER_MIN_SEVERITY'] = 'medium';

      const config = loadConfig();

      expect(config.alarm.trigger.minSeverity).toBe('MEDIUM');
    });

    it('rejects an invalid severity, naming the var and accepted values', () => {
      process.env['ALARM_TRIGGER_MIN_SEVERITY'] = 'banana';

      expect(() => loadConfig()).toThrow(/ALARM_TRIGGER_MIN_SEVERITY/);
      expect(() => loadConfig()).toThrow(/NONE, LOW, MEDIUM, HIGH, CRITICAL/);
    });

    it('rejects an invalid ALARM_WEBHOOK_ENABLED boolean', () => {
      process.env['ALARM_WEBHOOK_ENABLED'] = 'maybe';

      expect(() => loadConfig()).toThrow('ALARM_WEBHOOK_ENABLED');
    });

    it('rejects a non-numeric ALARM_TRIGGER_POLL_MS', () => {
      process.env['ALARM_TRIGGER_POLL_MS'] = 'soon';

      expect(() => loadConfig()).toThrow('ALARM_TRIGGER_POLL_MS');
    });

    it('rejects a negative ALARM_TRIGGER_COOLDOWN_MS, naming the variable', () => {
      process.env['ALARM_TRIGGER_COOLDOWN_MS'] = '-1';

      expect(() => loadConfig()).toThrow(/ALARM_TRIGGER_COOLDOWN_MS/);
      expect(() => loadConfig()).toThrow(/non-negative/);
    });

    it('loads without a path token when the webhook is disabled (ships dark)', () => {
      delete process.env['ALARM_WEBHOOK_ENABLED'];
      delete process.env['ALARM_WEBHOOK_PATH_TOKEN'];

      const config = loadConfig();

      expect(config.alarm.webhook.enabled).toBe(false);
      expect(config.alarm.webhook.pathToken).toBeUndefined();
    });

    it('requires a path token when the webhook is enabled, without leaking any token value', () => {
      process.env['ALARM_WEBHOOK_ENABLED'] = 'true';
      delete process.env['ALARM_WEBHOOK_PATH_TOKEN'];

      expect(() => loadConfig()).toThrow(
        'ALARM_WEBHOOK_PATH_TOKEN is required when ALARM_WEBHOOK_ENABLED=true'
      );
    });
  });
});
