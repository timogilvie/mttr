import type { Config } from '../config.js';
import type { AgentStateRepository, TriggerSource } from '../state/repository.js';
import type { IncidentTransition } from '../state/transitions.js';

interface FetchResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}

export type SlackFetch = (
  url: string,
  init: {
    method: 'POST';
    headers: Record<string, string>;
    body: string;
    signal?: AbortSignal;
  }
) => Promise<FetchResponse>;

export interface AlertDeliveryResult {
  incidentId: string;
  dedupeKey: string;
  status: 'sent' | 'deduped' | 'skipped';
}

export class AlertDeliveryError extends Error {
  constructor(
    message: string,
    readonly dedupeKey: string,
    readonly retryable: boolean
  ) {
    super(message);
    this.name = 'AlertDeliveryError';
  }
}

const ALERTABLE_TRANSITIONS = new Set<IncidentTransition['transitionType']>([
  'new_incident',
  'severity_increased',
  'ready_for_mitigation',
  'verified_active',
  'recovered',
  'closed',
]);

function dispositionForDedupe(transition: IncidentTransition): string {
  const disposition = transition.evidence['disposition'] ?? transition.evidence['status'] ?? 'none';
  return String(disposition);
}

async function triggerSourceForAlert(
  repository: AgentStateRepository,
  runId: string | undefined
): Promise<TriggerSource> {
  if (!runId || !repository.getRunTriggerSource) {
    return 'scheduled';
  }

  try {
    return (await repository.getRunTriggerSource(runId)) ?? 'scheduled';
  } catch {
    return 'scheduled';
  }
}

export function slackDedupeKey(channel: string, transition: IncidentTransition): string {
  return [
    channel,
    transition.incidentId,
    transition.transitionType,
    transition.severity,
    dispositionForDedupe(transition),
  ].join(':');
}

function slackPayload(
  transition: IncidentTransition,
  triggerSource: TriggerSource
): Record<string, unknown> {
  const provenanceLabel = triggerSource === 'alarm' ? 'ALARM triggered' : 'scheduled';
  return {
    text: `[${transition.severity}] [${triggerSource}] ${transition.message}`,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*${transition.transitionType}* ${transition.title}`,
        },
      },
      {
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text:
              `Incident: ${transition.incidentId} | Severity: ${transition.severity}` +
              ` | Trigger: ${provenanceLabel}` +
              (transition.service ? ` | Service: ${transition.service}` : ''),
          },
        ],
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: transition.message,
        },
      },
    ],
  };
}

function timeoutSignal(timeoutMs: number): AbortSignal | undefined {
  if (typeof AbortSignal === 'undefined' || typeof AbortSignal.timeout !== 'function') {
    return undefined;
  }
  return AbortSignal.timeout(timeoutMs);
}

export async function sendSlackAlerts(
  config: Config,
  repository: AgentStateRepository,
  runId: string | undefined,
  transitions: IncidentTransition[],
  fetchImpl: SlackFetch = fetch
): Promise<AlertDeliveryResult[]> {
  const webhookUrl = config.alerts.slack.webhookUrl;
  if (!webhookUrl) {
    return transitions.map((transition) => ({
      incidentId: transition.incidentId,
      dedupeKey: slackDedupeKey(config.alerts.slack.channel, transition),
      status: 'skipped',
    }));
  }

  const results: AlertDeliveryResult[] = [];
  let triggerSource: TriggerSource | undefined;
  for (const transition of transitions) {
    const dedupeKey = slackDedupeKey(config.alerts.slack.channel, transition);
    if (!transition.alertable || !ALERTABLE_TRANSITIONS.has(transition.transitionType)) {
      results.push({ incidentId: transition.incidentId, dedupeKey, status: 'skipped' });
      continue;
    }

    if (await repository.hasAlert?.(dedupeKey)) {
      results.push({ incidentId: transition.incidentId, dedupeKey, status: 'deduped' });
      continue;
    }

    triggerSource ??= await triggerSourceForAlert(repository, runId);
    const payload = slackPayload(transition, triggerSource);
    const signal = timeoutSignal(config.alerts.slack.timeoutMs);
    const response = await fetchImpl(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      ...(signal ? { signal } : {}),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new AlertDeliveryError(
        `Slack alert failed with HTTP ${response.status}: ${body}`,
        dedupeKey,
        response.status >= 500 || response.status === 429
      );
    }

    await repository.recordAlertSent?.({
      incidentId: transition.incidentId,
      runId,
      channel: config.alerts.slack.channel,
      dedupeKey,
      payload,
    });
    results.push({ incidentId: transition.incidentId, dedupeKey, status: 'sent' });
  }

  return results;
}
