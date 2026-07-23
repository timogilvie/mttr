import type {
  DecisionNextStage,
  DecisionResult,
  IncidentDecision,
  Investigation,
  InvestigationResult,
  StageInput,
  StageResult,
} from '../types.js';

const STAGE_PRIORITY: Record<DecisionNextStage, number> = {
  Mitigate: 4,
  Verify: 3,
  Investigate: 2,
  None: 1,
};

function highestNextStage(decisions: IncidentDecision[]): DecisionNextStage {
  return decisions.reduce<DecisionNextStage>((highest, decision) => {
    return STAGE_PRIORITY[decision.next_stage] > STAGE_PRIORITY[highest]
      ? decision.next_stage
      : highest;
  }, 'None');
}

function evidenceToPass(investigation: Investigation): string[] {
  return [
    ...investigation.confirmed_facts,
    ...investigation.supporting_evidence,
    ...investigation.contradicting_evidence.map((evidence) => `Contradicting: ${evidence}`),
  ].slice(0, 12);
}

function unresolvedActions(investigation: Investigation): string[] {
  return [
    ...investigation.unresolved_evidence_requirements.map(
      (requirement) => `${requirement.description} ${requirement.tool_hint}`.trim()
    ),
    ...investigation.additional_data_needed.map(
      (request) => `${request.data}: ${request.suggested_query_or_source}`
    ),
    ...investigation.recommended_next_investigation_steps.map((step) => step.action),
  ];
}

function isTransientCandidate(investigation: Investigation): boolean {
  const text = [
    ...investigation.supporting_evidence,
    ...investigation.likely_causes.map((cause) => cause.cause),
    ...investigation.confirmed_facts,
  ]
    .join(' ')
    .toLowerCase();

  return (
    text.includes('transient') ||
    text.includes('recovered') ||
    text.includes('steady state') ||
    text.includes('deployment') ||
    text.includes('rollout')
  );
}

/**
 * The bar for *proposing* a mitigation, which is lower than the bar for taking one.
 *
 * Mitigate emits a reviewable proposal and never acts, so suppressing a proposal because evidence
 * gaps remain costs more than it saves: the gaps ride along on the proposal itself. This also
 * consults `mitigation_confidence` — the field the Investigate prompt computes from a corroborated
 * causal chain — which nothing previously read. Without it the gate never opened: every production
 * incident to date routed to CONTINUE_INVESTIGATION, VERIFY, or a close, and never once to
 * Mitigate.
 *
 * `requires_more_evidence_before_mitigation` is deliberately *not* a blocker here. It becomes a
 * label on the proposal, and the incident stays open for the sweep to keep driving.
 */
function meetsProposalBar(investigation: Investigation): boolean {
  if (investigation.investigation_status === 'CONFIRMED_INCIDENT') {
    return true;
  }
  return (
    investigation.investigation_status === 'POSSIBLE_INCIDENT' &&
    investigation.mitigation_confidence === 'high'
  );
}

function proposalRationale(investigation: Investigation): string {
  if (investigation.investigation_status !== 'CONFIRMED_INCIDENT') {
    return (
      'Not fully confirmed, but causal evidence is strong enough (mitigation_confidence=high) ' +
      'to propose a mitigation for human review.'
    );
  }
  return investigation.requires_more_evidence_before_mitigation
    ? 'Confirmed incident; proposing a mitigation with the outstanding evidence gaps recorded on it.'
    : 'Confirmed incident with enough root-cause evidence to propose a mitigation.';
}

function decideInvestigation(investigation: Investigation): IncidentDecision {
  const actions = unresolvedActions(investigation);
  const base = {
    incident_id: investigation.incident_id,
    title: investigation.title,
    severity: investigation.severity,
    affected_services: investigation.affected_services,
    evidence_to_pass: evidenceToPass(investigation),
  };

  if (meetsProposalBar(investigation)) {
    return {
      ...base,
      disposition: 'MITIGATE',
      next_stage: 'Mitigate',
      rationale: proposalRationale(investigation),
      follow_up_actions: actions,
    };
  }

  if (investigation.investigation_status === 'OBSERVABILITY_GAP') {
    return {
      ...base,
      disposition: 'OPEN_OBSERVABILITY_FOLLOWUP',
      next_stage: 'None',
      rationale: 'Evidence points to an observability gap rather than a remediable service issue.',
      follow_up_actions: actions,
    };
  }

  if (investigation.investigation_status === 'LIKELY_NON_INCIDENT') {
    return {
      ...base,
      disposition: 'CLOSE_NON_INCIDENT',
      next_stage: 'None',
      rationale: 'Investigation downgraded this item and found no actionable incident.',
      follow_up_actions: actions,
    };
  }

  if (investigation.investigation_status === 'INSUFFICIENT_EVIDENCE') {
    return {
      ...base,
      disposition: 'CONTINUE_INVESTIGATION',
      next_stage: 'Investigate',
      rationale: 'The investigation did not gather enough evidence to make a response decision.',
      follow_up_actions: actions,
    };
  }

  if (actions.length > 0 && investigation.unresolved_evidence_requirements.length > 0) {
    return {
      ...base,
      disposition: 'VERIFY',
      next_stage: 'Verify',
      rationale:
        'Possible incident with no confirmed impact; verify current health and requested evidence before mitigation.',
      follow_up_actions: actions,
    };
  }

  if (isTransientCandidate(investigation)) {
    return {
      ...base,
      disposition: 'CLOSE_TRANSIENT',
      next_stage: 'Verify',
      rationale:
        'Evidence suggests a transient event; verify recovery before closing as transient.',
      follow_up_actions: actions,
    };
  }

  return {
    ...base,
    disposition: 'VERIFY',
    next_stage: 'Verify',
    rationale: 'Possible incident without confirmed root cause or user impact; verify before acting.',
    follow_up_actions: actions,
  };
}

export function decide(investigation: InvestigationResult): DecisionResult {
  if (investigation.investigations.length === 0) {
    return {
      summary: 'No investigations require response.',
      overall_next_stage: 'None',
      decisions: [],
      handoff_notes: [],
    };
  }

  const decisions = investigation.investigations.map(decideInvestigation);
  const overallNextStage = highestNextStage(decisions);
  const handoffNotes = decisions
    .filter((decision) => decision.next_stage === overallNextStage)
    .map((decision) => `${decision.incident_id}: ${decision.rationale}`);

  return {
    summary: `Decision stage selected ${overallNextStage} for ${decisions.length} investigation(s).`,
    overall_next_stage: overallNextStage,
    decisions,
    handoff_notes: handoffNotes,
  };
}

export async function run(input: StageInput, investigation: InvestigationResult): Promise<StageResult> {
  return {
    stage: 'Decide',
    status: 'success',
    timestamp: input.timestamp,
    data: decide(investigation),
  };
}
