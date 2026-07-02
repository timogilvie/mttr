import { describe, expect, it, vi } from 'vitest';
import type { Config } from '../config.js';
import type { AgentStateRepository, AlertRecordInput } from '../state/repository.js';
import type { IncidentTransition } from '../state/transitions.js';
import {
  AlertDeliveryError,
  sendSlackAlerts,
  slackDedupeKey,
  type SlackFetch,
} from '../alerts/slack.js';

function config(overrides: Partial<Config['alerts']['slack']> = {}): Config {
  return {
    openrouter: {
      apiKey: 'test-key',
      model: 'test-model',
      baseUrl: 'https://test.com',
      maxRetries: 1,
      backoffBaseMs: 1,
      backoffMaxMs: 1,
    },
    investigate: {
      model: 'test-model',
      modelFallback: 'fallback-model',
      maxToolIterations: 1,
      maxToolCalls: 1,
      closureEnabled: true,
      closureMaxToolIterations: 1,
      closureMaxToolCalls: 1,
      consecutiveFailureLimit: 3,
      llmTimeoutMs: 1000,
    },
    tools: {
      timeoutMs: 1000,
      resultMaxChars: 1000,
      defaultLookbackMinutes: 60,
      maxLookbackMinutes: 1440,
      maxConcurrency: 1,
    },
    healthReport: { s3Uri: 's3://test/report.md' },
    aws: { region: 'us-east-1', maxAttempts: 1 },
    monitoring: { intervalMs: 900000 },
    state: { backend: 'postgres', path: '.mttr-state.json' },
    database: { ssl: false, maxConnections: 1, idleTimeoutMs: 1000 },
    alerts: {
      slack: {
        webhookUrl: 'https://hooks.slack.test/services/secret',
        channel: 'slack',
        timeoutMs: 1000,
        ...overrides,
      },
    },
    timeouts: { llmMs: 1000, s3Ms: 1000 },
    alarm: {
      webhook: { enabled: false, verifySignature: true, autoconfirm: true },
      trigger: { minSeverity: 'CRITICAL', cooldownMs: 600000, pollMs: 5000, coalesceMs: 2000 },
    },
  };
}

function transition(overrides: Partial<IncidentTransition> = {}): IncidentTransition {
  return {
    incidentId: 'INC-001',
    title: 'High 4xx',
    transitionType: 'new_incident',
    alertable: true,
    severity: 'HIGH',
    service: 'data-pipeline-api',
    message: 'New incident: High 4xx',
    evidence: {
      transition_type: 'new_incident',
      alertable: true,
      disposition: 'MITIGATE',
    },
    ...overrides,
  };
}

function repository(existingKeys = new Set<string>()): {
  repo: AgentStateRepository;
  alerts: AlertRecordInput[];
} {
  const alerts: AlertRecordInput[] = [];
  return {
    repo: {
      async load() {
        return { version: 1, observations: {} };
      },
      async save() {
        return;
      },
      async hasAlert(dedupeKey: string) {
        return existingKeys.has(dedupeKey);
      },
      async recordAlertSent(alert: AlertRecordInput) {
        existingKeys.add(alert.dedupeKey);
        alerts.push(alert);
      },
    },
    alerts,
  };
}

function okFetch(): SlackFetch {
  return vi.fn(async () => ({
    ok: true,
    status: 200,
    async text() {
      return 'ok';
    },
  }));
}

describe('Slack alerts', () => {
  it('sends alertable transitions and persists the sent alert dedupe key', async () => {
    const { repo, alerts } = repository();
    const fetchImpl = okFetch();
    const item = transition();

    const result = await sendSlackAlerts(config(), repo, 'run-1', [item], fetchImpl);

    expect(result).toEqual([
      {
        incidentId: 'INC-001',
        dedupeKey: 'slack:INC-001:new_incident:HIGH:MITIGATE',
        status: 'sent',
      },
    ]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://hooks.slack.test/services/secret',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      })
    );
    expect(alerts[0]).toMatchObject({
      incidentId: 'INC-001',
      runId: 'run-1',
      channel: 'slack',
      dedupeKey: 'slack:INC-001:new_incident:HIGH:MITIGATE',
    });
  });

  it('dedupes alerts before sending to Slack', async () => {
    const item = transition();
    const existingKey = slackDedupeKey('slack', item);
    const { repo, alerts } = repository(new Set([existingKey]));
    const fetchImpl = okFetch();

    const result = await sendSlackAlerts(config(), repo, 'run-1', [item], fetchImpl);

    expect(result[0]).toMatchObject({ dedupeKey: existingKey, status: 'deduped' });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(alerts).toHaveLength(0);
  });

  it('does not persist failed retryable deliveries', async () => {
    const { repo, alerts } = repository();
    const fetchImpl: SlackFetch = vi.fn(async () => ({
      ok: false,
      status: 503,
      async text() {
        return 'temporarily unavailable';
      },
    }));

    await expect(
      sendSlackAlerts(config(), repo, 'run-1', [transition()], fetchImpl)
    ).rejects.toMatchObject({
      retryable: true,
      name: 'AlertDeliveryError',
    } satisfies Partial<AlertDeliveryError>);
    expect(alerts).toHaveLength(0);
  });

  it('skips unchanged transitions without sending or persisting alerts', async () => {
    const { repo, alerts } = repository();
    const fetchImpl = okFetch();

    const result = await sendSlackAlerts(
      config(),
      repo,
      'run-1',
      [
        transition({
          transitionType: 'unchanged',
          alertable: false,
          evidence: { transition_type: 'unchanged', alertable: false },
        }),
      ],
      fetchImpl
    );

    expect(result[0]?.status).toBe('skipped');
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(alerts).toHaveLength(0);
  });
});
