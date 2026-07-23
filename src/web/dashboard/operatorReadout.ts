import type { IncidentSummary, TransitionEvent } from './statusTypes.js';
import { verificationChecks } from './evidenceView.js';

/**
 * Turns an incident's raw stage events into the answer to "what do I do about this?".
 *
 * Lives outside the React component because the same derivation backs both the incident page and
 * the `/api/incidents/:id/brief` handoff document — those must not be allowed to disagree about
 * what the incident's status is.
 */
export interface ReadoutLikelyCause {
  cause: string;
  confidence: number | null;
  evidence: string[];
}

export interface ReadoutEvidenceRequirement {
  type: string | null;
  description: string;
  toolHint: string | null;
}

export interface ReadoutCheck {
  status: string;
  tool: string;
  target: string;
  evidence: string | null;
}

export interface OperatorReadout {
  tone: 'green' | 'yellow' | 'red' | 'stale';
  headline: string;
  why: string;
  closeGate: string;
  nextActions: string[];
  evidence: string[];
  likelyCauses: ReadoutLikelyCause[];
  evidenceRequirements: ReadoutEvidenceRequirement[];
  checks: ReadoutCheck[];
  verificationStatus: string | null;
  lastActivityAt: string | null;
}

export function stageEvents(events: TransitionEvent[], stage: string): TransitionEvent[] {
  return events.filter((event) => event.stage === stage);
}

