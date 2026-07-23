import type { Config } from '../config.js';
import type { AgentStateRepository, TriggerSource } from '../state/repository.js';
import type { IncidentTransition } from '../state/transitions.js';
import type { MitigationProposal } from '../types.js';

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

export function mitigationDedupeKey(channel: string, proposal: MitigationProposal): string {
  // Keyed on what the proposal actually asks for, so a re-run that reaches the same conclusion is
  // silent while a changed recommendation alerts again.
  return [
    channel,
    proposal.incident_id,
    'mitigation_proposed',
    proposal.action_kind,
    proposal.target.identifier,
    proposal.proposal_confidence,
  ].join(':');
}

function bullets(items: string[], limit = 4): string {
  return items
    .slice(0, limit)
    .map((item) => `• ${item}`)
    .join('\n');
}

/**
 * A proposal notification is a request for a human decision, so the payload leads with the action
 * and puts the two things that gate approval — blast radius and reversibility — directly beneath
 * it, rather than burying them under evidence.
 */
function mitigationPayload(
  proposal: MitigationProposal,
  briefPath: string
): Record<string, unknown> {
  const confidence =
    proposal.cause_confidence === null
      ? proposal.proposal_confidence
      : `${proposal.proposal_confidence} (cause ${proposal.cause_confidence.toFixed(2)})`;

  const sections: Array<Record<string, unknown>> = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Mitigation proposed — needs review*\n${proposal.title}`,
      },
    },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `*Action* (${proposal.action_kind})\n${proposal.action}` },
    },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*Target*\n${proposal.target.kind}: ${proposal.target.identifier}` },
        { type: 'mrkdwn', text: `*Reversibility*\n${proposal.reversibility}` },
        { type: 'mrkdwn', text: `*Confidence*\n${confidence}` },
        { type: 'mrkdwn', text: `*Blast radius*\n${proposal.blast_radius}` },
      ],
    },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `*Addresses*\n${proposal.addresses_cause}` },
    },
  ];

  if (proposal.preconditions.length > 0) {
    sections.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `*Check first*\n${bullets(proposal.preconditions)}` },
    });
  }
  if (proposal.evidence_gaps.length > 0) {
    sections.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `*Evidence gaps*\n${bullets(proposal.evidence_gaps, 3)}` },
    });
  }

  sections.push({
    type: 'context',
    elements: [
      {
        type: 'mrkdwn',
        text:
          `No action has been taken — this agent cannot execute changes. ` +
          `Incident: ${proposal.incident_id} | Full brief: ${briefPath}`,
      },
    ],
  });

  return {
    text: `[mitigation proposed] ${proposal.title}: ${proposal.action}`,
    blocks: sections,
  };
}

/**
 * Delivers mitigation proposals for human review. Sends nothing and changes nothing when no
 * webhook is configured; the proposal is still persisted and visible on the incident page.
 */
export async function sendMitigationProposalAlerts(
  config: Config,
  repository: AgentStateRepository,
  runId: string | undefined,
  proposals: MitigationProposal[],
  fetchImpl: SlackFetch = fetch
): Promise<AlertDeliveryResult[]> {
  const webhookUrl = config.alerts.slack.webhookUrl;
  const channel = config.alerts.slack.channel;
  const results: AlertDeliveryResult[] = [];

  for (const proposal of proposals) {
    const dedupeKey = mitigationDedupeKey(channel, proposal);

    // "Nothing to do" is worth recording but not worth interrupting anyone for.
    if (!webhookUrl || proposal.action_kind === 'no_action') {
      results.push({ incidentId: proposal.incident_id, dedupeKey, status: 'skipped' });
      continue;
    }

    if (await repository.hasAlert?.(dedupeKey)) {
      results.push({ incidentId: proposal.incident_id, dedupeKey, status: 'deduped' });
      continue;
    }

    const payload = mitigationPayload(
      proposal,
      `/api/incidents/${encodeURIComponent(proposal.incident_id)}/brief`
    );
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
        `Slack mitigation alert failed with HTTP ${response.status}: ${body}`,
        dedupeKey,
        response.status >= 500 || response.status === 429
      );
    }

    await repository.recordAlertSent?.({
      incidentId: proposal.incident_id,
      runId,
      channel,
      dedupeKey,
      payload,
    });
    results.push({ incidentId: proposal.incident_id, dedupeKey, status: 'sent' });
  }

  return results;
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
