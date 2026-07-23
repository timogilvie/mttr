import { describe, expect, it, vi } from 'vitest';
import type { Config } from '../config.js';
import type {
  AgentStateRepository,
  AlertRecordInput,
  TriggerSource,
} from '../state/repository.js';
import type { IncidentTransition } from '../state/transitions.js';
import {
  AlertDeliveryError,
  sendMitigationProposalAlerts,
  sendSlackAlerts,
  slackDedupeKey,
  type SlackFetch,
} from '../alerts/slack.js';
import type { MitigationProposal } from '../types.js';

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
    monitoring: {
    intervalMs: 900000,
    sweep: { enabled: false, staleAfterMs: 21600000, maxIncidents: 3 },
  },
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

function repository(
  existingKeys = new Set<string>(),
  triggerSource?: TriggerSource
): {
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
      ...(triggerSource
        ? {
            async getRunTriggerSource() {
              return triggerSource;
            },
          }
        : {}),
    },
    alerts,
  };
}

function okFetch(bodies: string[] = []): SlackFetch {
  return vi.fn(async (_url, init) => {
    bodies.push(init.body);
    return {
      ok: true,
      status: 200,
      async text() {
        return 'ok';
      },
    };
  });
}

function sentPayload(bodies: string[]): Record<string, unknown> {
  return JSON.parse(bodies[0] ?? '{}') as Record<string, unknown>;
}

function contextText(payload: Record<string, unknown>): string {
  const blocks = payload['blocks'] as Array<{ type: string; elements?: Array<{ text?: string }> }>;
  const context = blocks.find((block) => block.type === 'context');
  return context?.elements?.map((element) => element.text ?? '').join('\n') ?? '';
}

describe('Slack alerts', () => {
  it('sends alertable transitions and persists the sent alert dedupe key', async () => {
    const { repo, alerts } = repository(new Set(), 'scheduled');
    const bodies: string[] = [];
    const fetchImpl = okFetch(bodies);
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
      payload: {
        text: '[HIGH] [scheduled] New incident: High 4xx',
      },
    });
    expect(contextText(sentPayload(bodies))).toContain('Trigger: scheduled');
  });

  it('marks alarm-triggered alerts visibly without changing the dedupe key', async () => {
    const { repo, alerts } = repository(new Set(), 'alarm');
    const bodies: string[] = [];
    const fetchImpl = okFetch(bodies);
    const item = transition();
    const beforeKey = slackDedupeKey('slack', item);

    const result = await sendSlackAlerts(config(), repo, 'run-1', [item], fetchImpl);

    expect(result[0]?.dedupeKey).toBe(beforeKey);
    expect(slackDedupeKey('slack', item)).toBe('slack:INC-001:new_incident:HIGH:MITIGATE');
    expect(sentPayload(bodies)['text']).toBe('[HIGH] [alarm] New incident: High 4xx');
    expect(contextText(sentPayload(bodies))).toContain('Trigger: ALARM triggered');
    expect(alerts[0]?.payload).toMatchObject({
      text: '[HIGH] [alarm] New incident: High 4xx',
    });
  });

  it('falls back to scheduled provenance when run metadata is unavailable', async () => {
    const { repo } = repository();
    const bodies: string[] = [];
    const fetchImpl = okFetch(bodies);

    await sendSlackAlerts(config(), repo, undefined, [transition()], fetchImpl);

    expect(sentPayload(bodies)['text']).toBe('[HIGH] [scheduled] New incident: High 4xx');
    expect(contextText(sentPayload(bodies))).toContain('Trigger: scheduled');
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

function proposal(overrides: Partial<MitigationProposal> = {}): MitigationProposal {
  return {
    incident_id: 'INC-001',
    title: 'High detector errors',
    action: 'Rotate the detector RPC credential.',
    action_kind: 'credential_rotation',
    target: { kind: 'lambda_function', identifier: 'hokusai-detector', region: 'us-east-1' },
    addresses_cause: 'Downstream auth failure.',
    cause_confidence: 0.86,
    evidence_refs: ['659 repeated 403 errors.'],
    proposal_confidence: 'high',
    evidence_gaps: ['Remote host unknown.'],
    preconditions: ['Confirm which credential the call uses.'],
    rollback_plan: ['Keep the old credential valid until confirmed.'],
    blast_radius: 'Every consumer of the credential.',
    reversibility: 'manual',
    success_signal: { description: 'Errors clear.', checks: [] },
    requires_human_approval: true,
    ...overrides,
  };
}

describe('mitigation proposal alerts', () => {
  it('sends a review-request payload leading with the action, and states nothing was executed', async () => {
    const { repo, alerts } = repository();
    const bodies: string[] = [];
    const fetchImpl = okFetch(bodies);

    const result = await sendMitigationProposalAlerts(config(), repo, 'run-1', [proposal()], fetchImpl);

    expect(result[0]?.status).toBe('sent');
    const payload = sentPayload(bodies);
    expect(payload['text']).toContain('mitigation proposed');
    const rendered = JSON.stringify(payload);
    expect(rendered).toContain('Rotate the detector RPC credential.');
    expect(rendered).toContain('manual');
    expect(rendered).toContain('No action has been taken');
    expect(rendered).toContain('/api/incidents/INC-001/brief');
    expect(alerts[0]?.dedupeKey).toBe(
      'slack:INC-001:mitigation_proposed:credential_rotation:hokusai-detector:high'
    );
  });

  it('does not alert for a no_action proposal but still returns a result', async () => {
    const { repo, alerts } = repository();
    const fetchImpl = okFetch();

    const result = await sendMitigationProposalAlerts(
      config(),
      repo,
      'run-1',
      [proposal({ action_kind: 'no_action', action: 'No mitigation recommended.' })],
      fetchImpl
    );

    expect(result[0]?.status).toBe('skipped');
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(alerts).toHaveLength(0);
  });

  it('dedupes an unchanged proposal on re-run', async () => {
    const existingKey =
      'slack:INC-001:mitigation_proposed:credential_rotation:hokusai-detector:high';
    const { repo } = repository(new Set([existingKey]));
    const fetchImpl = okFetch();

    const result = await sendMitigationProposalAlerts(config(), repo, 'run-2', [proposal()], fetchImpl);

    expect(result[0]?.status).toBe('deduped');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('skips delivery when no webhook is configured but the proposal is still persisted elsewhere', async () => {
    const { repo, alerts } = repository();
    const fetchImpl = okFetch();

    const noWebhook = config();
    delete (noWebhook.alerts.slack as { webhookUrl?: string }).webhookUrl;

    const result = await sendMitigationProposalAlerts(noWebhook, repo, 'run-1', [proposal()], fetchImpl);

    expect(result[0]?.status).toBe('skipped');
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(alerts).toHaveLength(0);
  });
});