export function latestStageEvent(
  events: TransitionEvent[],
  stage: string
): TransitionEvent | null {
  return [...events].reverse().find((event) => event.stage === stage) ?? null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function evidenceRecord(event: TransitionEvent | null): Record<string, unknown> {
  return event?.evidence ?? {};
}

function compactText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function normalize(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

function objectSummary(value: Record<string, unknown>): string | null {
  const parts = [
    compactText(value['action']),
    compactText(value['description']),
    compactText(value['data']),
    compactText(value['reason']),
    compactText(value['tool_hint']),
    compactText(value['suggested_query_or_source']),
    compactText(value['cause']),
    compactText(value['expected_signal']),
  ].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join(' — ') : null;
}

export function evidenceRows(event: TransitionEvent | null, keys: string[]): string[] {
  const rows: string[] = [];
  const evidence = evidenceRecord(event);

  for (const key of keys) {
    const value = evidence[key];
    if (Array.isArray(value)) {
      for (const item of value) {
        const text = compactText(item) ?? (isRecord(item) ? objectSummary(item) : null);
        if (text) {
          rows.push(text);
        }
      }
    } else {
      const text = compactText(value);
      if (text) {
        rows.push(text);
      }
    }
  }

  return [...new Set(rows)];
}

export function evidenceField(event: TransitionEvent | null, key: string): string | null {
  return compactText(evidenceRecord(event)[key]);
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === 'string' && item.trim() !== '');
}

/**
 * The Investigate stage's ranked root-cause hypotheses with their confidence scores. This is the
 * most decision-useful field the agent produces and it was previously dropped on the floor by the
 * UI, which only rendered flat evidence strings.
 */
function likelyCauses(event: TransitionEvent | null): ReadoutLikelyCause[] {
  const value = evidenceRecord(event)['likely_causes'];
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(isRecord).flatMap((item) => {
    const cause = compactText(item['cause']);
    if (!cause) {
      return [];
    }
    const rawConfidence = item['confidence'];
    return [
      {
        cause,
        confidence: typeof rawConfidence === 'number' ? rawConfidence : null,
        evidence: stringList(item['evidence']),
      },
    ];
  });
}

/**
 * Evidence the investigation could not obtain, each carrying the tool call that would obtain it.
 * This is the actionable "here is exactly what to run next" payload for the next operator or
 * agent picking the incident up.
 */
function evidenceRequirements(event: TransitionEvent | null): ReadoutEvidenceRequirement[] {
  const value = evidenceRecord(event)['unresolved_evidence_requirements'];
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(isRecord).flatMap((item) => {
    const description = compactText(item['description']);
    if (!description) {
      return [];
    }
    return [
      {
        type: compactText(item['type']),
        description,
        toolHint: compactText(item['tool_hint']),
      },
    ];
  });
}

function readoutChecks(event: TransitionEvent | null): ReadoutCheck[] {
  if (!event) {
    return [];
  }
  return verificationChecks(event).map((check) => ({
    status: compactText(check['status']) ?? 'unknown',
    tool: compactText(check['tool']) ?? 'check',
    target: compactText(check['target']) ?? 'target',
    evidence: compactText(check['evidence']),
  }));
}

function currentness(events: TransitionEvent[]): string | null {
  for (const event of [...events].reverse()) {
    const semantics = event.evidence?.['semantics'];
    if (isRecord(semantics)) {
      const value = compactText(semantics['currentness']);
      if (value) {
        return value;
      }
    }
  }
  return null;
}

function lastActivity(incident: IncidentSummary, events: TransitionEvent[]): string | null {
  const timestamps = events
    .map((event) => event.createdAt)
    .filter((value): value is string => Boolean(value));
  if (timestamps.length > 0) {
    return timestamps.reduce((latest, value) => (value > latest ? value : latest));
  }
  return incident.lastActivityAt ?? incident.openedAt;
}

export function deriveOperatorReadout(
  incident: IncidentSummary,
  events: TransitionEvent[]
): OperatorReadout {
  const latestInvestigation = latestStageEvent(events, 'Investigate');
  const latestDecision = latestStageEvent(events, 'Decide');
  const latestVerification = latestStageEvent(events, 'Verify');
  const latestStatus = evidenceField(latestVerification, 'status');
  const latestDisposition =
    incident.currentDisposition ?? evidenceField(latestDecision, 'disposition');
  const latestNextStage =
    incident.currentNextStage ?? evidenceField(latestDecision, 'next_stage');
  const closed =
    Boolean(incident.closedAt) || incident.state === 'resolved' || incident.state === 'closed';
  const absentUnverified = incident.state === 'absent_unverified';
  const readyForMitigation =
    latestDisposition === 'MITIGATE' ||
    latestNextStage === 'Mitigate' ||
    latestStatus === 'VERIFIED_ACTIVE_INCIDENT';
  const current = currentness(events);
  const rationale =
    evidenceField(latestVerification, 'rationale') ??
    evidenceField(latestDecision, 'rationale') ??
    latestInvestigation?.message ??
    latestDecision?.message ??
    'No decision rationale was recorded.';

  // Unresolved evidence requirements get their own field (they carry a tool hint), and Decide
  // copies their text verbatim into follow_up_actions — so filter them back out of the action
  // list rather than showing the same sentence twice under two headings.
  const requirements = evidenceRequirements(latestInvestigation);
  const requirementText = requirements.map((requirement) => normalize(requirement.description));
  const nextActions = [
    ...evidenceRows(latestDecision, ['follow_up_actions']),
    ...evidenceRows(latestInvestigation, [
      'additional_data_needed',
      'recommended_next_investigation_steps',
      'unknowns',
    ]),
  ]
    .filter((action) => {
      const text = normalize(action);
      return !requirementText.some(
        (requirement) => text.includes(requirement) || requirement.includes(text)
      );
    })
    .slice(0, 6);
  const evidence = [
    ...evidenceRows(latestInvestigation, [
      'confirmed_facts',
      'supporting_evidence',
      'contradicting_evidence',
    ]),
    ...evidenceRows(latestDecision, ['evidence_to_pass']),
    ...readoutChecks(latestVerification).map(
      (check) => `${check.status}: ${check.tool} ${check.target}`
    ),
  ].slice(0, 8);

  const shared = {
    nextActions,
    evidence,
    likelyCauses: likelyCauses(latestInvestigation),
    evidenceRequirements: requirements,
    checks: readoutChecks(latestVerification),
    verificationStatus: latestStatus,
    lastActivityAt: lastActivity(incident, events),
  };

  if (closed) {
    return {
      ...shared,
      tone: 'green',
      headline: 'Closed',
      why:
        latestVerification?.message ??
        latestDecision?.message ??
        'A closure transition was recorded.',
      closeGate: 'Closed.',
    };
  }

  if (absentUnverified) {
    return {
      ...shared,
      tone: 'stale',
      headline: 'Absent, not verified',
      why:
        'The signal stopped appearing in the health report, but no check has confirmed it ' +
        'recovered. Absence from a report is not evidence of a fix.',
      closeGate:
        'A Verify pass must prove recovery (or prove this was never an incident) before this ' +
        'closes. The scheduled sweep will re-check it; nothing is needed from you unless it ' +
        'keeps coming back.',
    };
  }

  if (readyForMitigation) {
    return {
      ...shared,
      tone: 'red',
      headline: 'Action needed',
      why: rationale,
      closeGate:
        'Close after mitigation or recovery evidence moves Verify to recovered, non-incident, or observability-only.',
      nextActions:
        nextActions.length > 0
          ? nextActions
          : ['Review the latest run output and choose the mitigation or recovery check.'],
    };
  }

  if (latestNextStage === 'Investigate' || latestStatus === 'STILL_INCONCLUSIVE') {
    return {
      ...shared,
      tone: 'yellow',
      headline: 'Still open',
      why: rationale,
      closeGate:
        'Needs more evidence before closure. A future decision must choose CLOSE_TRANSIENT or CLOSE_NON_INCIDENT, or Verify must prove recovery.',
      nextActions:
        nextActions.length > 0
          ? nextActions
          : ['Open the source run and inspect Investigation and Decision JSON for unresolved evidence.'],
    };
  }

  if (latestNextStage === 'Verify' || latestDisposition === 'VERIFY') {
    return {
      ...shared,
      tone: 'yellow',
      headline: 'Waiting on verification',
      why: rationale,
      closeGate:
        'Verify must pass the current health checks before this can close as recovered or non-incident.',
      nextActions:
        nextActions.length > 0
          ? nextActions
          : ['Run or wait for Verify to check the current alarm, metric, log, or service signal.'],
    };
  }

  if (latestDisposition === 'OPEN_OBSERVABILITY_FOLLOWUP') {
    return {
      ...shared,
      tone: 'stale',
      headline: 'Observability follow-up',
      why: rationale,
      closeGate:
        'This is not ready for incident mitigation; close it by fixing or explicitly accepting the telemetry gap.',
      nextActions:
        nextActions.length > 0
          ? nextActions
          : ['Identify the missing metric/log source and create an instrumentation follow-up.'],
    };
  }

  return {
    ...shared,
    tone: current === 'ACTIVE' ? 'yellow' : 'stale',
    headline: current === 'ACTIVE' ? 'Active signal' : 'Needs review',
    why: rationale,
    closeGate:
      'No closure transition has been recorded. Look for the latest Decision and Verify events to see the blocking condition.',
    nextActions:
      nextActions.length > 0
        ? nextActions
        : ['Open the source run for raw stage output and check the latest Decision/Verify status.'],
  };
}
