import { beforeEach, describe, expect, it, vi } from 'vitest';
import { extractAlarmNames, verify } from '../stages/verify.js';
import { dispatchToolCall } from '../tools/registry.js';
import type { Config } from '../config.js';
import type { DecisionResult } from '../types.js';

vi.mock('../tools/registry.js', () => ({
  dispatchToolCall: vi.fn(),
}));

const config: Config = {
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

function decision(overrides: Partial<DecisionResult['decisions'][number]> = {}): DecisionResult {
  return {
    summary: 'verify auth',
    overall_next_stage: 'Verify',
    handoff_notes: [],
    decisions: [
      {
        incident_id: 'INC-001',
        title: 'Active alarm for auth-service: hokusai-auth-development-task-health',
        disposition: 'VERIFY',
        next_stage: 'Verify',
        severity: 'HIGH',
        affected_services: ['hokusai-auth-development'],
        rationale: 'Possible incident without confirmed impact.',
        evidence_to_pass: ['alarm hokusai-auth-development-task-health entered ALARM.'],
        follow_up_actions: ['Check ALB access logs for client-visible 5xx.'],
        ...overrides,
      },
    ],
  };
}

describe('Verify stage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('extracts concrete alarm names from decision evidence', () => {
    expect(extractAlarmNames(decision().decisions[0]!)).toContain(
      'hokusai-auth-development-task-health'
    );
  });

  it('marks passed checks as a recovered transient and does not mitigate', async () => {
    vi.mocked(dispatchToolCall)
      .mockResolvedValueOnce(
        'Found 1 alarm(s):\nalarm=hokusai-auth-development-task-health, state=OK'
      )
      .mockResolvedValueOnce('Deployments:\n  PRIMARY desired=1 running=1 failed=0')
      .mockResolvedValueOnce('Scanned 1 of 1 candidate file(s); 20 request(s) in window, 0 matching the status filter.');

    const result = await verify(config, decision());

    expect(result.overall_status).toBe('VERIFIED_RECOVERED_TRANSIENT');
    expect(result.overall_next_stage).toBe('None');
    expect(result.verifications[0]?.recommended_next_stage).toBe('None');
  });

  it('routes current alarm failure to Mitigate', async () => {
    vi.mocked(dispatchToolCall)
      .mockResolvedValueOnce(
        'Found 1 alarm(s):\nalarm=hokusai-auth-development-task-health, state=ALARM'
      )
      .mockResolvedValueOnce('Deployments:\n  PRIMARY desired=1 running=1 failed=0')
      .mockResolvedValueOnce('Scanned 1 of 1 candidate file(s); 20 request(s) in window, 0 matching the status filter.');

    const result = await verify(config, decision());

    expect(result.overall_status).toBe('VERIFIED_ACTIVE_INCIDENT');
    expect(result.overall_next_stage).toBe('Mitigate');
    expect(result.verifications[0]?.checks[0]?.status).toBe('failed');
  });

  it('keeps tool failures inconclusive instead of closing', async () => {
    vi.mocked(dispatchToolCall)
      .mockResolvedValueOnce('Error: tool "find_alarms" failed: denied')
      .mockResolvedValueOnce('Deployments:\n  PRIMARY desired=1 running=1 failed=0')
      .mockResolvedValueOnce('No load balancer found with name "hokusai-auth-development".');

    const result = await verify(config, decision());

    expect(result.overall_status).toBe('STILL_INCONCLUSIVE');
    expect(result.overall_next_stage).toBe('Investigate');
  });
});
