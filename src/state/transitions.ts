import type {
  DecisionDisposition,
  DecisionNextStage,
  DecisionResult,
  IncidentDecision,
  IncidentVerification,
  Severity,
  VerificationResult,
} from '../types.js';

export type IncidentTransitionType =
  | 'new_incident'
  | 'severity_increased'
  | 'ready_for_mitigation'
  | 'verified_active'
  | 'recovered'
  | 'closed'
  | 'unchanged';

export interface PersistedIncidentSnapshot {
  incidentId: string;
  severity: Severity | null;
  state: string | null;
  currentDisposition: DecisionDisposition | null;
  currentNextStage: DecisionNextStage | null;
  closedAt: string | null;
}

export interface IncidentTransition {
  incidentId: string;
  title: string;
  transitionType: IncidentTransitionType;
  alertable: boolean;
  severity: Severity;
  service: string | null;
  message: string;
  evidence: Record<string, unknown>;
}

const SEVERITY_RANK: Record<Severity, number> = {
  NONE: 0,
  LOW: 1,
  MEDIUM: 2,
  HIGH: 3,
  CRITICAL: 4,
};

function isClosed(previous: PersistedIncidentSnapshot | undefined): boolean {
  if (!previous) {
    return false;
  }
  return Boolean(previous.closedAt) || previous.state === 'closed' || previous.state === 'resolved';
}

function serviceFor(affectedServices: string[] | undefined): string | null {
  return affectedServices?.[0] ?? null;
}

function severityIncreased(
  previous: PersistedIncidentSnapshot | undefined,
  severity: Severity
): boolean {
  return previous?.severity ? SEVERITY_RANK[severity] > SEVERITY_RANK[previous.severity] : false;
}

function decisionIsIdentical(
  previous: PersistedIncidentSnapshot | undefined,
  decision: IncidentDecision
): boolean {
  return (
    previous?.severity === decision.severity &&
    previous.currentDisposition === decision.disposition &&
    previous.currentNextStage === decision.next_stage &&
    !isClosed(previous)
  );
}

function transition(
  transitionType: IncidentTransitionType,
  alertable: boolean,
  payload: {
    incidentId: string;
    title: string;
    severity: Severity;
    service: string | null;
    message: string;
    evidence: Record<string, unknown>;
  }
): IncidentTransition {
  return {
    ...payload,
    transitionType,
    alertable,
    evidence: {
      ...payload.evidence,
      transition_type: transitionType,
      alertable,
    },
  };
}

export function transitionFromDecision(
  previous: PersistedIncidentSnapshot | undefined,
  decision: IncidentDecision
): IncidentTransition {
  const base = {
    incidentId: decision.incident_id,
    title: decision.title,
    severity: decision.severity,
    service: serviceFor(decision.affected_services),
  };
  const evidence = {
    previous_state: previous?.state ?? null,
    previous_severity: previous?.severity ?? null,
    previous_disposition: previous?.currentDisposition ?? null,
    previous_next_stage: previous?.currentNextStage ?? null,
    disposition: decision.disposition,
    next_stage: decision.next_stage,
    rationale: decision.rationale,
  };

  if (!previous) {
    return transition('new_incident', true, {
      ...base,
      message: `New incident: ${decision.title}`,
      evidence,
    });
  }

  if (severityIncreased(previous, decision.severity)) {
    return transition('severity_increased', true, {
      ...base,
      message: `Severity increased to ${decision.severity}: ${decision.title}`,
      evidence,
    });
  }

  if (decisionIsIdentical(previous, decision)) {
    return transition('unchanged', false, {
      ...base,
      message: `Unchanged decision: ${decision.title}`,
      evidence,
    });
  }

  if (decision.disposition === 'MITIGATE' || decision.next_stage === 'Mitigate') {
    return transition('ready_for_mitigation', true, {
      ...base,
      message: `Ready for mitigation: ${decision.title}`,
      evidence,
    });
  }

  if (decision.disposition === 'CLOSE_TRANSIENT') {
    return transition('recovered', true, {
      ...base,
      message: `Recovered transient incident: ${decision.title}`,
      evidence,
    });
  }

  if (decision.disposition === 'CLOSE_NON_INCIDENT') {
    return transition('closed', true, {
      ...base,
      message: `Closed non-incident: ${decision.title}`,
      evidence,
    });
  }

  return transition('unchanged', false, {
    ...base,
    message: `No alertable decision change: ${decision.title}`,
    evidence,
  });
}

export function transitionsFromDecision(
  previousByIncidentId: Map<string, PersistedIncidentSnapshot>,
  decision: DecisionResult
): IncidentTransition[] {
  return decision.decisions.map((item) =>
    transitionFromDecision(previousByIncidentId.get(item.incident_id), item)
  );
}

export function transitionFromVerification(
  previous: PersistedIncidentSnapshot | undefined,
  verification: IncidentVerification
): IncidentTransition {
  const base = {
    incidentId: verification.incident_id,
    title: verification.title,
    severity: verification.severity,
    service: null,
  };
  const evidence = {
    previous_state: previous?.state ?? null,
    previous_severity: previous?.severity ?? null,
    status: verification.status,
    recommended_next_stage: verification.recommended_next_stage,
    rationale: verification.rationale,
  };

  if (verification.status === 'VERIFIED_ACTIVE_INCIDENT') {
    return transition('verified_active', true, {
      ...base,
      message: `Verified active incident: ${verification.title}`,
      evidence,
    });
  }

  if (isClosed(previous)) {
    return transition('unchanged', false, {
      ...base,
      message: `Incident already closed: ${verification.title}`,
      evidence,
    });
  }

  if (verification.status === 'VERIFIED_RECOVERED_TRANSIENT') {
    return transition('recovered', true, {
      ...base,
      message: `Recovered transient incident: ${verification.title}`,
      evidence,
    });
  }

  if (
    verification.status === 'VERIFIED_NON_INCIDENT' ||
    verification.status === 'VERIFIED_OBSERVABILITY_ISSUE'
  ) {
    return transition('closed', true, {
      ...base,
      message: `Closed after verification: ${verification.title}`,
      evidence,
    });
  }

  return transition('unchanged', false, {
    ...base,
    message: `Verification unchanged: ${verification.title}`,
    evidence,
  });
}

export function transitionsFromVerification(
  previousByIncidentId: Map<string, PersistedIncidentSnapshot>,
  verification: VerificationResult
): IncidentTransition[] {
  return verification.verifications.map((item) =>
    transitionFromVerification(previousByIncidentId.get(item.incident_id), item)
  );
}
