import type { MitigationProposal } from '../../types.js';
import type { IncidentSummary, TransitionEvent } from './statusTypes.js';
import { deriveOperatorReadout } from './operatorReadout.js';

/**
 * Renders an incident as a self-contained markdown handoff document.
 *
 * The agent already produces good root-cause work — ranked hypotheses with confidence scores, and
 * unresolved evidence requirements that name the exact tool call which would close the gap — but
 * none of it left the database in a form a human or another agent could pick up. This is that
 * form: everything needed to continue the investigation, in one copy-pasteable block.
 */
export interface IncidentBriefInput {
  incident: IncidentSummary;
  events: TransitionEvent[];
  /** The incident's current (non-superseded) mitigation proposal, if one exists. */
  proposal?: MitigationProposal | null;
  /** Injected so output is deterministic in tests. */
  now?: Date;
}

function proposalSection(proposal: MitigationProposal): string[] {
  const confidence =
    proposal.cause_confidence === null
      ? proposal.proposal_confidence
      : `${proposal.proposal_confidence} (cause ${proposal.cause_confidence.toFixed(2)})`;
  return [
    '## Proposed mitigation (needs human approval — not executed)',
    '',
    `**Action** (${proposal.action_kind}): ${proposal.action}`,
    '',
    `- **Target**: ${proposal.target.kind} \`${proposal.target.identifier}\``,
    `- **Addresses**: ${proposal.addresses_cause}`,
    `- **Confidence**: ${confidence}`,
    `- **Reversibility**: ${proposal.reversibility}`,
    `- **Blast radius**: ${proposal.blast_radius}`,
    ...(proposal.preconditions.length > 0
      ? ['', '_Check first:_', ...proposal.preconditions.map((item) => `- ${item}`)]
      : []),
    ...(proposal.rollback_plan.length > 0
      ? ['', '_Rollback:_', ...proposal.rollback_plan.map((item) => `- ${item}`)]
      : []),
    ...(proposal.success_signal.description
      ? ['', `_Success signal:_ ${proposal.success_signal.description}`]
      : []),
    '',
  ];
}

function relativeAge(value: string | null | undefined, nowMs: number): string {
  if (!value) {
    return 'unknown';
  }
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) {
    return 'unknown';
  }
  const minutes = Math.floor(Math.max(0, nowMs - timestamp) / 60000);
  if (minutes < 1) {
    return 'just now';
  }
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 48) {
    return `${hours}h ago`;
  }
  return `${Math.floor(hours / 24)}d ago`;
}

function stamp(value: string | null | undefined, nowMs: number): string {
  return value ? `${value} (${relativeAge(value, nowMs)})` : 'unknown';
}

function section(title: string, lines: string[]): string[] {
  return lines.length === 0 ? [] : [`## ${title}`, '', ...lines, ''];
}

function bullets(items: string[]): string[] {
  return items.map((item) => `- ${item}`);
}

export function buildIncidentBrief({
  incident,
  events,
  proposal,
  now,
}: IncidentBriefInput): string {
  const nowMs = (now ?? new Date()).getTime();
  const readout = deriveOperatorReadout(incident, events);

  const facts = [
    `- **Incident ID**: \`${incident.incidentId}\``,
    `- **Service**: ${incident.service ?? 'unknown'}`,
    `- **Severity**: ${incident.severity}`,
    `- **State**: ${incident.state}`,
    `- **Opened**: ${stamp(incident.openedAt, nowMs)}`,
    `- **Last activity**: ${stamp(readout.lastActivityAt, nowMs)}`,
    `- **Disposition**: ${incident.currentDisposition ?? 'none'} → next ${
      incident.currentNextStage ?? 'none'
    }`,
    ...(readout.verificationStatus
      ? [`- **Latest verification**: ${readout.verificationStatus}`]
      : []),
    ...(incident.closedAt ? [`- **Closed**: ${stamp(incident.closedAt, nowMs)}`] : []),
    ...(incident.lastRunId ? [`- **Source run**: \`${incident.lastRunId}\``] : []),
  ];

  const causes = readout.likelyCauses.flatMap((cause, index) => {
    const confidence =
      cause.confidence === null ? '' : ` _(confidence ${cause.confidence.toFixed(2)})_`;
    return [
      `${index + 1}. ${cause.cause}${confidence}`,
      ...cause.evidence.map((item) => `   - ${item}`),
    ];
  });

  const requirements = readout.evidenceRequirements.flatMap((requirement) => [
    `- **${requirement.type ?? 'EVIDENCE'}**: ${requirement.description}`,
    ...(requirement.toolHint ? [`  - Run: ${requirement.toolHint}`] : []),
  ]);

  const checks = readout.checks.map((check) => {
    const evidence = check.evidence ? ` — ${check.evidence.replace(/\s+/g, ' ').trim()}` : '';
    return `- \`${check.status}\` ${check.tool} ${check.target}${evidence}`;
  });

  const timeline = events.map((event) => {
    const at = event.createdAt ?? 'unknown time';
    return `- \`${at}\` **${event.stage}** — ${event.message}`;
  });

  const lines = [
    `# ${incident.title}`,
    '',
    ...facts,
    '',
    '## Current status',
    '',
    `**${readout.headline}.** ${readout.why}`,
    '',
    '## Closure gate',
    '',
    readout.closeGate,
    '',
    ...(proposal ? proposalSection(proposal) : []),
    ...section('Likely causes', causes),
    ...section('Recommended next checks', bullets(readout.nextActions)),
    ...section('Open evidence requirements', requirements),
    ...section('Evidence gathered', bullets(readout.evidence)),
    ...section('Verification checks run', checks),
    ...section('Timeline', timeline),
  ];

  // Collapse the blank line runs that empty sections leave behind.
  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`;
}
